-- Ikisai Flow · flujos por evento y acceso por proyecto (decisión de VG del 26-10-2026, aprobada por Core).
-- - Proyecto ligado a su evento (Booking), con fechas para ordenar «el más actual arriba» y una imagen de portada.
-- - Acceso por proyecto con los ámbitos del núcleo: core.memberships.scopes = {"projects": [uuid…]}. El owner (Dirección)
--   ve y toca todo; el resto, solo sus proyectos. Para filtrar cada fila, todas las tablas llevan project_id.
-- - Outsiders: solo tocar unidades (unit_step) y crear tareas de Logística; nada de cobros, ajustes, entregas ni catálogo.

-- ---------------------------------------------------------------------------
-- Proyecto: evento, fechas y portada
-- ---------------------------------------------------------------------------
alter table flow.projects add column booking_event_id uuid;
alter table flow.projects add column starts_on date;
alter table flow.projects add column ends_on date;
alter table flow.projects add column cover_image text check (cover_image is null or cover_image ~ '^/[a-z0-9/_.-]+\.(webp|jpg|png)$');
-- Modo pruebas (VG, 26-10): se cobra y se cuenta igual, pero el Cierre del día no envía ingresos a Finance.
alter table flow.projects add column test_mode boolean not null default false;
alter table flow.projects add constraint projects_dates_check check (starts_on is null or ends_on is null or ends_on >= starts_on);
select core.register_table('flow', 'flow', 'projects', array['name','status','notes','booking_event_id','starts_on','ends_on','cover_image','test_mode'], '{reader,editor,owner,outsider}', '{owner}', false);

-- El proyecto de la barra, con su portada y las fechas del evento (§14 del canon: del 30-10 al 1-11-2026).
update flow.projects set cover_image = '/guias/carta-general-mini.webp', starts_on = '2026-10-30', ends_on = '2026-11-01'
 where id = '0f10a000-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------------
-- Capa genérica como dato (Core, 26-10: Flow será un generador de flujos): las claves de columna ya no son la lista fija
-- de la barra, sino cualquier identificador corto. Lo que sigue siendo de la barra está en API.md, «Cómo se define un
-- flujo nuevo».
-- ---------------------------------------------------------------------------
alter table flow.columns drop constraint columns_key_check;
alter table flow.columns add constraint columns_key_check check (key ~ '^[a-z][a-z0-9_]{1,30}$');
alter table flow.units drop constraint units_column_key_check;
alter table flow.units add constraint units_column_key_check check (column_key ~ '^[a-z][a-z0-9_]{1,30}$');

-- ---------------------------------------------------------------------------
-- project_id en las tablas que no lo tenían, rellenado por el servidor desde su padre (el cliente nunca lo elige)
-- ---------------------------------------------------------------------------
alter table flow.order_lines add column project_id uuid references flow.projects(id);
alter table flow.payments add column project_id uuid references flow.projects(id);
alter table flow.product_components add column project_id uuid references flow.projects(id);
update flow.order_lines l set project_id = o.project_id from flow.orders o where o.id = l.order_id;
update flow.payments p set project_id = o.project_id from flow.orders o where o.id = p.order_id;
update flow.product_components c set project_id = pr.project_id from flow.products pr where pr.id = c.product_id;
alter table flow.order_lines alter column project_id set not null;
alter table flow.payments alter column project_id set not null;
alter table flow.product_components alter column project_id set not null;
create index order_lines_project_idx on flow.order_lines (project_id);
create index payments_project_idx on flow.payments (project_id);

create or replace function flow.fill_project_id() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'order_lines' then
    select project_id into new.project_id from flow.orders where id = new.order_id;
  elsif tg_table_name = 'payments' then
    select project_id into new.project_id from flow.orders where id = new.order_id;
  elsif tg_table_name = 'product_components' then
    select project_id into new.project_id from flow.products where id = new.product_id;
  end if;
  return new;
end $$;
-- Antes que la guarda (los disparadores van por orden alfabético), para que la guarda ya vea el proyecto.
create trigger a_flow_project before insert or update of order_id on flow.order_lines for each row execute function flow.fill_project_id();
create trigger a_flow_project before insert or update of order_id on flow.payments for each row execute function flow.fill_project_id();
create trigger a_flow_project before insert or update of product_id on flow.product_components for each row execute function flow.fill_project_id();

-- ---------------------------------------------------------------------------
-- Ámbito: ¿esta persona trabaja en este proyecto?
-- ---------------------------------------------------------------------------
create or replace function flow.in_scope(p_user uuid, p_project uuid) returns boolean language sql stable as $$
  select exists (
    select 1 from core.memberships m
     where m.app = 'flow' and m.user_id = p_user
       and (m.role = 'owner' or coalesce(m.scopes->'projects', '[]'::jsonb) ? p_project::text))
$$;

/** En los procedimientos: el proyecto tiene que estar en los ámbitos de quien actúa. */
create or replace function flow.check_scope(p jsonb, p_project uuid) returns void language plpgsql as $$
begin
  if p->>'role' = 'owner' then return; end if;
  if not flow.in_scope((p->>'actor')::uuid, p_project) then
    perform core.fail('PROJECT_OUT_OF_SCOPE', 403, jsonb_build_object('project_id', p_project));
  end if;
end $$;

/** En las escrituras de fila del personal (no las de procedimiento ni las públicas): mismo control, por `updated_by`. */
create or replace function flow.guard_scope() returns trigger language plpgsql as $$
declare v_project uuid;
begin
  if flow.in_proc() or core.is_public_batch() or new.updated_by is null then return new; end if;
  v_project := case when tg_table_name = 'projects' then new.id else (to_jsonb(new)->>'project_id')::uuid end;
  if v_project is not null and not flow.in_scope(new.updated_by, v_project) then
    perform core.fail('PROJECT_OUT_OF_SCOPE', 403, jsonb_build_object('table', 'flow.' || tg_table_name, 'project_id', v_project));
  end if;
  -- Tampoco se saca una fila de un proyecto ajeno hacia uno propio.
  if tg_op = 'UPDATE' and tg_table_name <> 'projects' then
    v_project := (to_jsonb(old)->>'project_id')::uuid;
    if v_project is not null and not flow.in_scope(new.updated_by, v_project) then
      perform core.fail('PROJECT_OUT_OF_SCOPE', 403, jsonb_build_object('table', 'flow.' || tg_table_name, 'project_id', v_project));
    end if;
  end if;
  return new;
end $$;
-- Después de touch_revision (que pone updated_by en las actualizaciones): nombre con «flow_scope».
create trigger flow_scope before insert or update on flow.orders for each row execute function flow.guard_scope();
create trigger flow_scope before insert or update on flow.order_lines for each row execute function flow.guard_scope();
create trigger flow_scope before insert or update on flow.units for each row execute function flow.guard_scope();
create trigger flow_scope before insert or update on flow.products for each row execute function flow.guard_scope();
create trigger flow_scope before insert or update on flow.product_components for each row execute function flow.guard_scope();
create trigger flow_scope before insert or update on flow.columns for each row execute function flow.guard_scope();
-- También donde el cliente ya no puede escribir (solo procedimientos o el lote público): defensa en profundidad.
create trigger flow_scope before insert or update on flow.payments for each row execute function flow.guard_scope();
create trigger flow_scope before insert or update on flow.events for each row execute function flow.guard_scope();
create trigger flow_scope before insert or update on flow.customers for each row execute function flow.guard_scope();

-- Lectura: todas las tablas para reader, editor, owner y outsider (el filtro por proyecto lo hace flow-api, hook `visible`).
select core.register_table('flow', 'flow', 'columns', array['project_id','key','label','behavior','position'], '{reader,editor,owner,outsider}', '{owner}', true);
select core.register_table('flow', 'flow', 'products', array['project_id','scope','code','name','description','price_cents','active','prepared','position','image_key'], '{reader,editor,owner,outsider}', '{owner}', true);
select core.register_table('flow', 'flow', 'product_components', array['product_id','station','ingredient','position'], '{reader,editor,owner,outsider}', '{owner}', true);
select core.register_table('flow', 'flow', 'customers', array['project_id','number','token_hash'], '{reader,editor,owner,outsider}', '{editor,owner}', true);
select core.register_table('flow', 'flow', 'orders', array['project_id','origin','notes','customer_id','parent_id','status','pay_seq','paid_at','paid_by','pay_method','total_cents','delivered_at','delivered_by','delivery_ident','delivery_exception'], '{reader,editor,owner,outsider}', '{editor,owner}', true);
select core.register_table('flow', 'flow', 'order_lines', array['order_id','product_id','quantity','position','delivered_qty','unit_price_cents'], '{reader,editor,owner,outsider}', '{editor,owner}', true);
select core.register_table('flow', 'flow', 'payments', array['order_id','kind','method','amount_cents','note','settled_at','settled_by'], '{reader,editor,owner,outsider}', '{editor,owner}', true);
-- Unidades: el outsider crea tareas de Logística (la guarda solo le deja eso y cambiar su texto o prioridad).
select core.register_table('flow', 'flow', 'units', array['project_id','column_key','kind','order_id','line_id','product_id','idx','pay_seq','label','priority','status','assigned_to','done_at','done_by'], '{reader,editor,owner,outsider}', '{editor,owner,outsider}', true);
select core.register_table('flow', 'flow', 'events', array['project_id','kind','order_id','unit_id','data','actor','at'], '{reader,editor,owner,outsider}', '{editor,owner,outsider}', true);

-- ---------------------------------------------------------------------------
-- Procedimientos: comprobar el ámbito del proyecto (redefinidos donde se bloquea la fila)
-- ---------------------------------------------------------------------------
create or replace function flow.lock_order(p jsonb) returns flow.orders language plpgsql as $$
declare v flow.orders; v_expected bigint := (p->'args'->>'expected_revision')::bigint;
begin
  select * into v from flow.orders where id = flow.arg_uuid(p, 'order_id') for update;
  if v.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.orders', 'id', p->'args'->>'order_id')); end if;
  perform flow.check_scope(p, v.project_id);
  if v.deleted_at is not null then perform core.fail('ROW_DELETED', 409, jsonb_build_object('table', 'flow.orders', 'id', v.id)); end if;
  if v_expected is not null and v_expected <> v.revision then
    perform core.fail('VERSION_CONFLICT', 409, jsonb_build_object('table', 'flow.orders', 'id', v.id, 'expectedRevision', v_expected, 'currentRevision', v.revision, 'current', to_jsonb(v)));
  end if;
  return v;
end $$;

-- unit_step: el mismo de la 0900, con el ámbito (también lo usa el outsider).
create or replace function flow.unit_step(p jsonb) returns jsonb language plpgsql as $$
declare v flow.units; v_from text := p->'args'->>'from'; v_actor uuid := (p->>'actor')::uuid; v_next text;
begin
  perform flow.proc_begin();
  select * into v from flow.units where id = flow.arg_uuid(p, 'unit_id') for update;
  if v.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.units', 'id', p->'args'->>'unit_id')); end if;
  perform flow.check_scope(p, v.project_id);
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

-- create_extension y confirm_refund comprueban el ámbito sobre el pedido padre o el del pago.
create or replace function flow.scope_of_order(p jsonb, p_order uuid) returns void language plpgsql as $$
declare v_project uuid;
begin
  select project_id into v_project from flow.orders where id = p_order;
  if v_project is not null then perform flow.check_scope(p, v_project); end if;
end $$;

-- Envoltorios: comprueban el ámbito y llaman a la versión de la 0901 (renombrada).
alter function flow.create_extension(jsonb) rename to create_extension_v1;
alter function flow.confirm_refund(jsonb) rename to confirm_refund_v1;
create or replace function flow.create_extension(p jsonb) returns jsonb language plpgsql as $$
begin
  perform flow.scope_of_order(p, flow.arg_uuid(p, 'parent_order_id'));
  return flow.create_extension_v1(p);
end $$;
create or replace function flow.confirm_refund(p jsonb) returns jsonb language plpgsql as $$
declare v_order uuid;
begin
  select order_id into v_order from flow.payments where id = flow.arg_uuid(p, 'payment_id');
  if v_order is not null then perform flow.scope_of_order(p, v_order); end if;
  return flow.confirm_refund_v1(p);
end $$;

-- Outsiders (decisión de Core para cuando VG los use): solo los toques de unidades.
select core.allow_outsider_procedure('flow', 'flow.unit_step');

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
