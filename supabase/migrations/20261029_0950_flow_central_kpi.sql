-- Ikisai Flow · indicadores para el panel de Dirección de Central (P7; contrato en docs/central/API.md §7.2). Solo agregados
-- de los flujos activos y fuera del modo pruebas; nada de personas. Fechas en hora de Madrid. Toca solo el schema flow.
-- - flow.sales_yesterday: dinero movido ayer (cobros, devoluciones y ajustes), en euros.
-- - flow.day_closures_pending: días de los últimos 30 (sin hoy) con dinero movido y sin cierre del día.
-- - flow.orders_unfinished_past: pedidos cobrados de días anteriores que siguen sin entregar.
-- - flow.buffers_below_target: mesas y neveras con capacidad cuyo nivel está por debajo de su umbral.
create view flow.central_kpi_projection as
with today as (select (now() at time zone 'Europe/Madrid')::date as d),
live as (select id from flow.projects where deleted_at is null and status = 'active' and not test_mode),
moves as (
  -- Todos los pagos del flujo: de pedidos y de cuentas (lo que se salda a cuenta también es dinero movido).
  select p.project_id, (p.created_at at time zone 'Europe/Madrid')::date as day, p.amount_cents
    from flow.payments p where p.deleted_at is null and p.project_id in (select id from live))
select k.kpi, k.label, k.value, k.unit, 'actual'::text as period,
       case when k.kpi = 'flow.sales_yesterday' then (select d - 1 from today) when k.kpi = 'flow.day_closures_pending' then (select d - 30 from today) else (select d from today) end as period_start,
       case when k.kpi = 'flow.sales_yesterday' then (select d - 1 from today) else (select d from today) end as period_end,
       k.direction, 'https://flow.ikisai.com/equipo/#/'::text as link, now() as computed_at
  from (values
    ('flow.sales_yesterday', 'Ventas de ayer en los flujos',
      (select round(coalesce(sum(amount_cents), 0) / 100.0, 2) from moves, today where day = today.d - 1), 'eur', 'up'),
    ('flow.day_closures_pending', 'Días sin cierre de caja (30 días)',
      (select count(*) from (select distinct m.project_id, m.day from moves m, today where m.day between today.d - 30 and today.d - 1) x
        where not exists (select 1 from flow.day_closures c where c.project_id = x.project_id and c.day = x.day and c.deleted_at is null))::numeric, 'count', 'down'),
    ('flow.orders_unfinished_past', 'Pedidos cobrados sin entregar de días anteriores',
      (select count(*) from flow.orders o, today where o.deleted_at is null and o.status = 'paid' and o.project_id in (select id from live)
         and (o.paid_at at time zone 'Europe/Madrid')::date < today.d)::numeric, 'count', 'down'),
    ('flow.buffers_below_target', 'Existencias por debajo de su umbral',
      (select count(*) from flow.buffers b where b.deleted_at is null and b.capacity > 0 and b.project_id in (select id from live)
         and b.level < b.capacity * b.threshold_pct / 100.0)::numeric, 'count', 'down')
  ) as k(kpi, label, value, unit, direction);

revoke all on flow.central_kpi_projection from public, anon, authenticated;
grant select on flow.central_kpi_projection to service_role;
select core.allow_read('central', 'flow.central_kpi_projection', 'view');
