-- Ikisai Flow · gasto real y aviso de compra (encargo de VG del 27-10, paso 3; para la v2).
-- - Con `fresh_stock` en la config de la columna de propuestas (solo la v2 lo lleva, por plantilla), cada ingrediente
--   tiene también un punto «fresco» (lo comprado sin preparar). Reponer la nevera lo descuenta; si baja de su umbral, se
--   propone «Comprar X», que se pide a Tasks de un toque como compra.
-- - `flow.stock_view`: mesa, nevera y fresco por ingrediente, con lo consumido hoy (vista Existencias del Inicio).
-- La v1 no cambia: no tiene `fresh_stock` ni puntos «fresco», y la reposición solo se amplía donde existen.

-- ---------------------------------------------------------------------------
-- Ajustes de columna por plantilla (los aplica «Nueva versión» desde una versión mínima)
-- ---------------------------------------------------------------------------
create table flow.template_column_patches (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  template_key text not null check (template_key ~ '^[a-z][a-z0-9_]{1,30}$'),
  min_version integer not null default 1 check (min_version >= 1),
  column_key text not null check (column_key ~ '^[a-z][a-z0-9_]{1,30}$'),
  config_patch jsonb not null default '{}'::jsonb
);
select core.register_table('flow', 'flow', 'template_column_patches', array['template_key','min_version','column_key','config_patch'], '{owner}', '{owner}', true);
insert into flow.template_column_patches (template_key, min_version, column_key, config_patch) values
  ('barra', 2, 'ingredients', '{"fresh_stock": true}'::jsonb);

alter function flow.new_version(jsonb) rename to new_version_station;
create or replace function flow.new_version(p jsonb) returns jsonb language plpgsql as $$
declare v_out jsonb; v_patch flow.template_column_patches; v_col flow.columns;
begin
  v_out := flow.new_version_station(p);
  perform flow.proc_begin();
  for v_patch in select * from flow.template_column_patches where deleted_at is null and template_key = v_out->>'template_key'
                   and min_version <= (v_out->>'template_version')::int order by min_version loop
    select * into v_col from flow.columns where project_id = (v_out->>'project_id')::uuid and key = v_patch.column_key and deleted_at is null;
    if v_col.id is not null then
      perform flow.upd(p, 'flow.columns', v_col.id, v_col.revision, jsonb_build_object('config', v_col.config || v_patch.config_patch));
    end if;
  end loop;
  perform flow.proc_end();
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- Generación: con fresh_stock, también el punto «fresco» (capacidad = lo previsto en fresco; empieza lleno)
-- ---------------------------------------------------------------------------
alter function flow.generate_ingredient_tasks(jsonb) rename to generate_ingredient_tasks_base;
create or replace function flow.generate_ingredient_tasks(p jsonb) returns jsonb language plpgsql as $$
declare v_out jsonb; v_project uuid := flow.arg_uuid(p, 'project_id'); v_t jsonb; v_qty numeric; v_key text; v_b flow.buffers; v_fresh int := 0;
begin
  v_out := flow.generate_ingredient_tasks_base(p);
  if not exists (select 1 from flow.columns where project_id = v_project and deleted_at is null and coalesce((config->>'fresh_stock')::boolean, false)) then
    return v_out;
  end if;
  perform flow.proc_begin();
  for v_t in select * from jsonb_array_elements(coalesce(p->'args'->'totals', '[]'::jsonb)) loop
    if not coalesce((v_t->>'convertible')::boolean, false) then continue; end if;
    v_qty := (v_t->>'fresco')::numeric;
    if v_qty is null or v_qty <= 0 then continue; end if;
    v_key := (v_t->>'component_key') || ':fresco';
    select * into v_b from flow.buffers where project_id = v_project and key = v_key and deleted_at is null for update;
    if v_b.id is null then
      perform flow.ins(p, 'flow.buffers', jsonb_build_object('project_id', v_project, 'key', v_key, 'item_key', v_t->>'component_key', 'name', v_t->>'name',
        'unit', v_t->>'unit', 'location', 'fresco', 'capacity', v_qty, 'level', v_qty));
      v_fresh := v_fresh + 1;
    elsif v_b.capacity <> v_qty then
      perform flow.upd(p, 'flow.buffers', v_b.id, v_b.revision, jsonb_build_object('capacity', v_qty));
    end if;
  end loop;
  perform flow.proc_end();
  return v_out || jsonb_build_object('fresh', v_fresh);
end $$;

-- ---------------------------------------------------------------------------
-- Reposición (amplía la de la 0904): reponer nevera descuenta de fresco si existe; fresco bajo umbral → «Comprar X»
-- ---------------------------------------------------------------------------
create or replace function flow.propose_restock(p jsonb, p_buffers uuid[]) returns void language plpgsql as $$
declare v_b flow.buffers; v_from text; v_qty numeric; v_open flow.units; v_payload jsonb; v_label text; v_ref text; v_col text; v_moves jsonb; v_purchase boolean;
begin
  for v_b in select * from flow.buffers where id = any(p_buffers) and deleted_at is null and capacity > 0 loop
    if v_b.level >= v_b.capacity * v_b.threshold_pct / 100.0 then continue; end if;
    v_purchase := v_b.location = 'fresco';
    v_from := case v_b.location when 'mesa' then 'nevera' when 'nevera' then 'fresco' else null end;
    v_qty := v_b.capacity - greatest(v_b.level, 0);
    v_ref := 'restock:' || v_b.key || ':' || coalesce(v_from, 'compra');
    v_col := coalesce((select key from flow.columns where project_id = v_b.project_id and deleted_at is null and coalesce((config->>'proposal')::boolean, false) order by position limit 1), 'ingredients');
    v_moves := jsonb_build_array(jsonb_build_object('buffer', v_b.key, 'delta', v_qty));
    if v_from = 'nevera' then
      v_moves := v_moves || jsonb_build_array(jsonb_build_object('buffer', v_b.item_key || ':nevera', 'delta', -v_qty));
    elsif v_from = 'fresco' and exists (select 1 from flow.buffers where project_id = v_b.project_id and key = v_b.item_key || ':fresco' and deleted_at is null) then
      v_moves := v_moves || jsonb_build_array(jsonb_build_object('buffer', v_b.item_key || ':fresco', 'delta', -v_qty));
    end if;
    v_payload := jsonb_build_object('item_key', v_b.item_key, 'name', v_b.name, 'unit', v_b.unit, 'qty', v_qty, 'to', v_b.location, 'from', v_from,
      'restock', v_ref, 'moves', v_moves) || case when v_purchase then jsonb_build_object('purchase', true) else '{}'::jsonb end;
    v_label := case when v_purchase then 'Comprar ' || v_b.name else 'Reponer ' || v_b.name || ' a ' || v_b.location || ' desde ' || v_from end;
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
-- Existencias: por ingrediente, mesa / nevera / fresco y lo consumido hoy (hora de Madrid). args = { project_id }
-- ---------------------------------------------------------------------------
create or replace function flow.stock_view(p jsonb) returns jsonb language sql stable as $$
  with pr as (select (p->'args'->>'project_id')::uuid as id),
  ok as (select id from pr where flow.in_scope((p->>'actor')::uuid, id)),
  items as (
    select b.item_key, max(b.name) as name, max(b.unit) as unit,
           jsonb_object_agg(b.location, jsonb_build_object('level', b.level, 'capacity', b.capacity, 'threshold_pct', b.threshold_pct)) as places
      from flow.buffers b join ok on ok.id = b.project_id where b.deleted_at is null group by b.item_key
  ),
  consumed as (
    select m->>'item_key' as item_key, -sum((m->>'delta')::numeric) as qty
      from flow.units u join ok on ok.id = u.project_id, jsonb_array_elements(coalesce(u.payload->'applied', '[]'::jsonb)) m
     where u.deleted_at is null and u.status = 'done' and u.product_id is not null and m ? 'item_key'
       and (u.done_at at time zone 'Europe/Madrid')::date = (now() at time zone 'Europe/Madrid')::date
     group by m->>'item_key'
  )
  select coalesce(jsonb_agg(jsonb_build_object('item_key', i.item_key, 'name', i.name, 'unit', i.unit, 'places', i.places,
           'consumed_today', coalesce(c.qty, 0)) order by i.name), '[]'::jsonb)
    from items i left join consumed c on c.item_key = i.item_key
$$;
select core.allow_read('flow', 'flow.stock_view', 'function', '{reader,editor,owner,outsider}');

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
