-- Flow 0959: aplicaciones de cada tarjeta del tablero (VG, 28-10, vista «Por app» del Avance).
-- - `flow.board_card` acepta `apps` (lista de claves de carril de las aplicaciones en las que se hace la tarea, puestas a mano;
--   null o lista vacía = las que salgan solas de sus enlaces) y la guarda en `payload.apps`.
-- - `flow.import_board` conserva las `apps` ya puestas si la carga no las trae (una recarga del tablero no borra lo agrupado a mano).
-- Sin columnas nuevas: lo demás de ambas funciones queda como en 0947.

create or replace function flow.board_card(p jsonb) returns jsonb language plpgsql as $$
declare
  a jsonb := p->'args'; v_project uuid := flow.arg_uuid(p, 'project_id'); v_id uuid; v_c flow.units;
  v_lane text := a->>'lane_key'; v_status text; v_kind text; v_payload jsonb; v_fields jsonb; v_title text; v_parent uuid; v_old_parent uuid;
begin
  perform flow.proc_begin();
  perform flow.check_scope(p, v_project);
  if not exists (select 1 from flow.columns where project_id = v_project and key = 'avance' and deleted_at is null) then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'this flow has no board'));
  end if;
  if a ? 'card_id' and coalesce(a->>'card_id', '') <> '' then v_id := flow.arg_uuid(p, 'card_id'); end if;
  if v_id is not null then select * into v_c from flow.units where id = v_id for update; end if;
  if v_c.id is not null and (v_c.project_id <> v_project or v_c.kind not in ('card', 'recurring') or v_c.deleted_at is not null) then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.units', 'id', v_id));
  end if;

  v_title := nullif(btrim(coalesce(a->>'title', '')), '');
  v_status := coalesce(a->>'status', v_c.status, 'pending');
  v_kind := coalesce(a->>'kind', v_c.kind, 'card');
  if v_status not in ('pending', 'in_progress', 'done') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'status')); end if;
  if v_kind not in ('card', 'recurring') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'kind')); end if;
  if a ? 'prio' and a->>'prio' is not null and a->>'prio' not in ('urgente', 'importante', 'secundario', 'opcional') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'prio'));
  end if;
  if a ? 'flag' and a->>'flag' is not null and a->>'flag' not in ('pr', 'backlog') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'flag')); end if;
  if a ? 'url' and a->>'url' is not null and (a->>'url' !~ '^https://[^\s]{3,}$' or length(a->>'url') > 500) then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'url'));
  end if;
  if a ? 'steps' and a->'steps' <> 'null'::jsonb and (jsonb_typeof(a->'steps') <> 'array' or jsonb_array_length(a->'steps') > 30
       or exists (select 1 from jsonb_array_elements(a->'steps') s where jsonb_typeof(s) <> 'string' or length(s #>> '{}') > 300)) then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'steps'));
  end if;
  if a ? 'tipo' and a->>'tipo' is not null and a->>'tipo' not in ('arreglo', 'funcion', 'prueba', 'decision', 'ajuste') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'tipo'));
  end if;
  if a ? 'order' and a->>'order' is not null and a->>'order' !~ '^-?[0-9]{1,9}$' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'order')); end if;
  -- Aplicaciones en las que se hace la tarea (0959, vista «Por app»): claves de carril; null las quita (vuelve a lo automático).
  if a ? 'apps' and a->'apps' <> 'null'::jsonb and (jsonb_typeof(a->'apps') <> 'array' or jsonb_array_length(a->'apps') > 12
       or exists (select 1 from jsonb_array_elements(a->'apps') s where jsonb_typeof(s) <> 'string' or (s #>> '{}') !~ '^[a-z][a-z0-9_]{1,30}$')) then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'apps'));
  end if;
  if length(coalesce(a->>'ref', '')) > 40 or length(coalesce(a->>'url_text', '')) > 60 or length(coalesce(a->>'note', '')) > 1000 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'ref/url_text/note'));
  end if;

  -- Hito (0947): `hito_id` cuelga la tarjeta de un hito del tablero (objetivo del mismo proyecto; null la descuelga) y `paso`
  -- es su número de paso en ese hito.
  v_old_parent := v_c.parent_id;
  v_parent := v_c.parent_id;
  if a ? 'hito_id' then
    v_parent := case when coalesce(a->>'hito_id', '') = '' then null else flow.arg_uuid(p, 'hito_id') end;
    if v_parent is not null and not exists (select 1 from flow.units where id = v_parent and project_id = v_project and class = 'objective' and deleted_at is null) then
      perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.units', 'hito_id', v_parent));
    end if;
  end if;
  if a ? 'paso' and a->>'paso' is not null and a->>'paso' !~ '^[0-9]{1,3}$' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'paso')); end if;
  -- Lo que va en payload: solo las claves que se dan (null las quita).
  v_payload := coalesce(v_c.payload, '{}'::jsonb);
  v_payload := v_payload || coalesce((select jsonb_object_agg(k, a->k) from unnest(array['ref', 'url', 'url_text', 'steps', 'note', 'tipo', 'paso', 'apps']) k where a ? k), '{}'::jsonb);
  v_payload := jsonb_strip_nulls(v_payload);

  if v_c.id is null then
    if v_lane is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'lane_key')); end if;
    if v_title is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'title')); end if;
    v_id := flow.ins(p, 'flow.units', jsonb_build_object('project_id', v_project, 'column_key', 'avance', 'kind', v_kind, 'label', left(v_title, 300),
      'lane_key', v_lane, 'prio', case when v_kind = 'recurring' then null else a->>'prio' end, 'board_flag', a->>'flag', 'status', v_status, 'idx', coalesce((a->>'order')::int, 0), 'parent_id', v_parent,
      'done_at', case when v_status = 'done' then now() end, 'done_by', case when v_status = 'done' then (p->>'actor')::uuid end, 'payload', v_payload),
      coalesce(v_id, gen_random_uuid()));
    perform flow.board_after_write(p, v_project, null, v_parent);
    perform flow.proc_end();
    return jsonb_build_object('card_id', v_id, 'created', true);
  end if;

  v_fields := jsonb_build_object('status', v_status, 'kind', v_kind, 'payload', v_payload);
  if v_title is not null then v_fields := v_fields || jsonb_build_object('label', left(v_title, 300)); end if;
  if v_lane is not null then v_fields := v_fields || jsonb_build_object('lane_key', v_lane); end if;
  if a ? 'prio' or v_kind = 'recurring' then v_fields := v_fields || jsonb_build_object('prio', case when v_kind = 'recurring' then null else a->>'prio' end); end if;
  if a ? 'flag' then v_fields := v_fields || jsonb_build_object('board_flag', a->>'flag'); end if;
  if a ? 'order' then v_fields := v_fields || jsonb_build_object('idx', coalesce((a->>'order')::int, 0)); end if;
  if a ? 'hito_id' then v_fields := v_fields || jsonb_build_object('parent_id', v_parent); end if;
  if v_status = 'done' and v_c.status <> 'done' then v_fields := v_fields || jsonb_build_object('done_at', now(), 'done_by', (p->>'actor')::uuid);
  elsif v_status <> 'done' then v_fields := v_fields || jsonb_build_object('done_at', null, 'done_by', null);
  end if;
  perform flow.upd(p, 'flow.units', v_c.id, v_c.revision, v_fields);
  perform flow.board_after_write(p, v_project, v_old_parent, v_parent);
  perform flow.proc_end();
  return jsonb_build_object('card_id', v_c.id, 'created', false);
end $$;

create or replace function flow.import_board(p_project_in uuid, p_payload jsonb) returns jsonb language plpgsql as $$
declare v_ops jsonb := '[]'::jsonb; x jsonb; u flow.units; v_fields jsonb; v_status text; v_kind text; v_hitos int := 0; v_cards int := 0; v_hist int := 0;
  p_project uuid := p_project_in;
begin
  if p_project is null then
    p_project := gen_random_uuid();
    perform flow.import_apply(jsonb_build_array(
      jsonb_build_object('op', 'insert', 'table', 'flow.projects', 'id', p_project, 'fields', jsonb_build_object(
        'name', left(coalesce(nullif(btrim(p_payload->>'name'), ''), 'Avance por aplicaciones'), 120), 'template_key', 'avance',
        -- La versión siguiente libre (único por plantilla y evento).
        'template_version', (select coalesce(max(template_version), 0) + 1 from flow.projects where template_key = 'avance' and booking_event_id is null and deleted_at is null))),
      jsonb_build_object('op', 'insert', 'table', 'flow.columns', 'id', gen_random_uuid(), 'fields', jsonb_build_object(
        'project_id', p_project, 'key', 'avance', 'label', 'Avance', 'behavior', 'free_task', 'position', 1, 'config', '{}'::jsonb))), 'proyecto');
  end if;
  if not exists (select 1 from flow.columns where project_id = p_project and key = 'avance' and deleted_at is null) then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'this flow has no board'));
  end if;
  -- 1. Hitos (pendientes; su estado sale de sus hijas al final).
  for x in select * from jsonb_array_elements(coalesce(p_payload->'hitos', '[]'::jsonb)) loop
    select * into u from flow.units where id = (x->>'hito_id')::uuid;
    v_fields := jsonb_build_object('label', left(btrim(x->>'title'), 120), 'payload', jsonb_build_object('orden', (x->>'orden')::int));
    if u.id is null then
      v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'flow.units', 'id', x->>'hito_id', 'fields', v_fields || jsonb_build_object(
        'project_id', p_project, 'column_key', 'avance', 'kind', 'task', 'class', 'objective', 'criteria', '[]'::jsonb, 'status', 'pending'));
    else
      v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'flow.units', 'id', u.id, 'expectedRevision', u.revision, 'fields', v_fields);
    end if;
    v_hitos := v_hitos + 1;
  end loop;
  if jsonb_array_length(v_ops) > 0 then perform flow.import_apply(v_ops, 'hitos'); end if;
  -- 2. Tarjetas.
  v_ops := '[]'::jsonb;
  for x in select * from jsonb_array_elements(coalesce(p_payload->'cards', '[]'::jsonb)) loop
    select * into u from flow.units where id = (x->>'card_id')::uuid;
    v_status := coalesce(x->>'status', 'pending'); v_kind := coalesce(x->>'kind', 'card');
    v_fields := jsonb_build_object('lane_key', x->>'lane_key', 'label', left(btrim(x->>'title'), 300), 'status', v_status, 'kind', v_kind,
      'board_flag', x->>'flag', 'prio', case when v_kind = 'recurring' then null else x->>'prio' end, 'idx', coalesce((x->>'order')::int, 0),
      'parent_id', nullif(x->>'hito_id', ''),
      'done_at', case when v_status = 'done' then coalesce(x->>'done_at', now()::text) end,
      'payload', jsonb_strip_nulls(jsonb_build_object('ref', x->'ref', 'url', x->'url', 'url_text', x->'url_text', 'steps', x->'steps', 'note', x->'note',
        'tipo', x->'tipo', 'paso', x->'paso', 'apps', coalesce(x->'apps', u.payload->'apps'))));
    if u.id is null then
      v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'flow.units', 'id', x->>'card_id', 'fields', v_fields || jsonb_build_object('project_id', p_project, 'column_key', 'avance'));
    else
      v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'flow.units', 'id', u.id, 'expectedRevision', u.revision, 'fields', v_fields);
    end if;
    v_cards := v_cards + 1;
  end loop;
  if jsonb_array_length(v_ops) > 0 then perform flow.import_apply(v_ops, 'cards'); end if;
  -- 3. Estado de los hitos (con su fecha exportada si la trae).
  v_ops := '[]'::jsonb;
  for x in select * from jsonb_array_elements(coalesce(p_payload->'hitos', '[]'::jsonb)) loop
    select * into u from flow.units where id = (x->>'hito_id')::uuid;
    if flow.hito_met(u.id) and u.status <> 'done' then
      v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'flow.units', 'id', u.id, 'expectedRevision', u.revision,
        'fields', jsonb_build_object('status', 'done', 'done_at', coalesce(x->>'done_at', now()::text)));
    elsif not flow.hito_met(u.id) and u.status = 'done' then
      v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'flow.units', 'id', u.id, 'expectedRevision', u.revision,
        'fields', jsonb_build_object('status', 'pending', 'done_at', null));
    end if;
  end loop;
  if jsonb_array_length(v_ops) > 0 then perform flow.import_apply(v_ops, 'estado'); end if;
  -- 3b. Cada hito, ejecución de su cadena (definición, tramos por paso, enlaces y estado).
  for x in select * from jsonb_array_elements(coalesce(p_payload->'hitos', '[]'::jsonb)) loop
    v_ops := flow.hito_chain_ops((x->>'hito_id')::uuid);
    if jsonb_array_length(v_ops) > 0 then perform flow.import_apply(v_ops, 'cadena'); end if;
  end loop;
  -- 4. Historial (sin repetir fotos ya cargadas).
  v_ops := '[]'::jsonb;
  for x in select * from jsonb_array_elements(coalesce(p_payload->'history', '[]'::jsonb)) loop
    if not exists (select 1 from flow.board_history where project_id = p_project and taken_at = (x->>'t')::timestamptz and deleted_at is null) then
      v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'flow.board_history', 'id', gen_random_uuid(), 'fields', jsonb_build_object(
        'project_id', p_project, 'taken_at', x->>'t', 'hecho', coalesce((x->>'hecho')::int, 0), 'pr', coalesce((x->>'pr')::int, 0), 'curso', coalesce((x->>'curso')::int, 0),
        'pend', coalesce((x->>'pend')::int, 0), 'backlog', coalesce((x->>'backlog')::int, 0), 'total', coalesce((x->>'total')::int, 0)));
      v_hist := v_hist + 1;
    end if;
  end loop;
  if jsonb_array_length(v_ops) > 0 then perform flow.import_apply(v_ops, 'historial'); end if;
  return jsonb_build_object('project_id', p_project, 'hitos', v_hitos, 'cards', v_cards, 'history', v_hist);
end $$;
