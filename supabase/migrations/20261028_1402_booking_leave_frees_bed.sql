-- Ikisai Booking · Alojamiento libre, tarjeta 4 (VG 27-10-2026; hueco 7 del inventario): marcar la salida
-- (`booking.guest_leave`, 0486) deja de ser solo una hora.
-- - Libera la cama: cada asignación viva del huésped que seguía después de hoy (hora de Madrid) se acorta y termina hoy,
--   y como mínimo dura una noche. Las noches [entrada, salida) siguen valiendo: la cama queda libre esta misma noche para
--   otro.
-- - Guarda la salida prevista en `planned_to_date`. «Deshacer» la devuelve, si la cama sigue libre; si no, el lote falla
--   con `BED_OVERBOOKED` y no cambia nada.
-- - La limpieza de la cama la pide la Edge a Tasks después del lote (booking-api, `afterCommit`), con la petición de
--   Tasks (`worker/requests/task`, tipo `booking.bed_cleaning`). Esta función devuelve qué camas han quedado libres.
-- Toca solo el schema booking.

alter table booking.room_assignments add column planned_to_date date;
select core.register_table('booking', 'booking', 'room_assignments', array['event_id','space_id','bed_id','guest_id','group_label','persons','from_date','to_date','notes','status',
  'resource_space_id','resource_bed_id','planned_to_date']);

create or replace function booking.guest_leave(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_g booking.guests := booking.guest_for_presence(p); v_undo boolean := coalesce((p->'args'->>'undo')::boolean, false); v_fields jsonb;
  v_today date := (now() at time zone 'Europe/Madrid')::date; a record; v_freed jsonb := '[]'::jsonb;
begin
  if not v_undo then
    if v_g.left_at is not null then return booking.guest_presence(v_g.id) || jsonb_build_object('freed', '[]'::jsonb); end if;
    v_fields := jsonb_build_object('left_at', now());
    -- la cama queda libre desde hoy
    for a in select ra.id, ra.revision, ra.bed_id, coalesce(ra.from_date, r.start_date) d_from, coalesce(ra.to_date, r.end_date) d_to
               from booking.room_assignments ra
               join booking.events e on e.id = ra.event_id join booking.reservations r on r.id = e.reservation_id
              where ra.guest_id = v_g.id and ra.deleted_at is null and coalesce(ra.to_date, r.end_date) > v_today loop
      perform core.apply_row_op(p->>'app', (p->>'actor')::uuid, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
        jsonb_build_object('op', 'update', 'table', 'booking.room_assignments', 'id', a.id, 'expectedRevision', a.revision,
          'fields', jsonb_build_object('to_date', greatest(v_today, a.d_from + 1), 'planned_to_date', a.d_to)));
      if a.bed_id is not null then v_freed := v_freed || jsonb_build_object('assignment_id', a.id, 'bed_id', a.bed_id); end if;
    end loop;
  else
    if v_g.left_at is null then return booking.guest_presence(v_g.id) || jsonb_build_object('freed', '[]'::jsonb); end if;
    v_fields := jsonb_build_object('left_at', null);
    -- deshacer devuelve la salida prevista (si la cama sigue libre: si no, BED_OVERBOOKED al validar el lote)
    for a in select ra.id, ra.revision, ra.planned_to_date from booking.room_assignments ra
              where ra.guest_id = v_g.id and ra.deleted_at is null and ra.planned_to_date is not null loop
      perform core.apply_row_op(p->>'app', (p->>'actor')::uuid, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
        jsonb_build_object('op', 'update', 'table', 'booking.room_assignments', 'id', a.id, 'expectedRevision', a.revision,
          'fields', jsonb_build_object('to_date', a.planned_to_date, 'planned_to_date', null)));
    end loop;
  end if;
  perform core.apply_row_op(p->>'app', (p->>'actor')::uuid, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
    jsonb_build_object('op', 'update', 'table', 'booking.guests', 'id', v_g.id, 'expectedRevision', v_g.revision, 'fields', v_fields));
  return booking.guest_presence(v_g.id) || jsonb_build_object('freed', v_freed);
end $$;

-- Para la Edge: lo que necesita la petición de limpieza de cada cama liberada (sin datos de la persona).
create or replace function booking.cleaning_source(p jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object(
      'assignment_id', ra.id, 'bed_id', b.id, 'bed', b.label, 'room', coalesce(s.public_name, s.name), 'reservation_code', r.code,
      'event_type', r.event_type) order by s.name, b.label), '[]'::jsonb))
    from booking.room_assignments ra
    join booking.beds b on b.id = ra.bed_id join booking.spaces s on s.id = b.space_id
    join booking.events e on e.id = ra.event_id join booking.reservations r on r.id = e.reservation_id
   where ra.id in (select (x->>'assignment_id')::uuid from jsonb_array_elements(coalesce(p->'args'->'items', '[]'::jsonb)) x)
$$;
select core.allow_read('booking', 'booking.cleaning_source', 'action', '{}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
