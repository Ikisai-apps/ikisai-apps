-- Ikisai Flow · caja profunda (VG 27-10, «C»; diseño aprobado por Core). Solo con `deep_checkout` en la config de Caja
-- (la v2 por plantilla; también las versiones ya creadas y no congeladas). La v1 no cambia.
-- - Ficha del cliente: todos sus pedidos; se pagan varios a la vez, en un solo justificante («unificar») o uno por pedido.
--   Cada pedido se sigue cobrando con su número de cobro y sus unidades (la cocina no cambia).
-- - Métodos: efectivo, Bizum, tarjeta (la app la deja deshabilitada), Bitcoin Lightning y on-chain (QR en la app; sin
--   conversión EUR→BTC: quien paga pone la cantidad). Las direcciones, en los ajustes del proyecto (solo owner las cambia).
-- - Justificantes (`flow.receipts`): «Enviar a Finance» manda ESE cobro como apunte fiscal (`nature: 'fiscal'`); el cierre
--   del día, que va como proceso, excluye lo ya enviado como fiscal (flow-api, con `flow.fiscal_of_day`).

insert into flow.template_column_patches (template_key, min_version, column_key, config_patch) values
  ('barra', 2, 'order', '{"deep_checkout": true}'::jsonb);
update flow.columns c set config = '{"deep_checkout": true}'::jsonb || c.config
  from flow.projects pr
 where pr.id = c.project_id and pr.deleted_at is null and not pr.frozen and pr.template_key = 'barra' and pr.template_version >= 2
   and c.key = 'order' and c.deleted_at is null;

alter table flow.orders drop constraint orders_pay_method_check;
alter table flow.orders add constraint orders_pay_method_check check (pay_method is null or pay_method in ('cash','bizum','account','card','btc_ln','btc_chain'));
alter table flow.payments drop constraint payments_method_check;
alter table flow.payments add constraint payments_method_check check (method is null or method in ('cash','bizum','card','btc_ln','btc_chain'));

-- ---------------------------------------------------------------------------
-- Ajustes del proyecto (direcciones de cobro con Bitcoin). Escribe el owner; leen editor y owner (la caja las enseña).
-- ---------------------------------------------------------------------------
create table flow.project_settings (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  project_id uuid not null references flow.projects(id),
  lightning_address text check (lightning_address is null or lightning_address ~* '^([a-z0-9._+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}|lnurl[0-9a-z]{20,1500})$'),
  bitcoin_address text check (bitcoin_address is null or bitcoin_address ~ '^(bc1[02-9ac-hj-np-z]{11,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$')
);
create unique index project_settings_project_uidx on flow.project_settings (project_id) where deleted_at is null;
select core.register_table('flow', 'flow', 'project_settings', array['project_id','lightning_address','bitcoin_address'], '{editor,owner}', '{owner}', true);
create trigger flow_scope before insert or update on flow.project_settings for each row execute function flow.guard_scope();

-- ---------------------------------------------------------------------------
-- Justificantes de cobro
-- ---------------------------------------------------------------------------
create table flow.receipts (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  project_id uuid not null references flow.projects(id),
  customer_id uuid references flow.customers(id),
  method text not null check (method in ('cash','bizum','card','btc_ln','btc_chain')),
  total_cents integer not null default 0 check (total_cents >= 0),
  order_ids uuid[] not null,
  issued_by uuid references auth.users(id),
  finance_status text check (finance_status is null or finance_status in ('sent','error')),
  finance_sent_at timestamptz,
  finance_result jsonb
);
create index receipts_project_idx on flow.receipts (project_id);
select core.register_table('flow', 'flow', 'receipts', array['project_id','customer_id','method','total_cents','order_ids','issued_by','finance_status','finance_sent_at','finance_result'], '{reader,editor,owner,outsider}', '{editor,owner}', true);
create trigger flow_guard before insert or update on flow.receipts for each row execute function flow.guard_marks();
create trigger flow_scope before insert or update on flow.receipts for each row execute function flow.guard_scope();

alter table flow.payments add column receipt_id uuid references flow.receipts(id);
select core.register_table('flow', 'flow', 'payments', array['order_id','kind','method','amount_cents','note','settled_at','settled_by','account_id','receipt_id'], '{reader,editor,owner,outsider}', '{editor,owner}', true);

/** Cobrar un pedido abierto (como confirm_payment, con cualquier método de la caja profunda y su justificante). */
create or replace function flow.charge_order(p jsonb, p_order flow.orders, p_method text, p_receipt uuid) returns jsonb language plpgsql as $$
declare v_line record; v_total int := 0; v_seq int; v_units int := 0;
begin
  if p_order.status <> 'open' then perform core.fail('ORDER_NOT_OPEN', 409, jsonb_build_object('order_id', p_order.id, 'status', p_order.status, 'paySeq', p_order.pay_seq)); end if;
  if not exists (select 1 from flow.order_lines where order_id = p_order.id and deleted_at is null) then
    perform core.fail('ORDER_EMPTY', 422, jsonb_build_object('order_id', p_order.id));
  end if;
  for v_line in
    select l.id, l.revision, l.quantity, pr.id as product_id, pr.price_cents, pr.active, pr.deleted_at, pr.name, pr.scope, pr.code
      from flow.order_lines l join flow.products pr on pr.id = l.product_id
     where l.order_id = p_order.id and l.deleted_at is null order by l.position, l.created_at, l.id
  loop
    if not v_line.active or v_line.deleted_at is not null then
      perform core.fail('PRODUCT_INACTIVE', 422, jsonb_build_object('product_id', v_line.product_id, 'scope', v_line.scope, 'code', v_line.code, 'name', v_line.name));
    end if;
    perform flow.upd(p, 'flow.order_lines', v_line.id, v_line.revision, jsonb_build_object('unit_price_cents', v_line.price_cents));
    v_total := v_total + v_line.quantity * v_line.price_cents;
  end loop;
  select coalesce(max((data->>'paySeq')::int), 0) + 1 into v_seq from flow.events where project_id = p_order.project_id and kind = 'paid';
  perform flow.upd(p, 'flow.orders', p_order.id, p_order.revision, jsonb_build_object('status', 'paid', 'pay_seq', v_seq, 'paid_at', now(),
    'paid_by', (p->>'actor')::uuid, 'pay_method', p_method, 'total_cents', v_total));
  perform flow.ins(p, 'flow.payments', jsonb_build_object('order_id', p_order.id, 'kind', 'charge', 'method', p_method, 'amount_cents', v_total, 'receipt_id', p_receipt));
  for v_line in
    select l.id, l.quantity, l.product_id from flow.order_lines l join flow.products pr on pr.id = l.product_id
     where l.order_id = p_order.id and l.deleted_at is null and pr.prepared order by l.position, l.created_at, l.id
  loop
    v_units := v_units + flow.add_units(p, p_order, v_line.id, v_line.product_id, v_line.quantity, v_seq);
  end loop;
  perform flow.log(p, p_order.project_id, 'paid', p_order.id, null, jsonb_build_object('paySeq', v_seq, 'method', p_method, 'totalCents', v_total, 'units', v_units, 'receiptId', p_receipt));
  return jsonb_build_object('order_id', p_order.id, 'pay_seq', v_seq, 'total_cents', v_total, 'units', v_units);
end $$;

-- Pagar varios pedidos abiertos a la vez. args = { order_ids, method, unify, revisions?: { <order_id>: revision } }
create or replace function flow.pay_orders(p jsonb) returns jsonb language plpgsql as $$
declare
  v_method text := p->'args'->>'method'; v_unify boolean := coalesce((p->'args'->>'unify')::boolean, false);
  v_ids uuid[]; v_id uuid; v_order flow.orders; v_project uuid; v_customer uuid; v_receipt uuid; v_out jsonb; v_charged jsonb := '[]'::jsonb;
  v_receipts jsonb := '[]'::jsonb; v_total int;
begin
  perform flow.proc_begin();
  if v_method is null or v_method not in ('cash','bizum','card','btc_ln','btc_chain') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'method must be cash, bizum, card, btc_ln or btc_chain'));
  end if;
  begin select array_agg(distinct x::uuid) into v_ids from jsonb_array_elements_text(p->'args'->'order_ids') x; exception when others then v_ids := null; end;
  if v_ids is null or array_length(v_ids, 1) is null or array_length(v_ids, 1) > 30 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'order_ids: 1 to 30 uuids'));
  end if;
  -- Todos del mismo flujo, en el ámbito, abiertos y con la revisión esperada si se da.
  foreach v_id in array v_ids loop
    v_order := flow.lock_order(jsonb_set(p, '{args}', jsonb_build_object('order_id', v_id, 'expected_revision', p->'args'->'revisions'->>(v_id::text))));
    if v_project is null then v_project := v_order.project_id; v_customer := v_order.customer_id;
    elsif v_project <> v_order.project_id then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'orders of one flow'));
    end if;
    if v_customer is distinct from v_order.customer_id then v_customer := null; end if;
    if v_order.status <> 'open' then perform core.fail('ORDER_NOT_OPEN', 409, jsonb_build_object('order_id', v_order.id, 'status', v_order.status)); end if;
  end loop;
  if not exists (select 1 from flow.columns where project_id = v_project and key = 'order' and deleted_at is null and coalesce((config->>'deep_checkout')::boolean, false)) then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'this flow charges with confirm_payment'));
  end if;
  if v_unify then
    v_receipt := flow.ins(p, 'flow.receipts', jsonb_build_object('project_id', v_project, 'customer_id', v_customer, 'method', v_method,
      'total_cents', 0, 'order_ids', to_jsonb(v_ids), 'issued_by', (p->>'actor')::uuid));
  end if;
  foreach v_id in array v_ids loop
    select * into v_order from flow.orders where id = v_id;
    if not v_unify then
      v_receipt := flow.ins(p, 'flow.receipts', jsonb_build_object('project_id', v_project, 'customer_id', v_order.customer_id, 'method', v_method,
        'total_cents', 0, 'order_ids', to_jsonb(array[v_id]), 'issued_by', (p->>'actor')::uuid));
    end if;
    v_out := flow.charge_order(p, v_order, v_method, v_receipt);
    v_charged := v_charged || (v_out || jsonb_build_object('receipt_id', v_receipt));
  end loop;
  -- Totales de los justificantes.
  for v_receipt in select distinct (x->>'receipt_id')::uuid from jsonb_array_elements(v_charged) x loop
    select coalesce(sum((x->>'total_cents')::int), 0) into v_total from jsonb_array_elements(v_charged) x where (x->>'receipt_id')::uuid = v_receipt;
    perform flow.upd(p, 'flow.receipts', v_receipt, (select revision from flow.receipts where id = v_receipt), jsonb_build_object('total_cents', v_total));
    v_receipts := v_receipts || jsonb_build_object('receipt_id', v_receipt, 'total_cents', v_total);
  end loop;
  perform flow.proc_end();
  return jsonb_build_object('orders', v_charged, 'receipts', v_receipts);
end $$;

-- El envío fiscal lo anota flow-api tras la respuesta de Finance, con el lote público del servidor (el navegador no puede
-- hacer lotes públicos): así nadie marca «enviado» un cobro que no ha ido, que si no saldría del cierre sin llegar a Finance.
-- En un lote público, de un justificante solo cambian sus campos de envío; nada más de él, nunca.
create or replace function flow.guard_receipts() returns trigger language plpgsql as $$
begin
  if flow.in_proc() then return new; end if;
  if core.is_public_batch() and tg_op = 'UPDATE'
     and not flow.changed(to_jsonb(old), to_jsonb(new), array['project_id','customer_id','method','total_cents','order_ids','issued_by','deleted_at'])
     and new.finance_status in ('sent','error') then
    return new;
  end if;
  perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.' || tg_table_name));
end $$;
drop trigger flow_guard on flow.receipts;
create trigger flow_guard before insert or update on flow.receipts for each row execute function flow.guard_receipts();
select core.allow_public_write('flow', 'flow.receipts');

select core.allow_procedure('flow', 'flow.pay_orders');
select core.allow_procedure('flow', 'flow.mark_receipt_sent');

-- Para flow-api: un justificante con lo necesario para Finance (en el ámbito). args = { id }
create or replace function flow.receipt_for_send(p jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('receipt', to_jsonb(r), 'project', jsonb_build_object('id', pr.id, 'name', pr.name, 'booking_event_id', pr.booking_event_id),
    'day', (r.created_at at time zone 'Europe/Madrid')::date,
    'detail', coalesce((select jsonb_agg(jsonb_build_object('code', p2.scope || ':' || p2.code, 'name', p2.name, 'quantity', l.quantity, 'amount_cents', l.quantity * coalesce(l.unit_price_cents, 0))
                         order by p2.scope, p2.code)
                          from flow.order_lines l join flow.products p2 on p2.id = l.product_id where l.order_id = any(r.order_ids) and l.deleted_at is null), '[]'::jsonb))
    from flow.receipts r join flow.projects pr on pr.id = r.project_id
   where r.id = (p->'args'->>'id')::uuid and r.deleted_at is null and flow.in_scope((p->>'actor')::uuid, r.project_id)
$$;
select core.allow_read('flow', 'flow.receipt_for_send', 'function', '{editor,owner}');

-- Lo ya enviado a Finance como fiscal en un día: el cierre (proceso) lo descuenta. args = { project_id, day }
create or replace function flow.fiscal_of_day(p jsonb) returns jsonb language sql stable as $$
  with r as (
    select * from flow.receipts where project_id = (p->'args'->>'project_id')::uuid and deleted_at is null and finance_status = 'sent'
       and (created_at at time zone 'Europe/Madrid')::date = (p->'args'->>'day')::date
  )
  select jsonb_build_object(
    'amount_cents', coalesce((select sum(total_cents) from r), 0),
    'methods', coalesce((select jsonb_object_agg(method, s) from (select method, sum(total_cents) as s from r group by method) m), '{}'::jsonb),
    'detail', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'units', units, 'amount_cents', amount)) from (
        select p2.scope || ':' || p2.code as code, sum(l.quantity)::int as units, sum(l.quantity * coalesce(l.unit_price_cents, 0))::int as amount
          from r, flow.order_lines l join flow.products p2 on p2.id = l.product_id
         where l.order_id = any(r.order_ids) and l.deleted_at is null group by 1) d), '[]'::jsonb))
$$;
select core.allow_read('flow', 'flow.fiscal_of_day', 'function', '{owner}');

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
