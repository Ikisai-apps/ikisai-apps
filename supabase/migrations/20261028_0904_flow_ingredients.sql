-- Ikisai Flow · columna «Ingredientes» (encargo de VG del 27-10-2026; diseño aprobado por Core). Todo genérico y
-- parametrizado: nada de montaditos en el código.
-- - columns.config: parámetros del comportamiento. `proposal` añade el estado previo 'proposed' (propuesta → confirmada →
--   asignada → hecha); `manual` deja crear a mano (nace confirmada).
-- - units.payload: parámetros de la tarea ({item_key, name, unit, qty, to, from, moves}) y units.source_ref (idempotencia
--   de lo generado).
-- - flow.buffers: puntos de existencias (bandeja de mesa, nevera) con nivel, capacidad y umbral.
-- - flow.consumption_rules: lo que consume cada producto (materializado desde Food).
-- - Al terminar una unidad se aplican sus movimientos (y se revierten al corregirla), con evento; si un punto baja de su
--   umbral se propone reponerlo, al final de la columna, una sola propuesta abierta por punto y sentido.

-- ---------------------------------------------------------------------------
-- Columnas parametrizadas
-- ---------------------------------------------------------------------------
alter table flow.columns add column config jsonb not null default '{}'::jsonb;
select core.register_table('flow', 'flow', 'columns', array['project_id','key','label','behavior','position','config'], '{reader,editor,owner,outsider}', '{owner}', true);

update flow.columns set config = '{"manual": true}'::jsonb where key = 'logistics';
update flow.columns set position = position + 1 where project_id = '0f10a000-0000-4000-8000-000000000001' and key in ('service','logistics');
insert into flow.columns (project_id, key, label, behavior, position, config) values
  ('0f10a000-0000-4000-8000-000000000001', 'ingredients', 'Ingredientes', 'quick_steps', 3, '{"proposal": true, "manual": true}'::jsonb);

/** ¿Admite esta columna crear tareas a mano? (dato de la columna) */
create or replace function flow.column_config(p_project uuid, p_key text) returns jsonb language sql stable as $$
  select coalesce((select config from flow.columns where project_id = p_project and key = p_key and deleted_at is null), '{}'::jsonb)
$$;

-- ---------------------------------------------------------------------------
-- Unidades: estado previo, parámetros e idempotencia
-- ---------------------------------------------------------------------------
alter table flow.units drop constraint units_status_check;
alter table flow.units add constraint units_status_check check (status in ('proposed','pending','in_progress','done','cancelled'));
alter table flow.units add column payload jsonb not null default '{}'::jsonb;
alter table flow.units add column source_ref text check (source_ref is null or length(source_ref) <= 200);
create unique index units_source_ref_uidx on flow.units (project_id, source_ref) where deleted_at is null and source_ref is not null;
select core.register_table('flow', 'flow', 'units', array['project_id','column_key','kind','order_id','line_id','product_id','idx','pay_seq','label','priority','status','assigned_to','done_at','done_by','payload','source_ref'], '{reader,editor,owner,outsider}', '{editor,owner,outsider}', true);

-- ---------------------------------------------------------------------------
-- Puntos de existencias y reglas de consumo
-- ---------------------------------------------------------------------------
create table flow.buffers (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  project_id uuid not null references flow.projects(id),
  key text not null check (length(key) between 1 and 200),
  item_key text not null check (length(item_key) between 1 and 120),
  name text not null check (length(name) between 1 and 120),
  unit text not null check (length(unit) between 1 and 12),
  location text not null check (location ~ '^[a-z][a-z0-9_]{1,30}$'),
  capacity numeric not null default 0 check (capacity >= 0),
  level numeric not null default 0,
  threshold_pct integer not null default 25 check (threshold_pct between 0 and 100)
);
create unique index buffers_key_uidx on flow.buffers (project_id, key) where deleted_at is null;
select core.register_table('flow', 'flow', 'buffers', array['project_id','key','item_key','name','unit','location','capacity','level','threshold_pct'], '{reader,editor,owner,outsider}', '{editor,owner,outsider}', true);

create table flow.consumption_rules (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  project_id uuid not null references flow.projects(id),
  product_id uuid not null references flow.products(id),
  item_key text not null,
  name text not null,
  unit text not null,
  per_unit numeric not null check (per_unit >= 0)
);
create index consumption_rules_product_idx on flow.consumption_rules (product_id) where deleted_at is null;
select core.register_table('flow', 'flow', 'consumption_rules', array['project_id','product_id','item_key','name','unit','per_unit'], '{reader,editor,owner,outsider}', '{owner}', true);

-- Guarda: el nivel solo lo mueven los procedimientos; capacidad y umbral, el owner; las reglas, solo el procedimiento.
create or replace function flow.guard_stock() returns trigger language plpgsql as $$
begin
  if flow.in_proc() then return new; end if;
  if tg_table_name = 'consumption_rules' then perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.consumption_rules')); end if;
  if tg_op = 'INSERT' or new.level is distinct from old.level or new.key is distinct from old.key or new.item_key is distinct from old.item_key
     or new.location is distinct from old.location or new.project_id is distinct from old.project_id then
    perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.buffers'));
  end if;
  if coalesce(core.current_role(), '') <> 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'flow.buffers')); end if;
  return new;
end $$;
create trigger flow_guard before insert or update on flow.buffers for each row execute function flow.guard_stock();
create trigger flow_guard before insert or update on flow.consumption_rules for each row execute function flow.guard_stock();
create trigger flow_scope before insert or update on flow.buffers for each row execute function flow.guard_scope();
create trigger flow_scope before insert or update on flow.consumption_rules for each row execute function flow.guard_scope();

-- Eventos nuevos.
alter table flow.events drop constraint events_kind_check;
alter table flow.events add constraint events_kind_check check (kind in ('paid','payment_reversed','order_adjusted','units_cancelled','unit_reverted',
  'delivered','order_reopened','extension_created','refund_settled','public_order','stock_moved','stock_reverted','tasks_generated'));

-- ---------------------------------------------------------------------------
-- Guarda de unidades: tareas a mano en cualquier columna con `manual` (antes, solo Logística)
-- ---------------------------------------------------------------------------
create or replace function flow.guard_units_manual() returns trigger language plpgsql as $$
begin
  if flow.in_proc() or core.is_public_batch() then return new; end if;
  if tg_op = 'INSERT' then
    if not (new.kind = 'task' and new.status = 'pending' and new.order_id is null and new.line_id is null and new.product_id is null
            and new.assigned_to is null and new.done_at is null and new.done_by is null and new.pay_seq is null and new.source_ref is null
            and coalesce((flow.column_config(new.project_id, new.column_key)->>'manual')::boolean, false)) then
      perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.units'));
    end if;
    -- Lo creado a mano no trae movimientos ni marcas de lo generado: solo los campos para enseñar la tarea.
    new.payload := (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(coalesce(new.payload, '{}'::jsonb)) as e(k, v)
                     where k in ('item_key','name','unit','qty','to','from'));
    return new;
  end if;
  if old.kind <> 'task' or flow.changed(to_jsonb(old), to_jsonb(new), array['project_id','column_key','kind','order_id','line_id','product_id','idx','pay_seq','status','assigned_to','done_at','done_by','payload','source_ref']) then
    perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.units'));
  end if;
  return new;
end $$;
-- Sustituye la rama de unidades de flow.guard (0901) con una guarda propia que corre antes.
create trigger flow_guard_a before insert or update on flow.units for each row execute function flow.guard_units_manual();
drop trigger flow_guard on flow.units;

-- ---------------------------------------------------------------------------
-- Movimientos de existencias
-- ---------------------------------------------------------------------------
/** Aplica [{buffer, delta}] (clave de buffer) con signo; devuelve los buffers tocados. */
create or replace function flow.apply_moves(p jsonb, p_project uuid, p_moves jsonb, p_sign int) returns uuid[] language plpgsql as $$
declare v_move jsonb; v_buffer flow.buffers; v_out uuid[] := '{}';
begin
  for v_move in select * from jsonb_array_elements(coalesce(p_moves, '[]'::jsonb)) loop
    select * into v_buffer from flow.buffers where project_id = p_project and key = v_move->>'buffer' and deleted_at is null for update;
    if v_buffer.id is null then continue; end if;
    perform flow.upd(p, 'flow.buffers', v_buffer.id, v_buffer.revision, jsonb_build_object('level', v_buffer.level + p_sign * (v_move->>'delta')::numeric));
    v_out := v_out || v_buffer.id;
  end loop;
  return v_out;
end $$;

/** Movimientos de una unidad terminada: los suyos (payload.moves) y, si es de un producto, su consumo de la mesa. */
create or replace function flow.moves_of(p_unit flow.units) returns jsonb language sql stable as $$
  select coalesce(p_unit.payload->'moves', '[]'::jsonb) || coalesce((
    select jsonb_agg(jsonb_build_object('buffer', r.item_key || ':mesa', 'delta', -r.per_unit, 'item_key', r.item_key, 'name', r.name, 'unit', r.unit))
      from flow.consumption_rules r where p_unit.product_id is not null and r.product_id = p_unit.product_id and r.deleted_at is null), '[]'::jsonb)
$$;

/**
 * Tras mover existencias: si un punto baja de su umbral, una propuesta de reponerlo, al final de su columna (orden por
 * creación). Una sola abierta por punto y sentido: si ya hay una propuesta, se actualiza su cantidad.
 */
create or replace function flow.propose_restock(p jsonb, p_buffers uuid[]) returns void language plpgsql as $$
declare v_b flow.buffers; v_from text; v_qty numeric; v_open flow.units; v_payload jsonb; v_label text; v_ref text; v_col text;
begin
  for v_b in select * from flow.buffers where id = any(p_buffers) and deleted_at is null and capacity > 0 loop
    if v_b.level >= v_b.capacity * v_b.threshold_pct / 100.0 then continue; end if;
    v_from := case v_b.location when 'mesa' then 'nevera' else 'fresco' end;
    v_qty := v_b.capacity - greatest(v_b.level, 0);
    v_ref := 'restock:' || v_b.key || ':' || v_from;
    v_col := coalesce((select key from flow.columns where project_id = v_b.project_id and deleted_at is null and coalesce((config->>'proposal')::boolean, false) order by position limit 1), 'ingredients');
    v_payload := jsonb_build_object('item_key', v_b.item_key, 'name', v_b.name, 'unit', v_b.unit, 'qty', v_qty, 'to', v_b.location, 'from', v_from, 'restock', v_ref,
      'moves', jsonb_build_array(jsonb_build_object('buffer', v_b.key, 'delta', v_qty))
        || case when v_from = 'nevera' then jsonb_build_array(jsonb_build_object('buffer', v_b.item_key || ':nevera', 'delta', -v_qty)) else '[]'::jsonb end);
    v_label := 'Reponer ' || v_b.name || ' a ' || v_b.location || ' desde ' || v_from;
    -- Solo cuenta lo generado por aquí: su source_ref (que una tarea a mano nunca lleva) empieza por la clave de la reposición.
    select * into v_open from flow.units
     where project_id = v_b.project_id and deleted_at is null and source_ref like v_ref || ':%' and status in ('proposed','pending','in_progress')
     order by created_at desc limit 1 for update;
    if v_open.id is null then
      perform flow.ins(p, 'flow.units', jsonb_build_object('project_id', v_b.project_id, 'column_key', v_col, 'kind', 'task', 'label', v_label,
        'status', 'proposed', 'payload', v_payload, 'source_ref', v_ref || ':' || gen_random_uuid()));
    elsif v_open.status = 'proposed' and (v_open.payload->>'qty')::numeric is distinct from v_qty then
      perform flow.upd(p, 'flow.units', v_open.id, v_open.revision, jsonb_build_object('payload', v_payload));
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- unit_step con el estado previo y los movimientos (sustituye al de la 0902)
-- ---------------------------------------------------------------------------
create or replace function flow.unit_step(p jsonb) returns jsonb language plpgsql as $$
declare v flow.units; v_from text := p->'args'->>'from'; v_actor uuid := (p->>'actor')::uuid; v_next text; v_moves jsonb; v_touched uuid[] := '{}';
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
  if v.status = 'proposed' then
    v_next := 'pending';
    perform flow.upd(p, 'flow.units', v.id, v.revision, jsonb_build_object('status', v_next));
  elsif v.status = 'pending' then
    v_next := 'in_progress';
    perform flow.upd(p, 'flow.units', v.id, v.revision, jsonb_build_object('status', v_next, 'assigned_to', v_actor));
  elsif v.status = 'in_progress' then
    v_next := 'done';
    v_moves := flow.moves_of(v);
    perform flow.upd(p, 'flow.units', v.id, v.revision, jsonb_build_object('status', v_next, 'done_at', now(), 'done_by', v_actor,
      'payload', v.payload || jsonb_build_object('applied', v_moves)));
    if jsonb_array_length(v_moves) > 0 then
      v_touched := flow.apply_moves(p, v.project_id, v_moves, 1);
      perform flow.log(p, v.project_id, 'stock_moved', v.order_id, v.id, jsonb_build_object('moves', v_moves));
    end if;
  else
    v_next := 'pending';
    v_moves := coalesce(v.payload->'applied', '[]'::jsonb);
    perform flow.upd(p, 'flow.units', v.id, v.revision, jsonb_build_object('status', v_next, 'assigned_to', null, 'done_at', null, 'done_by', null,
      'payload', v.payload - 'applied'));
    perform flow.log(p, v.project_id, 'unit_reverted', v.order_id, v.id, jsonb_build_object('doneBy', v.done_by, 'doneAt', v.done_at, 'assignedTo', v.assigned_to));
    if jsonb_array_length(v_moves) > 0 then
      v_touched := flow.apply_moves(p, v.project_id, v_moves, -1);
      perform flow.log(p, v.project_id, 'stock_reverted', v.order_id, v.id, jsonb_build_object('moves', v_moves));
    end if;
  end if;
  if array_length(v_touched, 1) is not null then perform flow.propose_restock(p, v_touched); end if;
  perform flow.proc_end();
  return jsonb_build_object('unit_id', v.id, 'from', v.status, 'status', v_next);
end $$;

-- Revisar la cantidad de una tarea antes de hacerla (propuesta o confirmada). args = { unit_id, qty, expected_revision }
create or replace function flow.unit_set_qty(p jsonb) returns jsonb language plpgsql as $$
declare v flow.units; v_qty numeric; v_old numeric; v_moves jsonb := '[]'::jsonb; v_m jsonb;
begin
  perform flow.proc_begin();
  select * into v from flow.units where id = flow.arg_uuid(p, 'unit_id') for update;
  if v.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.units')); end if;
  perform flow.check_scope(p, v.project_id);
  if v.kind <> 'task' or v.status not in ('proposed','pending') then perform core.fail('UNIT_CHANGED', 409, jsonb_build_object('unit_id', v.id, 'status', v.status)); end if;
  if (p->'args'->>'expected_revision')::bigint is distinct from v.revision then
    perform core.fail('VERSION_CONFLICT', 409, jsonb_build_object('table', 'flow.units', 'id', v.id, 'currentRevision', v.revision, 'current', to_jsonb(v)));
  end if;
  begin v_qty := (p->'args'->>'qty')::numeric; exception when others then v_qty := null; end;
  if v_qty is null or v_qty < 0 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'qty must be >= 0')); end if;
  v_old := nullif((v.payload->>'qty')::numeric, 0);
  for v_m in select * from jsonb_array_elements(coalesce(v.payload->'moves', '[]'::jsonb)) loop
    v_moves := v_moves || jsonb_build_object('buffer', v_m->>'buffer', 'delta', sign((v_m->>'delta')::numeric) * v_qty);
  end loop;
  perform flow.upd(p, 'flow.units', v.id, v.revision, jsonb_build_object('payload', v.payload || jsonb_build_object('qty', v_qty, 'moves', v_moves)));
  perform flow.proc_end();
  return jsonb_build_object('unit_id', v.id, 'qty', v_qty, 'previous', v_old);
end $$;

-- ---------------------------------------------------------------------------
-- Generación inicial desde la previsión de Food (owner). La lee el cliente con su sesión de Flow
-- (food.carta_prep_totals_projection y food.carta_prep_projection) y la pasa aquí.
-- args = { project_id, day, totals: [{component_key, name, unit, mesa, nevera, convertible}],
--          rules: [{line_id, component_key, name, unit, per_unit, convertible}] }
-- ---------------------------------------------------------------------------
create or replace function flow.generate_ingredient_tasks(p jsonb) returns jsonb language plpgsql as $$
declare
  v_project uuid := flow.arg_uuid(p, 'project_id'); v_day text := coalesce(p->'args'->>'day', to_char(now() at time zone 'Europe/Madrid', 'YYYY-MM-DD'));
  v_t jsonb; v_r jsonb; v_loc text; v_qty numeric; v_key text; v_b flow.buffers; v_ref text; v_u flow.units; v_prod uuid;
  v_created int := 0; v_updated int := 0; v_skipped jsonb := '[]'::jsonb; v_rules int := 0; v_col text; v_rule flow.consumption_rules;
begin
  perform flow.proc_begin();
  if p->>'role' <> 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'generating tasks is for the owner')); end if;
  v_col := coalesce((select key from flow.columns where project_id = v_project and deleted_at is null and coalesce((config->>'proposal')::boolean, false) order by position limit 1), 'ingredients');
  for v_t in select * from jsonb_array_elements(coalesce(p->'args'->'totals', '[]'::jsonb)) loop
    if not coalesce((v_t->>'convertible')::boolean, false) then
      v_skipped := v_skipped || jsonb_build_object('component_key', v_t->>'component_key', 'name', v_t->>'name');
      continue;
    end if;
    foreach v_loc in array array['mesa','nevera'] loop
      v_qty := (v_t->>v_loc)::numeric;
      if v_qty is null or v_qty <= 0 then continue; end if;
      v_key := (v_t->>'component_key') || ':' || v_loc;
      select * into v_b from flow.buffers where project_id = v_project and key = v_key and deleted_at is null for update;
      if v_b.id is null then
        perform flow.ins(p, 'flow.buffers', jsonb_build_object('project_id', v_project, 'key', v_key, 'item_key', v_t->>'component_key', 'name', v_t->>'name',
          'unit', v_t->>'unit', 'location', v_loc, 'capacity', v_qty, 'level', 0));
      elsif v_b.capacity <> v_qty then
        perform flow.upd(p, 'flow.buffers', v_b.id, v_b.revision, jsonb_build_object('capacity', v_qty));
      end if;
      v_ref := 'gen:' || v_day || ':' || v_key;
      select * into v_u from flow.units where project_id = v_project and source_ref = v_ref and deleted_at is null for update;
      if v_u.id is null then
        perform flow.ins(p, 'flow.units', jsonb_build_object('project_id', v_project, 'column_key', v_col, 'kind', 'task', 'status', 'proposed', 'source_ref', v_ref,
          'label', 'Preparar ' || (v_t->>'name') || ' para ' || v_loc,
          'payload', jsonb_build_object('item_key', v_t->>'component_key', 'name', v_t->>'name', 'unit', v_t->>'unit', 'qty', v_qty, 'to', v_loc, 'from', 'fresco',
            'moves', jsonb_build_array(jsonb_build_object('buffer', v_key, 'delta', v_qty)))));
        v_created := v_created + 1;
      elsif v_u.status = 'proposed' and (v_u.payload->>'qty')::numeric is distinct from v_qty then
        perform flow.upd(p, 'flow.units', v_u.id, v_u.revision, jsonb_build_object('payload', v_u.payload || jsonb_build_object('qty', v_qty,
          'moves', jsonb_build_array(jsonb_build_object('buffer', v_key, 'delta', v_qty)))));
        v_updated := v_updated + 1;
      end if;
    end loop;
  end loop;
  -- Reglas de consumo: se sustituyen por las de la carta vigente (por la línea de Food de cada producto).
  for v_rule in select * from flow.consumption_rules where project_id = v_project and deleted_at is null for update loop
    perform flow.row_op(p, jsonb_build_object('op', 'delete', 'table', 'flow.consumption_rules', 'id', v_rule.id, 'expectedRevision', v_rule.revision));
  end loop;
  for v_r in select * from jsonb_array_elements(coalesce(p->'args'->'rules', '[]'::jsonb)) loop
    if not coalesce((v_r->>'convertible')::boolean, false) or (v_r->>'per_unit') is null then continue; end if;
    select id into v_prod from flow.products where project_id = v_project and source_line_id = (v_r->>'line_id')::uuid and deleted_at is null;
    if v_prod is null then continue; end if;
    perform flow.ins(p, 'flow.consumption_rules', jsonb_build_object('project_id', v_project, 'product_id', v_prod, 'item_key', v_r->>'component_key',
      'name', v_r->>'name', 'unit', v_r->>'unit', 'per_unit', (v_r->>'per_unit')::numeric));
    v_rules := v_rules + 1;
  end loop;
  perform flow.log(p, v_project, 'tasks_generated', null, null, jsonb_build_object('day', v_day, 'created', v_created, 'updated', v_updated, 'rules', v_rules, 'skipped', v_skipped));
  perform flow.proc_end();
  return jsonb_build_object('created', v_created, 'updated', v_updated, 'rules', v_rules, 'skipped', v_skipped);
end $$;

select core.allow_procedure('flow', 'flow.unit_set_qty');
select core.allow_procedure('flow', 'flow.generate_ingredient_tasks');
select core.allow_outsider_procedure('flow', 'flow.unit_set_qty');

-- ---------------------------------------------------------------------------
-- Cierre del día: consumo estimado por ingrediente (lo aplicado por las unidades de producto terminadas ese día)
-- ---------------------------------------------------------------------------
alter function flow.day_summary(uuid, date) rename to day_summary_v1;
create or replace function flow.day_summary(p_project uuid, p_day date) returns jsonb language sql stable as $$
  select flow.day_summary_v1(p_project, p_day) || jsonb_build_object('consumption', coalesce((
    select jsonb_agg(jsonb_build_object('item_key', item_key, 'name', name, 'unit', unit, 'qty', qty) order by name)
      from (select m->>'item_key' as item_key, max(m->>'name') as name, max(m->>'unit') as unit, -sum((m->>'delta')::numeric) as qty
              from flow.units u, jsonb_array_elements(coalesce(u.payload->'applied', '[]'::jsonb)) m
             where u.project_id = p_project and u.deleted_at is null and u.status = 'done' and u.product_id is not null
               and (u.done_at at time zone 'Europe/Madrid')::date = p_day and m ? 'item_key'
             group by m->>'item_key') x), '[]'::jsonb))
$$;

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
