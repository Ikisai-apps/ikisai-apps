-- Ikisai Core · estado visible del reporte según el estado real de su petición en Tasks (petición de Tasks, MUELA-073 h. 8).
-- Hasta ahora, cualquier reporte con petición enlazada salía «En marcha» salvo con la tarea hecha, también si Tasks la
-- descartaba o la borraba. Correspondencia nueva (la última petición manda):
--   pending (por clasificar) → open «Recibido» · open → in_progress «En marcha» · done → pending_verify «Resuelto»
--   dismissed / deleted → dismissed «No lo vamos a hacer» (nunca «Resuelto») · sin estado o unknown → como antes.
-- Se deriva, no se guarda: si Tasks reabre o restaura la petición, el reporte vuelve a su estado sin tocar nada.
-- Y el worker deja de seguir las peticiones cerradas en Tasks (descartadas o borradas), además de las hechas.

create or replace function core.feedback_display(p_report core.feedback_reports)
returns text language sql stable as $$
  with last as (select l.task_status s from core.feedback_task_links l where l.report_id = p_report.id order by l.sequence desc limit 1)
  select case
    when p_report.status = 'dismissed' then 'dismissed'
    when p_report.status = 'verified' then 'verified'
    when p_report.released_at is not null then 'pending_verify'
    when (select s from last) = 'done' then 'pending_verify'
    when (select s from last) in ('dismissed', 'deleted') then 'dismissed'
    when (select s from last) = 'pending' then 'open'
    when exists (select 1 from core.feedback_task_links l where l.report_id = p_report.id) then 'in_progress'
    else 'open' end
$$;

create or replace function core.feedback_open_task_refs(p_limit int default 200)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(l.external_ref), '[]'::jsonb) from (
    select l.external_ref from core.feedback_task_links l join core.feedback_reports r on r.id = l.report_id
     where r.status = 'open' and l.task_id is not null and coalesce(l.task_status, '') not in ('done', 'dismissed', 'deleted')
     order by l.created_at limit p_limit) l
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select cron.schedule('ikisai-feedback-tick', '*/5 * * * *', $c$select core.worker_tick('central', 'feedback/tick')
      where exists (select 1 from core.feedback_reports where routing_status in ('pending','error') and status = 'open')
         or exists (select 1 from core.feedback_task_links l join core.feedback_reports r on r.id = l.report_id
                     where r.status = 'open' and l.task_id is not null and coalesce(l.task_status, '') not in ('done', 'dismissed', 'deleted'))$c$)$q$;
  end if;
end $$;

revoke all on function core.feedback_display(core.feedback_reports), core.feedback_open_task_refs(int) from public, anon, authenticated;
grant execute on function core.feedback_display(core.feedback_reports), core.feedback_open_task_refs(int) to service_role;
