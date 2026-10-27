-- Ikisai Flow · «Avance» para la mudanza (especificación de Core en AVANCE_EN_FLOW.md, «Especificación de la pantalla para la
-- mudanza»), paso 1 en el servidor: hitos, historial de recuentos e importación del tablero.
-- - Hito = unidad `class = 'objective'` del tablero, sin criterios, con `payload.orden`; sus pasos son tarjetas hijas
--   (`parent_id`) con `payload.paso`. Está cumplido cuando todas sus hijas que no son backlog están hechas (y hay al menos
--   una): entonces queda `done` con `done_at`; si se reabre, vuelve a `pending` y se borra. Lo recalcula `board_card` al
--   escribir (por el registro del núcleo, para que llegue a los móviles), nunca un trigger a escondidas.
-- - Historial: `flow.board_history` guarda fotos {taken_at, hecho, pr, curso, pend, backlog, total} del proyecto cuando cambian
--   los recuentos (como mucho una cada 10 min) o, sin cambios, cada 6 h. Las escribe el servidor al escribir una tarjeta.
-- - `flow.import_board(p_project, p_payload)` (solo service_role): carga hitos, tarjetas e historial exportados del artefacto,
--   idempotente por id, por el registro del núcleo (`core.apply_migration_operations`) en lotes de 400.

-- Hito = ejecución de una definición «cadena» (VG, 27-10): cada hito tiene su definición publicada y una ejecución; cada tarjeta
-- del hito es un tramo «ir a otro carril» (handoff, con su `lane_key`) y queda enlazada a él (`execution_id`, `stage_position`).
-- El objetivo del hito guarda `execution_id`. Cerrar la tarjeta (board_card, `done`) cierra su tramo; cumplido el hito, la
-- ejecución queda hecha. La pantalla y el gráfico siguen leyendo unidades: no cambian.
alter table flow.units add column execution_id uuid references flow.executions(id);
alter table flow.units add column stage_position integer check (stage_position is null or stage_position between 1 and 200);
alter table flow.definition_stages add column lane_key text check (lane_key is null or lane_key ~ '^[a-z][a-z0-9_]{1,30}$');
alter table flow.definition_stages drop constraint definition_stages_position_check;
alter table flow.definition_stages add constraint definition_stages_position_check check (position between 1 and 200);
create index units_execution_idx on flow.units (execution_id) where execution_id is not null;
select core.register_table('flow', 'flow', 'units', array['project_id','column_key','kind','order_id','line_id','product_id','idx','pay_seq','label','priority','status','assigned_to','done_at','done_by','payload','source_ref','lane_key','prio','board_flag','class','parent_id','criteria','result_link','verified_by','verified_at','execution_id','stage_position'], '{reader,editor,owner,outsider}', '{editor,owner,outsider}', true);
select core.register_table('flow', 'flow', 'definition_stages', array['version_id','position','kind','capability','title','explain','target_app','target_anchor','lane_key'], '{reader,editor,owner}', '{owner}', true);

create table flow.board_history (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  project_id uuid not null references flow.projects(id),
  -- `taken_at`, no `t`: el snapshot del núcleo usa `t` de alias de fila y una columna con ese nombre lo rompe.
  taken_at timestamptz not null,
  hecho integer not null default 0 check (hecho >= 0),
  pr integer not null default 0 check (pr >= 0),
  curso integer not null default 0 check (curso >= 0),
  pend integer not null default 0 check (pend >= 0),
  backlog integer not null default 0 check (backlog >= 0),
  total integer not null default 0 check (total >= 0)
);
create unique index board_history_uidx on flow.board_history (project_id, taken_at) where deleted_at is null;
select core.register_table('flow', 'flow', 'board_history', array['project_id','taken_at','hecho','pr','curso','pend','backlog','total'], '{reader,editor,owner,outsider}', '{editor,owner,outsider}', true);
create trigger flow_guard before insert or update on flow.board_history for each row execute function flow.guard_marks();
create trigger flow_scope before insert or update on flow.board_history for each row execute function flow.guard_scope();

/** ¿Cumplido el hito? Todas sus hijas vivas que no son backlog, hechas (las recurrentes cuentan como hechas), y al menos una. */
create or replace function flow.hito_met(p_hito uuid) returns boolean language sql stable as $$
  select count(*) > 0 and coalesce(bool_and(u.status = 'done' or u.kind = 'recurring'), false)
    from flow.units u where u.parent_id = p_hito and u.deleted_at is null and u.board_flag is distinct from 'backlog'
$$;

/** Recuentos del tablero (misma precedencia que la pantalla: backlog > fusión > hecho/recurrente > en marcha > pendiente). */
create or replace function flow.board_counts(p_project uuid) returns jsonb language sql stable as $$
  with c as (
    select case when board_flag = 'backlog' then 'backlog' when board_flag = 'pr' then 'pr'
                when status = 'done' or kind = 'recurring' then 'hecho' when status = 'in_progress' then 'curso' else 'pend' end as st
      from flow.units where project_id = p_project and kind in ('card', 'recurring') and deleted_at is null
  )
  select jsonb_build_object('hecho', count(*) filter (where st = 'hecho'), 'pr', count(*) filter (where st = 'pr'),
    'curso', count(*) filter (where st = 'curso'), 'pend', count(*) filter (where st = 'pend'),
    'backlog', count(*) filter (where st = 'backlog'), 'total', count(*)) from c
$$;

/** Foto del historial si toca: recuentos distintos y la última hace más de 10 min, o iguales y hace más de 6 h. */
create or replace function flow.board_snapshot(p jsonb, p_project uuid) returns void language plpgsql as $$
declare v_now jsonb := flow.board_counts(p_project); h flow.board_history; v_same boolean;
begin
  select * into h from flow.board_history where project_id = p_project and deleted_at is null order by taken_at desc limit 1;
  v_same := h.id is not null and h.hecho = (v_now->>'hecho')::int and h.pr = (v_now->>'pr')::int and h.curso = (v_now->>'curso')::int
            and h.pend = (v_now->>'pend')::int and h.backlog = (v_now->>'backlog')::int and h.total = (v_now->>'total')::int;
  if h.id is null or (not v_same and h.taken_at < now() - interval '10 minutes') or (v_same and h.taken_at < now() - interval '6 hours') then
    perform flow.ins(p, 'flow.board_history', jsonb_build_object('project_id', p_project, 'taken_at', now()) || v_now);
  end if;
end $$;

/** Pone el hito en `done` (con done_at) o lo reabre, según sus hijas. */
create or replace function flow.refresh_hito(p jsonb, p_hito uuid) returns void language plpgsql as $$
declare h flow.units; v_met boolean;
begin
  if p_hito is null then return; end if;
  select * into h from flow.units where id = p_hito and class = 'objective' and deleted_at is null;
  if h.id is null or jsonb_array_length(coalesce(h.criteria, '[]'::jsonb)) > 0 then return; end if;
  v_met := flow.hito_met(h.id);
  if v_met and h.status <> 'done' then
    perform flow.upd(p, 'flow.units', h.id, h.revision, jsonb_build_object('status', 'done', 'done_at', now()));
  elsif not v_met and h.status = 'done' then
    perform flow.upd(p, 'flow.units', h.id, h.revision, jsonb_build_object('status', 'pending', 'done_at', null, 'done_by', null));
  end if;
end $$;

create or replace function flow.board_after_write(p jsonb, p_project uuid, p_old_parent uuid, p_new_parent uuid) returns void language plpgsql as $$
begin
  perform flow.refresh_hito(p, p_new_parent);
  perform flow.hito_chain_apply(p, p_new_parent);
  if p_old_parent is distinct from p_new_parent then perform flow.refresh_hito(p, p_old_parent); perform flow.hito_chain_apply(p, p_old_parent); end if;
  perform flow.board_snapshot(p, p_project);
end $$;

create or replace function flow.guard_class() returns trigger language plpgsql as $$
begin
  -- Un puesto (kind station) es siempre actividad continua, lo cree quien lo cree.
  if tg_op = 'INSERT' and new.kind = 'station' then new.class := 'station'; end if;
  -- Clase, criterios, vínculo, verificación y dependencia: solo por procedimiento (nadie se verifica a sí mismo a mano).
  if not flow.in_proc() and (
       (tg_op = 'INSERT' and (new.class <> 'operation' or new.criteria is not null or new.result_link is not null or new.verified_by is not null
                              or new.verified_at is not null or new.parent_id is not null or new.execution_id is not null or new.stage_position is not null))
       or (tg_op = 'UPDATE' and flow.changed(to_jsonb(old), to_jsonb(new), array['class', 'criteria', 'result_link', 'verified_by', 'verified_at', 'parent_id', 'execution_id', 'stage_position']))) then
    perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.units', 'reason', 'activity class fields'));
  end if;
  -- Una unidad solo depende de otra viva del mismo proyecto (nada de colgarla de un proyecto ajeno).
  if new.parent_id is not null and (tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id)
     and not exists (select 1 from flow.units u where u.id = new.parent_id and u.project_id = new.project_id and u.deleted_at is null and u.id <> new.id) then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.units', 'parent_id', new.parent_id));
  end if;
  if new.class = 'station' and new.status = 'done' then perform core.fail('STATION_NEVER_DONE', 422, jsonb_build_object('unit_id', new.id)); end if;
  -- Objetivo con criterios: todos verificados. Hito del tablero (sin criterios, 0947): todas sus hijas que no sean backlog,
  -- hechas (y al menos una).
  if new.class = 'objective' and new.status = 'done' and (tg_op = 'INSERT' or old.status <> 'done')
     and ((jsonb_array_length(coalesce(new.criteria, '[]'::jsonb)) = 0 and not flow.hito_met(new.id))
          or exists (select 1 from jsonb_array_elements(coalesce(new.criteria, '[]'::jsonb)) c where c->>'verified_at' is null)) then
    perform core.fail('OBJECTIVE_NOT_MET', 409, jsonb_build_object('unit_id', new.id));
  end if;
  if new.class = 'result' and new.status = 'done' and new.verified_by is null then perform core.fail('RESULT_NOT_VERIFIED', 409, jsonb_build_object('unit_id', new.id)); end if;
  -- La clase no se cambia una vez creada (una operación no se convierte en objetivo a mitad).
  if tg_op = 'UPDATE' and new.class is distinct from old.class then perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.units', 'reason', 'class is fixed')); end if;
  return new;
end $$;

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
  v_payload := v_payload || coalesce((select jsonb_object_agg(k, a->k) from unnest(array['ref', 'url', 'url_text', 'steps', 'note', 'tipo', 'paso']) k where a ? k), '{}'::jsonb);
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

/** Aplica operaciones de fila por el registro del núcleo (lotes de importación), dentro de «procedimiento». */
create or replace function flow.import_apply(p_ops jsonb, p_tag text) returns void language plpgsql as $$
declare i int := 0; n int := jsonb_array_length(p_ops);
begin
  perform flow.proc_begin();
  while i < n loop
    perform core.apply_migration_operations('flow', 'migration:avance-' || p_tag || '-' || i || '-' || substr(md5(random()::text), 1, 8),
      (select jsonb_agg(o order by k) from jsonb_array_elements(p_ops) with ordinality as t(o, k) where k > i and k <= i + 400));
    i := i + 400;
  end loop;
  perform flow.proc_end();
end $$;

/**
 * Lo que falta para que el hito sea una ejecución de su cadena: definición, versión publicada y ejecución si no existen; un tramo
 * por cada tarjeta hija que aún no lo tenga (en orden de paso); el estado de cada tramo según su tarjeta (hecha → done, backlog →
 * skipped, si no → draft) y el de la ejecución (done cuando no queda ninguno en draft). Devuelve operaciones de fila: las aplica
 * board_card (`hito_chain_apply`) o la importación (`import_apply`), siempre por el registro del núcleo.
 */
create or replace function flow.hito_chain_ops(p_hito uuid) returns jsonb language plpgsql as $$
declare h flow.units; e flow.executions; c flow.units; v_def uuid; v_ver uuid; v_exec uuid; v_pos int := 0; v_new boolean;
  v_head jsonb := '[]'::jsonb; v_stage_ops jsonb := '[]'::jsonb; v_unit_ops jsonb := '[]'::jsonb; v_stages jsonb := '[]'::jsonb; v_p int; v_all boolean;
begin
  select * into h from flow.units where id = p_hito and class = 'objective' and deleted_at is null;
  if h.id is null or jsonb_array_length(coalesce(h.criteria, '[]'::jsonb)) > 0 then return '[]'::jsonb; end if;
  v_new := h.execution_id is null;
  if v_new then
    v_def := gen_random_uuid(); v_ver := gen_random_uuid(); v_exec := gen_random_uuid();
    v_head := jsonb_build_array(
      jsonb_build_object('op', 'insert', 'table', 'flow.definitions', 'id', v_def, 'fields', jsonb_build_object(
        'key', 'cadena_' || replace(h.id::text, '-', ''), 'name', left(coalesce(h.label, 'Hito'), 80), 'description', 'Cadena del hito del Avance')),
      jsonb_build_object('op', 'insert', 'table', 'flow.definition_versions', 'id', v_ver, 'fields', jsonb_build_object(
        'definition_id', v_def, 'version', 1, 'status', 'published')));
  else
    v_exec := h.execution_id;
    select * into e from flow.executions where id = v_exec;
    v_ver := e.version_id;
    select coalesce(max(position), 0) into v_pos from flow.definition_stages where version_id = v_ver and deleted_at is null;
  end if;
  for c in select * from flow.units where parent_id = h.id and deleted_at is null and kind in ('card', 'recurring')
            order by coalesce((payload->>'paso')::int, 9999), idx, created_at, id loop
    if c.stage_position is null or c.execution_id is distinct from v_exec then
      v_pos := v_pos + 1; v_p := v_pos;
      v_stage_ops := v_stage_ops || jsonb_build_object('op', 'insert', 'table', 'flow.definition_stages', 'id', gen_random_uuid(), 'fields', jsonb_build_object(
        'version_id', v_ver, 'position', v_pos, 'kind', 'handoff', 'title', left(coalesce(c.label, 'Paso'), 120), 'target_app', 'flow', 'lane_key', c.lane_key));
      v_unit_ops := v_unit_ops || jsonb_build_object('op', 'update', 'table', 'flow.units', 'id', c.id, 'expectedRevision', c.revision,
        'fields', jsonb_build_object('execution_id', v_exec, 'stage_position', v_pos));
    else
      v_p := c.stage_position;
    end if;
    v_stages := v_stages || jsonb_build_object('position', v_p, 'unit_id', c.id,
      'status', case when c.board_flag = 'backlog' then 'skipped' when c.status = 'done' or c.kind = 'recurring' then 'done' else 'draft' end);
  end loop;
  select coalesce(jsonb_agg(x order by (x->>'position')::int), '[]'::jsonb) into v_stages from jsonb_array_elements(v_stages) x;
  v_all := jsonb_array_length(v_stages) > 0 and not exists (select 1 from jsonb_array_elements(v_stages) x where x->>'status' = 'draft');
  if v_new then
    return v_head || v_stage_ops
      || jsonb_build_array(jsonb_build_object('op', 'insert', 'table', 'flow.executions', 'id', v_exec, 'fields', jsonb_build_object(
           'version_id', v_ver, 'mode', 'run', 'status', case when v_all then 'done' else 'draft' end, 'stages', v_stages,
           'finished_at', case when v_all then now() end)),
         jsonb_build_object('op', 'update', 'table', 'flow.units', 'id', h.id, 'expectedRevision', h.revision, 'fields', jsonb_build_object('execution_id', v_exec)))
      || v_unit_ops;
  end if;
  if e.stages is distinct from v_stages or (e.status = 'done') is distinct from v_all then
    v_unit_ops := v_unit_ops || jsonb_build_object('op', 'update', 'table', 'flow.executions', 'id', e.id, 'expectedRevision', e.revision, 'fields', jsonb_build_object(
      'stages', v_stages, 'status', case when v_all then 'done' else 'draft' end, 'finished_at', case when v_all then coalesce(e.finished_at, now()) end));
  end if;
  return v_stage_ops || v_unit_ops;
end $$;

/** Desde board_card: aplica la cadena con el permiso del procedimiento (las definiciones y ejecuciones son del encargado). */
create or replace function flow.hito_chain_apply(p jsonb, p_hito uuid) returns void language plpgsql as $$
declare op jsonb;
begin
  if p_hito is null then return; end if;
  for op in select * from jsonb_array_elements(flow.hito_chain_ops(p_hito)) loop
    perform flow.row_op(p || jsonb_build_object('role', 'owner'), op);
  end loop;
end $$;

/**
 * Importar el tablero exportado del artefacto (solo service_role; Core lo ejecuta en producción). Idempotente por id.
 * Con `p_project` null crea el flujo «Avance por aplicaciones» (plantilla `avance`, columna «Avance»; nombre en `p_payload.name`)
 * y devuelve su id en `project_id`: para la segunda carga, se pasa ese id.
 * p_payload = { hitos: [{hito_id, title, orden, done_at?}], cards: [{card_id, lane_key, title, status, flag?, prio?, kind?, tipo?,
 *   order?, ref?, url?, url_text?, steps?, note?, hito_id?, paso?, done_at?}], history: [{t, hecho, pr, curso, pend, backlog, total}] }
 */
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
        'tipo', x->'tipo', 'paso', x->'paso')));
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

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
