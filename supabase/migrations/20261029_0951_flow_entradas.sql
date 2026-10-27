-- Ikisai Flow · entradas por URL (decisión de VG, 27-10; MUELA/equipo/feedback/flow/URLS_ENTRADA.md): la raíz de
-- flow.ikisai.com es la entrada del equipo y la carta pública vive en /recorridos/carta (se llega desde ven.ikisai.com).
-- - El enlace de los indicadores para Central apunta a la raíz (antes /equipo/#/).
-- - El enlace de un uso de Guests a la carta (`carta_url`, FL2) apunta a /recorridos/carta; los antiguos (/?invitacion=)
--   los sigue redirigiendo el worker. Toca solo el schema flow.

create or replace view flow.central_kpi_projection as
with today as (select (now() at time zone 'Europe/Madrid')::date as d),
live as (select id from flow.projects where deleted_at is null and status = 'active' and not test_mode),
moves as (
  -- Todos los pagos del flujo: de pedidos y de cuentas (lo que se salda a cuenta también es dinero movido).
  select p.project_id, (p.created_at at time zone 'Europe/Madrid')::date as day, p.amount_cents
    from flow.payments p where p.deleted_at is null and p.project_id in (select id from live))
select k.kpi, k.label, k.value, k.unit, 'actual'::text as period,
       case when k.kpi = 'flow.sales_yesterday' then (select d - 1 from today) when k.kpi = 'flow.day_closures_pending' then (select d - 30 from today) else (select d from today) end as period_start,
       case when k.kpi = 'flow.sales_yesterday' then (select d - 1 from today) else (select d from today) end as period_end,
       k.direction, 'https://flow.ikisai.com/#/'::text as link, now() as computed_at
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

create or replace function flow.carta_link(p_customer flow.customers) returns text language plpgsql stable as $$
declare v_key text := flow.portal_key(); v_msg text;
begin
  if v_key is null then return null; end if;
  v_msg := p_customer.id::text || '.' || (extract(epoch from now())::bigint + 600)::text || '.' || p_customer.revision::text;
  return 'https://flow.ikisai.com/recorridos/carta?invitacion=' || v_msg || '.' || flow.hmac_sha256_hex(v_msg, v_key);
end $$;
