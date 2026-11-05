-- Flow 0964: el miembro elige en cada pedido de la carta si es una prueba (G-12 de Guests, decisión de VG del 05-11).
-- - `flow.orders.test_requested`: lo que marcó quien pide desde la carta. Solo cuenta si es un miembro (visitante atado a un
--   miembro del equipo); para cualquier otro, el disparador lo deja a null.
-- - Pedido de miembro: es de prueba (`test_excluded`, no cuenta en caja ni en Finance) si lo marcó. Si no viene la marca
--   (pedidos de antes o de otra vía), sigue la regla de 0953: es de prueba fuera del horario del evento.
-- - `flow.public_mine` dice `memberName` para que la carta enseñe la casilla «Es una prueba».

alter table flow.orders add column if not exists test_requested boolean;
select core.register_table('flow', 'flow', 'orders', array['project_id','origin','notes','customer_id','parent_id','status','pay_seq','paid_at','paid_by','pay_method','total_cents','delivered_at','delivered_by','delivery_ident','delivery_exception','account_id','test_requested'], '{reader,editor,owner,outsider}', '{editor,owner}', true);

create or replace function flow.orders_member_test() returns trigger language plpgsql as $$
declare v_visitor uuid; v_user uuid;
begin
  if tg_op = 'UPDATE' then
    new.test_by := old.test_by; new.test_name := old.test_name; new.test_excluded := old.test_excluded; new.test_requested := old.test_requested;
    return new;
  end if;
  new.test_by := null; new.test_name := null; new.test_excluded := false;
  if new.customer_id is not null then
    select visitor_id into v_visitor from flow.customers where id = new.customer_id;
    if v_visitor is not null then v_user := core.visitor_member(v_visitor); end if;
  end if;
  -- Una ampliación hereda la marca de su pedido.
  if v_user is null and new.parent_id is not null then
    select test_by, test_requested into v_user, new.test_requested from flow.orders where id = new.parent_id;
  end if;
  if v_user is not null then
    new.test_by := v_user;
    new.test_name := coalesce(nullif(left((select display_name from core.profiles where user_id = v_user), 80), ''), 'Equipo');
    new.test_excluded := coalesce(new.test_requested, not flow.in_event_window(new.project_id, now()));
  else
    new.test_requested := null;
  end if;
  return new;
end $$;
drop trigger if exists b_flow_orders_member_test on flow.orders;
create trigger b_flow_orders_member_test before insert or update of test_by, test_name, test_excluded, test_requested on flow.orders
  for each row execute function flow.orders_member_test();

create or replace function flow.public_mine(p jsonb) returns jsonb language sql stable as $$
  with c as (select id, number, project_id, visitor_id from flow.customers where token_hash = p->>'token_hash' and deleted_at is null and (p->>'token_hash') ~ '^[0-9a-f]{64}$')
  select jsonb_build_object(
    'number', (select number from c),
    -- Para flow-api (validar el token y armar las operaciones); flow-api no los reenvía al navegador.
    'customerId', (select id from c), 'projectId', (select project_id from c),
    -- Quien pide es del equipo (visitante atado a un miembro): la carta le deja marcar cada pedido como prueba (G-12, 0964).
    'memberName', (select coalesce(nullif(left(pf.display_name, 80), ''), 'Equipo') from c join core.profiles pf on pf.user_id = core.visitor_member(c.visitor_id) where c.visitor_id is not null),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id, 'createdAt', o.created_at, 'status', o.status, 'testName', o.test_name, 'testExcluded', o.test_excluded, 'paySeq', o.pay_seq, 'totalCents', o.total_cents,
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
