-- Ikisai Booking · «Vista previa como huésped» desde Booking (B-33, vg-14; VG 05-11).
-- El huésped de muestra lo creaba solo `booking.portal_preview_guest`, para Organizers y dentro del ámbito del organizador:
-- el personal de Booking que no organiza esa reserva no podía sacar la vista previa. `booking.preview_guest({reservation_id})`
-- hace lo mismo para Booking (procedimiento de un lote, `{op: 'call'}`; editor u owner con el ámbito de huéspedes): crea, o devuelve, el huésped de muestra del evento
-- de esa reserva. El enlace de Guests lo sigue emitiendo el núcleo (`POST /portal-links` con `preview: true`).
-- Toca solo el schema booking.

create or replace function booking.preview_guest(p jsonb)
returns jsonb language plpgsql as $$
declare v_res uuid; v_e booking.events; v_id uuid;
begin
  begin v_res := (p->'args'->>'reservation_id')::uuid; exception when others then v_res := null; end;
  if v_res is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'reservation_id must be a uuid')); end if;
  if not booking.actor_sees_guests((p->>'actor')::uuid) then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'guests scope required'));
  end if;
  select e.* into v_e from booking.events e join booking.reservations r on r.id = e.reservation_id
   where r.id = v_res and r.deleted_at is null and e.deleted_at is null;
  if v_e.id is null then perform core.fail('EVENT_REQUIRED', 422, jsonb_build_object('reservation_id', v_res)); end if;
  select id into v_id from booking.guests where event_id = v_e.id and preview and deleted_at is null;
  if v_id is not null then return jsonb_build_object('guest_id', v_id, 'created', false); end if;
  v_id := gen_random_uuid();
  perform set_config('booking.preview_procedure', 'on', true);
  perform core.apply_row_op(p->>'app', (p->>'actor')::uuid, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
    jsonb_build_object('op', 'insert', 'table', 'booking.guests', 'id', v_id,
      'fields', jsonb_build_object('event_id', v_e.id, 'first_name', 'Huésped', 'last_name_1', 'de muestra', 'preview', true)));
  perform set_config('booking.preview_procedure', '', true);
  return jsonb_build_object('guest_id', v_id, 'created', true);
end $$;
select core.allow_procedure('booking', 'booking.preview_guest');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
