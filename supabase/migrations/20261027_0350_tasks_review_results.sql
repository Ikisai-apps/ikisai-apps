-- Ikisai Tasks · «Revisión de apertura», 3: el resultado de cada ítem, la correctiva y «volver a comprobar» (encargo de VG
-- por Core, 27-10-2026; docs/tasks/API.md §46.3). Toca solo el schema tasks y, del núcleo, solo usa apply_row_op, fail,
-- allow_procedure y register_capability.
-- tasks.review_item_result(args {itemId, result: ok|fail, value?, text?, fileId?}), editor u owner con el proyecto en su ámbito:
-- - Según el tipo: una cantidad o una lectura necesitan `value`; una foto, `fileId` (archivo de Tasks verificado, imagen,
--   subido por quien marca); una observación, `text`. Una lectura fuera de [min, max] o una cantidad distinta de la esperada
--   cuentan como fallo aunque llegue `ok`.
-- - ok: el ítem queda `ok` (o `verified` si venía de un fallo) y su tarea, hecha; también «volver a comprobar» y la correctiva.
-- - fail: el ítem queda `failed` con su resultado y su evidencia (el primer fallo se guarda en `first_failure` y no se pisa);
--   (su foto, en `first_failure_file_id`, campo de archivo); su tarea, sin hacer; y en su zona, «Arreglar: …» (la correctiva, con el oficio del ítem) y «Volver a comprobar: …», que
--   depende de la correctiva. Si ya estaban, se reabren. Hacer la correctiva no verifica nada: solo un nuevo «ok».
-- - La revisión pasa a `ready` cuando todos sus críticos están en ok o verified, y vuelve a `open` si alguno deja de estarlo
--   (una abierta, `opened`, se queda así).
-- Devuelve {itemId, state, reviewId, reviewStatus, correctiveTaskId, recheckTaskId}.
-- Capacidad del catálogo `tasks.review_item_result` (POST reviews/result) para marcar desde Flow.

create or replace function tasks.review_item_result(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_app text := p->>'app';
  v_actor uuid := (p->>'actor')::uuid;
  v_role text := p->>'role';
  v_req text := p->>'requestId';
  v_cur bigint := (p->>'cursor')::bigint;
  v_scopes jsonb;
  it tasks.review_items; rv tasks.reviews; t tasks.tasks; x tasks.tasks;
  v_result text := v_args->>'result';
  v_value numeric; v_text text := nullif(btrim(coalesce(v_args->>'text', '')), ''); v_file uuid;
  v_state text; v_fail boolean; v_ok_all boolean; v_status text;
  v_corrective uuid; v_recheck uuid; v_pos numeric; tr record;
  v_evidence jsonb;
begin
  if coalesce(v_role, '') not in ('editor', 'owner') then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'editor or owner')); end if;
  begin
    select * into it from tasks.review_items where id = (v_args->>'itemId')::uuid and deleted_at is null;
    v_value := nullif(v_args->>'value', '')::numeric;
    v_file := nullif(v_args->>'fileId', '')::uuid;
  exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'itemId and fileId are uuids; value is a number'));
  end;
  select m.scopes into v_scopes from core.memberships m where m.app = v_app and m.user_id = v_actor;
  if it.id is null or not tasks.scope_project(v_scopes, it.tab_id, it.project_id) then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('kind', 'review_item', 'id', v_args->>'itemId'));
  end if;
  select * into rv from tasks.reviews where id = it.review_id;
  if rv.deleted_at is not null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('kind', 'review', 'id', rv.id)); end if;
  if coalesce(v_result, '') not in ('ok', 'fail') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'result', 'reason', 'ok or fail')); end if;
  if v_text is not null and length(v_text) > 2000 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'text', 'reason', 'up to 2000 characters')); end if;

  -- Lo que pide cada tipo de respuesta, y lo que cuenta como fallo.
  v_fail := v_result = 'fail';
  if it.answer in ('quantity', 'reading') and v_value is null then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'value', 'reason', 'a ' || it.answer || ' needs a value'));
  end if;
  if it.answer = 'quantity' then
    if v_value < 0 or v_value <> trunc(v_value) then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'value', 'reason', 'a whole number')); end if;
    if it.expected ? 'count' and v_value <> (it.expected->>'count')::numeric then v_fail := true; end if;
  elsif it.answer = 'reading' then
    if (it.expected ? 'min' and v_value < (it.expected->>'min')::numeric) or (it.expected ? 'max' and v_value > (it.expected->>'max')::numeric) then v_fail := true; end if;
  elsif v_value is not null then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'value', 'reason', 'only for quantity and reading'));
  end if;
  if it.answer = 'photo' and v_file is null and not v_fail then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'fileId', 'reason', 'a photo needs its file'));
  end if;
  if it.answer = 'note' and v_text is null then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'text', 'reason', 'an observation needs its text'));
  end if;
  if v_file is not null and not exists (select 1 from core.files f where f.id = v_file and f.app = 'tasks' and f.status = 'verified' and f.created_by = v_actor
                                          and f.mime in ('image/jpeg', 'image/png', 'image/webp')) then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'fileId', 'reason', 'a verified photo you uploaded'));
  end if;

  perform set_config('tasks.review_write', rv.id::text, true);
  v_evidence := jsonb_strip_nulls(jsonb_build_object('value', v_value, 'text', v_text, 'fileId', v_file, 'by', v_actor, 'at', now()));
  select * into t from tasks.tasks where id = it.task_id;
  v_corrective := it.corrective_task_id; v_recheck := it.recheck_task_id;

  if not v_fail then
    v_state := case when it.state in ('failed', 'verified') then 'verified' else 'ok' end;
    -- Su tarea, «volver a comprobar» y la correctiva, hechas.
    for x in select * from tasks.tasks where id in (it.task_id, it.recheck_task_id, it.corrective_task_id) and deleted_at is null and not done loop
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.tasks', 'id', x.id, 'expectedRevision', x.revision, 'fields', jsonb_build_object('done', true)));
    end loop;
  else
    v_state := 'failed';
    if t.id is not null and t.deleted_at is null and t.done then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.tasks', 'id', t.id, 'expectedRevision', t.revision, 'fields', jsonb_build_object('done', false)));
    end if;
    select coalesce(max(position), 0) into v_pos from tasks.tasks where parent_id = t.parent_id;
    -- La correctiva: nueva la primera vez (o si la borraron), reabierta si ya estaba hecha.
    select * into x from tasks.tasks where id = v_corrective;
    if x.id is null or x.deleted_at is not null then
      v_corrective := tasks.review_uuid(it.id || ':corrective:' || coalesce(x.id::text, '1'));
      v_pos := v_pos + 1024;
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.tasks', 'id', v_corrective,
        'fields', jsonb_build_object('tab_id', it.tab_id, 'project_id', it.project_id, 'parent_id', t.parent_id, 'title', left('Arreglar: ' || it.title, 500),
          'note', coalesce(v_text, ''), 'priority', case when it.critical then 'high' else 'normal' end, 'position', v_pos)));
      for tr in select tt.trade_id from tasks.task_trades tt where tt.task_id = it.task_id and tt.deleted_at is null loop
        perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.task_trades', 'id', tasks.review_uuid(v_corrective || ':trade:' || tr.trade_id),
          'fields', jsonb_build_object('tab_id', it.tab_id, 'project_id', it.project_id, 'task_id', v_corrective, 'trade_id', tr.trade_id)));
      end loop;
    elsif x.done then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.tasks', 'id', x.id, 'expectedRevision', x.revision, 'fields', jsonb_build_object('done', false)));
    end if;
    -- «Volver a comprobar», que espera a la correctiva.
    select * into x from tasks.tasks where id = v_recheck;
    if x.id is null or x.deleted_at is not null then
      v_recheck := tasks.review_uuid(it.id || ':recheck:' || coalesce(x.id::text, '1'));
      v_pos := v_pos + 1024;
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.tasks', 'id', v_recheck,
        'fields', jsonb_build_object('tab_id', it.tab_id, 'project_id', it.project_id, 'parent_id', t.parent_id, 'title', left('Volver a comprobar: ' || it.title, 500),
          'note', it.instructions, 'priority', case when it.critical then 'high' else 'normal' end, 'position', v_pos)));
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.task_dependencies', 'id', tasks.review_uuid(v_recheck || ':after:' || v_corrective),
        'fields', jsonb_build_object('tab_id', it.tab_id, 'project_id', it.project_id, 'task_id', v_recheck, 'depends_on_id', v_corrective, 'position', 1024)));
    elsif x.done then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.tasks', 'id', x.id, 'expectedRevision', x.revision, 'fields', jsonb_build_object('done', false)));
    end if;
  end if;

  perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.review_items', 'id', it.id, 'expectedRevision', it.revision,
    'fields', jsonb_build_object('state', v_state, 'value', v_value, 'text', v_text, 'file_id', v_file, 'checked_by', v_actor, 'checked_at', now(),
      'first_failure', case when v_fail and it.first_failure is null then v_evidence else it.first_failure end,
      'first_failure_file_id', case when v_fail and it.first_failure is null then v_file else it.first_failure_file_id end,
      'corrective_task_id', v_corrective, 'recheck_task_id', v_recheck)));

  -- ¿Lista para abrir? Todos los críticos en ok o verified.
  select coalesce(bool_and(i.state in ('ok', 'verified')), true) into v_ok_all from tasks.review_items i where i.review_id = rv.id and i.deleted_at is null and i.critical;
  v_status := case when rv.status = 'opened' then 'opened' when v_ok_all then 'ready' else 'open' end;
  if v_status <> rv.status then
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.reviews', 'id', rv.id, 'expectedRevision', rv.revision,
      'fields', jsonb_build_object('status', v_status)));
  end if;
  return jsonb_build_object('itemId', it.id, 'state', v_state, 'reviewId', rv.id, 'reviewStatus', v_status, 'correctiveTaskId', v_corrective, 'recheckTaskId', v_recheck);
end $$;
select core.allow_procedure('tasks', 'tasks.review_item_result');

revoke all on function tasks.review_item_result(jsonb) from public, anon, authenticated;
grant execute on function tasks.review_item_result(jsonb) to service_role;

select core.register_capability($cap${
  "id": "tasks.review_item_result",
  "app": "tasks",
  "kind": "execute",
  "title": "Marcar un ítem de una revisión de Tasks",
  "description": "Apunta el resultado de un ítem de una revisión (p. ej. la de apertura antes de un evento): funciona o no, la cantidad, la lectura, la foto o la observación. Un fallo crea en Tasks la tarea para arreglarlo y la de volver a comprobar; solo un nuevo «ok» lo verifica. La revisión queda lista para abrir cuando todos sus críticos están verificados.",
  "route": "POST reviews/result",
  "roles": ["editor", "owner"],
  "risk": "low",
  "idempotent": false,
  "reversible": false,
  "input": {
    "type": "object",
    "required": ["itemId", "result"],
    "additionalProperties": false,
    "properties": {
      "requestId": { "type": "string", "pattern": "^[A-Za-z0-9_.:-]{1,100}$" },
      "itemId": { "type": "string", "format": "uuid" },
      "result": { "enum": ["ok", "fail"] },
      "value": { "type": "number" },
      "text": { "type": "string", "maxLength": 2000 },
      "fileId": { "type": "string", "format": "uuid" }
    }
  },
  "output": {
    "type": "object",
    "required": ["itemId", "state", "reviewId", "reviewStatus"],
    "properties": {
      "itemId": { "type": "string", "format": "uuid" },
      "state": { "enum": ["pending", "ok", "failed", "verified"] },
      "reviewId": { "type": "string", "format": "uuid" },
      "reviewStatus": { "enum": ["open", "ready", "opened"] },
      "correctiveTaskId": { "type": ["string", "null"], "format": "uuid" },
      "recheckTaskId": { "type": ["string", "null"], "format": "uuid" }
    }
  },
  "anchors": ["tasks.revision.item.resultado"],
  "since": "0.1.0"
}$cap$::jsonb);
