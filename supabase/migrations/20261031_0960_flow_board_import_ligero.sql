-- Flow 0960: recargar el tablero sin reescribirlo entero (VG, 31-10).
-- Cada `flow.import_board` actualizaba todas las tarjetas y todos los hitos aunque no hubieran cambiado: cientos de cambios por
-- recarga que cada dispositivo tenía que bajarse, con revisiones nuevas que chocaban con lo que se estuviera editando.
-- Ahora solo se escribe la fila que cambia de verdad (la fecha de una tarjeta que ya estaba hecha no cuenta) y la salida dice
-- cuántas tarjetas han cambiado (`changed`). Lo demás, como en 0959.

/** ¿Alguno de estos campos es distinto en la fila? (comparación JSON: nulos iguales, uuid y texto como cadenas). */
create or replace function flow.fields_differ(p_row jsonb, p_fields jsonb) returns boolean language sql immutable as $$
  select exists (select 1 from jsonb_each(p_fields) f where p_row->f.key is distinct from f.value)
$$;

create or replace function flow.import_board(p_project_in uuid, p_payload jsonb) returns jsonb language plpgsql as $$
declare v_ops jsonb := '[]'::jsonb; x jsonb; u flow.units; v_fields jsonb; v_status text; v_kind text; v_hitos int := 0; v_cards int := 0; v_hist int := 0; v_changed int := 0;
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
    elsif flow.fields_differ(to_jsonb(u), v_fields) then
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
      v_changed := v_changed + 1;
    else
      -- Ya hecha y sigue hecha: su fecha no se toca (la del artefacto llega con otro formato y parecería un cambio).
      if u.status = 'done' and v_status = 'done' then v_fields := v_fields - 'done_at'; end if;
      if flow.fields_differ(to_jsonb(u), v_fields) then
        v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'flow.units', 'id', u.id, 'expectedRevision', u.revision, 'fields', v_fields);
        v_changed := v_changed + 1;
      end if;
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
  return jsonb_build_object('project_id', p_project, 'hitos', v_hitos, 'cards', v_cards, 'changed', v_changed, 'history', v_hist);
end $$;
