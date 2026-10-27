-- Ikisai Flow · editor de flujos (encargo de VG del 27-10, paso 6).
-- - Piezas: cada columna es una pieza conocida (su clave de datos), con su comportamiento fijo, su config base y sus
--   opciones (interruptores booleanos). Así las columnas de un flujo nuevo funcionan con las vistas que ya existen.
--     order (Caja, inspect_confirm; accounts) · prep (quick_steps) · ingredients (quick_steps; fresh_stock)
--     service (inspect_confirm; complete_on_delivery) · logistics (free_task) · arrival/bed/signature/departure (guest_presence)
-- - `create_flow` (sustituye al de la 0911): desde una plantilla, desde una lista de columnas o ambas (la lista manda). La
--   versión es la siguiente de esa plantilla en ese evento, y se aplican los ajustes de plantilla que le toquen.
-- - `save_template`: guarda las columnas de un flujo como nueva versión de una plantilla (la barra y el check-in se
--   reconstruyen desde el editor). Se siembra la plantilla `barra` v1 con las columnas de «Barra · v1».
-- - Editar las columnas de un flujo no congelado es escritura normal del owner sobre flow.columns (como hasta ahora).

create or replace function flow.piece_behavior(p_key text) returns text language sql immutable as $$
  select case p_key
    when 'order' then 'inspect_confirm' when 'service' then 'inspect_confirm'
    when 'prep' then 'quick_steps' when 'ingredients' then 'quick_steps'
    when 'logistics' then 'free_task'
    when 'arrival' then 'guest_presence' when 'bed' then 'guest_presence' when 'signature' then 'guest_presence' when 'departure' then 'guest_presence'
  end
$$;

create or replace function flow.piece_config(p_key text, p_options jsonb) returns jsonb language plpgsql immutable as $$
declare v_base jsonb; v_allowed text[]; v_k text;
begin
  v_base := case p_key
    when 'ingredients' then '{"proposal": true, "manual": true}'::jsonb
    when 'logistics' then '{"manual": true}'::jsonb
    when 'arrival' then '{"stage": "arrival"}'::jsonb when 'bed' then '{"stage": "bed"}'::jsonb
    when 'signature' then '{"stage": "signature"}'::jsonb when 'departure' then '{"stage": "departure"}'::jsonb
    else '{}'::jsonb end;
  v_allowed := case p_key when 'order' then array['accounts'] when 'service' then array['complete_on_delivery']
    when 'ingredients' then array['fresh_stock'] else array[]::text[] end;
  if p_options is null or jsonb_typeof(p_options) <> 'object' then return v_base; end if;
  for v_k in select jsonb_object_keys(p_options) loop
    if not (v_k = any(v_allowed)) or jsonb_typeof(p_options->v_k) <> 'boolean' then
      perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'unknown option for this piece', 'piece', p_key, 'option', v_k));
    end if;
    if (p_options->>v_k)::boolean then v_base := v_base || jsonb_build_object(v_k, true); end if;
  end loop;
  return v_base;
end $$;

-- ---------------------------------------------------------------------------
-- Nuevo flujo. args = { project_id, template_key?, name?, columns?: [{ key, label?, options? }], booking_event_id?,
--   starts_on?, ends_on? }. Solo el owner. Sin plantilla ni columnas, error.
-- ---------------------------------------------------------------------------
create or replace function flow.create_flow(p jsonb) returns jsonb language plpgsql as $$
declare
  v_id uuid := flow.arg_uuid(p, 'project_id'); v_key text := nullif(p->'args'->>'template_key', ''); v_tversion int; v_base text;
  v_name text; v_event uuid; v_version int; v_c jsonb; v_pos int := 0; v_t flow.template_columns; v_patch flow.template_column_patches;
  v_cols jsonb := p->'args'->'columns'; v_seen text[] := '{}'; v_label text; v_col flow.columns;
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

-- Guardar las columnas de un flujo como nueva versión de una plantilla. args = { project_id, template_key, label_base }
create or replace function flow.save_template(p jsonb) returns jsonb language plpgsql as $$
declare v_project uuid := flow.arg_uuid(p, 'project_id'); v_key text := p->'args'->>'template_key'; v_base text := btrim(coalesce(p->'args'->>'label_base', ''));
  v_version int; v_c flow.columns; v_n int := 0;
begin
  perform flow.proc_begin();
  if p->>'role' <> 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'templates are for the owner')); end if;
  if v_key is null or v_key !~ '^[a-z][a-z0-9_]{1,30}$' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'template_key')); end if;
  if v_base = '' or length(v_base) > 80 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'label_base must be 1..80')); end if;
  select coalesce(max(version), 0) + 1 into v_version from flow.template_columns where template_key = v_key;
  for v_c in select * from flow.columns where project_id = v_project and deleted_at is null order by position loop
    perform flow.ins(p, 'flow.template_columns', jsonb_build_object('template_key', v_key, 'version', v_version, 'label_base', v_base,
      'key', v_c.key, 'label', v_c.label, 'behavior', v_c.behavior, 'config', v_c.config, 'position', v_c.position));
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.columns', 'project_id', v_project)); end if;
  perform flow.proc_end();
  return jsonb_build_object('template_key', v_key, 'version', v_version, 'columns', v_n);
end $$;

select core.allow_procedure('flow', 'flow.save_template');

-- La plantilla `barra` v1, con las columnas de «Barra · v1» (sin los ajustes de la v2, que añade la propia plantilla).
insert into flow.template_columns (template_key, version, label_base, key, label, behavior, config, position)
select 'barra', 1, 'Barra', c.key, c.label, c.behavior, c.config, c.position
  from flow.columns c where c.project_id = '0f10a000-0000-4000-8000-000000000001' and c.deleted_at is null
    and not exists (select 1 from flow.template_columns t where t.template_key = 'barra');

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
