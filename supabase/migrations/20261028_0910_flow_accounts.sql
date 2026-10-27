-- Ikisai Flow · cuenta del cliente (encargo de VG del 27-10, paso 4; modelo aprobado por Core). Para la v2 y las siguientes.
-- - Cuentas: se abren a nombre de alguien (o de un número de cliente), los pedidos se cargan «a cuenta» (`pay_method`
--   'account': número de cobro y unidades como siempre, sin dinero) y se liquidan con un pago único (efectivo, Bizum o
--   tarjeta) por el owner o quien la abrió. Mientras está abierta, sus pedidos no se corrigen ni se anulan (ACCOUNT_OPEN).
-- - Resumen del día: lo cargado a cuenta cuenta el día en que se liquida; con la v1 el resultado es el mismo.
-- - Huéspedes (decisión técnica (c) de Core): el owner da número a los huéspedes del evento (clientes de origen 'guest',
--   idempotente); Guests lee `flow.portal_customer` (número, enlace firmado a la carta y si tiene cuenta abierta) y la carta
--   canjea el enlace (POST public/invitation) rotando el token del cliente por el lote público. Caduca a los 10 minutos.
-- La v1 no cambia: no lleva `accounts` en su columna de caja, y sus procedimientos solo se envuelven.

-- ---------------------------------------------------------------------------
-- Plantilla: la caja de la v2 lleva cuentas
-- ---------------------------------------------------------------------------
insert into flow.template_column_patches (template_key, min_version, column_key, config_patch) values
  ('barra', 2, 'order', '{"accounts": true}'::jsonb);

-- ---------------------------------------------------------------------------
-- Clientes: origen (web o huésped), el huésped de Booking y un nombre corto para la caja
-- ---------------------------------------------------------------------------
alter table flow.customers add column origin text not null default 'web' check (origin in ('web','guest'));
alter table flow.customers add column guest_id uuid;
alter table flow.customers add column display_name text check (display_name is null or length(display_name) between 1 and 80);
alter table flow.customers add constraint customers_guest_check check ((origin = 'guest') = (guest_id is not null));
create unique index customers_guest_uidx on flow.customers (project_id, guest_id) where guest_id is not null;
create index customers_guest_idx on flow.customers (guest_id) where guest_id is not null;
select core.register_table('flow', 'flow', 'customers', array['project_id','number','token_hash','origin','guest_id','display_name'], '{reader,editor,owner,outsider}', '{editor,owner}', true);

-- ---------------------------------------------------------------------------
-- Cuentas
-- ---------------------------------------------------------------------------
create table flow.accounts (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  project_id uuid not null references flow.projects(id),
  customer_id uuid references flow.customers(id),
  holder text not null check (length(holder) between 1 and 80),
  status text not null default 'open' check (status in ('open','settled')),
  opened_by uuid references auth.users(id),
  settled_at timestamptz,
  settled_by uuid references auth.users(id),
  payment_id uuid,
  check ((status = 'settled') = (settled_at is not null))
);
create index accounts_project_idx on flow.accounts (project_id);
create unique index accounts_open_customer_uidx on flow.accounts (customer_id) where status = 'open' and deleted_at is null and customer_id is not null;
select core.register_table('flow', 'flow', 'accounts', array['project_id','customer_id','holder','status','opened_by','settled_at','settled_by','payment_id'], '{reader,editor,owner,outsider}', '{editor,owner}', true);
create trigger flow_guard before insert or update on flow.accounts for each row execute function flow.guard();
create trigger flow_scope before insert or update on flow.accounts for each row execute function flow.guard_scope();

-- Pedidos: a cuenta. Pagos: la liquidación es un pago de la cuenta, sin pedido; también con tarjeta.
alter table flow.orders drop constraint orders_pay_method_check;
alter table flow.orders add constraint orders_pay_method_check check (pay_method is null or pay_method in ('cash','bizum','account'));
alter table flow.orders add column account_id uuid references flow.accounts(id);
alter table flow.orders add constraint orders_account_check check ((pay_method = 'account') = (account_id is not null));
create index orders_account_idx on flow.orders (account_id) where account_id is not null;
select core.register_table('flow', 'flow', 'orders', array['project_id','origin','notes','customer_id','parent_id','status','pay_seq','paid_at','paid_by','pay_method','total_cents','delivered_at','delivered_by','delivery_ident','delivery_exception','account_id'], '{reader,editor,owner,outsider}', '{editor,owner}', true);

alter table flow.payments drop constraint payments_method_check;
alter table flow.payments add constraint payments_method_check check (method is null or method in ('cash','bizum','card'));
alter table flow.payments add column account_id uuid references flow.accounts(id);
alter table flow.payments alter column order_id drop not null;
alter table flow.payments add constraint payments_owner_check check (order_id is not null or account_id is not null);
select core.register_table('flow', 'flow', 'payments', array['order_id','kind','method','amount_cents','note','settled_at','settled_by','account_id'], '{reader,editor,owner,outsider}', '{editor,owner}', true);

-- El proyecto de un pago sin pedido es el de su cuenta (el resto, como en la 0902).
create or replace function flow.fill_project_id() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'order_lines' then
    select project_id into new.project_id from flow.orders where id = new.order_id;
  elsif tg_table_name = 'payments' then
    if new.order_id is not null then
      select project_id into new.project_id from flow.orders where id = new.order_id;
    else
      select project_id into new.project_id from flow.accounts where id = new.account_id;
    end if;
  elsif tg_table_name = 'product_components' then
    select project_id into new.project_id from flow.products where id = new.product_id;
  end if;
  return new;
end $$;

alter table flow.events drop constraint events_kind_check;
alter table flow.events add constraint events_kind_check check (kind in ('paid','payment_reversed','order_adjusted','units_cancelled','unit_reverted',
  'delivered','order_reopened','extension_created','refund_settled','public_order','stock_moved','stock_reverted','tasks_generated',
  'account_opened','account_settled','guest_numbers'));

-- ---------------------------------------------------------------------------
-- Guarda (sustituye a la de la 0901): cuentas solo por procedimiento; `account_id` de pedido, también; en el lote público,
-- los clientes nuevos son de origen 'web' y un cliente de huésped solo cambia su token (canje de invitación).
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
      if tg_op = 'INSERT' and new.origin = 'web' and new.guest_id is null and new.display_name is null then return new; end if;
      -- Canje de una invitación (0910): solo cambiar el token de un cliente de huésped.
      if tg_op = 'UPDATE' and old.origin = 'guest' and not flow.changed(v_old, v_new, array['project_id','number','origin','guest_id','display_name','deleted_at']) then return new; end if;
    elsif tg_table_name = 'orders' then
      if tg_op = 'INSERT' and new.status = 'open' and new.origin = 'public' and new.customer_id is not null and new.parent_id is null
         and new.pay_seq is null and new.paid_at is null and new.total_cents is null and not new.delivery_exception and new.account_id is null then
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
                              or new.delivery_exception or new.parent_id is not null or new.account_id is not null))
       or (tg_op = 'UPDATE' and flow.changed(v_old, v_new, array['status','pay_seq','paid_at','paid_by','pay_method','total_cents','delivered_at','delivered_by','delivery_ident','delivery_exception','project_id','parent_id','account_id'])) then
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
  elsif tg_table_name in ('payments','events','customers','accounts') then
    perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.' || tg_table_name));
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Procedimientos
-- ---------------------------------------------------------------------------
/** ¿La caja de este proyecto lleva cuentas? (config `accounts` de la columna `order`; la v1 no). */
create or replace function flow.accounts_enabled(p_project uuid) returns boolean language sql stable as $$
  select exists (select 1 from flow.columns where project_id = p_project and key = 'order' and deleted_at is null
                   and coalesce((config->>'accounts')::boolean, false))
$$;

-- Abrir una cuenta. args = { project_id, holder?, customer_number?, account_id? }: a nombre de alguien o de un número de
-- cliente (si no se da nombre, el del cliente o «Cliente N»). Un cliente solo tiene una cuenta abierta.
create or replace function flow.open_account(p jsonb) returns jsonb language plpgsql as $$
declare
  v_project uuid := flow.arg_uuid(p, 'project_id'); v_holder text := btrim(coalesce(p->'args'->>'holder', '')); v_num int;
  v_c flow.customers; v_open uuid; v_id uuid;
begin
  perform flow.proc_begin();
  perform flow.check_scope(p, v_project);
  if not flow.accounts_enabled(v_project) then perform core.fail('ACCOUNTS_DISABLED', 409, jsonb_build_object('project_id', v_project)); end if;
  if coalesce(p->'args'->>'customer_number', '') <> '' then
    begin v_num := (p->'args'->>'customer_number')::int; exception when others then v_num := null; end;
    select * into v_c from flow.customers where project_id = v_project and number = v_num and deleted_at is null;
    if v_c.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.customers', 'number', p->'args'->>'customer_number')); end if;
    select id into v_open from flow.accounts where customer_id = v_c.id and status = 'open' and deleted_at is null;
    if v_open is not null then perform core.fail('ACCOUNT_ALREADY_OPEN', 409, jsonb_build_object('account_id', v_open, 'number', v_c.number)); end if;
    if v_holder = '' then v_holder := coalesce(v_c.display_name, 'Cliente ' || v_c.number); end if;
  end if;
  if v_holder = '' or length(v_holder) > 80 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'holder must be 1..80 characters')); end if;
  v_id := case when coalesce(p->'args'->>'account_id', '') <> '' then flow.arg_uuid(p, 'account_id') else gen_random_uuid() end;
  perform flow.ins(p, 'flow.accounts', jsonb_build_object('project_id', v_project, 'customer_id', v_c.id, 'holder', v_holder, 'status', 'open',
    'opened_by', (p->>'actor')::uuid), v_id);
  perform flow.log(p, v_project, 'account_opened', null, null, jsonb_build_object('accountId', v_id, 'holder', v_holder, 'customerNumber', v_c.number));
  perform flow.proc_end();
  return jsonb_build_object('account_id', v_id, 'holder', v_holder, 'customer_id', v_c.id, 'number', v_c.number);
end $$;

-- Cargar un pedido abierto a una cuenta abierta: como confirm_payment (precio cerrado, número de cobro y unidades), sin
-- dinero. args = { order_id, account_id, expected_revision }
create or replace function flow.charge_to_account(p jsonb) returns jsonb language plpgsql as $$
declare v_order flow.orders; v_a flow.accounts; v_line record; v_total int := 0; v_seq int; v_units int := 0;
begin
  perform flow.proc_begin();
  if p->'args'->>'expected_revision' is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'expected_revision required')); end if;
  v_order := flow.lock_order(p);
  select * into v_a from flow.accounts where id = flow.arg_uuid(p, 'account_id') for update;
  if v_a.id is null or v_a.deleted_at is not null or v_a.project_id <> v_order.project_id then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.accounts', 'id', p->'args'->>'account_id'));
  end if;
  if v_a.status <> 'open' then perform core.fail('ACCOUNT_NOT_OPEN', 409, jsonb_build_object('account_id', v_a.id, 'status', v_a.status)); end if;
  if not flow.accounts_enabled(v_order.project_id) then perform core.fail('ACCOUNTS_DISABLED', 409, jsonb_build_object('project_id', v_order.project_id)); end if;
  if v_order.status <> 'open' then perform core.fail('ORDER_NOT_OPEN', 409, jsonb_build_object('order_id', v_order.id, 'status', v_order.status, 'paySeq', v_order.pay_seq)); end if;
  if not exists (select 1 from flow.order_lines where order_id = v_order.id and deleted_at is null) then
    perform core.fail('ORDER_EMPTY', 422, jsonb_build_object('order_id', v_order.id));
  end if;
  for v_line in
    select l.id, l.revision, l.quantity, pr.id as product_id, pr.price_cents, pr.active, pr.deleted_at, pr.name, pr.scope, pr.code
      from flow.order_lines l join flow.products pr on pr.id = l.product_id
     where l.order_id = v_order.id and l.deleted_at is null order by l.position, l.created_at, l.id
  loop
    if not v_line.active or v_line.deleted_at is not null then
      perform core.fail('PRODUCT_INACTIVE', 422, jsonb_build_object('product_id', v_line.product_id, 'scope', v_line.scope, 'code', v_line.code, 'name', v_line.name));
    end if;
    perform flow.upd(p, 'flow.order_lines', v_line.id, v_line.revision, jsonb_build_object('unit_price_cents', v_line.price_cents));
    v_total := v_total + v_line.quantity * v_line.price_cents;
  end loop;

  select coalesce(max((data->>'paySeq')::int), 0) + 1 into v_seq from flow.events where project_id = v_order.project_id and kind = 'paid';
  perform flow.upd(p, 'flow.orders', v_order.id, v_order.revision, jsonb_build_object('status', 'paid', 'pay_seq', v_seq, 'paid_at', now(),
    'paid_by', (p->>'actor')::uuid, 'pay_method', 'account', 'account_id', v_a.id, 'total_cents', v_total));
  for v_line in
    select l.id, l.quantity, l.product_id from flow.order_lines l join flow.products pr on pr.id = l.product_id
     where l.order_id = v_order.id and l.deleted_at is null and pr.prepared order by l.position, l.created_at, l.id
  loop
    v_units := v_units + flow.add_units(p, v_order, v_line.id, v_line.product_id, v_line.quantity, v_seq);
  end loop;
  -- Evento 'paid' con método 'account': la secuencia de cobro es una sola (confirm_payment la sigue sin cambios).
  perform flow.log(p, v_order.project_id, 'paid', v_order.id, null, jsonb_build_object('paySeq', v_seq, 'method', 'account', 'accountId', v_a.id, 'holder', v_a.holder,
    'totalCents', v_total, 'units', v_units));
  perform flow.proc_end();
  return jsonb_build_object('order_id', v_order.id, 'account_id', v_a.id, 'pay_seq', v_seq, 'total_cents', v_total, 'units', v_units);
end $$;

-- Liquidar una cuenta: un pago único por la suma de sus pedidos vivos. Owner o quien la abrió.
-- args = { account_id, method: 'cash'|'bizum'|'card', expected_revision? }
create or replace function flow.settle_account(p jsonb) returns jsonb language plpgsql as $$
declare v_a flow.accounts; v_method text := p->'args'->>'method'; v_total int; v_n int; v_pay uuid; v_expected bigint := (p->'args'->>'expected_revision')::bigint;
begin
  perform flow.proc_begin();
  select * into v_a from flow.accounts where id = flow.arg_uuid(p, 'account_id') for update;
  if v_a.id is null or v_a.deleted_at is not null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.accounts', 'id', p->'args'->>'account_id')); end if;
  perform flow.check_scope(p, v_a.project_id);
  if v_expected is not null and v_expected <> v_a.revision then
    perform core.fail('VERSION_CONFLICT', 409, jsonb_build_object('table', 'flow.accounts', 'id', v_a.id, 'expectedRevision', v_expected, 'currentRevision', v_a.revision, 'current', to_jsonb(v_a)));
  end if;
  if v_a.status <> 'open' then perform core.fail('ACCOUNT_NOT_OPEN', 409, jsonb_build_object('account_id', v_a.id, 'status', v_a.status)); end if;
  if p->>'role' <> 'owner' and v_a.opened_by is distinct from (p->>'actor')::uuid then
    perform core.fail('SETTLE_FORBIDDEN', 403, jsonb_build_object('account_id', v_a.id, 'openedBy', v_a.opened_by));
  end if;
  if v_method is null or v_method not in ('cash','bizum','card') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'method must be cash, bizum or card')); end if;
  select coalesce(sum(total_cents), 0), count(*) into v_total, v_n from flow.orders where account_id = v_a.id and deleted_at is null and status in ('paid','delivered');
  if v_total > 0 then
    v_pay := flow.ins(p, 'flow.payments', jsonb_build_object('account_id', v_a.id, 'kind', 'charge', 'method', v_method, 'amount_cents', v_total,
      'note', left('Cuenta: ' || v_a.holder, 300)));
  end if;
  perform flow.upd(p, 'flow.accounts', v_a.id, v_a.revision, jsonb_build_object('status', 'settled', 'settled_at', now(), 'settled_by', (p->>'actor')::uuid, 'payment_id', v_pay));
  perform flow.log(p, v_a.project_id, 'account_settled', null, null, jsonb_build_object('accountId', v_a.id, 'holder', v_a.holder, 'method', v_method,
    'totalCents', v_total, 'orders', v_n, 'paymentId', v_pay));
  perform flow.proc_end();
  return jsonb_build_object('account_id', v_a.id, 'total_cents', v_total, 'orders', v_n, 'payment_id', v_pay);
end $$;

-- Pedidos a cuenta: con la cuenta abierta no se corrigen ni se anulan; liquidada, se corrigen (la diferencia es una
-- devolución, como siempre) pero no se anulan, porque su dinero está en el pago de la cuenta.
create or replace function flow.check_account_order(p jsonb, p_reverse boolean) returns void language plpgsql as $$
declare v_a flow.accounts;
begin
  select a.* into v_a from flow.orders o join flow.accounts a on a.id = o.account_id where o.id = flow.arg_uuid(p, 'order_id');
  if v_a.id is null then return; end if;
  if v_a.status = 'open' then perform core.fail('ACCOUNT_OPEN', 409, jsonb_build_object('account_id', v_a.id, 'holder', v_a.holder)); end if;
  if p_reverse then perform core.fail('ACCOUNT_SETTLED', 409, jsonb_build_object('account_id', v_a.id, 'reason', 'reduce the order instead')); end if;
end $$;
alter function flow.adjust_paid_order(jsonb) rename to adjust_paid_order_v1;
alter function flow.reverse_payment(jsonb) rename to reverse_payment_v1;
create or replace function flow.adjust_paid_order(p jsonb) returns jsonb language plpgsql as $$
begin
  perform flow.check_account_order(p, false);
  return flow.adjust_paid_order_v1(p);
end $$;
create or replace function flow.reverse_payment(p jsonb) returns jsonb language plpgsql as $$
begin
  perform flow.check_account_order(p, true);
  return flow.reverse_payment_v1(p);
end $$;

-- Dar número a los huéspedes del evento (lo que la app lee de booking.flow_guests_projection). Solo el owner; idempotente:
-- el mismo huésped conserva su número y solo se actualiza su nombre corto. args = { project_id, guests: [{ guest_id, display_name }] }
create or replace function flow.assign_guest_numbers(p jsonb) returns jsonb language plpgsql as $$
declare v_project uuid := flow.arg_uuid(p, 'project_id'); v_g jsonb; v_guest uuid; v_name text; v_c flow.customers; v_created int := 0; v_updated int := 0;
begin
  perform flow.proc_begin();
  if p->>'role' <> 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'guest numbers are for the owner')); end if;
  perform flow.check_scope(p, v_project); -- hoy siempre owner (pasa); por coherencia con los demás procedimientos
  if not exists (select 1 from flow.projects where id = v_project and deleted_at is null) then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.projects', 'id', v_project));
  end if;
  if jsonb_typeof(p->'args'->'guests') <> 'array' or jsonb_array_length(p->'args'->'guests') > 1000 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'guests must be an array of up to 1000'));
  end if;
  for v_g in select * from jsonb_array_elements(p->'args'->'guests') loop
    begin v_guest := (v_g->>'guest_id')::uuid; exception when others then v_guest := null; end;
    if v_guest is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'guest_id must be a uuid')); end if;
    v_name := nullif(left(btrim(coalesce(v_g->>'display_name', '')), 80), '');
    select * into v_c from flow.customers where project_id = v_project and guest_id = v_guest for update;
    if v_c.id is null then
      -- Token al azar que nadie conoce: el huésped entra por su invitación, que lo rota.
      perform flow.ins(p, 'flow.customers', jsonb_build_object('project_id', v_project, 'origin', 'guest', 'guest_id', v_guest, 'display_name', v_name,
        'token_hash', encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex')));
      v_created := v_created + 1;
    elsif v_c.display_name is distinct from v_name then
      perform flow.upd(p, 'flow.customers', v_c.id, v_c.revision, jsonb_build_object('display_name', v_name));
      v_updated := v_updated + 1;
    end if;
  end loop;
  perform flow.log(p, v_project, 'guest_numbers', null, null, jsonb_build_object('created', v_created, 'updated', v_updated));
  perform flow.proc_end();
  return jsonb_build_object('created', v_created, 'updated', v_updated, 'customers', coalesce((
    select jsonb_agg(jsonb_build_object('guest_id', guest_id, 'number', number) order by number)
      from flow.customers where project_id = v_project and origin = 'guest' and deleted_at is null), '[]'::jsonb));
end $$;

select core.allow_procedure('flow', 'flow.open_account');
select core.allow_procedure('flow', 'flow.charge_to_account');
select core.allow_procedure('flow', 'flow.settle_account');
select core.allow_procedure('flow', 'flow.assign_guest_numbers');

-- ---------------------------------------------------------------------------
-- Resumen del día (sustituye a day_summary_v1 de la 0903; day_summary de la 0904 la envuelve igual). Lo cargado a cuenta
-- se vende el día en que se liquida; el pago de la cuenta entra en el dinero de ese día; `card` solo si lo hay.
-- ---------------------------------------------------------------------------
create or replace function flow.day_summary_v1(p_project uuid, p_day date) returns jsonb language sql stable as $$
  with pays as (
    select pa.*, o.pay_seq from flow.payments pa left join flow.orders o on o.id = pa.order_id
     where pa.project_id = p_project and pa.deleted_at is null and (pa.created_at at time zone 'Europe/Madrid')::date = p_day
  ),
  moved as (select * from pays where kind <> 'refund' or settled_at is not null),
  sold_orders as (
    -- Lo vendido a cuenta cuenta el día en que se liquida la cuenta (0910); lo demás, el día del cobro.
    select o.* from flow.orders o left join flow.accounts a on a.id = o.account_id
     where o.project_id = p_project and o.deleted_at is null and o.status in ('paid','delivered')
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

-- ---------------------------------------------------------------------------
-- Enlace del huésped a la carta (Guests). Clave en el Vault de Supabase (`flow_portal_key`, la crea Core con permiso de
-- VG); en las pruebas, `flow.portal_key` de la sesión; sin clave no hay enlace (Guests enseña solo el número).
-- ---------------------------------------------------------------------------
create or replace function flow.portal_key() returns text language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  if to_regclass('vault.decrypted_secrets') is not null then
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v using 'flow_portal_key';
  end if;
  return coalesce(nullif(v, ''), nullif(current_setting('flow.portal_key', true), ''));
end $$;

/** HMAC-SHA256 (RFC 2104) con sha256() de Postgres: no depende de pgcrypto (PGlite no la carga). Hex en minúsculas. */
create or replace function flow.hmac_sha256_hex(p_msg text, p_key text) returns text language plpgsql immutable as $$
declare k bytea := convert_to(p_key, 'UTF8'); ipad bytea; opad bytea; i int;
begin
  if length(k) > 64 then k := sha256(k); end if;
  k := k || decode(repeat('00', 64 - length(k)), 'hex');
  ipad := k; opad := k;
  for i in 0..63 loop
    ipad := set_byte(ipad, i, get_byte(k, i) # 54);
    opad := set_byte(opad, i, get_byte(k, i) # 92);
  end loop;
  return encode(sha256(opad || sha256(ipad || convert_to(p_msg, 'UTF8'))), 'hex');
end $$;

/** Guests: el número del huésped en la barra que atiende la carta, el enlace firmado para pedir desde su móvil (10 min)
    y si tiene cuenta abierta. args = { reservation_id, guest_id } (core.portal_in_scope). */
create or replace function flow.portal_customer(p jsonb) returns jsonb language plpgsql stable as $$
declare v_res uuid; v_guest uuid; v_c flow.customers; v_public boolean; v_key text; v_msg text; v_url text;
begin
  begin
    v_res := (p->'args'->>'reservation_id')::uuid; v_guest := (p->'args'->>'guest_id')::uuid;
  exception when others then v_res := null;
  end;
  if v_res is null or v_guest is null or not core.portal_in_scope('guests', (p->>'actor')::uuid, v_res, v_guest) then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'guest out of scope'));
  end if;
  select c.* into v_c from flow.customers c join flow.projects pr on pr.id = c.project_id
   where c.guest_id = v_guest and c.origin = 'guest' and c.deleted_at is null and pr.deleted_at is null and pr.status = 'active'
   order by pr.serves_public desc, c.created_at desc limit 1;
  if v_c.id is null then return jsonb_build_object('number', null, 'carta_url', null, 'account_open', false); end if;
  select serves_public into v_public from flow.projects where id = v_c.project_id;
  v_key := flow.portal_key();
  -- Solo enlaza a la carta si su barra es la que la atiende (los pedidos públicos van al proyecto del cliente).
  if v_key is not null and v_public then
    v_msg := v_c.id::text || '.' || (extract(epoch from now())::bigint + 600)::text;
    v_url := 'https://flow.ikisai.com/?invitacion=' || v_msg || '.' || flow.hmac_sha256_hex(v_msg, v_key);
  end if;
  return jsonb_build_object('number', v_c.number, 'carta_url', v_url,
    'account_open', exists (select 1 from flow.accounts where customer_id = v_c.id and status = 'open' and deleted_at is null));
end $$;
select core.allow_read('guests', 'flow.portal_customer', 'function', '{editor,owner}');

/** Canje (flow-api, POST public/invitation): valida firma y caducidad; devuelve el cliente de huésped para rotar su token.
    args = { invitation: '<customer_id>.<exp>.<firma>' } */
create or replace function flow.public_guest_link(p jsonb) returns jsonb language plpgsql stable as $$
declare v_parts text[] := string_to_array(coalesce(p->>'invitation', ''), '.'); v_id uuid; v_key text; v_c flow.customers;
begin
  if coalesce(array_length(v_parts, 1), 0) <> 3 or v_parts[2] !~ '^[0-9]{1,12}$' or v_parts[3] !~ '^[0-9a-f]{64}$' then return null; end if;
  begin v_id := v_parts[1]::uuid; exception when others then return null; end;
  v_key := flow.portal_key();
  if v_key is null or flow.hmac_sha256_hex(v_parts[1] || '.' || v_parts[2], v_key) <> v_parts[3] then return null; end if;
  if v_parts[2]::bigint < extract(epoch from now()) then return jsonb_build_object('expired', true); end if;
  select * into v_c from flow.customers where id = v_id and origin = 'guest' and deleted_at is null;
  if v_c.id is null then return null; end if;
  return jsonb_build_object('customerId', v_c.id, 'revision', v_c.revision, 'number', v_c.number);
end $$;
select core.allow_public_read('flow_guest_link', 'flow.public_guest_link');

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
revoke all on function flow.portal_key() from public, anon, authenticated;
