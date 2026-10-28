-- Ikisai Flow · la barra sobre el motor genérico (orden de VG por Core, 28-10). Los datos de la barra siguen en sus tablas
-- (pedidos, líneas, cobros, cierres), pero cada uno tiene su unidad del motor, que es lo que recorren carriles y vistas:
-- - Carriles por puesto (`lane_key`): caja, cocina, servicio, ingredientes y barra (la logística y sus puestos continuos,
--   como el pan, que son `station`). Se ponen solos al escribir una unidad de esas columnas si no traen carril.
-- - Pedido = unidad `operation` (kind `order`, enlazada por `source_ref` = «flow.orders:<id>», no por `order_id`, que es de las
--   unidades de preparación): nace al pedir (también el de la carta) en «caja»; cobrado, pasa a
--   «cocina» mientras tenga preparación pendiente y después a «servicio»; entregado, queda hecho. Volver atrás la devuelve.
-- - Cierre del día = unidad `result` (kind `closure`, `result_link` al cierre), en «caja», hecha.
-- Todo lo escribe el servidor por el registro del núcleo (en el lote que cambia el pedido, la preparación o el cierre), con la
-- marca de procedimiento: llega a los dispositivos y no lo escribe nadie a mano. La v1 congelada no se toca.
-- Toca solo el schema flow; del núcleo, la petición en curso (core.in_batch, core.current_request_id) y apply_row_op.

alter table flow.units drop constraint units_kind_check;
alter table flow.units add constraint units_kind_check check (kind in ('prep', 'task', 'station', 'card', 'recurring', 'order', 'closure'));

-- El guard de carriles del Avance (0937) sigue cerrado por defecto (tarjetas y cualquier carril), con una sola excepción: el
-- carril de la barra que sale de su columna (`flow.barra_lane`), en unidades que no son tarjetas. Las unidades del motor de la
-- barra (pedido y cierre) solo las escribe el servidor.
create or replace function flow.guard_board() returns trigger language plpgsql as $$
declare v_actor uuid := nullif(current_setting('core' || '.actor', true), '')::uuid;
begin
  if (new.kind in ('order', 'closure') or (tg_op = 'UPDATE' and old.kind in ('order', 'closure'))) and not flow.in_proc() then
    perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.units', 'reason', 'flow engine units'));
  end if;
  if not (new.kind in ('card', 'recurring') or new.lane_key is not null
          or (tg_op = 'UPDATE' and (old.kind in ('card', 'recurring') or old.lane_key is not null))) then
    return new;
  end if;
  if new.kind not in ('card', 'recurring') and new.lane_key is not distinct from flow.barra_lane(new.column_key)
     and (tg_op = 'INSERT' or (old.kind not in ('card', 'recurring') and (old.lane_key is null or old.lane_key is not distinct from flow.barra_lane(old.column_key)))) then
    return new;
  end if;
  if not flow.in_proc() then perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.units', 'reason', 'board cards')); end if;
  if v_actor is not null then
    if not flow.lane_allowed(v_actor, new.project_id, new.lane_key)
       or (tg_op = 'UPDATE' and old.lane_key is not null and not flow.lane_allowed(v_actor, old.project_id, old.lane_key)) then
      perform core.fail('LANE_FORBIDDEN', 403, jsonb_build_object('lane', coalesce(new.lane_key, old.lane_key)));
    end if;
  end if;
  return new;
end $$;

/** Carril de un puesto de la barra por su columna (null: no es de la barra o ya trae carril). */
create or replace function flow.barra_lane(p_column text) returns text language sql immutable as $$
  select case p_column when 'order' then 'caja' when 'prep' then 'cocina' when 'service' then 'servicio'
    when 'ingredients' then 'ingredientes' when 'logistics' then 'barra' end
$$;

create or replace function flow.units_lane() returns trigger language plpgsql as $$
begin
  if new.lane_key is null and new.column_key is not null then new.lane_key := flow.barra_lane(new.column_key); end if;
  return new;
end $$;
create trigger a_flow_units_lane before insert or update of column_key, lane_key on flow.units for each row execute function flow.units_lane();

/** Contexto de la petición en curso para escribir por el núcleo desde un disparador (null fuera de un lote). */
create or replace function flow.batch_ctx() returns jsonb language plpgsql stable as $$
begin
  if not core.in_batch() then return null; end if;
  return jsonb_build_object('app', 'flow', 'actor', nullif(current_setting('core' || '.actor', true), ''), 'role', 'owner',
    'requestId', core.current_request_id(), 'cursor', nullif(current_setting('core' || '.cursor', true), '')::bigint);
end $$;

/** ¿Es un flujo con la barra sobre el motor? (con columna de pedidos y no congelado). */
create or replace function flow.engine_barra(p_project uuid) returns boolean language sql stable as $$
  select exists (select 1 from flow.projects pr where pr.id = p_project and not pr.frozen and pr.deleted_at is null)
     and exists (select 1 from flow.columns c where c.project_id = p_project and c.key = 'order' and c.deleted_at is null)
$$;

/** La unidad del pedido, al día: carril y estado según el pedido y su preparación. */
create or replace function flow.order_unit_sync(p_order uuid) returns void language plpgsql as $$
declare p jsonb := flow.batch_ctx(); o flow.orders; u flow.units; v_lane text; v_status text; v_fields jsonb; v_prev text;
begin
  if p is null or p_order is null then return; end if;
  select * into o from flow.orders where id = p_order;
  if o.id is null or not flow.engine_barra(o.project_id) then return; end if;
  select * into u from flow.units where source_ref = 'flow.orders:' || o.id and kind = 'order' and deleted_at is null limit 1;
  if o.deleted_at is not null then
    v_lane := null;
  elsif o.status = 'open' then v_lane := 'caja'; v_status := 'pending';
  elsif o.status = 'delivered' then v_lane := 'servicio'; v_status := 'done';
  elsif exists (select 1 from flow.units x where x.order_id = o.id and x.kind = 'prep' and x.deleted_at is null and x.status in ('pending', 'in_progress')) then
    v_lane := 'cocina'; v_status := 'in_progress';
  else v_lane := 'servicio'; v_status := 'in_progress';
  end if;
  v_prev := current_setting('flow.proc', true);
  perform set_config('flow.proc', 'on', true);
  if u.id is null and v_lane is not null then
    perform flow.row_op(p, jsonb_build_object('op', 'insert', 'table', 'flow.units', 'id', gen_random_uuid(), 'fields', jsonb_build_object(
      'project_id', o.project_id, 'column_key', 'order', 'kind', 'order', 'class', 'operation', 'source_ref', 'flow.orders:' || o.id, 'pay_seq', o.pay_seq,
      'label', left('Pedido' || coalesce(' ' || o.pay_seq, ''), 120), 'lane_key', v_lane, 'status', v_status,
      'done_at', case when v_status = 'done' then coalesce(o.delivered_at, now()) end)));
  elsif u.id is not null and v_lane is null then
    perform flow.row_op(p, jsonb_build_object('op', 'update', 'table', 'flow.units', 'id', u.id, 'expectedRevision', u.revision, 'fields', jsonb_build_object('deleted_at', now())));
  elsif u.id is not null and (u.lane_key is distinct from v_lane or u.status is distinct from v_status or u.pay_seq is distinct from o.pay_seq) then
    v_fields := jsonb_build_object('lane_key', v_lane, 'status', v_status, 'pay_seq', o.pay_seq,
      'label', left('Pedido' || coalesce(' ' || o.pay_seq, ''), 120),
      'done_at', case when v_status = 'done' then coalesce(u.done_at, o.delivered_at, now()) end);
    perform flow.row_op(p, jsonb_build_object('op', 'update', 'table', 'flow.units', 'id', u.id, 'expectedRevision', u.revision, 'fields', v_fields));
  end if;
  perform set_config('flow.proc', coalesce(v_prev, ''), true);
end $$;

create or replace function flow.orders_engine() returns trigger language plpgsql as $$
begin
  perform flow.order_unit_sync(new.id);
  return null;
end $$;
create trigger z_flow_orders_engine after insert or update of status, pay_seq, deleted_at on flow.orders for each row execute function flow.orders_engine();

create or replace function flow.prep_engine() returns trigger language plpgsql as $$
begin
  if new.kind = 'prep' and new.order_id is not null then perform flow.order_unit_sync(new.order_id); end if;
  return null;
end $$;
create trigger z_flow_prep_engine after insert or update of status, deleted_at on flow.units for each row execute function flow.prep_engine();

/** El cierre del día como resultado del flujo. */
create or replace function flow.closure_engine() returns trigger language plpgsql as $$
declare p jsonb := flow.batch_ctx(); u flow.units; v_prev text;
begin
  if p is null or not flow.engine_barra(new.project_id) then return null; end if;
  select * into u from flow.units where kind = 'closure' and project_id = new.project_id and result_link->>'id' = new.id::text and deleted_at is null limit 1;
  if u.id is not null then return null; end if;
  v_prev := current_setting('flow.proc', true);
  perform set_config('flow.proc', 'on', true);
  perform flow.row_op(p, jsonb_build_object('op', 'insert', 'table', 'flow.units', 'id', gen_random_uuid(), 'fields', jsonb_build_object(
    'project_id', new.project_id, 'column_key', 'order', 'kind', 'closure', 'class', 'result', 'lane_key', 'caja',
    'label', 'Cierre del ' || to_char(new.day, 'DD-MM'), 'status', 'done', 'done_at', now(),
    -- Lo verifica quien cierra el día (el owner).
    'verified_by', coalesce(new.closed_by, (p->>'actor')::uuid), 'verified_at', now(),
    'result_link', jsonb_build_object('app', 'flow', 'kind', 'day_closure', 'id', new.id))));
  perform set_config('flow.proc', coalesce(v_prev, ''), true);
  return null;
end $$;
create trigger z_flow_closure_engine after insert on flow.day_closures for each row execute function flow.closure_engine();

-- Lo que ya hay en los flujos de barra no congelados: carriles de sus unidades y la unidad de cada pedido vivo.
do $$
declare v_ops jsonb := '[]'::jsonb; r record; v_lane text; v_status text;
begin
  for r in select u.id, u.column_key from flow.units u
            where u.deleted_at is null and u.lane_key is null and flow.barra_lane(u.column_key) is not null and flow.engine_barra(u.project_id) loop
    v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'flow.units', 'id', r.id, 'fields', jsonb_build_object('lane_key', flow.barra_lane(r.column_key)));
  end loop;
  for r in select o.* from flow.orders o
            where o.deleted_at is null and flow.engine_barra(o.project_id)
              and not exists (select 1 from flow.units u where u.source_ref = 'flow.orders:' || o.id and u.kind = 'order' and u.deleted_at is null) loop
    v_lane := case when r.status = 'open' then 'caja' when r.status = 'delivered' then 'servicio'
                   when exists (select 1 from flow.units x where x.order_id = r.id and x.kind = 'prep' and x.deleted_at is null and x.status in ('pending', 'in_progress')) then 'cocina'
                   else 'servicio' end;
    v_status := case when r.status = 'open' then 'pending' when r.status = 'delivered' then 'done' else 'in_progress' end;
    v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'flow.units', 'id', gen_random_uuid(), 'fields', jsonb_build_object(
      'project_id', r.project_id, 'column_key', 'order', 'kind', 'order', 'class', 'operation', 'source_ref', 'flow.orders:' || r.id, 'pay_seq', r.pay_seq,
      'label', left('Pedido' || coalesce(' ' || r.pay_seq, ''), 120), 'lane_key', v_lane, 'status', v_status,
      'done_at', case when v_status = 'done' then coalesce(r.delivered_at, now()) end));
  end loop;
  if jsonb_array_length(v_ops) > 0 then perform flow.import_apply(v_ops, 'barra-motor'); end if;
end $$;

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
