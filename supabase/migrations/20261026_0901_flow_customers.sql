-- Ikisai Flow · FLOW-DIR-001 (precisiones de VG del 26-10-2026; docs/flow/API.md §14).
-- Número de cliente anónimo, ampliaciones con su propia secuencia, cantidad entregada por línea, devoluciones pendientes
-- hasta confirmarlas y P-2 (owner o quien cobró mueven dinero hacia atrás). La 0900 no se toca.

-- ---------------------------------------------------------------------------
-- Clientes anónimos del servicio (§1): número corto para decir en barra y un token que solo vive en el navegador.
-- Aquí solo llega su SHA-256 (lo calcula flow-api): el token no pasa por core.changes ni por los recibos.
-- ---------------------------------------------------------------------------
create table flow.customers (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  project_id uuid not null references flow.projects(id),
  number integer not null check (number >= 100),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$')
);
create unique index customers_number_uidx on flow.customers (project_id, number);
create unique index customers_token_uidx on flow.customers (token_hash);

select core.register_table('flow', 'flow', 'customers', array['project_id','number','token_hash'], '{reader,editor,owner}', '{editor,owner}', true);

-- Número de cliente: lo asigna siempre el servidor, el siguiente del proyecto desde 100. Los lotes de la app van en serie
-- (app_state), los clientes nunca se borran (never_purge y la guarda), así que no hay colisiones ni números reutilizados.
create or replace function flow.assign_customer_number() returns trigger language plpgsql as $$
begin
  select greatest(coalesce(max(number), 99) + 1, 100) into new.number from flow.customers where project_id = new.project_id;
  return new;
end $$;
create trigger flow_customer_number before insert on flow.customers for each row execute function flow.assign_customer_number();

-- Escritura pública sin sesión (contrato de Core, migración core 0094): solo estas tablas, y lo que la guarda permite.
select core.allow_public_write('flow', 'flow.customers');
select core.allow_public_write('flow', 'flow.orders');
select core.allow_public_write('flow', 'flow.order_lines');

-- ---------------------------------------------------------------------------
-- Pedidos: cliente y ampliación. Líneas: cantidad entregada (sustituye al check de revisión). Pagos: devoluciones.
-- ---------------------------------------------------------------------------
alter table flow.orders add column customer_id uuid references flow.customers(id);
alter table flow.orders add column parent_id uuid references flow.orders(id);
alter table flow.orders add constraint orders_parent_not_self check (parent_id is null or parent_id <> id);
create index orders_customer_idx on flow.orders (customer_id);
create index orders_parent_idx on flow.orders (parent_id);

alter table flow.order_lines add column delivered_qty integer not null default 0;
alter table flow.order_lines add constraint order_lines_delivered_qty_check check (delivered_qty >= 0 and delivered_qty <= quantity);
alter table flow.order_lines drop column delivery_checked;

alter table flow.payments drop constraint payments_kind_check;
alter table flow.payments add constraint payments_kind_check check (kind in ('charge','reversal','adjustment','refund'));
alter table flow.payments add column settled_at timestamptz;
alter table flow.payments add column settled_by uuid references auth.users(id);

alter table flow.events drop constraint events_kind_check;
alter table flow.events add constraint events_kind_check check (kind in ('paid','payment_reversed','order_adjusted','units_cancelled','unit_reverted',
  'delivered','order_reopened','extension_created','refund_settled','public_order'));

-- Representaciones gráficas de cada producto (decisión de VG del 26-10): clave `<categoria>/<slug>` de
-- apps/flow/public/assets (icono.svg, medallon.svg, miniatura.webp, zoom.webp). Sin clave, medallón con el código.
alter table flow.products add column image_key text check (image_key is null or image_key ~ '^[a-z0-9-]+/[a-z0-9-]+$');
select core.register_table('flow', 'flow', 'products', array['project_id','scope','code','name','description','price_cents','active','prepared','position','image_key'], '{reader,editor,owner}', '{owner}', true);
update flow.products set image_key = 'montaditos/serrano' where id = '0f10a000-0000-4000-8000-000000000101';

select core.register_table('flow', 'flow', 'orders', array['project_id','origin','notes','customer_id','parent_id','status','pay_seq','paid_at','paid_by','pay_method','total_cents','delivered_at','delivered_by','delivery_ident','delivery_exception'], '{reader,editor,owner}', '{editor,owner}', true);
select core.register_table('flow', 'flow', 'order_lines', array['order_id','product_id','quantity','position','delivered_qty','unit_price_cents'], '{reader,editor,owner}', '{editor,owner}', true);
select core.register_table('flow', 'flow', 'payments', array['order_id','kind','method','amount_cents','note','settled_at','settled_by'], '{reader,editor,owner}', '{editor,owner}', true);

-- ---------------------------------------------------------------------------
-- Guarda (sustituye a la de la 0900): además, clientes y ampliaciones solo por procedimiento; con el pedido cobrado el
-- cliente solo cambia `delivered_qty`.
-- ---------------------------------------------------------------------------
create or replace function flow.guard() returns trigger language plpgsql as $$
declare v_new jsonb := to_jsonb(new); v_old jsonb; v_status text;
begin
  if flow.in_proc() then return new; end if;
  if tg_op = 'UPDATE' then v_old := to_jsonb(old); end if;
  -- Lote público (carta, sin sesión): crear su cliente, crear su pedido abierto y poner líneas en un pedido público abierto.
  -- (Un `if` por tabla: PL/pgSQL resuelve `new.<campo>` aunque la condición anterior del `and` sea falsa.)
  if core.is_public_batch() then
    if tg_table_name = 'customers' then
      if tg_op = 'INSERT' then return new; end if;
    elsif tg_table_name = 'orders' then
      if tg_op = 'INSERT' and new.status = 'open' and new.origin = 'public' and new.customer_id is not null and new.parent_id is null
         and new.pay_seq is null and new.paid_at is null and new.total_cents is null and not new.delivery_exception then
        return new;
      end if;
    elsif tg_table_name = 'order_lines' then
      if new.unit_price_cents is null and new.delivered_qty = 0
         and exists (select 1 from flow.orders o where o.id = new.order_id and o.status = 'open' and o.origin = 'public' and o.deleted_at is null)
         -- Solo productos de la carta: activos y del mismo proyecto que el pedido.
         and exists (select 1 from flow.products pr join flow.orders o on o.id = new.order_id
                      where pr.id = new.product_id and pr.project_id = o.project_id and pr.active and pr.deleted_at is null)
         and (tg_op = 'INSERT' or not flow.changed(v_old, v_new, array['order_id'])) then
        return new;
      end if;
    end if;
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'public batch', 'table', 'flow.' || tg_table_name));
  end if;
  if tg_table_name = 'orders' then
    if (tg_op = 'INSERT' and (new.status <> 'open' or new.pay_seq is not null or new.paid_at is not null or new.total_cents is not null or new.delivered_at is not null
                              or new.delivery_exception or new.parent_id is not null))
       or (tg_op = 'UPDATE' and flow.changed(v_old, v_new, array['status','pay_seq','paid_at','paid_by','pay_method','total_cents','delivered_at','delivered_by','delivery_ident','delivery_exception','project_id','parent_id'])) then
      perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.orders'));
    end if;
    -- Un pedido cobrado no se borra ni cambia de origen o de cliente desde el cliente (§4.6).
    if tg_op = 'UPDATE' and old.status <> 'open' and flow.changed(v_old, v_new, array['deleted_at','origin','customer_id']) then
      perform core.fail('ORDER_NOT_OPEN', 409, jsonb_build_object('order_id', old.id, 'status', old.status));
    end if;
    if tg_op = 'UPDATE' and new.deleted_at is not null and old.deleted_at is null and exists (select 1 from flow.payments where order_id = old.id) then
      perform core.fail('ORDER_HAS_PAYMENTS', 409, jsonb_build_object('order_id', old.id));
    end if;
  elsif tg_table_name = 'order_lines' then
    select status into v_status from flow.orders where id = new.order_id;
    if (tg_op = 'INSERT' and new.unit_price_cents is not null) or (tg_op = 'UPDATE' and flow.changed(v_old, v_new, array['unit_price_cents','order_id'])) then
      perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.order_lines'));
    end if;
    if v_status <> 'open' and (tg_op = 'INSERT' or flow.changed(v_old, v_new, array['product_id','quantity','position','deleted_at'])) then
      perform core.fail('ORDER_NOT_OPEN', 409, jsonb_build_object('order_id', new.order_id, 'status', v_status));
    end if;
  elsif tg_table_name = 'units' then
    if tg_op = 'INSERT' and not (new.kind = 'task' and new.column_key = 'logistics' and new.status = 'pending' and new.order_id is null and new.line_id is null
                                 and new.product_id is null and new.assigned_to is null and new.done_at is null and new.done_by is null and new.pay_seq is null) then
      perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.units'));
    end if;
    if tg_op = 'UPDATE' and (old.kind <> 'task' or flow.changed(v_old, v_new, array['project_id','column_key','kind','order_id','line_id','product_id','idx','pay_seq','status','assigned_to','done_at','done_by'])) then
      perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.units'));
    end if;
  elsif tg_table_name in ('payments','events','customers') then
    perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.' || tg_table_name));
  end if;
  return new;
end $$;

create trigger flow_guard before insert or update on flow.customers for each row execute function flow.guard();

-- ---------------------------------------------------------------------------
-- P-2 (VG): mover dinero hacia atrás (anular, devolver, confirmar devolución) lo puede el owner o quien hizo el cobro.
-- ---------------------------------------------------------------------------
create or replace function flow.check_money_back(p jsonb, p_order flow.orders) returns void language plpgsql as $$
begin
  if p->>'role' = 'owner' then return; end if;
  if p_order.paid_by is not null and p_order.paid_by = (p->>'actor')::uuid then return; end if;
  perform core.fail('MONEY_BACK_FORBIDDEN', 403, jsonb_build_object('order_id', p_order.id, 'paidBy', p_order.paid_by));
end $$;

-- ---------------------------------------------------------------------------
-- Ampliación (§3): pedido hijo abierto, del mismo cliente. Al cobrarlo con confirm_payment recibe su propio número al
-- final de la cola y genera sus unidades; la secuencia del pedido original no cambia.
-- args = { parent_order_id, order_id (uuid del cliente), lines: [{ product_id, quantity }] }
-- ---------------------------------------------------------------------------
create or replace function flow.create_extension(p jsonb) returns jsonb language plpgsql as $$
declare v_parent flow.orders; v_id uuid := flow.arg_uuid(p, 'order_id'); v_item jsonb; v_product flow.products; v_pos int := 0; v_q int;
begin
  perform flow.proc_begin();
  select * into v_parent from flow.orders where id = flow.arg_uuid(p, 'parent_order_id') for update;
  if v_parent.id is null or v_parent.deleted_at is not null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.orders', 'id', p->'args'->>'parent_order_id')); end if;
  if v_parent.status = 'open' then perform core.fail('ORDER_NOT_PAID', 409, jsonb_build_object('order_id', v_parent.id, 'status', v_parent.status)); end if;
  if jsonb_typeof(p->'args'->'lines') <> 'array' or jsonb_array_length(p->'args'->'lines') = 0 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'lines required'));
  end if;
  perform flow.ins(p, 'flow.orders', jsonb_build_object('project_id', v_parent.project_id, 'origin', 'counter', 'customer_id', v_parent.customer_id, 'parent_id', v_parent.id), v_id);
  for v_item in select * from jsonb_array_elements(p->'args'->'lines') loop
    v_q := (v_item->>'quantity')::int;
    if v_q is null or v_q < 1 or v_q > 99 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'quantity must be 1..99')); end if;
    select * into v_product from flow.products where id = (v_item->>'product_id')::uuid;
    if v_product.id is null or v_product.project_id <> v_parent.project_id then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.products', 'id', v_item->>'product_id')); end if;
    if not v_product.active or v_product.deleted_at is not null then
      perform core.fail('PRODUCT_INACTIVE', 422, jsonb_build_object('product_id', v_product.id, 'scope', v_product.scope, 'code', v_product.code, 'name', v_product.name));
    end if;
    v_pos := v_pos + 1;
    perform flow.ins(p, 'flow.order_lines', jsonb_build_object('order_id', v_id, 'product_id', v_product.id, 'quantity', v_q, 'position', v_pos));
  end loop;
  perform flow.log(p, v_parent.project_id, 'extension_created', v_id, null, jsonb_build_object('parentOrderId', v_parent.id, 'parentPaySeq', v_parent.pay_seq, 'lines', p->'args'->'lines'));
  perform flow.proc_end();
  return jsonb_build_object('order_id', v_id, 'parent_order_id', v_parent.id);
end $$;

-- ---------------------------------------------------------------------------
-- Corrección de un pedido cobrado: SOLO REDUCE (lo añadido va por create_extension). Primero cancela unidades pendientes;
-- si tiene que tocar unidades en curso o terminadas, o cantidad ya entregada, pide confirmación (§3). La diferencia crea
-- una devolución PENDIENTE, que se cierra con confirm_refund cuando se ha devuelto de verdad.
-- args = { order_id, lines: [{ line_id, quantity }], method, confirm_started?, note?, expected_revision }
-- ---------------------------------------------------------------------------
create or replace function flow.adjust_paid_order(p jsonb) returns jsonb language plpgsql as $$
declare
  v_order flow.orders; v_item jsonb; v_line flow.order_lines; v_q int; v_pending int; v_started jsonb := '[]'::jsonb;
  v_diff int := 0; v_total int; v_changes jsonb := '[]'::jsonb; v_cancelled jsonb; v_all_cancelled jsonb := '[]'::jsonb;
  v_method text := p->'args'->>'method'; v_confirm boolean := coalesce((p->'args'->>'confirm_started')::boolean, false); v_refund uuid;
begin
  perform flow.proc_begin();
  if jsonb_typeof(p->'args'->'lines') <> 'array' or jsonb_array_length(p->'args'->'lines') = 0 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'lines required'));
  end if;
  v_order := flow.lock_order(p);
  if v_order.status not in ('paid','delivered') then perform core.fail('ORDER_NOT_PAID', 409, jsonb_build_object('order_id', v_order.id, 'status', v_order.status)); end if;
  perform flow.check_money_back(p, v_order);

  -- Primera pasada: validar y ver si la reducción toca trabajo empezado, hecho o entregado.
  for v_item in select * from jsonb_array_elements(p->'args'->'lines') loop
    v_q := (v_item->>'quantity')::int;
    if v_item->>'line_id' is null then perform core.fail('USE_EXTENSION', 422, jsonb_build_object('reason', 'new lines go in an extension')); end if;
    select * into v_line from flow.order_lines where id = (v_item->>'line_id')::uuid and order_id = v_order.id and deleted_at is null for update;
    if v_line.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.order_lines', 'id', v_item->>'line_id')); end if;
    if v_q is null or v_q < 0 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'quantity must be >= 0')); end if;
    if v_q > v_line.quantity then perform core.fail('USE_EXTENSION', 422, jsonb_build_object('reason', 'increases go in an extension', 'line_id', v_line.id)); end if;
    select count(*) into v_pending from flow.units where line_id = v_line.id and deleted_at is null and status = 'pending';
    if (v_line.quantity - v_q) > v_pending and exists (select 1 from flow.units where line_id = v_line.id and deleted_at is null) then
      v_started := v_started || jsonb_build_object('lineId', v_line.id, 'cancel', v_line.quantity - v_q, 'pending', v_pending,
        'units', (select coalesce(jsonb_agg(jsonb_build_object('unitId', u.id, 'status', u.status, 'assignedTo', u.assigned_to, 'doneBy', u.done_by) order by u.idx), '[]'::jsonb)
                    from flow.units u where u.line_id = v_line.id and u.deleted_at is null and u.status in ('in_progress','done')));
    end if;
    if v_q < v_line.delivered_qty then
      v_started := v_started || jsonb_build_object('lineId', v_line.id, 'deliveredQty', v_line.delivered_qty, 'to', v_q);
    end if;
  end loop;
  if jsonb_array_length(v_started) > 0 and not v_confirm then
    perform core.fail('REDUCTION_NEEDS_CONFIRMATION', 409, jsonb_build_object('order_id', v_order.id, 'affected', v_started));
  end if;

  -- Segunda pasada: aplicar.
  for v_item in select * from jsonb_array_elements(p->'args'->'lines') loop
    v_q := (v_item->>'quantity')::int;
    select * into v_line from flow.order_lines where id = (v_item->>'line_id')::uuid;
    if v_q = v_line.quantity then continue; end if;
    v_cancelled := flow.cancel_units(p, v_line.id, v_line.quantity - v_q);
    v_all_cancelled := v_all_cancelled || v_cancelled;
    v_diff := v_diff + (v_q - v_line.quantity) * v_line.unit_price_cents;
    if v_q = 0 then
      perform flow.row_op(p, jsonb_build_object('op', 'delete', 'table', 'flow.order_lines', 'id', v_line.id, 'expectedRevision', v_line.revision));
    else
      perform flow.upd(p, 'flow.order_lines', v_line.id, v_line.revision, jsonb_build_object('quantity', v_q, 'delivered_qty', least(v_line.delivered_qty, v_q)));
    end if;
    v_changes := v_changes || jsonb_build_object('lineId', v_line.id, 'productId', v_line.product_id, 'from', v_line.quantity, 'to', v_q, 'unitPriceCents', v_line.unit_price_cents);
  end loop;

  if jsonb_array_length(v_changes) = 0 then perform flow.proc_end(); return jsonb_build_object('order_id', v_order.id, 'diff_cents', 0, 'changed', false); end if;
  if v_diff <> 0 then
    if v_method is null or v_method not in ('cash','bizum') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'method required for the refund', 'diffCents', v_diff)); end if;
    v_refund := flow.ins(p, 'flow.payments', jsonb_build_object('order_id', v_order.id, 'kind', 'refund', 'method', v_method, 'amount_cents', v_diff, 'note', p->'args'->>'note'));
  end if;
  select coalesce(sum(quantity * unit_price_cents), 0) into v_total from flow.order_lines where order_id = v_order.id and deleted_at is null;
  perform flow.upd(p, 'flow.orders', v_order.id, v_order.revision, jsonb_build_object('total_cents', v_total));
  perform flow.log(p, v_order.project_id, 'order_adjusted', v_order.id, null, jsonb_build_object('paySeq', v_order.pay_seq, 'diffCents', v_diff, 'totalCents', v_total,
    'method', v_method, 'refundId', v_refund, 'confirmedStarted', v_confirm, 'lines', v_changes));
  if jsonb_array_length(v_all_cancelled) > 0 then
    perform flow.log(p, v_order.project_id, 'units_cancelled', v_order.id, null, jsonb_build_object('reason', 'adjust', 'units', v_all_cancelled));
  end if;
  perform flow.proc_end();
  return jsonb_build_object('order_id', v_order.id, 'diff_cents', v_diff, 'total_cents', v_total, 'changed', true, 'refund_id', v_refund, 'cancelled', jsonb_array_length(v_all_cancelled));
end $$;

-- Devolución hecha de verdad (§3): cierra un `refund` pendiente. args = { payment_id }
create or replace function flow.confirm_refund(p jsonb) returns jsonb language plpgsql as $$
declare v flow.payments; v_order flow.orders;
begin
  perform flow.proc_begin();
  select * into v from flow.payments where id = flow.arg_uuid(p, 'payment_id') for update;
  if v.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.payments', 'id', p->'args'->>'payment_id')); end if;
  if v.kind <> 'refund' or v.settled_at is not null then perform core.fail('REFUND_NOT_PENDING', 409, jsonb_build_object('payment_id', v.id, 'kind', v.kind, 'settledAt', v.settled_at)); end if;
  select * into v_order from flow.orders where id = v.order_id;
  perform flow.check_money_back(p, v_order);
  perform flow.upd(p, 'flow.payments', v.id, v.revision, jsonb_build_object('settled_at', now(), 'settled_by', (p->>'actor')::uuid));
  perform flow.log(p, v_order.project_id, 'refund_settled', v_order.id, null, jsonb_build_object('paymentId', v.id, 'amountCents', v.amount_cents, 'method', v.method));
  perform flow.proc_end();
  return jsonb_build_object('payment_id', v.id, 'order_id', v_order.id);
end $$;

-- Anular un cobro: como en la 0900, con P-2 (owner o quien cobró). El reversal se da por hecho al anotarlo.
create or replace function flow.reverse_payment(p jsonb) returns jsonb language plpgsql as $$
declare v_order flow.orders; v_net int; v_cancelled jsonb := '[]'::jsonb; v_unit flow.units;
begin
  perform flow.proc_begin();
  if coalesce(p->'args'->>'reason', '') = '' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'reason required')); end if;
  v_order := flow.lock_order(p);
  if v_order.status <> 'paid' then perform core.fail('ORDER_NOT_PAID', 409, jsonb_build_object('order_id', v_order.id, 'status', v_order.status)); end if;
  perform flow.check_money_back(p, v_order);
  select coalesce(sum(amount_cents), 0) into v_net from flow.payments where order_id = v_order.id and deleted_at is null;
  perform flow.ins(p, 'flow.payments', jsonb_build_object('order_id', v_order.id, 'kind', 'reversal', 'method', v_order.pay_method, 'amount_cents', -v_net,
    'note', p->'args'->>'reason', 'settled_at', now(), 'settled_by', (p->>'actor')::uuid));
  for v_unit in select * from flow.units where order_id = v_order.id and deleted_at is null and status in ('pending','in_progress') order by idx for update loop
    perform flow.upd(p, 'flow.units', v_unit.id, v_unit.revision, jsonb_build_object('status', 'cancelled'));
    v_cancelled := v_cancelled || jsonb_build_object('unitId', v_unit.id, 'idx', v_unit.idx, 'status', v_unit.status, 'assignedTo', v_unit.assigned_to);
  end loop;
  perform flow.upd(p, 'flow.orders', v_order.id, v_order.revision, jsonb_build_object('status', 'open', 'pay_seq', null, 'paid_at', null, 'paid_by', null,
    'pay_method', null, 'total_cents', null));
  perform flow.log(p, v_order.project_id, 'payment_reversed', v_order.id, null, jsonb_build_object('paySeq', v_order.pay_seq, 'paidAt', v_order.paid_at,
    'paidBy', v_order.paid_by, 'method', v_order.pay_method, 'amountCents', v_net, 'reason', p->'args'->>'reason', 'cancelledUnits', v_cancelled));
  perform flow.proc_end();
  return jsonb_build_object('order_id', v_order.id, 'reversed_cents', v_net, 'previous_pay_seq', v_order.pay_seq, 'cancelled', jsonb_array_length(v_cancelled));
end $$;

-- Entrega (§2): lo pendiente son las unidades sin terminar y las líneas con delivered_qty < quantity.
create or replace function flow.deliver_order(p jsonb) returns jsonb language plpgsql as $$
declare v_order flow.orders; v_ident text := p->'args'->>'ident'; v_pending int; v_undelivered int; v_exception boolean;
begin
  perform flow.proc_begin();
  if v_ident is null or v_ident not in ('number','qr','presence','skipped') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'ident must be number, qr, presence or skipped')); end if;
  v_order := flow.lock_order(p);
  if v_order.status = 'delivered' then perform core.fail('ORDER_ALREADY_DELIVERED', 409, jsonb_build_object('order_id', v_order.id)); end if;
  if v_order.status <> 'paid' then perform core.fail('ORDER_NOT_PAID', 409, jsonb_build_object('order_id', v_order.id, 'status', v_order.status)); end if;
  select count(*) into v_pending from flow.units where order_id = v_order.id and deleted_at is null and status in ('pending','in_progress');
  select coalesce(sum(quantity - delivered_qty), 0) into v_undelivered from flow.order_lines where order_id = v_order.id and deleted_at is null;
  v_exception := v_pending > 0 or v_undelivered > 0;
  if v_exception and coalesce((p->'args'->>'confirm_exception')::boolean, false) is not true then
    perform core.fail('DELIVERY_NEEDS_CONFIRMATION', 409, jsonb_build_object('order_id', v_order.id, 'pendingUnits', v_pending, 'undeliveredItems', v_undelivered));
  end if;
  perform flow.upd(p, 'flow.orders', v_order.id, v_order.revision, jsonb_build_object('status', 'delivered', 'delivered_at', now(),
    'delivered_by', (p->>'actor')::uuid, 'delivery_ident', v_ident, 'delivery_exception', v_exception));
  perform flow.log(p, v_order.project_id, 'delivered', v_order.id, null, jsonb_build_object('paySeq', v_order.pay_seq, 'ident', v_ident,
    'exception', v_exception, 'pendingUnits', v_pending, 'undeliveredItems', v_undelivered));
  perform flow.proc_end();
  return jsonb_build_object('order_id', v_order.id, 'exception', v_exception, 'pending_units', v_pending, 'undelivered_items', v_undelivered);
end $$;

-- ---------------------------------------------------------------------------
-- Lectura pública de lo propio (§1): flow-api resume el token de la cabecera X-Flow-Customer y llama a `flow_mine`.
-- ---------------------------------------------------------------------------
/** Lo que ve el cliente: solo sus pedidos, por su token resumido. Con el número solo no se ve nada. args = { token_hash } */
create or replace function flow.public_mine(p jsonb) returns jsonb language sql stable as $$
  with c as (select id, number, project_id from flow.customers where token_hash = p->>'token_hash' and deleted_at is null and (p->>'token_hash') ~ '^[0-9a-f]{64}$')
  select jsonb_build_object(
    'number', (select number from c),
    -- Para flow-api (validar el token y armar las operaciones); flow-api no los reenvía al navegador.
    'customerId', (select id from c), 'projectId', (select project_id from c),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id, 'createdAt', o.created_at, 'status', o.status, 'paySeq', o.pay_seq, 'totalCents', o.total_cents,
        'preparing', exists (select 1 from flow.units u where u.order_id = o.id and u.deleted_at is null and u.status in ('pending','in_progress')),
        'lines', (select coalesce(jsonb_agg(jsonb_build_object('productId', l.product_id, 'name', pr.name, 'scope', pr.scope, 'code', pr.code,
                    'quantity', l.quantity, 'deliveredQty', l.delivered_qty, 'prepared', pr.prepared,
                    'preparedQty', (select count(*) from flow.units u where u.line_id = l.id and u.deleted_at is null and u.status = 'done')) order by l.position), '[]'::jsonb)
                  from flow.order_lines l join flow.products pr on pr.id = l.product_id where l.order_id = o.id and l.deleted_at is null)
      ) order by o.created_at desc)
      from flow.orders o join c on c.id = o.customer_id where o.deleted_at is null), '[]'::jsonb))
$$;

-- La carta pública también dice el id del proyecto, para que flow-api cree el cliente en él (no lo reenvía al navegador).
create or replace function flow.public_menu(p jsonb) returns jsonb language sql stable as $$
  with project as (
    select id, name from flow.projects where deleted_at is null and status = 'active' order by created_at desc, id desc limit 1
  )
  select jsonb_build_object(
    'project', (select name from project),
    'projectId', (select id from project),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('id', pr.id, 'scope', pr.scope, 'code', pr.code, 'name', pr.name, 'description', pr.description,
               'priceCents', pr.price_cents, 'position', pr.position, 'imageKey', pr.image_key) order by pr.scope, pr.position, pr.code)
        from flow.products pr join project on project.id = pr.project_id
       where pr.deleted_at is null and pr.active), '[]'::jsonb))
$$;

select core.allow_public_read('flow_mine', 'flow.public_mine');
select core.allow_procedure('flow', 'flow.create_extension');
select core.allow_procedure('flow', 'flow.confirm_refund');

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
