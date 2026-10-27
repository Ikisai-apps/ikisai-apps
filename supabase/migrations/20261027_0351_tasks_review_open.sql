-- Ikisai Tasks · «Revisión de apertura», 4: «lista para abrir» y la proyección para Flow (encargo de VG por Core,
-- 27-10-2026; docs/tasks/API.md §46.4). Toca solo el schema tasks y, del núcleo, solo usa apply_row_op, fail,
-- allow_procedure, allow_read y register_capability.
-- - tasks.review_open(args {reviewId, override?, note?}): abre la revisión. Con todos los críticos en ok o verified, editor
--   u owner con el proyecto en su ámbito. Con críticos pendientes, solo una owner con el área entera, `override: true` y una
--   nota (decisión de VG, 27-10-2026): queda quién, cuándo, la nota y la lista de lo que faltaba.
-- - Los críticos de la plantilla de la casa son los que decidió VG (27-10): agua caliente, electricidad, accesos,
--   barandillas, extintores y agua. Las cámaras frigoríficas se leen, pero no bloquean la apertura.
-- - tasks.review_items_projection(args {reviewId} | {eventRef}): la revisión que quien lee ve (la de `eventRef` más
--   reciente si hay varias), con sus zonas e ítems (estado, último valor, quién y cuándo, correctiva y comprobación con su
--   estado) y los totales. Es lo que pinta Flow con la pieza «lista de comprobación» del kit; capacidad `tasks.review_projection`.

create or replace function tasks.review_open(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_app text := p->>'app';
  v_actor uuid := (p->>'actor')::uuid;
  v_role text := p->>'role';
  v_scopes jsonb;
  rv tasks.reviews;
  v_override boolean := coalesce((v_args->>'override')::boolean, false);
  v_note text := nullif(btrim(coalesce(v_args->>'note', '')), '');
  v_pending jsonb;
begin
  if coalesce(v_role, '') not in ('editor', 'owner') then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'editor or owner')); end if;
  begin select * into rv from tasks.reviews where id = (v_args->>'reviewId')::uuid and deleted_at is null;
  exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'reviewId is a uuid')); end;
  select m.scopes into v_scopes from core.memberships m where m.app = v_app and m.user_id = v_actor;
  if rv.id is null or not tasks.scope_project(v_scopes, rv.tab_id, rv.project_id) then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('kind', 'review', 'id', v_args->>'reviewId'));
  end if;
  if rv.status = 'opened' then
    return jsonb_build_object('reviewId', rv.id, 'status', rv.status, 'override', rv.open_override, 'openedAt', rv.opened_at, 'openedBy', rv.opened_by, 'pending', coalesce(rv.pending_at_open, '[]'::jsonb));
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('itemId', i.id, 'zone', i.zone, 'title', i.title, 'state', i.state) order by i.position), '[]'::jsonb) into v_pending
    from tasks.review_items i where i.review_id = rv.id and i.deleted_at is null and i.critical and i.state not in ('ok', 'verified');
  if jsonb_array_length(v_pending) > 0 then
    if not v_override then perform core.fail('REVIEW_NOT_READY', 409, jsonb_build_object('pending', v_pending)); end if;
    if v_role <> 'owner' or not tasks.scope_full(v_scopes, rv.tab_id) then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'opening with critical items pending: owner with the whole area'));
    end if;
    if v_note is null or length(v_note) > 2000 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'note', 'reason', 'why it opens with critical items pending (up to 2000 characters)')); end if;
  end if;
  perform set_config('tasks.review_write', rv.id::text, true);
  perform core.apply_row_op(v_app, v_actor, v_role, p->>'requestId', (p->>'cursor')::bigint, jsonb_build_object('op', 'update', 'table', 'tasks.reviews', 'id', rv.id, 'expectedRevision', rv.revision,
    'fields', jsonb_build_object('status', 'opened', 'opened_at', now(), 'opened_by', v_actor, 'open_override', jsonb_array_length(v_pending) > 0,
      'open_note', v_note, 'pending_at_open', v_pending)));
  return jsonb_build_object('reviewId', rv.id, 'status', 'opened', 'override', jsonb_array_length(v_pending) > 0, 'openedAt', now(), 'openedBy', v_actor, 'pending', v_pending);
end $$;
select core.allow_procedure('tasks', 'tasks.review_open');

create or replace function tasks.review_items_projection(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_scopes jsonb;
  rv tasks.reviews;
  v_id uuid;
  v_zones jsonb;
  v_totals jsonb;
begin
  select m.scopes into v_scopes from core.memberships m where m.app = p->>'app' and m.user_id = (p->>'actor')::uuid;
  if v_args ? 'reviewId' then
    begin v_id := (v_args->>'reviewId')::uuid; exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'reviewId is a uuid')); end;
    select * into rv from tasks.reviews r where r.id = v_id and r.deleted_at is null and tasks.scope_project(v_scopes, r.tab_id, r.project_id);
  elsif coalesce(v_args->>'eventRef', '') <> '' then
    select * into rv from tasks.reviews r where r.event_ref = v_args->>'eventRef' and r.deleted_at is null and tasks.scope_project(v_scopes, r.tab_id, r.project_id)
      order by r.created_at desc limit 1;
  else
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'reviewId or eventRef'));
  end if;
  if rv.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('kind', 'review')); end if;

  select coalesce(jsonb_agg(z.zone_json order by z.pos), '[]'::jsonb) into v_zones from (
    select min(i.position) pos, jsonb_build_object('zone', i.zone, 'label', tasks.review_zone_label(i.zone), 'items', jsonb_agg(jsonb_build_object(
      'id', i.id, 'taskId', i.task_id, 'title', i.title, 'answer', i.answer, 'expected', i.expected, 'critical', i.critical, 'instructions', i.instructions,
      'state', i.state, 'value', i.value, 'text', i.text, 'fileId', i.file_id, 'checkedBy', i.checked_by, 'checkedAt', i.checked_at,
      'firstFailure', i.first_failure,
      'corrective', case when c.id is null then null else jsonb_build_object('taskId', c.id, 'done', c.done, 'deleted', c.deleted_at is not null) end,
      'recheck', case when k.id is null then null else jsonb_build_object('taskId', k.id, 'done', k.done, 'deleted', k.deleted_at is not null) end
    ) order by i.position)) zone_json
    from tasks.review_items i
    left join tasks.tasks c on c.id = i.corrective_task_id
    left join tasks.tasks k on k.id = i.recheck_task_id
    where i.review_id = rv.id and i.deleted_at is null
    group by i.zone
  ) z;
  select jsonb_build_object(
    'items', count(*), 'critical', count(*) filter (where critical),
    'criticalDone', count(*) filter (where critical and state in ('ok', 'verified')),
    'done', count(*) filter (where state in ('ok', 'verified')), 'failed', count(*) filter (where state = 'failed'),
    'pending', count(*) filter (where state = 'pending'))
    into v_totals from tasks.review_items where review_id = rv.id and deleted_at is null;
  return jsonb_build_object(
    'review', jsonb_build_object('id', rv.id, 'projectId', rv.project_id, 'tabId', rv.tab_id, 'title', rv.title, 'eventRef', rv.event_ref, 'status', rv.status,
      'ready', rv.status in ('ready', 'opened') or (v_totals->>'critical')::int = (v_totals->>'criticalDone')::int,
      'openedAt', rv.opened_at, 'openedBy', rv.opened_by, 'override', rv.open_override, 'openNote', rv.open_note, 'pendingAtOpen', rv.pending_at_open),
    'zones', v_zones, 'totals', v_totals);
end $$;
select core.allow_read('tasks', 'tasks.review_items_projection', 'function');

do $$
declare f text;
begin
  foreach f in array array['tasks.review_open(jsonb)', 'tasks.review_items_projection(jsonb)'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;

select core.register_capability($cap${
  "id": "tasks.review_projection",
  "app": "tasks",
  "kind": "read",
  "title": "Revisión de Tasks (lista de comprobación)",
  "description": "Una revisión de Tasks (p. ej. la de apertura antes de un evento) por su id o por el evento: sus zonas e ítems con el estado, el último valor, quién y cuándo, la tarea para arreglarlo y la de volver a comprobar, y si está lista para abrir. Solo la que ve la persona.",
  "route": "GET reviews/projection",
  "roles": ["reader", "editor", "owner"],
  "risk": "low",
  "idempotent": true,
  "reversible": false,
  "input": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "reviewId": { "type": "string", "format": "uuid" },
      "eventRef": { "type": "string", "pattern": "^[a-z][a-z0-9_-]{1,30}:[A-Za-z0-9_.:/-]{1,150}$" }
    }
  },
  "output": {
    "type": "object",
    "required": ["review", "zones", "totals"],
    "properties": {
      "review": { "type": "object", "properties": { "id": { "type": "string", "format": "uuid" }, "status": { "enum": ["open", "ready", "opened"] }, "ready": { "type": "boolean" } } },
      "zones": { "type": "array" },
      "totals": { "type": "object" }
    }
  },
  "anchors": ["tasks.revision.lista"],
  "since": "0.1.0"
}$cap$::jsonb);

-- Críticos de la plantilla de la casa, como decidió VG: las cámaras dejan de serlo (solo en la plantilla; las revisiones ya
-- creadas guardan su copia). Pasa por la plantilla sembrada en 0348, por su id fijo.
update tasks.review_template_items set critical = false, revision = revision + 1, updated_at = now()
 where template_id = md5('ikisai-tasks-review-template:apertura')::uuid and zone = 'maquinaria' and critical;
