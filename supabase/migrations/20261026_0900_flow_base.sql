-- Ikisai Flow · modelo base (docs/flow/API.md, aprobado por Core el 26-10-2026).
-- Capa genérica (proyectos, columnas, unidades, eventos) y capa de barra (catálogo, pedidos, líneas, pagos).
-- Importes en céntimos. Estados y dinero solo cambian por procedimientos `call`; un trigger de guarda lo impide desde
-- el cliente (la marca de transacción `flow.proc` la ponen y quitan los procedimientos).

create schema if not exists flow;
revoke all on schema flow from public, anon, authenticated;
grant usage on schema flow to service_role;

-- ---------------------------------------------------------------------------
-- Capa genérica
-- ---------------------------------------------------------------------------
create table flow.projects (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  name text not null check (length(name) between 1 and 120),
  status text not null default 'active' check (status in ('active','closed')),
  notes text check (notes is null or length(notes) <= 1000),
  -- Último número de cobro (§4: el orden de trabajo es la secuencia de confirmación del pago). Solo lo sube confirm_payment.
  last_pay_seq integer not null default 0 check (last_pay_seq >= 0)
);

create table flow.columns (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  project_id uuid not null references flow.projects(id),
  key text not null check (key in ('order','prep','service','logistics')),
  label text not null check (length(label) between 1 and 60),
  behavior text not null check (behavior in ('inspect_confirm','quick_steps','free_task')),
  position integer not null default 0
);
create unique index columns_project_key_uidx on flow.columns (project_id, key) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Capa de barra: catálogo
-- ---------------------------------------------------------------------------
create table flow.products (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  project_id uuid not null references flow.projects(id),
  scope text not null check (scope in ('clasico','gourmet','barra')),
  code text not null check (code in ('A','B','C','D','α','β','γ','δ')),
  name text not null check (length(name) between 1 and 80),
  description text check (description is null or length(description) <= 300),
  price_cents integer not null check (price_cents >= 0 and price_cents <= 100000),
  active boolean not null default true,
  -- Montadito: cada uno es una unidad de Preparación. Bebidas y extras van en Servicio y entrega (§6).
  prepared boolean not null default false,
  position integer not null default 0
);
-- La letra sola nunca es clave (§8): única por proyecto y ámbito entre los productos vivos.
create unique index products_scope_code_uidx on flow.products (project_id, scope, code) where deleted_at is null;

create table flow.product_components (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  product_id uuid not null references flow.products(id),
  station integer not null check (station between 1 and 4),
  ingredient text not null check (length(ingredient) between 1 and 80),
  position integer not null default 0
);
create index product_components_product_idx on flow.product_components (product_id);

-- ---------------------------------------------------------------------------
-- Capa de barra: pedidos, líneas y pagos
-- ---------------------------------------------------------------------------
create table flow.orders (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  project_id uuid not null references flow.projects(id),
  origin text not null default 'counter' check (origin in ('public','counter')),
  status text not null default 'open' check (status in ('open','paid','delivered')),
  pay_seq integer check (pay_seq is null or pay_seq > 0),
  paid_at timestamptz,
  paid_by uuid references auth.users(id),
  pay_method text check (pay_method is null or pay_method in ('cash','bizum')),
  total_cents integer check (total_cents is null or total_cents >= 0),
  delivered_at timestamptz,
  delivered_by uuid references auth.users(id),
  delivery_ident text check (delivery_ident is null or delivery_ident in ('number','qr','presence','skipped')),
  delivery_exception boolean not null default false,
  notes text check (notes is null or length(notes) <= 500),
  check ((status = 'open') = (pay_seq is null)),
  check ((status = 'delivered') = (delivered_at is not null))
);
create unique index orders_pay_seq_uidx on flow.orders (project_id, pay_seq) where pay_seq is not null;
create index orders_project_idx on flow.orders (project_id, pay_seq);

create table flow.order_lines (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  order_id uuid not null references flow.orders(id),
  product_id uuid not null references flow.products(id),
  quantity integer not null check (quantity between 1 and 99),
  -- Precio cerrado al cobrar (§4, snapshot): el catálogo vigente no recalcula ventas cerradas.
  unit_price_cents integer check (unit_price_cents is null or unit_price_cents >= 0),
  position integer not null default 0,
  delivery_checked boolean not null default false
);
create index order_lines_order_idx on flow.order_lines (order_id);

-- Cobros y su historia (§4.6): se añaden, nunca se borran ni se reescriben.
create table flow.payments (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  order_id uuid not null references flow.orders(id),
  kind text not null check (kind in ('charge','reversal','adjustment')),
  method text check (method is null or method in ('cash','bizum')),
  amount_cents integer not null,
  note text check (note is null or length(note) <= 300)
);
create index payments_order_idx on flow.payments (order_id);

-- ---------------------------------------------------------------------------
-- Unidades de trabajo y eventos (capa genérica)
-- ---------------------------------------------------------------------------
create table flow.units (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  project_id uuid not null references flow.projects(id),
  column_key text not null check (column_key in ('order','prep','service','logistics')),
  kind text not null check (kind in ('prep','task')),
  order_id uuid references flow.orders(id),
  line_id uuid references flow.order_lines(id),
  product_id uuid references flow.products(id),
  idx integer not null default 0,
  pay_seq integer,
  label text check (label is null or length(label) between 1 and 120),
  priority boolean not null default false,
  status text not null default 'pending' check (status in ('pending','in_progress','done','cancelled')),
  assigned_to uuid references auth.users(id),
  done_at timestamptz,
  done_by uuid references auth.users(id),
  check (kind <> 'prep' or (order_id is not null and line_id is not null and product_id is not null and pay_seq is not null)),
  check (kind <> 'task' or label is not null),
  check ((status = 'done') = (done_at is not null))
);
-- Orden estable de Preparación: secuencia de pago y posición dentro del pedido (§5, §10.3).
create index units_column_idx on flow.units (project_id, column_key, pay_seq, idx);
create index units_order_idx on flow.units (order_id);

create table flow.events (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  project_id uuid not null references flow.projects(id),
  kind text not null check (kind in ('paid','payment_reversed','order_adjusted','units_cancelled','unit_reverted','delivered','order_reopened')),
  order_id uuid references flow.orders(id),
  unit_id uuid references flow.units(id),
  data jsonb not null default '{}'::jsonb,
  actor uuid references auth.users(id),
  at timestamptz not null default now()
);
create index events_project_idx on flow.events (project_id, at);

-- ---------------------------------------------------------------------------
-- Registro en el núcleo. Las columnas que solo escriben los procedimientos están en la lista (apply_row_op las exige),
-- y la guarda de abajo las cierra al cliente. Todas never_purge (llevan el dinero y su rastro) salvo `projects`, que es
-- también la tabla de muestra de la conformidad (purgar un proyecto con pedidos lo impiden sus FK).
-- ---------------------------------------------------------------------------
-- Editor en writable_roles solo para que confirm_payment suba last_pay_seq; fuera de los procedimientos, solo el owner (guarda).
select core.register_table('flow', 'flow', 'projects', array['name','status','notes','last_pay_seq'], '{reader,editor,owner}', '{editor,owner}', false);
select core.register_table('flow', 'flow', 'columns', array['project_id','key','label','behavior','position'], '{reader,editor,owner}', '{owner}', true);
select core.register_table('flow', 'flow', 'products', array['project_id','scope','code','name','description','price_cents','active','prepared','position'], '{reader,editor,owner}', '{owner}', true);
select core.register_table('flow', 'flow', 'product_components', array['product_id','station','ingredient','position'], '{reader,editor,owner}', '{owner}', true);
select core.register_table('flow', 'flow', 'orders', array['project_id','origin','notes','status','pay_seq','paid_at','paid_by','pay_method','total_cents','delivered_at','delivered_by','delivery_ident','delivery_exception'], '{reader,editor,owner}', '{editor,owner}', true);
select core.register_table('flow', 'flow', 'order_lines', array['order_id','product_id','quantity','position','delivery_checked','unit_price_cents'], '{reader,editor,owner}', '{editor,owner}', true);
select core.register_table('flow', 'flow', 'payments', array['order_id','kind','method','amount_cents','note'], '{reader,editor,owner}', '{editor,owner}', true);
select core.register_table('flow', 'flow', 'units', array['project_id','column_key','kind','order_id','line_id','product_id','idx','pay_seq','label','priority','status','assigned_to','done_at','done_by'], '{reader,editor,owner}', '{editor,owner}', true);
select core.register_table('flow', 'flow', 'events', array['project_id','kind','order_id','unit_id','data','actor','at'], '{reader,editor,owner}', '{editor,owner}', true);

-- ---------------------------------------------------------------------------
-- Guarda: lo que el cliente puede escribir directamente (insert/update/delete lógico/restore)
-- ---------------------------------------------------------------------------
create or replace function flow.in_proc() returns boolean language sql stable as $$
  select coalesce(current_setting('flow.proc', true), '') = 'on'
$$;

create or replace function flow.proc_begin() returns void language plpgsql as $$ begin perform set_config('flow.proc', 'on', true); end $$;
create or replace function flow.proc_end() returns void language plpgsql as $$ begin perform set_config('flow.proc', '', true); end $$;

/** ¿Cambia alguna de estas columnas entre old y new? */
create or replace function flow.changed(p_old jsonb, p_new jsonb, p_cols text[]) returns boolean language sql immutable as $$
  select exists (select 1 from unnest(p_cols) c where p_old->c is distinct from p_new->c)
$$;

create or replace function flow.guard() returns trigger language plpgsql as $$
declare v_new jsonb := to_jsonb(new); v_old jsonb; v_status text;
begin
  if flow.in_proc() then return new; end if;
  if tg_op = 'UPDATE' then v_old := to_jsonb(old); end if;
  if tg_table_name = 'projects' then
    if coalesce(current_setting('core.role', true), '') not in ('owner', '') then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'flow.projects'));
    end if;
    if (tg_op = 'INSERT' and new.last_pay_seq <> 0) or (tg_op = 'UPDATE' and new.last_pay_seq <> old.last_pay_seq) then
      perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.projects', 'field', 'last_pay_seq'));
    end if;
  elsif tg_table_name = 'orders' then
    if (tg_op = 'INSERT' and (new.status <> 'open' or new.pay_seq is not null or new.paid_at is not null or new.total_cents is not null or new.delivered_at is not null or new.delivery_exception))
       or (tg_op = 'UPDATE' and flow.changed(v_old, v_new, array['status','pay_seq','paid_at','paid_by','pay_method','total_cents','delivered_at','delivered_by','delivery_ident','delivery_exception','project_id'])) then
      perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.orders'));
    end if;
    -- Un pedido cobrado no se borra ni se cambia de origen desde el cliente (§4.6).
    if tg_op = 'UPDATE' and old.status <> 'open' and flow.changed(v_old, v_new, array['deleted_at','origin']) then
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
    -- Con el pedido cobrado, el cliente solo marca la revisión de entrega; corregir es adjust_paid_order (§4.5).
    if v_status <> 'open' and (tg_op = 'INSERT' or flow.changed(v_old, v_new, array['product_id','quantity','position','deleted_at'])) then
      perform core.fail('ORDER_NOT_OPEN', 409, jsonb_build_object('order_id', new.order_id, 'status', v_status));
    end if;
  elsif tg_table_name = 'units' then
    -- El cliente solo crea tareas de Logística pendientes y cambia su texto o prioridad; los toques van por unit_step.
    if tg_op = 'INSERT' and not (new.kind = 'task' and new.column_key = 'logistics' and new.status = 'pending' and new.order_id is null and new.line_id is null
                                 and new.product_id is null and new.assigned_to is null and new.done_at is null and new.done_by is null and new.pay_seq is null) then
      perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.units'));
    end if;
    if tg_op = 'UPDATE' and (old.kind <> 'task' or flow.changed(v_old, v_new, array['project_id','column_key','kind','order_id','line_id','product_id','idx','pay_seq','status','assigned_to','done_at','done_by'])) then
      perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.units'));
    end if;
  elsif tg_table_name in ('payments','events') then
    perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.' || tg_table_name));
  end if;
  return new;
end $$;

create trigger flow_guard before insert or update on flow.projects for each row execute function flow.guard();
create trigger flow_guard before insert or update on flow.orders for each row execute function flow.guard();
create trigger flow_guard before insert or update on flow.order_lines for each row execute function flow.guard();
create trigger flow_guard before insert or update on flow.units for each row execute function flow.guard();
create trigger flow_guard before insert or update on flow.payments for each row execute function flow.guard();
create trigger flow_guard before insert or update on flow.events for each row execute function flow.guard();

-- ---------------------------------------------------------------------------
-- Ayudantes de los procedimientos
-- ---------------------------------------------------------------------------
-- Anular un cobro o devolver dinero en un ajuste exige owner (P-2, pendiente de VG). Para relajarlo, devolver false.
create or replace function flow.money_back_requires_owner() returns boolean language sql immutable as $$ select true $$;

/** Una operación de fila con el contexto del `call` (p = { app, actor, role, requestId, cursor, args }). */
create or replace function flow.row_op(p jsonb, p_op jsonb) returns jsonb language sql as $$
  select core.apply_row_op(p->>'app', (p->>'actor')::uuid, p->>'role', p->>'requestId', (p->>'cursor')::bigint, p_op)
$$;

create or replace function flow.ins(p jsonb, p_table text, p_fields jsonb, p_id uuid default gen_random_uuid()) returns uuid language plpgsql as $$
begin
  perform flow.row_op(p, jsonb_build_object('op', 'insert', 'table', p_table, 'id', p_id, 'fields', p_fields));
  return p_id;
end $$;

create or replace function flow.upd(p jsonb, p_table text, p_id uuid, p_revision bigint, p_fields jsonb) returns void language plpgsql as $$
begin
  perform flow.row_op(p, jsonb_build_object('op', 'update', 'table', p_table, 'id', p_id, 'expectedRevision', p_revision, 'fields', p_fields));
end $$;

create or replace function flow.log(p jsonb, p_project uuid, p_kind text, p_order uuid, p_unit uuid, p_data jsonb) returns void language plpgsql as $$
begin
  perform flow.ins(p, 'flow.events', jsonb_build_object('project_id', p_project, 'kind', p_kind, 'order_id', p_order, 'unit_id', p_unit,
    'data', coalesce(p_data, '{}'::jsonb), 'actor', (p->>'actor')::uuid, 'at', now()));
end $$;

create or replace function flow.arg_uuid(p jsonb, p_name text) returns uuid language plpgsql as $$
declare v uuid;
begin
  begin v := (p->'args'->>p_name)::uuid; exception when others then v := null; end;
  if v is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', p_name || ' must be a uuid')); end if;
  return v;
end $$;

/** El pedido bloqueado, vivo y con la revisión esperada (si se da). */
create or replace function flow.lock_order(p jsonb) returns flow.orders language plpgsql as $$
declare v flow.orders; v_expected bigint := (p->'args'->>'expected_revision')::bigint;
begin
  select * into v from flow.orders where id = flow.arg_uuid(p, 'order_id') for update;
  if v.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.orders', 'id', p->'args'->>'order_id')); end if;
  if v.deleted_at is not null then perform core.fail('ROW_DELETED', 409, jsonb_build_object('table', 'flow.orders', 'id', v.id)); end if;
  if v_expected is not null and v_expected <> v.revision then
    perform core.fail('VERSION_CONFLICT', 409, jsonb_build_object('table', 'flow.orders', 'id', v.id, 'expectedRevision', v_expected, 'currentRevision', v.revision, 'current', to_jsonb(v)));
  end if;
  return v;
end $$;

/** Crea `p_count` unidades de preparación de una línea, al final del pedido. Devuelve cuántas creó. */
create or replace function flow.add_units(p jsonb, p_order flow.orders, p_line uuid, p_product uuid, p_count int, p_pay_seq int) returns int language plpgsql as $$
declare v_idx int; i int;
begin
  if p_count <= 0 then return 0; end if;
  select coalesce(max(idx), 0) into v_idx from flow.units where order_id = p_order.id;
  for i in 1..p_count loop
    perform flow.ins(p, 'flow.units', jsonb_build_object('project_id', p_order.project_id, 'column_key', 'prep', 'kind', 'prep', 'order_id', p_order.id,
      'line_id', p_line, 'product_id', p_product, 'idx', v_idx + i, 'pay_seq', p_pay_seq, 'status', 'pending'));
  end loop;
  return p_count;
end $$;

/** Cancela `p_count` unidades vivas de una línea: primero pendientes, luego en curso, luego terminadas; las últimas antes.
    Devuelve las canceladas con su estado anterior y quién las tenía o las había hecho (nota 4 de Core). */
create or replace function flow.cancel_units(p jsonb, p_line uuid, p_count int) returns jsonb language plpgsql as $$
declare v flow.units; v_out jsonb := '[]'::jsonb;
begin
  if p_count <= 0 then return v_out; end if;
  for v in select * from flow.units where line_id = p_line and deleted_at is null and status <> 'cancelled'
    order by case status when 'pending' then 0 when 'in_progress' then 1 else 2 end, idx desc limit p_count for update loop
    perform flow.upd(p, 'flow.units', v.id, v.revision, jsonb_build_object('status', 'cancelled', 'done_at', null));
    v_out := v_out || jsonb_build_object('unitId', v.id, 'idx', v.idx, 'status', v.status, 'assignedTo', v.assigned_to, 'doneBy', v.done_by, 'doneAt', v.done_at);
  end loop;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- Procedimientos (API.md §3)
-- ---------------------------------------------------------------------------

-- Cobro explícito (§4.4): precio cerrado, número de cobro nuevo y una unidad por montadito.
-- args = { order_id, method: 'cash'|'bizum', expected_revision }
create or replace function flow.confirm_payment(p jsonb) returns jsonb language plpgsql as $$
declare
  v_order flow.orders; v_project flow.projects; v_method text := p->'args'->>'method';
  v_line record; v_total int := 0; v_seq int; v_units int := 0;
begin
  perform flow.proc_begin();
  if v_method is null or v_method not in ('cash','bizum') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'method must be cash or bizum')); end if;
  if p->'args'->>'expected_revision' is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'expected_revision required')); end if;
  v_order := flow.lock_order(p);
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

  select * into v_project from flow.projects where id = v_order.project_id for update;
  v_seq := v_project.last_pay_seq + 1;
  perform flow.upd(p, 'flow.projects', v_project.id, v_project.revision, jsonb_build_object('last_pay_seq', v_seq));
  perform flow.upd(p, 'flow.orders', v_order.id, v_order.revision, jsonb_build_object('status', 'paid', 'pay_seq', v_seq, 'paid_at', now(),
    'paid_by', (p->>'actor')::uuid, 'pay_method', v_method, 'total_cents', v_total));
  perform flow.ins(p, 'flow.payments', jsonb_build_object('order_id', v_order.id, 'kind', 'charge', 'method', v_method, 'amount_cents', v_total));

  for v_line in
    select l.id, l.quantity, l.product_id from flow.order_lines l join flow.products pr on pr.id = l.product_id
     where l.order_id = v_order.id and l.deleted_at is null and pr.prepared order by l.position, l.created_at, l.id
  loop
    v_units := v_units + flow.add_units(p, v_order, v_line.id, v_line.product_id, v_line.quantity, v_seq);
  end loop;

  perform flow.log(p, v_order.project_id, 'paid', v_order.id, null, jsonb_build_object('paySeq', v_seq, 'method', v_method, 'totalCents', v_total, 'units', v_units));
  perform flow.proc_end();
  return jsonb_build_object('order_id', v_order.id, 'pay_seq', v_seq, 'total_cents', v_total, 'units', v_units);
end $$;

-- Corrección de un pedido cobrado (§4.5): solo las líneas que cambian; nunca regenera unidades (§10.3, §16).
-- args = { order_id, lines: [{ line_id?, product_id, quantity }], method?, note?, expected_revision }
-- `quantity` es la cantidad final de esa línea (0 la quita). Las líneas que no se mencionan no cambian.
create or replace function flow.adjust_paid_order(p jsonb) returns jsonb language plpgsql as $$
declare
  v_order flow.orders; v_item jsonb; v_line flow.order_lines; v_product flow.products; v_q int; v_line_id uuid;
  v_diff int := 0; v_total int; v_changes jsonb := '[]'::jsonb; v_cancelled jsonb; v_all_cancelled jsonb := '[]'::jsonb;
  v_method text := p->'args'->>'method'; v_pos int;
begin
  perform flow.proc_begin();
  if jsonb_typeof(p->'args'->'lines') <> 'array' or jsonb_array_length(p->'args'->'lines') = 0 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'lines required'));
  end if;
  v_order := flow.lock_order(p);
  if v_order.status not in ('paid','delivered') then perform core.fail('ORDER_NOT_PAID', 409, jsonb_build_object('order_id', v_order.id, 'status', v_order.status)); end if;

  for v_item in select * from jsonb_array_elements(p->'args'->'lines') loop
    v_q := (v_item->>'quantity')::int;
    if v_q is null or v_q < 0 or v_q > 99 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'quantity must be 0..99')); end if;
    if v_item->>'line_id' is not null then
      select * into v_line from flow.order_lines where id = (v_item->>'line_id')::uuid and order_id = v_order.id and deleted_at is null for update;
      if v_line.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.order_lines', 'id', v_item->>'line_id')); end if;
      if v_item->>'product_id' is not null and (v_item->>'product_id')::uuid <> v_line.product_id then
        perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'a line keeps its product; add a new line instead', 'line_id', v_line.id));
      end if;
      select * into v_product from flow.products where id = v_line.product_id;
      if v_q = v_line.quantity then continue; end if;
      if v_q > v_line.quantity then
        if v_product.prepared then perform flow.add_units(p, v_order, v_line.id, v_product.id, v_q - v_line.quantity, v_order.pay_seq); end if;
      else
        v_cancelled := flow.cancel_units(p, v_line.id, v_line.quantity - v_q);
        v_all_cancelled := v_all_cancelled || v_cancelled;
      end if;
      v_diff := v_diff + (v_q - v_line.quantity) * v_line.unit_price_cents;
      if v_q = 0 then
        perform flow.row_op(p, jsonb_build_object('op', 'delete', 'table', 'flow.order_lines', 'id', v_line.id, 'expectedRevision', v_line.revision));
      else
        perform flow.upd(p, 'flow.order_lines', v_line.id, v_line.revision, jsonb_build_object('quantity', v_q));
      end if;
      v_changes := v_changes || jsonb_build_object('lineId', v_line.id, 'productId', v_product.id, 'from', v_line.quantity, 'to', v_q, 'unitPriceCents', v_line.unit_price_cents);
    else
      if v_q = 0 then continue; end if;
      select * into v_product from flow.products where id = (v_item->>'product_id')::uuid;
      if v_product.id is null or v_product.project_id <> v_order.project_id then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.products', 'id', v_item->>'product_id')); end if;
      if not v_product.active or v_product.deleted_at is not null then
        perform core.fail('PRODUCT_INACTIVE', 422, jsonb_build_object('product_id', v_product.id, 'scope', v_product.scope, 'code', v_product.code, 'name', v_product.name));
      end if;
      select coalesce(max(position), 0) + 1 into v_pos from flow.order_lines where order_id = v_order.id;
      v_line_id := flow.ins(p, 'flow.order_lines', jsonb_build_object('order_id', v_order.id, 'product_id', v_product.id, 'quantity', v_q, 'position', v_pos, 'unit_price_cents', v_product.price_cents));
      if v_product.prepared then perform flow.add_units(p, v_order, v_line_id, v_product.id, v_q, v_order.pay_seq); end if;
      v_diff := v_diff + v_q * v_product.price_cents;
      v_changes := v_changes || jsonb_build_object('lineId', v_line_id, 'productId', v_product.id, 'from', 0, 'to', v_q, 'unitPriceCents', v_product.price_cents);
    end if;
  end loop;

  if jsonb_array_length(v_changes) = 0 then perform flow.proc_end(); return jsonb_build_object('order_id', v_order.id, 'diff_cents', 0, 'changed', false); end if;
  if v_diff < 0 and flow.money_back_requires_owner() and p->>'role' <> 'owner' then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'refund requires owner', 'diffCents', v_diff));
  end if;
  if v_diff <> 0 then
    if v_method is null or v_method not in ('cash','bizum') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'method required when the amount changes', 'diffCents', v_diff)); end if;
    perform flow.ins(p, 'flow.payments', jsonb_build_object('order_id', v_order.id, 'kind', 'adjustment', 'method', v_method, 'amount_cents', v_diff, 'note', p->'args'->>'note'));
  end if;
  select coalesce(sum(quantity * unit_price_cents), 0) into v_total from flow.order_lines where order_id = v_order.id and deleted_at is null;
  perform flow.upd(p, 'flow.orders', v_order.id, v_order.revision, jsonb_build_object('total_cents', v_total));
  perform flow.log(p, v_order.project_id, 'order_adjusted', v_order.id, null, jsonb_build_object('paySeq', v_order.pay_seq, 'diffCents', v_diff, 'totalCents', v_total, 'method', v_method, 'lines', v_changes));
  if jsonb_array_length(v_all_cancelled) > 0 then
    perform flow.log(p, v_order.project_id, 'units_cancelled', v_order.id, null, jsonb_build_object('reason', 'adjust', 'units', v_all_cancelled));
  end if;
  perform flow.proc_end();
  return jsonb_build_object('order_id', v_order.id, 'diff_cents', v_diff, 'total_cents', v_total, 'changed', true, 'cancelled', jsonb_array_length(v_all_cancelled));
end $$;

-- Anular un cobro (§4.6): un `reversal` por lo cobrado; el pedido vuelve a abierto sin número de cobro. Si se cobra otra
-- vez, es otra confirmación y recibe un número nuevo, al final de la cola (nota 3 de Core). El número anterior queda en
-- el evento y en las unidades canceladas. Las unidades terminadas se conservan.
-- args = { order_id, reason, expected_revision }
create or replace function flow.reverse_payment(p jsonb) returns jsonb language plpgsql as $$
declare v_order flow.orders; v_net int; v_cancelled jsonb := '[]'::jsonb; v_unit flow.units;
begin
  perform flow.proc_begin();
  if flow.money_back_requires_owner() and p->>'role' <> 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'reversal requires owner')); end if;
  if coalesce(p->'args'->>'reason', '') = '' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'reason required')); end if;
  v_order := flow.lock_order(p);
  if v_order.status <> 'paid' then perform core.fail('ORDER_NOT_PAID', 409, jsonb_build_object('order_id', v_order.id, 'status', v_order.status)); end if;
  select coalesce(sum(amount_cents), 0) into v_net from flow.payments where order_id = v_order.id and deleted_at is null;
  perform flow.ins(p, 'flow.payments', jsonb_build_object('order_id', v_order.id, 'kind', 'reversal', 'method', v_order.pay_method, 'amount_cents', -v_net, 'note', p->'args'->>'reason'));
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

-- Toque sobre una unidad (§5) o una tarea (§7): pending → in_progress (asignada a quien toca) → done (la puede cerrar otra
-- persona: done_by es quien la cierra) → pending (corrección, con evento). Si ya no está en `from`, solo ganó otro toque.
-- args = { unit_id, from }
create or replace function flow.unit_step(p jsonb) returns jsonb language plpgsql as $$
declare v flow.units; v_from text := p->'args'->>'from'; v_actor uuid := (p->>'actor')::uuid; v_next text;
begin
  perform flow.proc_begin();
  select * into v from flow.units where id = flow.arg_uuid(p, 'unit_id') for update;
  if v.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.units', 'id', p->'args'->>'unit_id')); end if;
  if v.deleted_at is not null then perform core.fail('ROW_DELETED', 409, jsonb_build_object('table', 'flow.units', 'id', v.id)); end if;
  if v.status = 'cancelled' then perform core.fail('UNIT_CANCELLED', 409, jsonb_build_object('unit_id', v.id, 'current', to_jsonb(v))); end if;
  if v_from is distinct from v.status then
    perform core.fail('UNIT_CHANGED', 409, jsonb_build_object('unit_id', v.id, 'expected', v_from, 'status', v.status, 'assignedTo', v.assigned_to, 'doneBy', v.done_by, 'current', to_jsonb(v)));
  end if;
  if v.status = 'pending' then
    v_next := 'in_progress';
    perform flow.upd(p, 'flow.units', v.id, v.revision, jsonb_build_object('status', v_next, 'assigned_to', v_actor));
  elsif v.status = 'in_progress' then
    v_next := 'done';
    perform flow.upd(p, 'flow.units', v.id, v.revision, jsonb_build_object('status', v_next, 'done_at', now(), 'done_by', v_actor));
  else
    v_next := 'pending';
    perform flow.upd(p, 'flow.units', v.id, v.revision, jsonb_build_object('status', v_next, 'assigned_to', null, 'done_at', null, 'done_by', null));
    perform flow.log(p, v.project_id, 'unit_reverted', v.order_id, v.id, jsonb_build_object('doneBy', v.done_by, 'doneAt', v.done_at, 'assignedTo', v.assigned_to));
  end if;
  perform flow.proc_end();
  return jsonb_build_object('unit_id', v.id, 'from', v.status, 'status', v_next);
end $$;

-- Entrega del pedido completo (§6): con unidades sin terminar o líneas sin revisar, exige confirmación consciente y la
-- registra. «Preparado» no es «entregado»: solo esto lo marca.
-- args = { order_id, ident: 'number'|'qr'|'presence'|'skipped', confirm_exception, expected_revision }
create or replace function flow.deliver_order(p jsonb) returns jsonb language plpgsql as $$
declare v_order flow.orders; v_ident text := p->'args'->>'ident'; v_pending int; v_unchecked int; v_exception boolean;
begin
  perform flow.proc_begin();
  if v_ident is null or v_ident not in ('number','qr','presence','skipped') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'ident must be number, qr, presence or skipped')); end if;
  v_order := flow.lock_order(p);
  if v_order.status = 'delivered' then perform core.fail('ORDER_ALREADY_DELIVERED', 409, jsonb_build_object('order_id', v_order.id)); end if;
  if v_order.status <> 'paid' then perform core.fail('ORDER_NOT_PAID', 409, jsonb_build_object('order_id', v_order.id, 'status', v_order.status)); end if;
  select count(*) into v_pending from flow.units where order_id = v_order.id and deleted_at is null and status in ('pending','in_progress');
  select count(*) into v_unchecked from flow.order_lines where order_id = v_order.id and deleted_at is null and not delivery_checked;
  v_exception := v_pending > 0 or v_unchecked > 0;
  if v_exception and coalesce((p->'args'->>'confirm_exception')::boolean, false) is not true then
    perform core.fail('DELIVERY_NEEDS_CONFIRMATION', 409, jsonb_build_object('order_id', v_order.id, 'pendingUnits', v_pending, 'uncheckedLines', v_unchecked));
  end if;
  perform flow.upd(p, 'flow.orders', v_order.id, v_order.revision, jsonb_build_object('status', 'delivered', 'delivered_at', now(),
    'delivered_by', (p->>'actor')::uuid, 'delivery_ident', v_ident, 'delivery_exception', v_exception));
  perform flow.log(p, v_order.project_id, 'delivered', v_order.id, null, jsonb_build_object('paySeq', v_order.pay_seq, 'ident', v_ident,
    'exception', v_exception, 'pendingUnits', v_pending, 'uncheckedLines', v_unchecked));
  perform flow.proc_end();
  return jsonb_build_object('order_id', v_order.id, 'exception', v_exception, 'pending_units', v_pending, 'unchecked_lines', v_unchecked);
end $$;

-- Reabrir un pedido entregado (§6.6, §15.20): vuelve a cobrado, con evento. No toca el dinero.
-- args = { order_id, reason, expected_revision }
create or replace function flow.reopen_order(p jsonb) returns jsonb language plpgsql as $$
declare v_order flow.orders;
begin
  perform flow.proc_begin();
  v_order := flow.lock_order(p);
  if v_order.status <> 'delivered' then perform core.fail('ORDER_NOT_DELIVERED', 409, jsonb_build_object('order_id', v_order.id, 'status', v_order.status)); end if;
  perform flow.upd(p, 'flow.orders', v_order.id, v_order.revision, jsonb_build_object('status', 'paid', 'delivered_at', null, 'delivered_by', null,
    'delivery_ident', null, 'delivery_exception', false));
  perform flow.log(p, v_order.project_id, 'order_reopened', v_order.id, null, jsonb_build_object('paySeq', v_order.pay_seq, 'deliveredAt', v_order.delivered_at,
    'deliveredBy', v_order.delivered_by, 'ident', v_order.delivery_ident, 'exception', v_order.delivery_exception, 'reason', p->'args'->>'reason'));
  perform flow.proc_end();
  return jsonb_build_object('order_id', v_order.id, 'status', 'paid');
end $$;

select core.allow_procedure('flow', 'flow.confirm_payment');
select core.allow_procedure('flow', 'flow.adjust_paid_order');
select core.allow_procedure('flow', 'flow.reverse_payment');
select core.allow_procedure('flow', 'flow.unit_step');
select core.allow_procedure('flow', 'flow.deliver_order');
select core.allow_procedure('flow', 'flow.reopen_order');

-- ---------------------------------------------------------------------------
-- Carta pública (API.md §6): sin sesión, solo productos activos del proyecto activo más reciente (V1 asume uno).
-- Nada de pedidos ni de personas.
-- ---------------------------------------------------------------------------
create or replace function flow.public_menu(p jsonb) returns jsonb language sql stable as $$
  with project as (
    select id, name from flow.projects where deleted_at is null and status = 'active' order by created_at desc, id desc limit 1
  )
  select jsonb_build_object(
    'project', (select name from project),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('id', pr.id, 'scope', pr.scope, 'code', pr.code, 'name', pr.name, 'description', pr.description,
               'priceCents', pr.price_cents, 'position', pr.position, 'image', null) order by pr.scope, pr.position, pr.code)
        from flow.products pr join project on project.id = pr.project_id
       where pr.deleted_at is null and pr.active), '[]'::jsonb))
$$;

select core.allow_public_read('flow_menu', 'flow.public_menu');

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;

-- ---------------------------------------------------------------------------
-- Semilla (canon V1 §2.1 y §8): el proyecto de la barra, sus 4 columnas y el catálogo inicial exacto.
-- ---------------------------------------------------------------------------
insert into flow.projects (id, name) values ('0f10a000-0000-4000-8000-000000000001', 'Barra · Evento de octubre');

insert into flow.columns (project_id, key, label, behavior, position) values
  ('0f10a000-0000-4000-8000-000000000001', 'order', 'Pedido y cobro', 'inspect_confirm', 1),
  ('0f10a000-0000-4000-8000-000000000001', 'prep', 'Preparación', 'quick_steps', 2),
  ('0f10a000-0000-4000-8000-000000000001', 'service', 'Servicio y entrega', 'inspect_confirm', 3),
  ('0f10a000-0000-4000-8000-000000000001', 'logistics', 'Logística', 'free_task', 4);

insert into flow.products (id, project_id, scope, code, name, description, price_cents, prepared, position) values
  ('0f10a000-0000-4000-8000-000000000101', '0f10a000-0000-4000-8000-000000000001', 'clasico', 'A', 'Serrano', 'Tomate fresco, jamón serrano y aceite de oliva', 250, true, 1),
  ('0f10a000-0000-4000-8000-000000000102', '0f10a000-0000-4000-8000-000000000001', 'clasico', 'B', 'Dobladillo', 'Atún preparado, tomate fresco y mayonesa', 250, true, 2),
  ('0f10a000-0000-4000-8000-000000000103', '0f10a000-0000-4000-8000-000000000001', 'clasico', 'C', 'Mediterráneo', 'Hummus, tomate seco en aceite y rúcula', 250, true, 3),
  ('0f10a000-0000-4000-8000-000000000104', '0f10a000-0000-4000-8000-000000000001', 'clasico', 'D', 'Caprese', 'Queso crema, tomate fresco, pesto y albahaca fresca', 250, true, 4),
  ('0f10a000-0000-4000-8000-000000000201', '0f10a000-0000-4000-8000-000000000001', 'gourmet', 'α', 'Campero', 'Paté de campaña, cebolla caramelizada y tomillo', 300, true, 1),
  ('0f10a000-0000-4000-8000-000000000202', '0f10a000-0000-4000-8000-000000000001', 'gourmet', 'β', 'Payoyo', 'Queso payoyo, miel y nueces troceadas', 300, true, 2),
  ('0f10a000-0000-4000-8000-000000000203', '0f10a000-0000-4000-8000-000000000001', 'gourmet', 'γ', 'Cabra dulce', 'Cebolla caramelizada, queso de cabra y mermelada de tomate', 300, true, 3),
  ('0f10a000-0000-4000-8000-000000000204', '0f10a000-0000-4000-8000-000000000001', 'gourmet', 'δ', 'Nórdico', 'Queso crema, salmón ahumado y eneldo', 300, true, 4),
  ('0f10a000-0000-4000-8000-000000000301', '0f10a000-0000-4000-8000-000000000001', 'barra', 'A', 'Agua, botella pequeña', null, 100, false, 1),
  ('0f10a000-0000-4000-8000-000000000302', '0f10a000-0000-4000-8000-000000000001', 'barra', 'B', 'Refresco, lata', null, 200, false, 2),
  ('0f10a000-0000-4000-8000-000000000303', '0f10a000-0000-4000-8000-000000000001', 'barra', 'C', 'Cerveza, lata', null, 200, false, 3),
  ('0f10a000-0000-4000-8000-000000000304', '0f10a000-0000-4000-8000-000000000001', 'barra', 'D', 'Café / infusión', null, 150, false, 4),
  ('0f10a000-0000-4000-8000-000000000305', '0f10a000-0000-4000-8000-000000000001', 'barra', 'α', 'Palomitas', null, 150, false, 5);

-- Componentes y estación de cada montadito (§8.1–8.2): 1 Untar · 2 Colocar · 3 Dosificar · 4 Acabados.
insert into flow.product_components (product_id, station, ingredient, position) values
  ('0f10a000-0000-4000-8000-000000000101', 2, 'Tomate fresco', 1),
  ('0f10a000-0000-4000-8000-000000000101', 2, 'Jamón serrano', 2),
  ('0f10a000-0000-4000-8000-000000000101', 3, 'Aceite de oliva', 3),
  ('0f10a000-0000-4000-8000-000000000102', 1, 'Atún preparado', 1),
  ('0f10a000-0000-4000-8000-000000000102', 2, 'Tomate fresco', 2),
  ('0f10a000-0000-4000-8000-000000000102', 3, 'Mayonesa', 3),
  ('0f10a000-0000-4000-8000-000000000103', 1, 'Hummus', 1),
  ('0f10a000-0000-4000-8000-000000000103', 1, 'Tomate seco en aceite', 2),
  ('0f10a000-0000-4000-8000-000000000103', 4, 'Rúcula', 3),
  ('0f10a000-0000-4000-8000-000000000104', 1, 'Queso crema', 1),
  ('0f10a000-0000-4000-8000-000000000104', 2, 'Tomate fresco', 2),
  ('0f10a000-0000-4000-8000-000000000104', 3, 'Pesto', 3),
  ('0f10a000-0000-4000-8000-000000000104', 4, 'Albahaca fresca', 4),
  ('0f10a000-0000-4000-8000-000000000201', 1, 'Paté de campaña', 1),
  ('0f10a000-0000-4000-8000-000000000201', 1, 'Cebolla caramelizada', 2),
  ('0f10a000-0000-4000-8000-000000000201', 4, 'Tomillo', 3),
  ('0f10a000-0000-4000-8000-000000000202', 2, 'Queso payoyo', 1),
  ('0f10a000-0000-4000-8000-000000000202', 3, 'Miel', 2),
  ('0f10a000-0000-4000-8000-000000000202', 4, 'Nueces troceadas', 3),
  ('0f10a000-0000-4000-8000-000000000203', 1, 'Cebolla caramelizada', 1),
  ('0f10a000-0000-4000-8000-000000000203', 2, 'Queso de cabra', 2),
  ('0f10a000-0000-4000-8000-000000000203', 3, 'Mermelada de tomate', 3),
  ('0f10a000-0000-4000-8000-000000000204', 1, 'Queso crema', 1),
  ('0f10a000-0000-4000-8000-000000000204', 2, 'Salmón ahumado', 2),
  ('0f10a000-0000-4000-8000-000000000204', 4, 'Eneldo', 3);
