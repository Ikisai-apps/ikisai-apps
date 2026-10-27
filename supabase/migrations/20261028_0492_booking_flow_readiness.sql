-- Ikisai Booking · «Listo para Flow» en la ficha del evento (Core, 27-10-2026): por qué `booking.flow_guests_of` (0486)
-- devolvería vacío, en el mismo orden en que filtra la cadena. `booking.flow_readiness({reservation_id})` (reader,
-- editor, owner) devuelve la primera condición de Booking que falla:
--   `reservation_closed` (cancelada o perdida) · `no_event` (sin evento vivo) · `no_guests` (ningún huésped que Flow
--   vea: vivos, no de muestra, no anonimizados).
-- Lleva los recuentos para explicarlo: huéspedes visibles, de muestra y anonimizados. Que haya un flujo enlazado
-- (`flow.projects.booking_event_id`) lo publica Flow, no esta migración. Solo cuentas, sin datos personales.
-- Toca solo el schema booking.

create or replace function booking.flow_readiness(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_id uuid; v_r booking.reservations; v_event uuid; v_visible integer := 0; v_preview integer := 0; v_anon integer := 0;
begin
  begin v_id := (p->'args'->>'reservation_id')::uuid; exception when others then v_id := null; end;
  select * into v_r from booking.reservations where id = v_id and deleted_at is null;
  if v_r.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'booking.reservations', 'id', p->'args'->>'reservation_id')); end if;
  select e.id into v_event from booking.events e where e.reservation_id = v_r.id and e.deleted_at is null;
  if v_event is not null then
    select count(*) into v_visible from booking.flow_guests_projection f where f.event_id = v_event;
    select count(*) filter (where g.preview), count(*) filter (where g.anonymized_at is not null and not g.preview)
      into v_preview, v_anon from booking.guests g where g.event_id = v_event and g.deleted_at is null;
  end if;
  return jsonb_build_object(
    'event_id', v_event,
    'failing', case when v_r.status in ('cancelada', 'perdida') then 'reservation_closed'
                    when v_event is null then 'no_event'
                    when v_visible = 0 then 'no_guests' end,
    'status', v_r.status, 'guests', v_visible, 'preview', v_preview, 'anonymized', v_anon);
end $$;
select core.allow_read('booking', 'booking.flow_readiness', 'function', '{reader,editor,owner}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
