-- Ikisai Booking · Alojamiento libre, tarjeta 2 (VG 27-10-2026): un visitante del QR pide noches. Hay dos modos de pago y
-- se eligen por evento al crear la reserva:
-- - `hold`: la solicitud reserva las plazas N horas y se paga en recepción;
-- - `pay_first`: no reserva nada hasta pagar.
-- Lo que añade la migración:
-- - `booking.reservations.lodging_pay_mode` y `lodging_hold_hours`.
-- - `booking.visitor_requests` con `kind = 'stay'`: noches [from_date, to_date), personas, tarifa (`rate_id`), total y modo.
--   El servidor calcula el total con la tarifa; lo que mande el cliente no cuenta.
--   En modo `hold` lleva además las camas que bloquea (`hold_bed_ids`) y hasta cuándo (`hold_until`).
-- - El bloqueo y la comprobación van en la misma fila, dentro del lote público, y los lotes de la app van en serie
--   (`core.app_state … for update`). Así dos teléfonos nunca se quedan la última plaza: el segundo recibe 409
--   `NO_AVAILABILITY` y no queda nada a medias.
-- - Una solicitud nueva del mismo visitante para el mismo evento sustituye a la anterior pendiente y suelta su bloqueo.
-- - `booking.free_beds` resta los bloqueos vivos. `booking.check_lodging_holds` (validación de cada lote) impide que el
--   personal asigne una cama bloqueada (`BED_HELD`) mientras el bloqueo esté vivo. Al aceptar la solicitud (tarjeta 3) el
--   bloqueo se convierte en asignación.
-- - `booking.visitor_requests_of` da también lo de las noches, el id y si el bloqueo ha caducado.
-- Toca solo el schema booking.

alter table booking.reservations
  add column lodging_pay_mode text not null default 'hold' check (lodging_pay_mode in ('hold', 'pay_first')),
  add column lodging_hold_hours integer not null default 24 check (lodging_hold_hours between 1 and 168);
select core.register_table('booking', 'booking', 'reservations', array[
  'title','event_type','status','priority','start_date','end_date','expected_guests','minors_count',
  'contact_name','contact_phone','contact_email','customer_type',
  'uses_accommodation','requires_meals','meal_plan_requested','menu_style_requested','meal_notes',
  'uses_interpretation_center','uses_outdoors','uses_pool','special_setup','technical_support',
  'customer_notes','briefing_received','internal_notes','archived_at',
  'ses_enabled','ses_disabled_reason','ses_disabled_note','collect_guest_data','dates_definitive','organizer_notes',
  'guests_visible','public_summary','food_carta_ids','lodging_pay_mode','lodging_hold_hours']);

alter table booking.visitor_requests drop constraint visitor_requests_kind_check;
alter table booking.visitor_requests add constraint visitor_requests_kind_check check (kind in ('join', 'contact', 'stay'));
alter table booking.visitor_requests drop constraint visitor_requests_contact_kind;
alter table booking.visitor_requests add constraint visitor_requests_contact_kind check (kind in ('join', 'stay') or status in ('pendiente', 'atendida', 'descartada'));
alter table booking.visitor_requests
  add column from_date date,
  add column to_date date,
  add column persons integer check (persons is null or persons between 1 and 20),
  add column rate_id uuid references booking.rates(id),
  add column total_cents integer check (total_cents is null or total_cents >= 0),
  add column pay_mode text check (pay_mode is null or pay_mode in ('hold', 'pay_first')),
  add column hold_bed_ids uuid[],
  add column hold_until timestamptz,
  add constraint visitor_requests_stay_fields check (kind <> 'stay' or (from_date is not null and to_date > from_date and persons is not null and rate_id is not null and total_cents is not null and pay_mode is not null)),
  add constraint visitor_requests_stay_only check (kind = 'stay' or (from_date is null and to_date is null and persons is null and rate_id is null and hold_bed_ids is null and hold_until is null));
create index visitor_requests_holds_idx on booking.visitor_requests (hold_until) where kind = 'stay' and status = 'pendiente' and deleted_at is null and hold_until is not null;
select core.register_table('booking', 'booking', 'visitor_requests', array['event_id','via_code','visitor_id','kind','name','contact','note','status','guest_id','decided_at',
  'from_date','to_date','persons','rate_id','total_cents','pay_mode','hold_bed_ids','hold_until'],
  '{editor,owner}', '{editor,owner}');

-- Camas libres todas las noches de [desde, hasta): la de 0498, menos las que bloquea una solicitud pendiente y viva.
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
     and not exists (
       select 1 from booking.visitor_requests q
        where q.kind = 'stay' and q.status = 'pendiente' and q.deleted_at is null and q.hold_until > now()
          and b.id = any (q.hold_bed_ids) and q.from_date < p_to and p_from < q.to_date)
$$;

-- La guarda de 0489 con las solicitudes de noches.
create or replace function booking.visitor_request_guard()
returns trigger language plpgsql as $$
declare r booking.reservations; t booking.rates; v_free integer; v_got integer := 0; v_beds uuid[] := '{}'; f record;
begin
  -- lo que hace el propio procedimiento (sustituir la solicitud anterior del visitante, decidir) no pasa por la guarda del visitante
  if tg_op = 'UPDATE' and coalesce(current_setting('booking.visitor_procedure', true), '') = 'on'
     and new.visitor_id is not distinct from old.visitor_id and new.event_id is not distinct from old.event_id then
    return new;
  end if;
  if core.is_public_batch() then
    if tg_op <> 'INSERT' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'a visitor only creates its request')); end if;
    if new.visitor_id is null or new.visitor_id is distinct from core.current_visitor() then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'visitor_id must be the visitor of the batch'));
    end if;
    if new.status <> 'pendiente' or new.guest_id is not null or new.decided_at is not null then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.visitor_requests', 'reason', 'pending request with visitor_id only'));
    end if;
    new.via_code := upper(btrim(coalesce(new.via_code, '')));
    new.event_id := (select e.id from booking.events e where e.public_code = new.via_code and e.deleted_at is null);
    select rr.* into r from booking.events e join booking.reservations rr on rr.id = e.reservation_id
     where e.id = new.event_id and e.deleted_at is null and rr.deleted_at is null;
    if r.id is null or r.archived_at is not null or r.status not in ('pre_reservada', 'confirmada', 'en_ejecucion') or (new.kind in ('join', 'stay') and not r.guests_visible) then
      perform core.fail('RESERVATION_NOT_OPEN', 422, jsonb_build_object('event_id', new.event_id));
    end if;
    new.name := nullif(btrim(new.name), '');
    new.note := nullif(btrim(new.note), '');
    new.contact := nullif(btrim(new.contact), '');
    if new.kind = 'contact' and new.contact is null then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.visitor_requests', 'field', 'contact'));
    end if;
    if new.kind <> 'stay' then
      if new.from_date is not null or new.to_date is not null or new.persons is not null or new.rate_id is not null or new.hold_bed_ids is not null or new.hold_until is not null then
        perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.visitor_requests', 'reason', 'nights only in a stay request'));
      end if;
      return new;
    end if;
    -- solicitud de noches: jornadas abiertas, dentro del evento y con una tarifa de alojamiento que valga todas las noches
    if r.event_type <> 'jornadas_abiertas' then perform core.fail('NO_LODGING', 422, jsonb_build_object('event_id', new.event_id)); end if;
    if new.name is null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.visitor_requests', 'field', 'name')); end if;
    if new.from_date is null or new.to_date is null or new.to_date <= new.from_date or new.from_date < r.start_date or new.to_date > r.end_date or new.to_date - new.from_date > 31 then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.visitor_requests', 'field', 'from_date', 'starts_on', r.start_date, 'ends_on', r.end_date));
    end if;
    if new.persons is null or new.persons not between 1 and 20 then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.visitor_requests', 'field', 'persons'));
    end if;
    select x.* into t from booking.lodging_rates(r.event_type) x
     where x.id = new.rate_id and (x.valid_from is null or x.valid_from <= new.from_date) and (x.valid_to is null or (new.to_date - 1) <= x.valid_to)
       and (x.max_persons is null or new.persons <= x.max_persons) and (x.min_persons is null or new.persons >= x.min_persons);
    if t.id is null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.visitor_requests', 'field', 'rate_id')); end if;
    new.total_cents := round(t.amount * 100)::integer * (new.to_date - new.from_date) * new.persons;
    new.pay_mode := r.lodging_pay_mode;
    new.hold_bed_ids := null; new.hold_until := null;
    -- la solicitud anterior del mismo visitante para este evento queda sustituida (y suelta su bloqueo)
    -- por apply_row_op, con el lote en curso (apply_operations deja app, actor, petición y cursor): queda en core.changes
    perform set_config('booking.visitor_procedure', 'on', true);
    for f in select id, revision from booking.visitor_requests
              where event_id = new.event_id and visitor_id = new.visitor_id and kind = 'stay' and status = 'pendiente' and deleted_at is null loop
      perform core.apply_row_op(current_setting('core.app'), nullif(current_setting('core.actor', true), '')::uuid, 'editor',
        current_setting('core.request_id'), current_setting('core.cursor')::bigint,
        jsonb_build_object('op', 'update', 'table', 'booking.visitor_requests', 'id', f.id, 'expectedRevision', f.revision,
          'fields', jsonb_build_object('status', 'descartada', 'decided_at', now(), 'hold_until', null)));
    end loop;
    perform set_config('booking.visitor_procedure', '', true);
    select coalesce(sum(x.places), 0) into v_free from booking.free_beds(new.from_date, new.to_date) x;
    if v_free < new.persons then
      perform core.fail('NO_AVAILABILITY', 409, jsonb_build_object('available', least(v_free, 20), 'persons', new.persons));
    end if;
    if new.pay_mode = 'hold' then
      for f in select * from booking.free_beds(new.from_date, new.to_date) order by space_id, bed_id loop
        exit when v_got >= new.persons;
        v_beds := v_beds || f.bed_id; v_got := v_got + f.places;
      end loop;
      new.hold_bed_ids := v_beds;
      new.hold_until := now() + make_interval(hours => r.lodging_hold_hours);
    end if;
    return new;
  end if;
  if tg_op = 'INSERT' and coalesce(current_setting('booking.visitor_procedure', true), '') <> 'on' then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'only visitors create requests'));
  end if;
  if tg_op = 'UPDATE' and (new.visitor_id is distinct from old.visitor_id or new.event_id is distinct from old.event_id) then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.visitor_requests', 'reason', 'visitor and event do not change'));
  end if;
  if tg_op = 'UPDATE' and (new.status is distinct from old.status or new.guest_id is distinct from old.guest_id)
     and coalesce(current_setting('booking.visitor_procedure', true), '') <> 'on' then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'decide with booking.join_from_visitor'));
  end if;
  -- lo de las noches solo lo pone el visitante (y el bloqueo, el servidor)
  if tg_op = 'UPDATE' and (new.from_date, new.to_date, new.persons, new.rate_id, new.total_cents, new.pay_mode, new.hold_bed_ids, new.hold_until)
       is distinct from (old.from_date, old.to_date, old.persons, old.rate_id, old.total_cents, old.pay_mode, old.hold_bed_ids, old.hold_until)
     and coalesce(current_setting('booking.visitor_procedure', true), '') <> 'on' then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.visitor_requests', 'reason', 'stay fields do not change'));
  end if;
  return new;
end $$;

-- Nadie asigna una cama bloqueada por una solicitud viva (el bloqueo se convierte en asignación al aceptarla, tarjeta 3).
create or replace function booking.check_lodging_holds(p jsonb)
returns void language plpgsql as $$
declare v_id uuid; v_req uuid;
begin
  select a.id, q.id into v_id, v_req
    from booking.visitor_requests q
    join booking.room_assignments a on a.bed_id = any (q.hold_bed_ids) and a.deleted_at is null
    join booking.events e on e.id = a.event_id and e.deleted_at is null
    join booking.reservations r on r.id = e.reservation_id and r.deleted_at is null and r.archived_at is null and r.status not in ('cancelada','perdida')
   where q.kind = 'stay' and q.status = 'pendiente' and q.deleted_at is null and q.hold_until > now()
     and coalesce(a.from_date, r.start_date) < q.to_date and q.from_date < coalesce(a.to_date, r.end_date)
     and a.created_at >= q.created_at
   limit 1;
  if v_id is not null then perform core.fail('BED_HELD', 422, jsonb_build_object('id', v_id, 'request_id', v_req)); end if;
end $$;
select core.add_validate_hook('booking', 'booking.check_lodging_holds');

-- Lo del visitante, con su id, las noches y si el bloqueo ha caducado.
create or replace function booking.visitor_requests_of(p jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'event_code', e.public_code, 'kind', q.kind, 'name', q.name, 'status', q.status,
             'created_at', q.created_at, 'decided_at', q.decided_at,
             'from', q.from_date, 'to', q.to_date, 'persons', q.persons, 'mode_id', q.rate_id, 'total_cents', q.total_cents, 'pay', q.pay_mode,
             'hold_until', q.hold_until, 'hold_expired', q.kind = 'stay' and q.pay_mode = 'hold' and q.status = 'pendiente' and (q.hold_until is null or q.hold_until <= now()))
             order by q.created_at desc), '[]'::jsonb))
    from booking.visitor_requests q join booking.events e on e.id = q.event_id
   where q.deleted_at is null and q.visitor_id = nullif(p->>'visitor_id', '')::uuid
     and (nullif(p->>'event_code', '') is null or e.public_code = upper(btrim(p->>'event_code')))
$$;

-- La oferta pública dice el modo de pago del evento y cuántas horas reserva.
create or replace function booking.public_lodging_pay(p_code text)
returns jsonb language sql stable as $$
  select jsonb_build_object('pay', r.lodging_pay_mode, 'hold_hours', case when r.lodging_pay_mode = 'hold' then r.lodging_hold_hours end)
    from booking.events e join booking.reservations r on r.id = e.reservation_id
   where e.deleted_at is null and e.public_code = upper(btrim(coalesce(p_code, '')))
$$;
alter function booking.public_lodging(jsonb) rename to public_lodging_base;
create or replace function booking.public_lodging(p jsonb)
returns jsonb language sql stable as $$
  select booking.public_lodging_base(p) || coalesce(booking.public_lodging_pay(coalesce(p->>'event_code', p->>'code')), '{}'::jsonb)
$$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
