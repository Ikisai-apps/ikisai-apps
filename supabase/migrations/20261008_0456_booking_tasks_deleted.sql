-- Ikisai Booking · B13, caso límite (revisión de Tasks, 8-10-2026): si el proyecto del retiro está en la papelera de Tasks
-- (`deleted`), no se piden sus extras (darían PROJECT_NOT_READY para siempre); se reanudan cuando el proyecto vuelve a
-- `created`, `restored` o `renamed`. Toca solo el schema booking.

create or replace function booking.tasks_extras_due(p_limit int)
returns table (proposal_line_id uuid, reservation_id uuid, code text, start_date date, description text, quantity numeric, line_position numeric)
language sql stable as $$
  select l.id, r.id, r.code, r.start_date, l.description, l.quantity, l.position
    from booking.proposal_lines l
    join booking.rates rt on rt.id = l.rate_id and rt.layer = 'extra'
    join booking.proposals p on p.id = l.proposal_id and p.status = 'aceptada' and p.deleted_at is null
    join booking.reservations r on r.id = p.reservation_id and r.deleted_at is null and r.archived_at is null and r.status in ('confirmada','en_ejecucion','cerrada')
    join booking.tasks_projects t on t.reservation_id = r.id and t.synced_state = 'confirmed' and t.project_id is not null
      -- proyecto enviado a la papelera en Tasks: sus extras se abandonan hasta que vuelva (created, restored o renamed)
      and t.last_status is distinct from 'deleted'
   where l.deleted_at is null and not exists (select 1 from booking.tasks_extras x where x.proposal_line_id = l.id)
   order by r.start_date, l.position
   limit greatest(1, least(coalesce(p_limit, 50), 100));
$$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
