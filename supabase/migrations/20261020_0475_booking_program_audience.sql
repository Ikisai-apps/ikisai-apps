-- Ikisai Booking · MUELA-065, PR 3 (VG: «Dato audience: Sí»): para quién es cada actividad del programa, para que Guests
-- pinte el Programa de la familia por columnas (lo común a todo el ancho; lo de alguien, en su columna).
--   `audience`: 'todos' (por defecto: lo de hoy no cambia), 'adultos', 'menores' o 'personas'.
--   `audience_guest_ids`: con 'personas', los huéspedes del retiro a los que va (al menos uno); vacío en los demás casos.
-- Regla de la 065: audience nunca deja ver a una persona las actividades de otra familia. En Guests, una actividad de
-- 'personas' sale solo si alguno de esos huéspedes es del ámbito de quien lee, y la lista lleva solo esos.

alter table booking.program_items
  add column audience text not null default 'todos' check (audience in ('todos','adultos','menores','personas')),
  add column audience_guest_ids uuid[] not null default '{}',
  add constraint program_items_audience_guests check ((audience = 'personas') = (cardinality(audience_guest_ids) > 0) and cardinality(audience_guest_ids) <= 100);
select core.register_table('booking', 'booking', 'program_items', array['event_id','day','starts_at','ends_at','title','space_id','place_text',
  'public_note','internal_note','kind','optional','position','resource_space_id','audience','audience_guest_ids']);

-- La de 0459, más: las personas son huéspedes vivos de este retiro. Solo al cambiar la lista: si después se borra un
-- huésped, la actividad se sigue pudiendo editar (la lectura ya no lo enseña).
create or replace function booking.program_item_check()
returns trigger language plpgsql as $$
declare v_r booking.reservations;
begin
  if new.deleted_at is not null then return new; end if;
  select r.* into v_r from booking.events e join booking.reservations r on r.id = e.reservation_id where e.id = new.event_id;
  if v_r.start_date is not null and v_r.end_date is not null and (new.day < v_r.start_date or new.day > v_r.end_date)
     and (tg_op = 'INSERT' or new.day is distinct from old.day) then
    perform core.fail('PROGRAM_DAY_OUT_OF_RANGE', 422, jsonb_build_object('table', 'booking.program_items', 'id', new.id, 'day', new.day));
  end if;
  if new.space_id is not null and not exists (select 1 from booking.spaces s where s.id = new.space_id and s.deleted_at is null and s.active) then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.program_items', 'field', 'space_id'));
  end if;
  if cardinality(new.audience_guest_ids) > 0 and (tg_op = 'INSERT' or new.audience_guest_ids is distinct from old.audience_guest_ids)
     and exists (select 1 from unnest(new.audience_guest_ids) x(id)
                  where not exists (select 1 from booking.guests g where g.id = x.id and g.event_id = new.event_id and g.deleted_at is null)) then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.program_items', 'id', new.id, 'field', 'audience_guest_ids'));
  end if;
  return new;
end $$;

-- Para quién va, visto por el lector del portal: el organizador, los huéspedes vivos; el huésped, solo los de su ámbito.
create or replace function booking.program_audience_for(p jsonb, p_res uuid, i booking.program_items)
returns uuid[] language sql stable as $$
  select coalesce(array_agg(x.id order by x.ord), '{}'::uuid[])
    from unnest(i.audience_guest_ids) with ordinality x(id, ord)
   where exists (select 1 from booking.guests g where g.id = x.id and g.event_id = i.event_id and g.deleted_at is null)
     and (p->>'app' <> 'guests' or booking.portal_in_scope('guests', (p->>'actor')::uuid, p_res, x.id))
$$;

-- La de 0459, más `audience` y `audience_guest_ids` en cada actividad, y sin las de 'personas' ajenas para el huésped.
create or replace function booking.portal_program(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_r booking.reservations; v_e booking.events; v_org boolean := p->>'app' = 'organizers';
begin
  v_r := booking.portal_scope_reservation(p);
  select * into v_e from booking.events where reservation_id = v_r.id and deleted_at is null;
  return jsonb_build_object(
    'revision', coalesce((select sum(i.revision) from booking.program_items i where i.event_id = v_e.id), 0),
    'confirmed', v_e.id is not null, 'start_date', v_r.start_date, 'end_date', v_r.end_date,
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'revision', i.revision, 'day', i.day,
        'starts_at', to_char(i.starts_at, 'HH24:MI'), 'ends_at', to_char(i.ends_at, 'HH24:MI'), 'title', i.title,
        'place', coalesce(booking.space_public_name(s), i.place_text), 'space_id', i.space_id, 'place_text', i.place_text,
        'public_note', i.public_note, 'kind', i.kind, 'position', i.position,
        'audience', i.audience, 'audience_guest_ids', to_jsonb(a.ids))
        || case when v_org then jsonb_build_object('internal_note', i.internal_note) else '{}'::jsonb end
        order by i.day, i.starts_at nulls first, i.position)
      from booking.program_items i left join booking.spaces s on s.id = i.space_id
      cross join lateral (select booking.program_audience_for(p, v_r.id, i) ids) a
     where i.event_id = v_e.id and i.deleted_at is null
       and (v_org or i.audience <> 'personas' or cardinality(a.ids) > 0)), '[]'::jsonb))
    || case when v_org then jsonb_build_object('spaces', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', booking.space_public_name(s), 'kind', s.kind, 'zone', s.zone)
        order by s.kind <> 'sala', s.zone nulls last, s.position)
      from booking.spaces s where s.deleted_at is null and s.active and s.kind <> 'habitacion'), '[]'::jsonb)) else '{}'::jsonb end;
end $$;

-- La de 0459, más `audience` y `audience_guest_ids`. Con un público que no es 'personas', la lista se vacía sola.
create or replace function booking.portal_program_save(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_e booking.events := booking.portal_program_event(p); v_item jsonb := coalesce(p->'args'->'item', '{}'::jsonb);
  v_id uuid; v_old booking.program_items; v_fields jsonb := '{}'::jsonb; v_key text; v_out jsonb;
begin
  begin v_id := (v_item->>'id')::uuid; exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'item.id debe ser un uuid')); end;
  if v_id is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'item.id es obligatorio (lo genera el cliente)')); end if;
  foreach v_key in array array['day','starts_at','ends_at','title','space_id','place_text','public_note','internal_note','kind','position','audience','audience_guest_ids'] loop
    if v_item ? v_key then v_fields := v_fields || jsonb_build_object(v_key, case when v_item->v_key = '""'::jsonb then 'null'::jsonb else v_item->v_key end); end if;
  end loop;
  if v_fields ? 'audience_guest_ids' and jsonb_typeof(v_fields->'audience_guest_ids') = 'null' then v_fields := v_fields || jsonb_build_object('audience_guest_ids', '[]'::jsonb); end if;
  if v_fields ? 'audience' and v_fields->>'audience' is distinct from 'personas' and not v_fields ? 'audience_guest_ids' then
    v_fields := v_fields || jsonb_build_object('audience_guest_ids', '[]'::jsonb);
  end if;
  select * into v_old from booking.program_items where id = v_id;
  if v_old.id is not null and (v_old.event_id <> v_e.id or v_old.deleted_at is not null) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('id', v_id));
  end if;
  if v_old.id is null then
    v_out := booking.portal_apply('organizer', jsonb_build_array(jsonb_build_object('op', 'insert', 'table', 'booking.program_items', 'id', v_id,
      'fields', v_fields || jsonb_build_object('event_id', v_e.id))));
  else
    if v_fields = '{}'::jsonb then return jsonb_build_object('id', v_id, 'revision', v_old.revision, 'cursor', null); end if;
    v_out := booking.portal_apply('organizer', jsonb_build_array(jsonb_build_object('op', 'update', 'table', 'booking.program_items', 'id', v_id,
      'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, v_old.revision), 'fields', v_fields)));
  end if;
  return jsonb_build_object('id', v_id, 'revision', (select revision from booking.program_items where id = v_id), 'cursor', v_out->'cursor');
end $$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
