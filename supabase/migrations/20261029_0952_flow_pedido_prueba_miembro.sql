-- Ikisai Flow · pedido de prueba de un miembro (por Core, 27-10; recomendación de vg-48, pendiente de VG). Con el núcleo 0115,
-- dirección y staff entran en ven.ikisai.com con su identidad (visitante atado a su cuenta) y pueden pedir desde la carta.
-- - Un pedido cuyo cliente tiene un visitante de un miembro (`core.visitor_member`) nace marcado: `test_by` (quién) y
--   `test_name` (su nombre, para el aviso «Pedido de prueba (nombre)»). Lo pone el servidor y no se puede cambiar.
-- - No cuenta en caja ni en Finance: el resumen del día (cierre, envío a Food y a Finance) y los indicadores de Central lo
--   dejan fuera. Se prepara y se entrega como cualquier otro, para probar el recorrido entero.
-- - «Mis pedidos» de la carta lo dice (`testName`). Toca solo el schema flow; lee del núcleo visitor_member y profiles.

alter table flow.orders add column test_by uuid references auth.users(id);
alter table flow.orders add column test_name text check (test_name is null or length(test_name) <= 80);

create or replace function flow.orders_member_test() returns trigger language plpgsql as $$
declare v_visitor uuid; v_user uuid;
begin
  if tg_op = 'UPDATE' then
    new.test_by := old.test_by; new.test_name := old.test_name;
    return new;
  end if;
  new.test_by := null; new.test_name := null;
  if new.customer_id is not null then
    select visitor_id into v_visitor from flow.customers where id = new.customer_id;
    if v_visitor is not null then v_user := core.visitor_member(v_visitor); end if;
  end if;
  -- Una ampliación hereda la marca de su pedido.
  if v_user is null and new.parent_id is not null then
    select test_by into v_user from flow.orders where id = new.parent_id;
  end if;
  if v_user is not null then
    new.test_by := v_user;
    new.test_name := coalesce(nullif(left((select display_name from core.profiles where user_id = v_user), 80), ''), 'Equipo');
  end if;
  return new;
end $$;
create trigger b_flow_orders_member_test before insert or update of test_by, test_name on flow.orders
  for each row execute function flow.orders_member_test();

create or replace function flow.day_summary_v1(p_project uuid, p_day date) returns jsonb language sql stable as $$
  with pays as (
    select pa.*, o.pay_seq from flow.payments pa left join flow.orders o on o.id = pa.order_id
     where pa.project_id = p_project and pa.deleted_at is null and (pa.created_at at time zone 'Europe/Madrid')::date = p_day
       and o.test_by is null -- los pedidos de prueba de un miembro no cuentan (0952); los pagos de cuenta no llevan pedido
  ),
  moved as (select * from pays where kind <> 'refund' or settled_at is not null),
  sold_orders as (
    -- Lo vendido a cuenta cuenta el día en que se liquida la cuenta (0910); lo demás, el día del cobro.
    select o.* from flow.orders o left join flow.accounts a on a.id = o.account_id
     where o.project_id = p_project and o.deleted_at is null and o.status in ('paid','delivered') and o.test_by is null
       and case when o.pay_method = 'account' then a.status = 'settled' and (a.settled_at at time zone 'Europe/Madrid')::date = p_day
                else (o.paid_at at time zone 'Europe/Madrid')::date = p_day end
  ),
  sold as (
    select pr.scope, pr.code, pr.name, pr.source_line_id, sum(l.quantity)::int as units, sum(l.quantity * coalesce(l.unit_price_cents, 0))::int as amount
      from flow.order_lines l join sold_orders o on o.id = l.order_id join flow.products pr on pr.id = l.product_id
     where l.deleted_at is null
     group by pr.scope, pr.code, pr.name, pr.source_line_id
  )
  select jsonb_build_object(
    'day', p_day,
    'orders', (select count(*) from sold_orders),
    'sales_cents', (select coalesce(sum(amount_cents), 0) from moved),
    'sales_by_method', jsonb_build_object(
      'cash', (select coalesce(sum(amount_cents), 0) from moved where method = 'cash'),
      'bizum', (select coalesce(sum(amount_cents), 0) from moved where method = 'bizum'))
      || case when exists (select 1 from moved where method = 'card') then jsonb_build_object('card', (select sum(amount_cents) from moved where method = 'card')) else '{}'::jsonb end,
    'reversals_cents', (select coalesce(sum(amount_cents), 0) from pays where kind = 'reversal'),
    'refunds_pending_cents', (select coalesce(-sum(amount_cents), 0) from pays where kind = 'refund' and settled_at is null),
    'units_by_product', coalesce((select jsonb_agg(jsonb_build_object('scope', scope, 'code', code, 'name', name, 'units', units, 'amount_cents', amount,
        'source_line_id', source_line_id) order by scope, code) from sold), '[]'::jsonb),
    'peak_hours', coalesce((select jsonb_agg(jsonb_build_object('hour', h, 'orders', n) order by h)
        from (select extract(hour from paid_at at time zone 'Europe/Madrid')::int as h, count(*)::int as n from sold_orders group by 1) x), '[]'::jsonb))
$$;

create or replace view flow.central_kpi_projection as
with today as (select (now() at time zone 'Europe/Madrid')::date as d),
live as (select id from flow.projects where deleted_at is null and status = 'active' and not test_mode),
moves as (
  -- Todos los pagos del flujo: de pedidos y de cuentas (lo que se salda a cuenta también es dinero movido).
  select p.project_id, (p.created_at at time zone 'Europe/Madrid')::date as day, p.amount_cents
    from flow.payments p left join flow.orders o on o.id = p.order_id
   where p.deleted_at is null and p.project_id in (select id from live) and o.test_by is null)
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
      (select count(*) from flow.orders o, today where o.deleted_at is null and o.status = 'paid' and o.test_by is null and o.project_id in (select id from live)
         and (o.paid_at at time zone 'Europe/Madrid')::date < today.d)::numeric, 'count', 'down'),
    ('flow.buffers_below_target', 'Existencias por debajo de su umbral',
      (select count(*) from flow.buffers b where b.deleted_at is null and b.capacity > 0 and b.project_id in (select id from live)
         and b.level < b.capacity * b.threshold_pct / 100.0)::numeric, 'count', 'down')
  ) as k(kpi, label, value, unit, direction);

create or replace function flow.public_mine(p jsonb) returns jsonb language sql stable as $$
  with c as (select id, number, project_id from flow.customers where token_hash = p->>'token_hash' and deleted_at is null and (p->>'token_hash') ~ '^[0-9a-f]{64}$')
  select jsonb_build_object(
    'number', (select number from c),
    -- Para flow-api (validar el token y armar las operaciones); flow-api no los reenvía al navegador.
    'customerId', (select id from c), 'projectId', (select project_id from c),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id, 'createdAt', o.created_at, 'status', o.status, 'testName', o.test_name, 'paySeq', o.pay_seq, 'totalCents', o.total_cents,
        'preparing', exists (select 1 from flow.units u where u.order_id = o.id and u.deleted_at is null and u.status in ('pending','in_progress')),
        'lines', (select coalesce(jsonb_agg(jsonb_build_object('productId', l.product_id, 'name', pr.name, 'scope', pr.scope, 'code', pr.code,
                    'quantity', l.quantity, 'deliveredQty', l.delivered_qty, 'prepared', pr.prepared,
                    'preparedQty', (select count(*) from flow.units u where u.line_id = l.id and u.deleted_at is null and u.status = 'done')) order by l.position), '[]'::jsonb)
                  from flow.order_lines l join flow.products pr on pr.id = l.product_id where l.order_id = o.id and l.deleted_at is null)
      ) order by o.created_at desc)
      from flow.orders o join c on c.id = o.customer_id where o.deleted_at is null), '[]'::jsonb))
$$;

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
