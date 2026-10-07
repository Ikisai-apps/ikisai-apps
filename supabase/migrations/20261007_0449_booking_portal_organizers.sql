-- Ikisai Booking · peticiones de Organizers B1–B3 (docs/organizers/API.md §14): detalle de la reserva, `declared` en la lista
-- de huéspedes y alta idempotente ante un reintento. Toca solo el schema booking.

-- B1 · Detalle de la reserva para la ficha de Organizers: horas, plazas, régimen y menú, servicios y alojamiento por espacio
-- (sin huéspedes, importes ni notas internas). Fuera de ámbito o inexistente, igual: OUT_OF_SCOPE.
create or replace function booking.portal_reservation_detail(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_res uuid; v_r booking.reservations; v_e booking.events;
begin
  begin v_res := (p->'args'->>'reservation_id')::uuid; exception when others then v_res := null; end;
  if v_res is null or not booking.portal_in_scope('organizers', (p->>'actor')::uuid, v_res, null) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', p->'args'->>'reservation_id'));
  end if;
  select * into v_r from booking.reservations where id = v_res and deleted_at is null;
  if v_r.id is null then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', v_res)); end if;
  select * into v_e from booking.events where reservation_id = v_res and deleted_at is null;
  return jsonb_build_object(
    'id', v_r.id, 'code', v_r.code, 'title', v_r.title, 'status', v_r.status, 'start_date', v_r.start_date, 'end_date', v_r.end_date,
    'expected_guests', v_r.expected_guests, 'final_guests', v_e.final_guests, 'minors_count', v_r.minors_count,
    'arrival_time', v_e.arrival_time, 'departure_time', v_e.departure_time,
    'meal_plan', coalesce(v_e.meal_plan_confirmed, v_r.meal_plan_requested), 'meal_plan_confirmed', v_e.meal_plan_confirmed is not null,
    'menu_style', coalesce(v_e.menu_style_confirmed, v_r.menu_style_requested), 'menu_style_confirmed', v_e.menu_style_confirmed is not null,
    'uses_accommodation', v_r.uses_accommodation, 'requires_meals', v_r.requires_meals, 'uses_interpretation_center', v_r.uses_interpretation_center,
    'uses_outdoors', v_r.uses_outdoors, 'uses_pool', v_r.uses_pool,
    'mode', booking.guest_mode(v_res), 'confirmed', v_e.id is not null,
    'lodging', coalesce((select jsonb_agg(jsonb_build_object('space', s.name, 'kind', s.kind, 'zone', s.zone, 'persons', x.persons) order by s.zone nulls last, s.position)
      from (select a.space_id, sum(a.persons)::int persons from booking.room_assignments a where a.event_id = v_e.id and a.deleted_at is null group by a.space_id) x
      join booking.spaces s on s.id = x.space_id), '[]'::jsonb));
end $$;
select core.allow_read('organizers', 'booking.portal_reservation_detail', 'function', '{editor,owner}');

-- B2 · `declared`: si el organizador ya aceptó la declaración en esta reserva (para pedirla antes de escribir).
create or replace function booking.portal_guests(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_res uuid; v_event uuid;
begin
  begin v_res := (p->'args'->>'reservation_id')::uuid; exception when others then v_res := null; end;
  if v_res is null or not booking.portal_in_scope('organizers', (p->>'actor')::uuid, v_res, null) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', p->'args'->>'reservation_id'));
  end if;
  select id into v_event from booking.events where reservation_id = v_res and deleted_at is null;
  if v_event is null then return jsonb_build_object('confirmed', false, 'mode', booking.guest_mode(v_res), 'declared', exists (select 1 from booking.portal_declarations d where d.reservation_id = v_res and d.user_id = (p->>'actor')::uuid and d.deleted_at is null), 'items', '[]'::jsonb); end if;
  if booking.guest_mode(v_res) = 'ninguno' then return jsonb_build_object('confirmed', true, 'mode', 'ninguno', 'declared', exists (select 1 from booking.portal_declarations d where d.reservation_id = v_res and d.user_id = (p->>'actor')::uuid and d.deleted_at is null), 'items', '[]'::jsonb); end if;
  return jsonb_build_object('confirmed', true, 'mode', booking.guest_mode(v_res), 'declared', exists (select 1 from booking.portal_declarations d where d.reservation_id = v_res and d.user_id = (p->>'actor')::uuid and d.deleted_at is null), 'items', coalesce((
    select jsonb_agg(booking.portal_organizer_guest(g) order by g.created_at)
      from booking.guests g where g.event_id = v_event and g.deleted_at is null), '[]'::jsonb));
end $$;

-- B3 · alta idempotente (redefinida desde la 0440).
create or replace function booking.portal_add_guest(p jsonb)
returns jsonb language plpgsql as $$
declare v_res uuid; v_event uuid; v_id uuid; v_fields jsonb; v_mode text; v_out jsonb;
begin
  begin v_res := (p->'args'->>'reservation_id')::uuid; v_id := (p->'args'->>'guest_id')::uuid; exception when others then v_res := null; end;
  if v_res is null or v_id is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'reservation_id and guest_id must be uuids')); end if;
  if not booking.portal_in_scope('organizers', (p->>'actor')::uuid, v_res, null) then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', v_res)); end if;
  -- reintento tras perder la respuesta (sin cobertura): si ya existe en esta reserva y lo dio de alta el mismo actor, éxito
  if exists (select 1 from booking.guests g join booking.events e on e.id = g.event_id where g.id = v_id) then
    if exists (select 1 from booking.guests g join booking.events e on e.id = g.event_id
                where g.id = v_id and e.reservation_id = v_res and g.deleted_at is null)
       and exists (select 1 from core.changes c where c.schema_name = 'booking' and c.table_name = 'guests' and c.row_id = v_id
                    and c.op = 'insert' and c.actor_id = (p->>'actor')::uuid) then
      return jsonb_build_object('guest_id', v_id, 'cursor', null, 'existing', true);
    end if;
    perform core.fail('ROW_EXISTS', 409, jsonb_build_object('table', 'booking.guests', 'id', v_id));
  end if;
  select e.id into v_event from booking.events e join booking.reservations r on r.id = e.reservation_id
   where e.reservation_id = v_res and e.deleted_at is null and r.deleted_at is null and r.status not in ('cancelada','perdida');
  if v_event is null then perform core.fail('RESERVATION_NOT_CONFIRMED', 422, jsonb_build_object('reservation_id', v_res)); end if;
  v_mode := booking.guest_mode(v_res);
  if v_mode = 'ninguno' then perform core.fail('GUEST_DATA_OFF', 422, jsonb_build_object('reservation_id', v_res)); end if;
  v_fields := booking.portal_clean_fields(p->'args'->'fields', v_mode);
  if coalesce(btrim(v_fields->>'first_name'), '') = '' then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.guests', 'field', 'first_name')); end if;
  v_out := booking.portal_apply('organizer', booking.portal_declaration_ops(p, v_res) || jsonb_build_array(
    jsonb_build_object('op', 'insert', 'table', 'booking.guests', 'id', v_id, 'fields', v_fields || jsonb_build_object('event_id', v_event))));
  return jsonb_build_object('guest_id', v_id, 'cursor', v_out->'cursor');
end $$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
