-- Ikisai Flow · integraciones (encargo de VG del 26-10-2026; contratos acordados con Food, Booking y Finance).
-- - Food: el catálogo de Flow es un REFLEJO de la carta de Food (food.carta_projection). El owner lo actualiza a mano
--   («Actualizar carta desde Food»): durante el servicio no cambia solo. Los precios cobrados siguen copiándose en la línea.
-- - Cierre del día: flow.close_day guarda en flow.day_closures el resumen del día (una fila por proyecto y día, que se
--   sustituye al repetir). Booking lo lee por flow.booking_service_projection. Los envíos a Food (ventas por línea) y a
--   Finance (apunte de ingresos) los hace flow-api con la sesión de la persona y quedan anotados en la fila.

-- ---------------------------------------------------------------------------
-- Enlace con Food
-- ---------------------------------------------------------------------------
alter table flow.projects add column food_menu_id uuid;
select core.register_table('flow', 'flow', 'projects', array['name','status','notes','booking_event_id','starts_on','ends_on','cover_image','test_mode','food_menu_id'], '{reader,editor,owner,outsider}', '{owner}', false);

alter table flow.products add column source_line_id uuid;
alter table flow.products add column allergens text[] not null default '{}';
alter table flow.products add column allergens_checked boolean not null default false;
create unique index products_source_line_uidx on flow.products (project_id, source_line_id) where deleted_at is null and source_line_id is not null;
select core.register_table('flow', 'flow', 'products', array['project_id','scope','code','name','description','price_cents','active','prepared','position','image_key','source_line_id','allergens','allergens_checked'], '{reader,editor,owner,outsider}', '{owner}', true);

-- La carta pública dice también los alérgenos (y si están confirmados con etiquetas reales, §8.4).
create or replace function flow.public_menu(p jsonb) returns jsonb language sql stable as $$
  with project as (
    select id, name from flow.projects where deleted_at is null and status = 'active' order by created_at desc, id desc limit 1
  )
  select jsonb_build_object(
    'project', (select name from project),
    'projectId', (select id from project),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('id', pr.id, 'scope', pr.scope, 'code', pr.code, 'name', pr.name, 'description', pr.description,
               'priceCents', pr.price_cents, 'position', pr.position, 'imageKey', pr.image_key,
               'allergens', to_jsonb(pr.allergens), 'allergensChecked', pr.allergens_checked) order by pr.scope, pr.position, pr.code)
        from flow.products pr join project on project.id = pr.project_id
       where pr.deleted_at is null and pr.active), '[]'::jsonb))
$$;

-- ---------------------------------------------------------------------------
-- Cierre del día
-- ---------------------------------------------------------------------------
create table flow.day_closures (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  project_id uuid not null references flow.projects(id),
  day date not null,
  data jsonb not null,
  closed_by uuid references auth.users(id),
  closed_at timestamptz not null,
  food_status text check (food_status is null or food_status in ('sent','error')),
  food_sent_at timestamptz,
  food_result jsonb,
  finance_status text check (finance_status is null or finance_status in ('sent','error','skipped_test_mode')),
  finance_sent_at timestamptz,
  finance_result jsonb
);
create unique index day_closures_project_day_uidx on flow.day_closures (project_id, day) where deleted_at is null;
select core.register_table('flow', 'flow', 'day_closures',
  array['project_id','day','data','closed_by','closed_at','food_status','food_sent_at','food_result','finance_status','finance_sent_at','finance_result'],
  '{reader,editor,owner}', '{owner}', true);
-- Solo lo escriben los procedimientos (como pagos y eventos).
create or replace function flow.guard_closures() returns trigger language plpgsql as $$
begin
  if flow.in_proc() then return new; end if;
  perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.day_closures'));
end $$;
create trigger flow_guard before insert or update on flow.day_closures for each row execute function flow.guard_closures();
create trigger flow_scope before insert or update on flow.day_closures for each row execute function flow.guard_scope();

/**
 * Resumen de un día (hora de Madrid) de un proyecto. Dinero: los movimientos de ese día (cobros, anulaciones y
 * devoluciones confirmadas), por método; las devoluciones pendientes, aparte. Vendido: las líneas de los pedidos cobrados
 * ese día que siguen cobrados o entregados, con su precio cerrado. Contrato con Finance: detail + pending = amount.
 */
create or replace function flow.day_summary(p_project uuid, p_day date) returns jsonb language sql stable as $$
  with pays as (
    select pa.*, o.pay_seq from flow.payments pa join flow.orders o on o.id = pa.order_id
     where pa.project_id = p_project and pa.deleted_at is null and (pa.created_at at time zone 'Europe/Madrid')::date = p_day
  ),
  moved as (select * from pays where kind <> 'refund' or settled_at is not null),
  sold_orders as (
    select o.* from flow.orders o
     where o.project_id = p_project and o.deleted_at is null and o.status in ('paid','delivered')
       and (o.paid_at at time zone 'Europe/Madrid')::date = p_day
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
      'bizum', (select coalesce(sum(amount_cents), 0) from moved where method = 'bizum')),
    'reversals_cents', (select coalesce(sum(amount_cents), 0) from pays where kind = 'reversal'),
    'refunds_pending_cents', (select coalesce(-sum(amount_cents), 0) from pays where kind = 'refund' and settled_at is null),
    'units_by_product', coalesce((select jsonb_agg(jsonb_build_object('scope', scope, 'code', code, 'name', name, 'units', units, 'amount_cents', amount,
        'source_line_id', source_line_id) order by scope, code) from sold), '[]'::jsonb),
    'peak_hours', coalesce((select jsonb_agg(jsonb_build_object('hour', h, 'orders', n) order by h)
        from (select extract(hour from paid_at at time zone 'Europe/Madrid')::int as h, count(*)::int as n from sold_orders group by 1) x), '[]'::jsonb))
$$;

-- Cerrar (o volver a cerrar) un día. args = { project_id, day }. Solo el owner.
create or replace function flow.close_day(p jsonb) returns jsonb language plpgsql as $$
declare v_project uuid := flow.arg_uuid(p, 'project_id'); v_day date; v_data jsonb; v_row flow.day_closures;
begin
  perform flow.proc_begin();
  if p->>'role' <> 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'closing the day is for the owner')); end if;
  begin v_day := (p->'args'->>'day')::date; exception when others then v_day := null; end;
  if v_day is null then perform core.fail('INVALID_DAY', 422, jsonb_build_object('day', p->'args'->>'day')); end if;
  if not exists (select 1 from flow.projects where id = v_project and deleted_at is null) then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.projects', 'id', v_project));
  end if;
  v_data := flow.day_summary(v_project, v_day);
  select * into v_row from flow.day_closures where project_id = v_project and day = v_day and deleted_at is null for update;
  if v_row.id is null then
    v_row.id := flow.ins(p, 'flow.day_closures', jsonb_build_object('project_id', v_project, 'day', v_day, 'data', v_data,
      'closed_by', (p->>'actor')::uuid, 'closed_at', now()));
  else
    -- Repetir sustituye el resumen; lo enviado antes queda marcado para reenviar si ha cambiado.
    perform flow.upd(p, 'flow.day_closures', v_row.id, v_row.revision, jsonb_build_object('data', v_data, 'closed_by', (p->>'actor')::uuid, 'closed_at', now()));
  end if;
  perform flow.proc_end();
  return jsonb_build_object('closure_id', v_row.id, 'day', v_day, 'data', v_data);
end $$;

-- Anotar el resultado de un envío. args = { closure_id, target: 'food'|'finance', status, result }. Solo el owner.
create or replace function flow.mark_closure_sent(p jsonb) returns jsonb language plpgsql as $$
declare v flow.day_closures; v_target text := p->'args'->>'target'; v_status text := p->'args'->>'status'; v_fields jsonb;
begin
  perform flow.proc_begin();
  if p->>'role' <> 'owner' then perform core.fail('FORBIDDEN', 403, null); end if;
  select * into v from flow.day_closures where id = flow.arg_uuid(p, 'closure_id') for update;
  if v.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.day_closures')); end if;
  if v_target = 'food' and v_status in ('sent','error') then
    v_fields := jsonb_build_object('food_status', v_status, 'food_sent_at', now(), 'food_result', p->'args'->'result');
  elsif v_target = 'finance' and v_status in ('sent','error','skipped_test_mode') then
    v_fields := jsonb_build_object('finance_status', v_status, 'finance_sent_at', now(), 'finance_result', p->'args'->'result');
  else
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'target/status'));
  end if;
  perform flow.upd(p, 'flow.day_closures', v.id, v.revision, v_fields);
  perform flow.proc_end();
  return jsonb_build_object('closure_id', v.id, 'target', v_target, 'status', v_status);
end $$;

select core.allow_procedure('flow', 'flow.close_day');
select core.allow_procedure('flow', 'flow.mark_closure_sent');

-- Para flow-api (enviar a Food y a Finance): el cierre con lo que hace falta para el envío. Solo owner.
create or replace function flow.closure_for_send(p jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('closure', to_jsonb(c), 'project', jsonb_build_object('id', pr.id, 'name', pr.name, 'test_mode', pr.test_mode,
           'food_menu_id', pr.food_menu_id, 'booking_event_id', pr.booking_event_id))
    from flow.day_closures c join flow.projects pr on pr.id = c.project_id
   where c.id = (p->'args'->>'id')::uuid and c.deleted_at is null
$$;
select core.allow_read('flow', 'flow.closure_for_send', 'function', '{owner}');

-- Booking lee el resumen del servicio en la ficha del evento (contrato del 26-10; Booking no escribe aquí).
create view flow.booking_service_projection as
  select pr.booking_event_id as event_id, c.day, c.data, c.updated_at
    from flow.day_closures c join flow.projects pr on pr.id = c.project_id
   where c.deleted_at is null and pr.deleted_at is null and pr.booking_event_id is not null;
select core.allow_read('booking', 'flow.booking_service_projection', 'view', '{reader,editor,owner}');

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
