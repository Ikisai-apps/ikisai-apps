-- Ikisai Tasks · «Proyectos y producción», 7.4: la entrevista de diseño (diseño en MUELA/equipo/feedback/tasks/
-- PROYECTOS_PRODUCCION.md §7.4; encargo de Core, 27-10-2026; docs/tasks/API.md §54). Toca solo el schema tasks y, del
-- núcleo, solo usa apply_row_op, allow_procedure, register_capability y fail.
-- - tasks.project_design(args): en un lote, el proyecto entero que sale de una entrevista (la hace Flow): el proyecto, sus
--   fases, las tareas madre con su fase, sus pasos (en orden o no; un paso puede quedar fuera de la cadena), sus oficios,
--   espacios, personas y materiales, y las dependencias entre tareas (por su `key`).
--   - Quién: editor u owner con el área entera (crear un proyecto es del área).
--   - Repetible: los ids salen de `designId` y de cada `key`; repetir devuelve el proyecto que ya hay (`created: false`).
--   - Comprobaciones: claves únicas y bien formadas, la fase de cada tarea existe, `dependsOn` apunta a tareas del diseño y
--     sin ciclos, y como mucho 30 fases, 200 tareas y 1000 pasos. Oficios, espacios, personas y artículos los comprueban los
--     hooks de siempre (vivos en Central y Recursos).
--   - No pide compras: «Pedir» es de la producción (§53). Las unidades y los entregables llegan en 7.5.
-- - Capacidad del catálogo `tasks.project_design` (`POST projects/design`).

create or replace function tasks.design_uuid(p_seed text)
returns uuid language sql immutable as $$
  select (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-8' || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid
  from (select md5('ikisai-tasks-design:' || p_seed) h) x
$$;

create or replace function tasks.project_design(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_app text := p->>'app';
  v_actor uuid := (p->>'actor')::uuid;
  v_role text := p->>'role';
  v_req text := p->>'requestId';
  v_cur bigint := (p->>'cursor')::bigint;
  v_scopes jsonb;
  v_design text; v_tab uuid; v_due date; v_title text;
  v_phases jsonb := coalesce(v_args->'phases', '[]'::jsonb);
  v_tasks jsonb := coalesce(v_args->'tasks', '[]'::jsonb);
  v_project uuid; v_pos numeric; v_task uuid; v_step uuid; v_n int := 0; v_steps int := 0; v_i int;
  v_bad text;
  f jsonb; t jsonb; s jsonb; x jsonb;
  k text;
begin
  if coalesce(v_role, '') not in ('editor', 'owner') then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'editor or owner')); end if;
  begin
    v_design := lower(btrim(v_args->>'designId')); v_tab := (v_args->>'tabId')::uuid; v_due := nullif(v_args->>'due', '')::date;
    perform (v_design::uuid);
  exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'designId and tabId are uuids; due is a date'));
  end;
  if v_design is null or v_tab is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'designId and tabId are required')); end if;
  v_project := tasks.design_uuid(v_design || ':project');
  -- Repetir devuelve el que ya hay.
  if exists (select 1 from tasks.projects pr where pr.id = v_project) then
    return (select jsonb_build_object('projectId', pr.id, 'created', false) from tasks.projects pr where pr.id = v_project);
  end if;
  select m.scopes into v_scopes from core.memberships m where m.app = v_app and m.user_id = v_actor;
  if not exists (select 1 from tasks.tabs tb where tb.id = v_tab and tb.deleted_at is null) or not tasks.scope_full(v_scopes, v_tab) then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'a project needs the whole area'));
  end if;

  -- Forma.
  v_title := btrim(coalesce(v_args->>'title', ''));
  if length(v_title) < 1 or length(v_title) > 300 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'title is 1 to 300 characters')); end if;
  if jsonb_typeof(v_phases) <> 'array' or jsonb_typeof(v_tasks) <> 'array' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'phases and tasks are lists')); end if;
  if jsonb_array_length(v_phases) > 30 or jsonb_array_length(v_tasks) > 200 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'at most 30 phases and 200 tasks'));
  end if;
  select coalesce(sum(jsonb_array_length(coalesce(e->'steps', '[]'::jsonb))), 0) into v_steps from jsonb_array_elements(v_tasks) e where jsonb_typeof(coalesce(e->'steps', '[]'::jsonb)) = 'array';
  if v_steps > 1000 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'at most 1000 steps')); end if;
  select e->>'key' into v_bad from (select e from jsonb_array_elements(v_phases) e union all select e from jsonb_array_elements(v_tasks) e) z
   where jsonb_typeof(e) <> 'object' or coalesce(e->>'key', '') !~ '^[A-Za-z0-9_-]{1,40}$' limit 1;
  if found then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'every phase and task has a key [A-Za-z0-9_-]{1,40}', 'key', v_bad)); end if;
  select k2 into v_bad from (select e->>'key' k2 from jsonb_array_elements(v_phases) e) z group by k2 having count(*) > 1 limit 1;
  if found then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'duplicate phase key', 'key', v_bad)); end if;
  select k2 into v_bad from (select e->>'key' k2 from jsonb_array_elements(v_tasks) e) z group by k2 having count(*) > 1 limit 1;
  if found then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'duplicate task key', 'key', v_bad)); end if;
  select e->>'key' into v_bad from jsonb_array_elements(v_tasks) e
   where coalesce(e->>'phase', '') <> '' and not exists (select 1 from jsonb_array_elements(v_phases) ph where ph->>'key' = e->>'phase') limit 1;
  if found then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'unknown phase', 'key', v_bad)); end if;
  select e->>'key' into v_bad from jsonb_array_elements(v_tasks) e, jsonb_array_elements_text(case when jsonb_typeof(e->'dependsOn') = 'array' then e->'dependsOn' else '[]'::jsonb end) d
   where not exists (select 1 from jsonb_array_elements(v_tasks) o where o->>'key' = d) or d = e->>'key' limit 1;
  if found then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'dependsOn must name other tasks of the design', 'key', v_bad)); end if;
  -- Nombres, prioridad, pasos, ids, personas, materiales y fechas: 422 aquí y no un error de la base más adelante.
  select e->>'key' into v_bad from jsonb_array_elements(v_phases) e where length(btrim(coalesce(e->>'name', ''))) not between 1 and 120 limit 1;
  if found then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'a phase needs a name of up to 120 characters', 'key', v_bad)); end if;
  select e->>'key' into v_bad from jsonb_array_elements(v_tasks) e
   where length(btrim(coalesce(e->>'title', ''))) not between 1 and 1000 or coalesce(e->>'priority', 'normal') not in ('normal', 'high', 'critical')
      or (e ? 'inOrder' and jsonb_typeof(e->'inOrder') <> 'boolean') limit 1;
  if found then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'a task needs a title; priority is normal, high or critical', 'key', v_bad)); end if;
  select e->>'key' into v_bad from jsonb_array_elements(v_tasks) e, jsonb_array_elements(case when jsonb_typeof(e->'steps') = 'array' then e->'steps' else '[]'::jsonb end) st
   where jsonb_typeof(st) <> 'object' or length(btrim(coalesce(st->>'title', ''))) not between 1 and 1000 or (st ? 'free' and jsonb_typeof(st->'free') <> 'boolean') limit 1;
  if found then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'every step needs a title', 'key', v_bad)); end if;
  select e->>'key' into v_bad from jsonb_array_elements(v_tasks) e,
       jsonb_array_elements_text((case when jsonb_typeof(e->'trades') = 'array' then e->'trades' else '[]'::jsonb end) || (case when jsonb_typeof(e->'spaces') = 'array' then e->'spaces' else '[]'::jsonb end)) u
   where u !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' limit 1;
  if found then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'trades and spaces are uuids', 'key', v_bad)); end if;
  select e->>'key' into v_bad from jsonb_array_elements(v_tasks) e, jsonb_array_elements(case when jsonb_typeof(e->'people') = 'array' then e->'people' else '[]'::jsonb end) pp
   where jsonb_typeof(pp) <> 'object' or (pp->>'personId' is null) = (pp->>'houseLevel' is null)
      or coalesce(pp->>'personId', '00000000-0000-0000-0000-000000000000') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(pp->>'houseLevel', 'staff') not in ('direccion', 'staff', 'outsider') limit 1;
  if found then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'a person is {personId} or {houseLevel}', 'key', v_bad)); end if;
  select e->>'key' into v_bad from jsonb_array_elements(v_tasks) e, jsonb_array_elements(case when jsonb_typeof(e->'materials') = 'array' then e->'materials' else '[]'::jsonb end) mt
   where jsonb_typeof(mt) <> 'object' or coalesce(mt->>'itemId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or case when jsonb_typeof(mt->'quantity') = 'number' then (mt->>'quantity')::numeric <= 0 else true end limit 1;
  if found then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'a material is {itemId, quantity > 0}', 'key', v_bad)); end if;
  begin
    perform (d)::date from (select e->>'start' d from jsonb_array_elements(v_phases) e union all select e->>'due' from jsonb_array_elements(v_phases) e
                            union all select e->>'due' from jsonb_array_elements(v_tasks) e) z where coalesce(d, '') <> '';
  exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'dates are AAAA-MM-DD'));
  end;
  -- Sin ciclos: desde cada tarea, por sus dependencias, no se vuelve a ella.
  with recursive edges as (
    select e->>'key' src, d dst from jsonb_array_elements(v_tasks) e, jsonb_array_elements_text(case when jsonb_typeof(e->'dependsOn') = 'array' then e->'dependsOn' else '[]'::jsonb end) d
  ), walk as (
    select src start, dst node, 1 depth from edges
    union
    select w.start, e.dst, w.depth + 1 from walk w join edges e on e.src = w.node where w.depth < 200 and w.node <> w.start
  ) select start into v_bad from walk where node = start limit 1;
  if found then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'dependsOn has a cycle', 'key', v_bad)); end if;

  -- El proyecto, al final de su área.
  select coalesce(max(position), 0) + 1024 into v_pos from tasks.projects where tab_id = v_tab;
  perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.projects', 'id', v_project,
    'fields', jsonb_build_object('tab_id', v_tab, 'title', v_title, 'note', left(coalesce(v_args->>'objective', ''), 20000), 'position', v_pos, 'due', v_due)));
  -- Fases, en el orden de la entrevista.
  v_i := 0;
  for f in select e from jsonb_array_elements(v_phases) e loop
    v_i := v_i + 1;
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.project_phases', 'id', tasks.design_uuid(v_design || ':phase:' || (f->>'key')),
      'fields', jsonb_build_object('tab_id', v_tab, 'project_id', v_project, 'name', left(btrim(coalesce(f->>'name', '')), 120), 'position', v_i * 1024,
        'start', nullif(f->>'start', ''), 'due', nullif(f->>'due', ''))));
  end loop;
  -- Madres, con su fase, sus pasos y lo que llevan.
  for t in select e from jsonb_array_elements(v_tasks) e loop
    v_n := v_n + 1;
    v_task := tasks.design_uuid(v_design || ':task:' || (t->>'key'));
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.tasks', 'id', v_task,
      'fields', jsonb_build_object('tab_id', v_tab, 'project_id', v_project, 'title', left(btrim(coalesce(t->>'title', '')), 1000), 'note', left(coalesce(t->>'note', ''), 20000),
        'priority', coalesce(t->>'priority', 'normal'), 'due', nullif(t->>'due', ''), 'position', v_n * 1024,
        'steps_in_order', coalesce((t->>'inOrder')::boolean, false),
        'phase_id', case when coalesce(t->>'phase', '') = '' then null else tasks.design_uuid(v_design || ':phase:' || (t->>'phase')) end)));
    v_i := 0;
    for s in select e from jsonb_array_elements(case when jsonb_typeof(t->'steps') = 'array' then t->'steps' else '[]'::jsonb end) e loop
      v_i := v_i + 1;
      v_step := tasks.design_uuid(v_design || ':step:' || (t->>'key') || ':' || v_i);
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.tasks', 'id', v_step,
        'fields', jsonb_build_object('tab_id', v_tab, 'project_id', v_project, 'parent_id', v_task, 'title', left(btrim(coalesce(s->>'title', '')), 1000),
          'note', left(coalesce(s->>'note', ''), 20000), 'position', v_i * 1024, 'step_free', coalesce((s->>'free')::boolean, false))));
    end loop;
    for k in select jsonb_array_elements_text(case when jsonb_typeof(t->'trades') = 'array' then t->'trades' else '[]'::jsonb end) loop
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.task_trades', 'id', tasks.design_uuid(v_design || ':trade:' || (t->>'key') || ':' || k),
        'fields', jsonb_build_object('tab_id', v_tab, 'project_id', v_project, 'task_id', v_task, 'trade_id', k)));
    end loop;
    for k in select jsonb_array_elements_text(case when jsonb_typeof(t->'spaces') = 'array' then t->'spaces' else '[]'::jsonb end) loop
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.task_spaces', 'id', tasks.design_uuid(v_design || ':space:' || (t->>'key') || ':' || k),
        'fields', jsonb_build_object('tab_id', v_tab, 'project_id', v_project, 'task_id', v_task, 'space_id', k)));
    end loop;
    for x in select e from jsonb_array_elements(case when jsonb_typeof(t->'people') = 'array' then t->'people' else '[]'::jsonb end) e loop
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.task_people',
        'id', tasks.design_uuid(v_design || ':person:' || (t->>'key') || ':' || coalesce(x->>'personId', 'level:' || (x->>'houseLevel'))),
        'fields', jsonb_build_object('tab_id', v_tab, 'project_id', v_project, 'task_id', v_task, 'person_id', x->>'personId', 'house_level', x->>'houseLevel')));
    end loop;
    v_i := 0;
    for x in select e from jsonb_array_elements(case when jsonb_typeof(t->'materials') = 'array' then t->'materials' else '[]'::jsonb end) e loop
      v_i := v_i + 1;
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.task_materials', 'id', tasks.design_uuid(v_design || ':material:' || (t->>'key') || ':' || (x->>'itemId')),
        'fields', jsonb_build_object('tab_id', v_tab, 'project_id', v_project, 'task_id', v_task, 'item_id', x->>'itemId', 'quantity', x->'quantity', 'position', v_i * 1024)));
    end loop;
  end loop;
  -- Dependencias, cuando ya están todas las tareas.
  for t in select e from jsonb_array_elements(v_tasks) e where jsonb_typeof(e->'dependsOn') = 'array' loop
    v_i := 0;
    for k in select jsonb_array_elements_text(t->'dependsOn') loop
      v_i := v_i + 1;
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.task_dependencies', 'id', tasks.design_uuid(v_design || ':dep:' || (t->>'key') || ':' || k),
        'fields', jsonb_build_object('tab_id', v_tab, 'project_id', v_project, 'task_id', tasks.design_uuid(v_design || ':task:' || (t->>'key')),
          'depends_on_id', tasks.design_uuid(v_design || ':task:' || k), 'position', v_i * 1024)));
    end loop;
  end loop;
  return jsonb_build_object('projectId', v_project, 'created', true, 'phases', jsonb_array_length(v_phases), 'tasks', v_n, 'steps', v_steps);
end $$;
select core.allow_procedure('tasks', 'tasks.project_design');

revoke all on function tasks.design_uuid(text) from public, anon, authenticated;
grant execute on function tasks.design_uuid(text) to service_role;
revoke all on function tasks.project_design(jsonb) from public, anon, authenticated;
grant execute on function tasks.project_design(jsonb) to service_role;

select core.register_capability($cap${
  "id": "tasks.project_design",
  "app": "tasks",
  "kind": "execute",
  "title": "Crear en Tasks un proyecto entero desde una entrevista",
  "description": "En un solo paso: el proyecto, sus fases, las tareas con su fase, sus pasos (en orden o no), oficios, espacios, personas, materiales y dependencias. Repetir con el mismo designId devuelve el proyecto que ya hay. No pide compras.",
  "route": "POST projects/design",
  "roles": ["editor", "owner"],
  "risk": "medium",
  "idempotent": true,
  "reversible": true,
  "input": {
    "type": "object",
    "required": ["designId", "tabId", "title", "tasks"],
    "additionalProperties": false,
    "properties": {
      "designId": { "type": "string", "format": "uuid" },
      "tabId": { "type": "string", "format": "uuid" },
      "title": { "type": "string", "minLength": 1, "maxLength": 300 },
      "objective": { "type": "string", "maxLength": 20000 },
      "due": { "type": "string", "format": "date" },
      "phases": { "type": "array", "maxItems": 30, "items": { "type": "object", "required": ["key", "name"], "additionalProperties": false, "properties": {
        "key": { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,40}$" }, "name": { "type": "string", "minLength": 1, "maxLength": 120 },
        "start": { "type": "string", "format": "date" }, "due": { "type": "string", "format": "date" } } } },
      "tasks": { "type": "array", "maxItems": 200, "items": { "type": "object", "required": ["key", "title"], "additionalProperties": false, "properties": {
        "key": { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,40}$" }, "phase": { "type": "string" }, "title": { "type": "string", "minLength": 1, "maxLength": 1000 },
        "note": { "type": "string" }, "due": { "type": "string", "format": "date" }, "priority": { "enum": ["normal", "high", "critical"] }, "inOrder": { "type": "boolean" },
        "steps": { "type": "array", "items": { "type": "object", "required": ["title"], "additionalProperties": false, "properties": { "title": { "type": "string" }, "note": { "type": "string" }, "free": { "type": "boolean" } } } },
        "trades": { "type": "array", "items": { "type": "string", "format": "uuid" } }, "spaces": { "type": "array", "items": { "type": "string", "format": "uuid" } },
        "people": { "type": "array", "items": { "type": "object", "additionalProperties": false, "properties": { "personId": { "type": "string", "format": "uuid" }, "houseLevel": { "enum": ["direccion", "staff", "outsider"] } } } },
        "materials": { "type": "array", "items": { "type": "object", "required": ["itemId", "quantity"], "additionalProperties": false, "properties": { "itemId": { "type": "string", "format": "uuid" }, "quantity": { "type": "number", "exclusiveMinimum": 0 } } } },
        "dependsOn": { "type": "array", "items": { "type": "string" } } } } }
    }
  },
  "output": {
    "type": "object",
    "required": ["projectId", "created"],
    "properties": { "projectId": { "type": "string", "format": "uuid" }, "created": { "type": "boolean" }, "phases": { "type": "integer" }, "tasks": { "type": "integer" }, "steps": { "type": "integer" } }
  },
  "reads": [],
  "writes": ["tasks.project_phases.due", "tasks.project_phases.name", "tasks.project_phases.position", "tasks.project_phases.start", "tasks.projects.due", "tasks.projects.note", "tasks.projects.tab_id", "tasks.projects.title", "tasks.task_dependencies.depends_on_id", "tasks.task_materials.item_id", "tasks.task_materials.quantity", "tasks.task_people.house_level", "tasks.task_people.person_id", "tasks.task_spaces.space_id", "tasks.task_trades.trade_id", "tasks.tasks.due", "tasks.tasks.note", "tasks.tasks.parent_id", "tasks.tasks.phase_id", "tasks.tasks.position", "tasks.tasks.priority", "tasks.tasks.step_free", "tasks.tasks.steps_in_order", "tasks.tasks.title"],
  "anchors": ["tasks.fases.nueva"],
  "since": "0.1.0"
}$cap$::jsonb);
