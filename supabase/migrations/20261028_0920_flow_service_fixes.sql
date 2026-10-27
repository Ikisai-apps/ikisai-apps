-- Ikisai Flow · arreglos de la prueba de extremo a extremo del servicio del sábado (encargo de Core, 27-10).
-- - `create_flow` desde la plantilla `barra` en un evento nuevo creaba una v1: sin los ajustes de la v2 (cuentas, caja
--   profunda, entregar de una vez, fresco) y sin el puesto «Pan». Ahora la versión nunca queda por debajo de la de la
--   plantilla, se siembra `barra` v2 (columnas de la v1 con los ajustes de la v2) y se añaden las unidades de plantilla.

insert into flow.template_columns (template_key, version, label_base, key, label, behavior, config, position)
select t.template_key, 2, t.label_base, t.key, t.label, t.behavior,
       t.config || coalesce((select jsonb_object_agg(e.key, e.value) from flow.template_column_patches pt, jsonb_each(pt.config_patch) e
                              where pt.template_key = 'barra' and pt.min_version <= 2 and pt.column_key = t.key and pt.deleted_at is null), '{}'::jsonb),
       t.position
  from flow.template_columns t
 where t.template_key = 'barra' and t.version = 1 and t.deleted_at is null
   and not exists (select 1 from flow.template_columns x where x.template_key = 'barra' and x.version = 2);

create or replace function flow.create_flow(p jsonb) returns jsonb language plpgsql as $$
declare
  v_id uuid := flow.arg_uuid(p, 'project_id'); v_key text := nullif(p->'args'->>'template_key', ''); v_tversion int; v_base text;
  v_name text; v_event uuid; v_version int; v_c jsonb; v_pos int := 0; v_t flow.template_columns; v_patch flow.template_column_patches;
  v_cols jsonb := p->'args'->'columns'; v_seen text[] := '{}'; v_label text; v_col flow.columns; v_u flow.template_units;
begin
  perform flow.proc_begin();
  if p->>'role' <> 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'a new flow is for the owner')); end if;
  if v_key is not null then
    if v_key !~ '^[a-z][a-z0-9_]{1,30}$' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'template_key')); end if;
    select max(version) into v_tversion from flow.template_columns where template_key = v_key and deleted_at is null;
    if v_tversion is null and v_cols is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.template_columns', 'template_key', v_key)); end if;
    select label_base into v_base from flow.template_columns where template_key = v_key and version = v_tversion and deleted_at is null limit 1;
  end if;
  if v_key is null and (v_cols is null or jsonb_typeof(v_cols) <> 'array' or jsonb_array_length(v_cols) = 0) then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'template_key or columns required'));
  end if;
  if coalesce(p->'args'->>'booking_event_id', '') <> '' then v_event := flow.arg_uuid(p, 'booking_event_id'); end if;
  -- Versión: la siguiente de esa plantilla en ese evento (las de la barra las numera también «Nueva versión»).
  if v_key is not null then
    select coalesce(max(template_version), 0) + 1 into v_version from flow.projects
     where template_key = v_key and deleted_at is null and booking_event_id is not distinct from v_event;
    -- Nunca por debajo de la versión de la plantilla: la barra de un evento nuevo nace como v2 (0920).
    v_version := greatest(v_version, coalesce(v_tversion, 1));
  end if;
  v_name := coalesce(nullif(btrim(p->'args'->>'name'), ''), coalesce(v_base, 'Flujo') || coalesce(' · v' || v_version, ''));
  if length(v_name) > 120 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'name too long')); end if;
  perform flow.ins(p, 'flow.projects', jsonb_build_object('name', v_name, 'status', 'active', 'template_key', v_key, 'template_version', v_version,
    'booking_event_id', v_event, 'starts_on', nullif(p->'args'->>'starts_on', ''), 'ends_on', nullif(p->'args'->>'ends_on', '')), v_id);

  if v_cols is not null and jsonb_typeof(v_cols) = 'array' and jsonb_array_length(v_cols) > 0 then
    if jsonb_array_length(v_cols) > 12 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'at most 12 columns')); end if;
    for v_c in select * from jsonb_array_elements(v_cols) loop
      if flow.piece_behavior(v_c->>'key') is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'unknown piece', 'key', v_c->>'key')); end if;
      if (v_c->>'key') = any(v_seen) then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'each piece once', 'key', v_c->>'key')); end if;
      v_seen := v_seen || (v_c->>'key');
      v_label := coalesce(nullif(btrim(v_c->>'label'), ''), v_c->>'key');
      v_pos := v_pos + 1;
      perform flow.ins(p, 'flow.columns', jsonb_build_object('project_id', v_id, 'key', v_c->>'key', 'label', left(v_label, 60),
        'behavior', flow.piece_behavior(v_c->>'key'), 'position', v_pos, 'config', flow.piece_config(v_c->>'key', v_c->'options')));
    end loop;
  else
    for v_t in select * from flow.template_columns where template_key = v_key and version = v_tversion and deleted_at is null order by position loop
      perform flow.ins(p, 'flow.columns', jsonb_build_object('project_id', v_id, 'key', v_t.key, 'label', v_t.label, 'behavior', v_t.behavior,
        'position', v_t.position, 'config', v_t.config));
    end loop;
  end if;
  -- Unidades de plantilla de esta versión (p. ej. el puesto «Pan» de la barra desde la v2), como «Nueva versión» (0920).
  if v_key is not null then
    for v_u in select * from flow.template_units where deleted_at is null and template_key = v_key and min_version <= v_version order by position loop
      perform flow.ins(p, 'flow.units', jsonb_build_object('project_id', v_id, 'column_key', v_u.column_key, 'kind', v_u.kind,
        'label', v_u.label, 'status', 'pending', 'payload', v_u.payload));
    end loop;
  end if;
  -- Ajustes de plantilla que tocan a esta versión (p. ej. la barra desde la v2), sin pisar lo elegido.
  if v_key is not null then
    for v_patch in select * from flow.template_column_patches where deleted_at is null and template_key = v_key and min_version <= v_version loop
      select * into v_col from flow.columns where project_id = v_id and key = v_patch.column_key and deleted_at is null;
      if v_col.id is not null and v_cols is null then
        perform flow.upd(p, 'flow.columns', v_col.id, v_col.revision, jsonb_build_object('config', v_patch.config_patch || v_col.config));
      end if;
    end loop;
  end if;
  perform flow.proc_end();
  return jsonb_build_object('project_id', v_id, 'name', v_name, 'template_key', v_key, 'template_version', v_version);
end $$;

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;

-- ---------------------------------------------------------------------------
-- Capacidades que Flow ofrece a otras apps (catálogo del núcleo, 0097). Se invocan por la Edge de quien las ofrece con el
-- token de la persona: su rol en Flow y su ámbito deciden.
-- ---------------------------------------------------------------------------
/** Resumen del día de un flujo (lo mismo que se cierra), para la Edge (ruta `POST day-summary`). args = { project_id, day } */
create or replace function flow.day_summary_read(p jsonb) returns jsonb language plpgsql stable as $$
declare v_project uuid; v_day date;
begin
  begin v_project := (p->'args'->>'project_id')::uuid; v_day := (p->'args'->>'day')::date; exception when others then v_project := null; end;
  if v_project is null or v_day is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'project_id and day required')); end if;
  if not flow.in_scope((p->>'actor')::uuid, v_project) then perform core.fail('PROJECT_OUT_OF_SCOPE', 403, jsonb_build_object('project_id', v_project)); end if;
  return flow.day_summary(v_project, v_day);
end $$;
select core.allow_read('flow', 'flow.day_summary_read', 'function', '{owner}');

select core.register_capability(jsonb_build_object(
  'id', 'flow' || '.day_summary', 'app', 'flow', 'kind', 'read', 'title', 'Resumen del día de un flujo',
  'description', 'Lo vendido, el dinero por método, las devoluciones pendientes y el consumo estimado de un día de una barra (hora de Madrid).',
  'route', 'POST day-summary', 'roles', jsonb_build_array('owner'), 'risk', 'low', 'idempotent', true,
  'input', '{"type":"object","required":["project_id","day"],"properties":{"project_id":{"type":"string","format":"uuid"},"day":{"type":"string","format":"date"}}}'::jsonb,
  'output', '{"type":"object","properties":{"sales_cents":{"type":"integer"},"sales_by_method":{"type":"object"},"units_by_product":{"type":"array"},"consumption":{"type":"array"}}}'::jsonb,
  'anchors', jsonb_build_array('flow.cierre'), 'since', '0920'));
select core.register_capability(jsonb_build_object(
  'id', 'flow' || '.logistics_task', 'app', 'flow', 'kind', 'execute', 'title', 'Crear tarea de Logística en un flujo',
  'description', 'Una tarea libre en la columna Logística de una barra (montaje, reposición, avisos). Idempotente por requestId.',
  'route', 'POST logistics-task', 'roles', jsonb_build_array('editor', 'owner'), 'risk', 'low', 'idempotent', true, 'reversible', true,
  'input', '{"type":"object","required":["requestId","project_id","label"],"properties":{"requestId":{"type":"string"},"project_id":{"type":"string","format":"uuid"},"label":{"type":"string","maxLength":120},"priority":{"type":"boolean"}}}'::jsonb,
  'output', '{"type":"object","properties":{"id":{"type":"string","format":"uuid"},"replayed":{"type":"boolean"}}}'::jsonb,
  'anchors', jsonb_build_array('flow.logistica'), 'since', '0920'));

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
