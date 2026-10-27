-- Ikisai Tasks · «Pedir a Tasks» con hijas (encargo de Core para el «Montaje del evento» de Booking, 27-10-2026;
-- docs/tasks/API.md §42). Toca solo el schema tasks y, del núcleo, solo usa apply_row_op, fail y allow_procedure.
--
-- tasks.request_children(args { parentRef, kind, children: [{ ref, title, note?, due?, priority? }], create?, retire? }):
-- las hijas de una tarea pedida (la de `parentRef`, viva), cada una con su clave estable. Lo llama `worker/requests/task`
-- después de crear o reenviar la madre:
-- 1. una vez con la lista ENTERA, `create: false` y `retire: true`: pone al día y retira, y dice qué hijas faltan
--    (`status: 'missing'`);
-- 2. una vez por cada hija que falta, con solo ella y `retire: false`: la crea. Va en su propio lote porque la procedencia
--    (`external_ref`) solo la fija una petición por lote (tasks.external_request, como tasks.request_task).
-- Lo que pasa con cada hija:
-- - una hija nueva se crea bajo la madre, en su proyecto, al final y con las etiquetas del proyecto. Su `external_ref` es
--   `<parentRef>/<ref>` y su id se deriva de él, así que repetir la petición no duplica;
-- - una que ya estaba y sigue abierta se pone al día (título, nota, fecha y urgencia) solo si algo cambió;
-- - una que ya no viene se retira a la papelera si no está hecha (se puede restaurar); las hechas se quedan. Las hijas
--   que alguien añadió a mano (sin esa referencia) no se tocan nunca;
-- - una que alguien borró no se resucita (otra app no resucita lo que alguien borró, §19).
-- Devuelve { children: [{ ref, taskId, status: open|done|deleted }], created, updated, retired }.

create or replace function tasks.request_children(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_app text := p->>'app';
  v_actor uuid := (p->>'actor')::uuid;
  v_role text := p->>'role';
  v_req text := p->>'requestId';
  v_cur bigint := (p->>'cursor')::bigint;
  v_parent_ref text := v_args->>'parentRef';
  v_kind text := v_args->>'kind';
  v_parent tasks.tasks;
  v_child jsonb;
  v_ref text;
  v_full text;
  v_refs text[] := '{}';
  v_id uuid;
  v_hex text;
  v_row tasks.tasks;
  v_fields jsonb;
  v_position numeric;
  v_hash text;
  v_out jsonb := '[]'::jsonb;
  v_created int := 0; v_updated int := 0; v_retired int := 0;
  v_create boolean := coalesce((v_args->>'create')::boolean, true);
  v_retire boolean := coalesce((v_args->>'retire')::boolean, true);
  l record;
begin
  if v_parent_ref is null or v_parent_ref !~ '^[a-z][a-z0-9_-]{1,30}:.+$' or v_kind is null or split_part(v_kind, '.', 1) <> split_part(v_parent_ref, ':', 1)
     or jsonb_typeof(v_args->'children') <> 'array' or jsonb_array_length(v_args->'children') > 100 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'parentRef, kind (of the same source) and up to 100 children required'));
  end if;
  select * into v_parent from tasks.tasks t where t.external_ref = v_parent_ref and t.deleted_at is null order by t.created_at limit 1;
  if v_parent.id is null then return jsonb_build_object('children', '[]'::jsonb, 'created', 0, 'updated', 0, 'retired', 0, 'parent', 'missing'); end if;
  if v_parent.parent_id is not null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'the parent is already a child task')); end if;

  for v_child in select * from jsonb_array_elements(v_args->'children') loop
    v_ref := btrim(coalesce(v_child->>'ref', ''));
    if v_ref !~ '^[A-Za-z0-9_.:-]{1,100}$' or v_ref = any (v_refs) or btrim(coalesce(v_child->>'title', '')) = '' then
      perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'each child needs a unique ref and a title', 'ref', v_ref));
    end if;
    v_refs := v_refs || v_ref;
    v_full := v_parent_ref || '/' || v_ref;
    -- Mismo esquema de id que `requestTaskId` de la Edge (ikisai-tasks-request:<referencia>).
    v_hex := encode(sha256(convert_to('ikisai-tasks-request:' || v_full, 'UTF8')), 'hex');
    v_id := (substr(v_hex, 1, 8) || '-' || substr(v_hex, 9, 4) || '-4' || substr(v_hex, 14, 3) || '-'
             || to_hex((('x' || substr(v_hex, 17, 1))::bit(4)::int & 3) | 8) || substr(v_hex, 18, 3) || '-' || substr(v_hex, 21, 12))::uuid;
    select * into v_row from tasks.tasks t where t.id = v_id;
    if v_row.id is null and not v_create then
      v_out := v_out || jsonb_build_object('ref', v_ref, 'taskId', v_id, 'status', 'missing');
      continue;
    end if;
    if v_row.id is null then
      if v_created > 0 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'one new child per batch')); end if;
      perform set_config('tasks.external_request', v_full, true);
      perform set_config('tasks.external_request_id', v_id::text, true);
      select coalesce(max(t.position), 0) + 1024 into v_position from tasks.tasks t where t.project_id = v_parent.project_id;
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.tasks', 'id', v_id,
        'fields', jsonb_build_object('tab_id', v_parent.tab_id, 'project_id', v_parent.project_id, 'parent_id', v_parent.id,
          'title', left(btrim(v_child->>'title'), 500), 'note', coalesce(v_child->>'note', ''), 'priority', coalesce(v_child->>'priority', 'normal'),
          'due', nullif(v_child->>'due', ''), 'position', v_position,
          'external_ref', v_full, 'external_kind', v_kind, 'external_url', v_parent.external_url, 'external_on_behalf', v_parent.external_on_behalf)));
      -- Las etiquetas del proyecto, como la madre (ids derivados del de la hija).
      for l in select pl.label_id from tasks.project_labels pl where pl.project_id = v_parent.project_id and pl.deleted_at is null order by pl.label_id loop
        v_hash := md5(v_id::text || ':' || l.label_id::text);
        perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.task_labels',
          'id', (substr(v_hash, 1, 8) || '-' || substr(v_hash, 9, 4) || '-4' || substr(v_hash, 14, 3) || '-8' || substr(v_hash, 18, 3) || '-' || substr(v_hash, 21, 12))::uuid,
          'fields', jsonb_build_object('tab_id', v_parent.tab_id, 'project_id', v_parent.project_id, 'task_id', v_id, 'label_id', l.label_id)));
      end loop;
      v_created := v_created + 1;
      v_out := v_out || jsonb_build_object('ref', v_ref, 'taskId', v_id, 'status', 'open');
      continue;
    end if;
    if v_row.deleted_at is not null then v_out := v_out || jsonb_build_object('ref', v_ref, 'taskId', v_id, 'status', 'deleted'); continue; end if;
    if v_row.done then v_out := v_out || jsonb_build_object('ref', v_ref, 'taskId', v_id, 'status', 'done'); continue; end if;
    v_fields := '{}'::jsonb;
    if v_row.title is distinct from left(btrim(v_child->>'title'), 500) then v_fields := v_fields || jsonb_build_object('title', left(btrim(v_child->>'title'), 500)); end if;
    if v_child ? 'note' and v_row.note is distinct from coalesce(v_child->>'note', '') then v_fields := v_fields || jsonb_build_object('note', coalesce(v_child->>'note', '')); end if;
    if v_child ? 'due' and v_row.due::text is distinct from nullif(v_child->>'due', '') then v_fields := v_fields || jsonb_build_object('due', nullif(v_child->>'due', '')); end if;
    if v_child ? 'priority' and v_row.priority is distinct from coalesce(v_child->>'priority', 'normal') then v_fields := v_fields || jsonb_build_object('priority', coalesce(v_child->>'priority', 'normal')); end if;
    if v_fields <> '{}'::jsonb then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.tasks', 'id', v_id, 'expectedRevision', v_row.revision, 'fields', v_fields));
      v_updated := v_updated + 1;
    end if;
    v_out := v_out || jsonb_build_object('ref', v_ref, 'taskId', v_id, 'status', 'open');
  end loop;

  -- Las que ya no vienen: a la papelera si no están hechas. Solo las de esta madre con su referencia.
  for v_row in select t.* from tasks.tasks t
                where v_retire and t.parent_id = v_parent.id and t.deleted_at is null and not t.done
                  and t.external_ref like v_parent_ref || '/%' and not (substr(t.external_ref, length(v_parent_ref) + 2) = any (v_refs)) loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'delete', 'table', 'tasks.tasks', 'id', v_row.id, 'expectedRevision', v_row.revision));
    -- Con sus propias hijas vivas, como borrar en la app (deleteTaskOps).
    for l in select g.id, g.revision from tasks.tasks g where g.parent_id = v_row.id and g.deleted_at is null loop
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'delete', 'table', 'tasks.tasks', 'id', l.id, 'expectedRevision', l.revision));
    end loop;
    v_retired := v_retired + 1;
  end loop;

  return jsonb_build_object('children', v_out, 'created', v_created, 'updated', v_updated, 'retired', v_retired, 'parent', 'open');
end $$;

select core.allow_procedure('tasks', 'tasks.request_children');

revoke all on function tasks.request_children(jsonb) from public, anon, authenticated;
grant execute on function tasks.request_children(jsonb) to service_role;
