-- Ikisai Booking · Alojamiento libre, tarjeta 1 (VG 27-10-2026; inventario ALOJAMIENTO_LIBRE_INVENTARIO.md, hueco 1): la
-- oferta pública de noches que pinta Guests en ven.ikisai.com. Nombres y formas acordados con Guests.
-- - `booking.free_beds(desde, hasta)`: camas libres TODAS las noches de [desde, hasta). Libre quiere decir:
--   - activa, no supletoria y no de equipo, de una estancia activa y reservable;
--   - sin asignación de un evento vivo que se solape;
--   - sin estancia de outsider o staff que se solape.
--   Una sola cama para todo el intervalo, sin cambiar de cama a mitad. La usarán también la solicitud y el bloqueo
--   (tarjeta 2).
-- - `booking_public_events` (cliente, sin argumentos): eventos vivos, visibles para huéspedes (`guests_visible`), con
--   código público y sin terminar:
--   - jornadas abiertas abiertas;
--   - familiares abiertos;
--   - retiros con «Apuntarme».
--   `lodging` dice si ofrecen noches (jornadas abiertas con una tarifa de alojamiento por persona y noche).
-- - `booking_public_lodging({event_code, from, to, persons})` (cliente): las modalidades (tarifas de alojamiento por
--   persona y noche que valen para el tipo y para TODAS las noches del intervalo), con:
--   - precio por noche;
--   - total para esas personas y noches;
--   - plazas libres en todo el intervalo, con un tope de 20 para no enseñar el aforo interno.
--   Nunca camas concretas ni huéspedes.
-- Toca solo el schema booking.

create or replace function booking.free_beds(p_from date, p_to date)
returns table (bed_id uuid, space_id uuid, places integer) language sql stable as $$
  select b.id, b.space_id, greatest(coalesce(b.capacity, 1), 1)::integer
    from booking.beds b join booking.spaces s on s.id = b.space_id
   where b.deleted_at is null and b.active and b.kind <> 'supletoria' and not b.team_bed
     and s.deleted_at is null and s.active and s.bookable
     and p_from is not null and p_to is not null and p_from < p_to
     and not exists (
       select 1 from booking.room_assignments a
         join booking.events e on e.id = a.event_id and e.deleted_at is null
         join booking.reservations r on r.id = e.reservation_id and r.deleted_at is null and r.archived_at is null and r.status not in ('cancelada','perdida')
        where a.bed_id = b.id and a.deleted_at is null
          and coalesce(a.from_date, r.start_date) < p_to and p_from < coalesce(a.to_date, r.end_date))
     and not exists (
       select 1 from booking.stays st
        where st.bed_id = b.id and st.deleted_at is null and st.from_date < p_to and p_from < st.to_date)
$$;

-- El evento público por su código, si está abierto (lo mismo que `booking.public_event`, 0488).
create or replace function booking.public_open_event(p_code text)
returns table (event_id uuid, code text, name text, kind text, starts_on date, ends_on date, joinable boolean, summary text,
               arrival_time time, departure_time time)
language sql stable as $$
  select e.id, e.public_code, r.title, r.event_type, r.start_date, r.end_date,
         r.guests_visible and r.status in ('pre_reservada', 'confirmada', 'en_ejecucion'),
         case when r.guests_visible then r.public_summary end, e.arrival_time, e.departure_time
    from booking.events e
    join booking.reservations r on r.id = e.reservation_id and r.deleted_at is null and r.archived_at is null
     and r.status in ('pre_reservada', 'confirmada', 'en_ejecucion')
   where e.deleted_at is null and e.public_code is not null and e.public_code = upper(btrim(coalesce(p_code, '')))
$$;

-- Tarifas de alojamiento por persona y noche que valen para el tipo de reserva (sin mirar fechas).
create or replace function booking.lodging_rates(p_kind text)
returns setof booking.rates language sql stable as $$
  select * from booking.rates t
   where t.deleted_at is null and t.active and t.service = 'alojamiento' and t.unit = 'persona_noche'
     and (t.event_types is null or cardinality(t.event_types) = 0 or p_kind = any (t.event_types))
$$;

create or replace function booking.public_events(p jsonb)
returns jsonb language sql stable as $$
  with today as (select (now() at time zone 'Europe/Madrid')::date as d)
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object(
      'code', e.public_code, 'name', r.title, 'kind', r.event_type, 'status', 'abierto',
      'joinable', r.guests_visible, 'starts_on', r.start_date, 'ends_on', r.end_date, 'summary', r.public_summary,
      'lodging', r.event_type = 'jornadas_abiertas' and exists (select 1 from booking.lodging_rates(r.event_type)))
      order by r.start_date, r.title, e.public_code), '[]'::jsonb))
    from booking.events e
    join booking.reservations r on r.id = e.reservation_id and r.deleted_at is null and r.archived_at is null
     and r.status in ('pre_reservada', 'confirmada', 'en_ejecucion') and r.guests_visible
    cross join today
   where e.deleted_at is null and e.public_code is not null
     and coalesce(r.end_date, r.start_date) >= today.d
     and r.event_type in ('jornadas_abiertas', 'familiar', 'retiro')
$$;
select core.allow_public_read('booking_public_events', 'booking.public_events', true);

create or replace function booking.public_lodging(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_ev record; v_from date; v_to date; v_persons integer; v_nights integer; v_free integer;
begin
  select * into v_ev from booking.public_open_event(coalesce(p->>'event_code', p->>'code'));
  if v_ev.event_id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('reason', 'event')); end if;
  -- solo lo que el personal ha hecho visible para huéspedes se vende por el QR
  if not v_ev.joinable then perform core.fail('NOT_FOUND', 404, jsonb_build_object('reason', 'event not public')); end if;
  if v_ev.kind <> 'jornadas_abiertas' then perform core.fail('NO_LODGING', 422, jsonb_build_object('reason', 'event does not sell nights')); end if;
  begin
    v_from := (p->>'from')::date; v_to := (p->>'to')::date; v_persons := coalesce((p->>'persons')::integer, 1);
  exception when others then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'from/to/persons'));
  end;
  if v_from is null or v_to is null or v_to <= v_from then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'to', 'reason', 'to after from')); end if;
  -- noches dentro del evento: la primera, la de su entrada; la última, la víspera de su salida
  if v_from < v_ev.starts_on or v_to > v_ev.ends_on then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'from', 'reason', 'outside event', 'starts_on', v_ev.starts_on, 'ends_on', v_ev.ends_on));
  end if;
  v_nights := v_to - v_from;
  if v_nights > 31 then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'to', 'reason', 'max 31 nights')); end if;
  if v_persons < 1 or v_persons > 20 then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'persons', 'reason', '1..20')); end if;
  select coalesce(sum(f.places), 0) into v_free from booking.free_beds(v_from, v_to) f;
  return jsonb_build_object(
    'event', jsonb_build_object('code', v_ev.code, 'name', v_ev.name, 'starts_on', v_ev.starts_on, 'ends_on', v_ev.ends_on,
                                'arrival_time', v_ev.arrival_time, 'departure_time', v_ev.departure_time),
    'from', v_from, 'to', v_to, 'nights', v_nights, 'persons', v_persons,
    'modes', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', t.id, 'name', t.name, 'includes', t.includes,
          'price_night_cents', round(t.amount * 100)::integer,
          'total_cents', round(t.amount * 100)::integer * v_nights * v_persons,
          'max_persons', t.max_persons,
          'available', least(v_free, 20),
          'fits', v_free >= v_persons and (t.max_persons is null or v_persons <= t.max_persons) and (t.min_persons is null or v_persons >= t.min_persons))
          order by t.position, t.name)
        from booking.lodging_rates(v_ev.kind) t
       where (t.valid_from is null or t.valid_from <= v_from) and (t.valid_to is null or (v_to - 1) <= t.valid_to)), '[]'::jsonb),
    'available', least(v_free, 20),
    'rules_text', v_ev.summary);
end $$;
select core.allow_public_read('booking_public_lodging', 'booking.public_lodging', true);

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
