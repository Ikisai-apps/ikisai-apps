-- Ikisai Tasks · indicadores para el panel de Dirección de Central (docs/central/API.md §7.2; claves y fórmulas en
-- docs/tasks/API.md §21). Toca solo el schema tasks. Solo agregados: ningún título, nombre ni importe.
-- `period = 'actual'`: la foto de hoy (hora de Madrid). Cuenta solo lo vivo: sin papelera, sin áreas borradas ni
-- proyectos archivados o borrados.
create view tasks.central_kpi_projection as
with today as (select (now() at time zone 'Europe/Madrid')::date as d),
-- Tareas pendientes: hojas (sin hijas vivas) sin completar. Un padre se calcula por sus hijas, así que no cuenta aparte.
pending as (
  select t.id, t.due
    from tasks.tasks t
    join tasks.projects pr on pr.id = t.project_id and pr.deleted_at is null and pr.status <> 'archived'
    join tasks.tabs tb on tb.id = t.tab_id and tb.deleted_at is null
   where t.deleted_at is null and not t.done
     and not exists (select 1 from tasks.tasks c where c.parent_id = t.id and c.deleted_at is null)),
supplies as (
  select s.id, s.min_quantity,
         coalesce((select sum(mv.delta) from tasks.supply_movements mv where mv.supply_item_id = s.id and mv.deleted_at is null), 0) as stock
    from tasks.supply_items s join tasks.tabs tb on tb.id = s.tab_id and tb.deleted_at is null
   where s.deleted_at is null and not s.archived)
select k.kpi, k.label, k.value, k.unit, 'actual'::text as period, (select d from today) as period_start, (select d from today) as period_end,
       k.direction, k.link, now() as computed_at
  from (values
    ('tasks.open', 'Tareas pendientes', (select count(*) from pending)::numeric, 'count', null, 'https://tasks.ikisai.com/#/tasks'),
    ('tasks.overdue', 'Tareas vencidas', (select count(*) from pending, today where pending.due < today.d)::numeric, 'count', 'down', 'https://tasks.ikisai.com/#/tasks'),
    ('tasks.purchase_requests_open', 'Compras pedidas sin recibir',
      (select count(*) from tasks.purchase_requests rq join tasks.tabs tb on tb.id = rq.tab_id and tb.deleted_at is null
        where rq.deleted_at is null and rq.status in ('requested', 'approved', 'purchased'))::numeric, 'count', 'down', 'https://tasks.ikisai.com/#/purchases'),
    ('tasks.supplies_below_min', 'Suministros bajo mínimo', (select count(*) from supplies where stock < min_quantity)::numeric, 'count', 'down', 'https://tasks.ikisai.com/#/supplies'),
    ('tasks.requests_pending', 'Peticiones por clasificar',
      (select count(*) from tasks.requests r where r.deleted_at is null and r.status = 'pending')::numeric, 'count', 'down', 'https://tasks.ikisai.com/#/triage')
  ) as k(kpi, label, value, unit, direction, link);

revoke all on tasks.central_kpi_projection from public, anon, authenticated;
grant select on tasks.central_kpi_projection to service_role;
select core.allow_read('central', 'tasks.central_kpi_projection', 'view');
