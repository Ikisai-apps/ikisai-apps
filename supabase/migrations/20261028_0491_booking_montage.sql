-- Ikisai Booking · «Montaje» del evento (VG, 27-10-2026; DECORACION_Y_FINCA.md): cada cambio de la decoración del evento
-- sobre la general (Recursos 0814, capa `event`) es una tarea hija de «Montaje del evento» en el proyecto de la reserva en
-- Tasks (docs/tasks/API.md §42, `worker/requests/task` con `children`). La decoración la escribe la ficha con
-- `resources.set_event_decor`; después llama a `POST /api/v1/montage/:reservationId/sync`, que manda la lista ENTERA.
-- - `booking.montage_source`: lo que necesita la Edge (código, título, fecha, evento, proyecto de Tasks y si ya se mandó).
-- - `booking.montage_mark` (sistema): anota la tarea madre y cuántas hijas se mandaron.
-- Toca solo el schema booking.

alter table booking.tasks_projects
  add column montage_task_id text check (montage_task_id is null or length(montage_task_id) <= 80),
  add column montage_children integer check (montage_children is null or montage_children between 0 and 500),
  add column montage_synced_at timestamptz;

create or replace function booking.montage_source(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_id uuid; v jsonb;
begin
  begin v_id := (p->'args'->>'reservation_id')::uuid; exception when others then v_id := null; end;
  select jsonb_build_object(
      'reservation', jsonb_build_object('id', r.id, 'code', r.code, 'title', r.title, 'start_date', r.start_date),
      'event_id', e.id, 'project_id', tp.project_id, 'montage_task_id', tp.montage_task_id, 'montage_synced_at', tp.montage_synced_at)
    into v
    from booking.reservations r
    left join booking.events e on e.reservation_id = r.id
    left join booking.tasks_projects tp on tp.reservation_id = r.id and tp.deleted_at is null
   where r.id = v_id and r.deleted_at is null;
  return jsonb_build_object('source', v);
end $$;
select core.allow_read('booking', 'booking.montage_source', 'function', '{editor,owner}');

create or replace function booking.montage_mark(p jsonb)
returns jsonb language plpgsql as $$
declare v_a jsonb := p->'args';
begin
  update booking.tasks_projects
     set montage_task_id = coalesce(v_a->>'task_id', montage_task_id), montage_children = (v_a->>'children')::integer,
         montage_synced_at = now(), updated_at = now(), revision = revision + 1
   where reservation_id = (v_a->>'reservation_id')::uuid and deleted_at is null;
  return jsonb_build_object('ok', found);
end $$;
select core.allow_read('booking', 'booking.montage_mark', 'action', '{}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
