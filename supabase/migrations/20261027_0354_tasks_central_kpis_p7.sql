-- Ikisai Tasks · P7 de Central: dos indicadores más en tasks.central_kpi_projection (encargo de Core del 27-10-2026;
-- contrato en docs/central/API.md §7.2; docs/tasks/API.md §49). Toca solo el schema tasks.
-- - `tasks.blocked`: tareas pendientes (hojas) que esperan a una dependencia sin hacer o al paso anterior de una madre con
--   pasos en orden (como `blocked` en tasks.today_projection, 0352).
-- - `tasks.reviews_open`: revisiones de apertura (0349) sin abrir (`open` o `ready`), de proyectos vivos.
-- Las demás claves no cambian (tasks.open, tasks.overdue, tasks.purchase_requests_open, tasks.supplies_below_min y
-- tasks.requests_pending). Solo agregados. Ya está registrada con core.allow_read('central', …, 'view') desde 0309.

create or replace view tasks.central_kpi_projection as
with today as (select (now() at time zone 'Europe/Madrid')::date as d),
-- Tareas pendientes: hojas (sin hijas vivas) sin completar. Un padre se calcula por sus hijas, así que no cuenta aparte.
pending as (
  select t.id, t.due
    from tasks.tasks t
    join tasks.projects pr on pr.id = t.project_id and pr.deleted_at is null and pr.status <> 'archived'
    join tasks.tabs tb on tb.id = t.tab_id and tb.deleted_at is null
   where t.deleted_at is null and not t.done
     and not exists (select 1 from tasks.tasks c where c.parent_id = t.id and c.deleted_at is null)),
-- Bloqueadas (0354): pendientes que esperan a una dependencia sin hacer, o al paso anterior en una madre con pasos en orden.
blocked as (
  select p.id from pending p join tasks.tasks t on t.id = p.id
   where exists (select 1 from tasks.task_dependencies d join tasks.tasks b on b.id = d.depends_on_id
                  where d.task_id = t.id and d.deleted_at is null and b.deleted_at is null and not b.done)
      or exists (select 1 from tasks.tasks pa join tasks.tasks sib on sib.parent_id = pa.id
                  where pa.id = t.parent_id and pa.steps_in_order and not t.step_free and not sib.step_free
                    and sib.deleted_at is null and not sib.done and sib.position < t.position)),
supplies as (
  select i.id, i.min_quantity,
         coalesce((select sum(mv.quantity) from resources.movements mv where mv.item_id = i.id and mv.deleted_at is null), 0) as stock
    from resources.items i
   where i.deleted_at is null and i.active and tasks.supply_kind(i.kind) and i.min_quantity is not null)
select k.kpi, k.label, k.value, k.unit, 'actual'::text as period, (select d from today) as period_start, (select d from today) as period_end,
       k.direction, k.link, now() as computed_at
  from (values
    ('tasks.open', 'Tareas pendientes', (select count(*) from pending)::numeric, 'count', null, 'https://tasks.ikisai.com/#/tasks'),
    ('tasks.overdue', 'Tareas vencidas', (select count(*) from pending, today where pending.due < today.d)::numeric, 'count', 'down', 'https://tasks.ikisai.com/#/tasks'),
    ('tasks.purchase_requests_open', 'Compras pedidas sin recibir',
      (select count(*) from tasks.purchase_requests rq join tasks.tabs tb on tb.id = rq.tab_id and tb.deleted_at is null
        where rq.deleted_at is null and rq.status in ('requested', 'approved', 'purchased'))::numeric, 'count', 'down', 'https://tasks.ikisai.com/#/purchases'),
    ('tasks.supplies_below_min', 'Suministros bajo mínimo', (select count(*) from supplies where stock < min_quantity)::numeric, 'count', 'down', 'https://tasks.ikisai.com/#/supplies'),
    ('tasks.blocked', 'Tareas bloqueadas', (select count(*) from blocked)::numeric, 'count', 'down', 'https://tasks.ikisai.com/#/tasks'),
    ('tasks.reviews_open', 'Revisiones de apertura sin cerrar',
      (select count(*) from tasks.reviews rv join tasks.projects pr on pr.id = rv.project_id and pr.deleted_at is null and pr.status <> 'archived'
        join tasks.tabs tb on tb.id = rv.tab_id and tb.deleted_at is null
        where rv.deleted_at is null and rv.status <> 'opened')::numeric, 'count', 'down', 'https://tasks.ikisai.com/#/projects'),
    ('tasks.requests_pending', 'Peticiones por clasificar',
      (select count(*) from tasks.requests r where r.deleted_at is null and r.status = 'pending')::numeric, 'count', 'down', 'https://tasks.ikisai.com/#/triage')
  ) as k(kpi, label, value, unit, direction, link);

revoke all on tasks.central_kpi_projection from public, anon, authenticated;
grant select on tasks.central_kpi_projection to service_role;
