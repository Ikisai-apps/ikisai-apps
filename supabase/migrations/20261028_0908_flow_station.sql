-- Ikisai Flow · comportamiento «station» (puesto) con métrica en vivo (encargo de VG del 27-10, paso 2; para la v2).
-- - Un puesto es una unidad que no se termina: un toque la ocupa (assigned_to = quien toca), otro la suelta.
-- - Lleva una métrica calculada en el servidor (`flow.station_metrics`), enchufable: una función `flow.metric_<clave>` por
--   métrica. La primera, `bread_ahead`. Nada de productos concretos en el código: los textos y parámetros van en la unidad.
-- - Las unidades de plantilla (`flow.template_units`) las añade «Nueva versión» desde una versión mínima: así el puesto
--   de la barra entra en la v2 sin tocar la v1.

alter table flow.units drop constraint units_kind_check;
alter table flow.units add constraint units_kind_check check (kind in ('prep','task','station'));

-- ---------------------------------------------------------------------------
-- Unidades de plantilla
-- ---------------------------------------------------------------------------
create table flow.template_units (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  template_key text not null check (template_key ~ '^[a-z][a-z0-9_]{1,30}$'),
  min_version integer not null default 1 check (min_version >= 1),
  column_key text not null check (column_key ~ '^[a-z][a-z0-9_]{1,30}$'),
  kind text not null check (kind in ('task','station')),
  label text not null check (length(label) between 1 and 120),
  payload jsonb not null default '{}'::jsonb,
  position integer not null default 0
);
select core.register_table('flow', 'flow', 'template_units', array['template_key','min_version','column_key','kind','label','payload','position'], '{owner}', '{owner}', true);

insert into flow.template_units (template_key, min_version, column_key, kind, label, payload, position) values
  ('barra', 2, 'logistics', 'station', 'Pan', jsonb_build_object(
    'metric', 'bread_ahead',
    'params', jsonb_build_object('lookback_min', 5, 'per_order_cap', 4, 'warmup_min', 1, 'lead_min', 1,
      'tiers', jsonb_build_array(jsonb_build_object('upto', 2, 'pct', 60), jsonb_build_object('upto', 8, 'pct', 30), jsonb_build_object('upto', null, 'pct', 0))),
    'text', 'Ahora deben estar calentándose {target} panes · {rate} montaditos/min',
    'notice', 'Pan: {target} calentándose',
    'notice_in', jsonb_build_array('prep')), 1);

-- «Nueva versión» añade las unidades de plantilla que tocan a esa versión.
alter function flow.new_version(jsonb) rename to new_version_media;
create or replace function flow.new_version(p jsonb) returns jsonb language plpgsql as $$
declare v_out jsonb; v_t flow.template_units;
begin
  v_out := flow.new_version_media(p);
  perform flow.proc_begin();
  for v_t in select * from flow.template_units where deleted_at is null and template_key = v_out->>'template_key'
               and min_version <= (v_out->>'template_version')::int order by position loop
    perform flow.ins(p, 'flow.units', jsonb_build_object('project_id', (v_out->>'project_id')::uuid, 'column_key', v_t.column_key, 'kind', v_t.kind,
      'label', v_t.label, 'status', 'pending', 'payload', v_t.payload));
  end loop;
  perform flow.proc_end();
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- Métricas
-- ---------------------------------------------------------------------------
/**
 * bread_ahead: cuánto hay que tener preparándose ahora según el ritmo de entrada.
 * Entrada: unidades de preparación de los pedidos cobrados en los últimos `lookback_min` minutos, como mucho
 * `per_order_cap` por pedido. rate = unidades / lookback_min; expected = rate × (warmup_min + lead_min); descuento por
 * tramos según rate (`tiers`: [{upto, pct}], el último con upto null); target = floor(expected × (1 − pct/100)).
 */
create or replace function flow.metric_bread_ahead(p_project uuid, p_params jsonb) returns jsonb language plpgsql stable as $$
declare
  v_lookback numeric := greatest(coalesce((p_params->>'lookback_min')::numeric, 5), 0.5);
  v_cap int := greatest(coalesce((p_params->>'per_order_cap')::int, 4), 1);
  v_ahead numeric := coalesce((p_params->>'warmup_min')::numeric, 1) + coalesce((p_params->>'lead_min')::numeric, 1);
  v_units int; v_rate numeric; v_expected numeric; v_pct numeric := 0; v_tier jsonb;
begin
  select coalesce(sum(least(n, v_cap)), 0) into v_units from (
    select count(*) as n from flow.units u join flow.orders o on o.id = u.order_id
     where u.project_id = p_project and u.kind = 'prep' and u.deleted_at is null and u.status <> 'cancelled'
       and o.paid_at >= now() - make_interval(secs => (v_lookback * 60)::double precision)
     group by u.order_id) x;
  v_rate := v_units / v_lookback;
  v_expected := v_rate * v_ahead;
  for v_tier in select * from jsonb_array_elements(coalesce(p_params->'tiers', '[{"upto": null, "pct": 0}]'::jsonb)) loop
    if v_tier->>'upto' is null or v_rate <= (v_tier->>'upto')::numeric then v_pct := coalesce((v_tier->>'pct')::numeric, 0); exit; end if;
  end loop;
  return jsonb_build_object('target', floor(v_expected * (1 - v_pct / 100))::int, 'rate', round(v_rate, 2), 'window', v_lookback,
    'units', v_units, 'pct', v_pct);
end $$;

/** Métricas de los puestos de un proyecto (las de las claves que existan). args = { project_id } */
create or replace function flow.station_metrics(p jsonb) returns jsonb language plpgsql stable as $$
declare v_project uuid := (p->'args'->>'project_id')::uuid; v_u flow.units; v_key text; v_out jsonb := '[]'::jsonb; v_value jsonb;
begin
  if v_project is null or not flow.in_scope((p->>'actor')::uuid, v_project) then return v_out; end if;
  for v_u in select * from flow.units where project_id = v_project and kind = 'station' and deleted_at is null order by created_at loop
    v_key := v_u.payload->>'metric';
    if v_key is null or v_key !~ '^[a-z][a-z0-9_]{1,40}$' or to_regprocedure(format('flow.metric_%s(uuid, jsonb)', v_key)) is null then continue; end if;
    execute format('select flow.metric_%s($1, $2)', v_key) into v_value using v_project, coalesce(v_u.payload->'params', '{}'::jsonb);
    v_out := v_out || jsonb_build_object('unit_id', v_u.id, 'metric', v_key, 'value', v_value);
  end loop;
  return v_out;
end $$;
select core.allow_read('flow', 'flow.station_metrics', 'function', '{reader,editor,owner,outsider}');

-- ---------------------------------------------------------------------------
-- Ocupar y soltar un puesto (dentro de unit_step, solo para kind 'station': las demás unidades no cambian)
-- ---------------------------------------------------------------------------
alter function flow.unit_step(jsonb) rename to unit_step_units;
create or replace function flow.unit_step(p jsonb) returns jsonb language plpgsql as $$
declare v flow.units; v_from text := p->'args'->>'from'; v_next text;
begin
  select * into v from flow.units where id = flow.arg_uuid(p, 'unit_id');
  if v.id is null or v.kind <> 'station' then return flow.unit_step_units(p); end if;
  perform flow.proc_begin();
  select * into v from flow.units where id = v.id for update;
  perform flow.check_scope(p, v.project_id);
  if v.deleted_at is not null then perform core.fail('ROW_DELETED', 409, jsonb_build_object('table', 'flow.units', 'id', v.id)); end if;
  if v_from is distinct from v.status then
    perform core.fail('UNIT_CHANGED', 409, jsonb_build_object('unit_id', v.id, 'expected', v_from, 'status', v.status, 'assignedTo', v.assigned_to, 'current', to_jsonb(v)));
  end if;
  if v.status = 'pending' then
    v_next := 'in_progress';
    perform flow.upd(p, 'flow.units', v.id, v.revision, jsonb_build_object('status', v_next, 'assigned_to', (p->>'actor')::uuid));
  else
    v_next := 'pending';
    perform flow.upd(p, 'flow.units', v.id, v.revision, jsonb_build_object('status', v_next, 'assigned_to', null));
  end if;
  perform flow.proc_end();
  return jsonb_build_object('unit_id', v.id, 'from', v.status, 'status', v_next);
end $$;

/** Parámetros de la métrica de un puesto (owner, desde su tarjeta). args = { unit_id, params, expected_revision } */
create or replace function flow.station_set_params(p jsonb) returns jsonb language plpgsql as $$
declare v flow.units; v_params jsonb := p->'args'->'params'; v_k text;
begin
  perform flow.proc_begin();
  if p->>'role' <> 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'station parameters are for the owner')); end if;
  select * into v from flow.units where id = flow.arg_uuid(p, 'unit_id') for update;
  if v.id is null or v.kind <> 'station' then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.units')); end if;
  if (p->'args'->>'expected_revision')::bigint is distinct from v.revision then
    perform core.fail('VERSION_CONFLICT', 409, jsonb_build_object('table', 'flow.units', 'id', v.id, 'currentRevision', v.revision, 'current', to_jsonb(v)));
  end if;
  if jsonb_typeof(v_params) <> 'object' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'params must be an object')); end if;
  for v_k in select jsonb_object_keys(v_params) loop
    if v_k <> 'tiers' and (jsonb_typeof(v_params->v_k) <> 'number' or (v_params->>v_k)::numeric < 0) then
      perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'numeric params >= 0', 'param', v_k));
    end if;
  end loop;
  perform flow.upd(p, 'flow.units', v.id, v.revision, jsonb_build_object('payload', v.payload || jsonb_build_object('params', coalesce(v.payload->'params', '{}'::jsonb) || v_params)));
  perform flow.proc_end();
  return jsonb_build_object('unit_id', v.id, 'params', coalesce(v.payload->'params', '{}'::jsonb) || v_params);
end $$;
select core.allow_procedure('flow', 'flow.station_set_params');

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
