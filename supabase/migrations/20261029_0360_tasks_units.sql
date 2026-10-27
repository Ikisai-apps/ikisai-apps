-- Ikisai Tasks · «Proyectos y producción», 7.5 (1): unidades repetidas (decisión de VG en vg-37: opción A, una marca por
-- unidad y paso, «Montar bastidor · 2 de 4»; diseño en MUELA/equipo/feedback/tasks/PROYECTOS_PRODUCCION.md §7.5;
-- docs/tasks/API.md §55). Toca solo el schema tasks y, del núcleo, solo usa register_table, synced_tables,
-- add_validate_hook, apply_row_op, allow_procedure, register_capability y fail.
-- - tasks.tasks.unit_count (1–100, opcional): en una madre, cuántas unidades se hacen («4 marcos»). Sus pasos (o ella
--   misma, si no tiene pasos) se marcan unidad a unidad. Un paso no lo lleva (INVALID_UNITS).
-- - tasks.task_units: una fila por unidad hecha de una tarea de trabajo (`task_id`, `unit` 1…n, `done_by`, `done_at`).
--   Deshacer es borrarla. La visibilidad es la de su tarea (`tab_id` y `project_id` desnormalizados, que la siguen al
--   moverla). Solo la escribe tasks.unit_step (marcador `tasks.unit_write`); seguir a su tarea, convertir un área y vaciar
--   la papelera, también.
-- - tasks.unit_step(args {taskId, unit, done}): marca o desmarca una unidad. La tarea queda hecha cuando lo están todas
--   sus unidades, y deja de estarlo si se desmarca una. Repetir no cambia nada. Editor u owner que vea la tarea; no en
--   proyectos archivados ni en un contenedor. Capacidad `tasks.unit_step` (`POST tasks/unit-step`), para Flow.
-- - tasks.validate_units (hook): solo tasks.unit_step escribe unidades; las vivas siguen a su tarea (INCONSISTENT_KEYS);
--   `unit_count` solo en una madre.
-- - tasks.empty_trash_prepare (copia de 0356) y tasks.convert_tab_into_project (copia de 0334): las unidades van a la
--   papelera con su tarea y pasan de área con ella.

alter table tasks.tasks add column unit_count int check (unit_count is null or unit_count between 1 and 100);
do $$
declare r record;
begin
  for r in select * from core.synced_tables where app = 'tasks' and schema_name = 'tasks' and table_name = 'tasks' loop
    perform core.register_table('tasks', 'tasks', r.table_name,
      r.writable_columns || array(select c from unnest(array['unit_count']) c where not (c = any(r.writable_columns))),
      r.readable_roles, r.writable_roles, r.never_purge);
  end loop;
end $$;

create table tasks.task_units (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid not null references tasks.tabs(id),
  project_id uuid not null references tasks.projects(id),
  task_id uuid not null references tasks.tasks(id),
  unit int not null check (unit between 1 and 100),
  done_by uuid references auth.users(id),
  done_at timestamptz not null default now()
);
create unique index task_units_live_idx on tasks.task_units (task_id, unit) where deleted_at is null;
create index task_units_project_idx on tasks.task_units (project_id);
create trigger tasks_guard_immutable before update on tasks.task_units for each row execute function tasks.guard_immutable('task_id', 'unit');
select core.register_table('tasks', 'tasks', 'task_units', array['tab_id','project_id','task_id','unit','done_by','done_at'],
  '{reader,outsider,editor,owner}', '{editor,owner}');

-- Cuántas unidades tiene una tarea de trabajo: las de su madre si es un paso; las suyas si es madre. Nulo = sin unidades.
create or replace function tasks.task_unit_total(p_task uuid)
returns int language sql stable as $$
  select case when t.parent_id is null then t.unit_count else (select m.unit_count from tasks.tasks m where m.id = t.parent_id) end
    from tasks.tasks t where t.id = p_task
$$;

create or replace function tasks.validate_units(p jsonb)
returns void language plpgsql as $$
declare
  v_app text := p->>'app';
  v_cursor bigint := (p->>'cursor')::bigint;
  v_write text := coalesce(current_setting('tasks.unit_write', true), '');
  v_purge boolean := coalesce(current_setting('tasks.purge_mode', true), '') <> '';
  -- Importar una copia (tasks.import_rows, solo la propietaria con toda la app) trae sus unidades tal cual.
  v_import boolean := coalesce(current_setting('tasks.import_mode', true), '') <> '';
  v_id uuid;
  c record;
begin
  for c in select ch.table_name, ch.row_id, ch.op, ch.before, ch.after from core.changes ch
            where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name in ('task_units', 'tasks')
              and ch.op in ('insert', 'update', 'delete', 'restore') order by ch.seq loop
    if c.table_name = 'tasks' then
      if c.op in ('insert', 'update', 'restore') and c.after->>'unit_count' is not null and c.after->>'parent_id' is not null then
        perform core.fail('INVALID_UNITS', 422, jsonb_build_object('taskId', c.row_id, 'reason', 'unit_count goes on the mother task'));
      end if;
      continue;
    end if;
    -- Seguir a su tarea (área o proyecto) es una actualización; lo demás, solo tasks.unit_step (o vaciar la papelera).
    continue when c.op = 'update';
    continue when (c.op = 'delete' and v_purge) or v_import;
    if v_write = '' or v_write <> coalesce(c.after, c.before)->>'task_id' then
      perform core.fail('INVALID_UNITS', 422, jsonb_build_object('table', 'tasks.task_units', 'id', c.row_id, 'reason', 'written only by tasks.unit_step'));
    end if;
  end loop;
  -- Las unidades vivas siguen a su tarea (las del lote y las de las tareas del lote).
  select u.id into v_id from tasks.task_units u join tasks.tasks t on t.id = u.task_id
   where u.deleted_at is null and (u.tab_id <> t.tab_id or u.project_id <> t.project_id)
     and (u.id in (select ch.row_id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'task_units')
          or u.task_id in (select ch.row_id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'tasks'))
   limit 1;
  if v_id is not null then perform core.fail('INCONSISTENT_KEYS', 422, jsonb_build_object('id', v_id)); end if;
end $$;
select core.add_validate_hook('tasks', 'tasks.validate_units');

create or replace function tasks.unit_step(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_app text := p->>'app';
  v_actor uuid := (p->>'actor')::uuid;
  v_role text := p->>'role';
  v_req text := p->>'requestId';
  v_cur bigint := (p->>'cursor')::bigint;
  v_scopes jsonb;
  v_task tasks.tasks;
  v_unit int; v_done boolean; v_total int; v_count int; v_row tasks.task_units;
  v_project tasks.projects;
begin
  if coalesce(v_role, '') not in ('editor', 'owner') then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'editor or owner')); end if;
  begin
    select * into v_task from tasks.tasks where id = (v_args->>'taskId')::uuid;
    v_unit := (v_args->>'unit')::int; v_done := coalesce((v_args->>'done')::boolean, true);
  exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'taskId is a uuid, unit an integer and done a boolean'));
  end;
  select m.scopes into v_scopes from core.memberships m where m.app = v_app and m.user_id = v_actor;
  if v_task.id is null or v_task.deleted_at is not null or not tasks.scope_project(v_scopes, v_task.tab_id, v_task.project_id) then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('kind', 'task', 'id', v_args->>'taskId'));
  end if;
  select * into v_project from tasks.projects where id = v_task.project_id;
  if v_project.status = 'archived' or v_project.deleted_at is not null then perform core.fail('PROJECT_ARCHIVED', 409, jsonb_build_object('projectId', v_project.id)); end if;
  if exists (select 1 from tasks.tasks c where c.parent_id = v_task.id and c.deleted_at is null) then
    perform core.fail('INVALID_UNITS', 422, jsonb_build_object('reason', 'mark the units on its steps'));
  end if;
  v_total := tasks.task_unit_total(v_task.id);
  if v_total is null then perform core.fail('INVALID_UNITS', 422, jsonb_build_object('reason', 'this task has no units: use tasks/complete')); end if;
  if v_unit is null or v_unit < 1 or v_unit > v_total then
    perform core.fail('INVALID_UNITS', 422, jsonb_build_object('reason', 'unit is 1..' || v_total));
  end if;

  perform set_config('tasks.unit_write', v_task.id::text, true);
  select * into v_row from tasks.task_units where task_id = v_task.id and unit = v_unit and deleted_at is null;
  if v_done and v_row.id is null then
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.task_units', 'id', gen_random_uuid(),
      'fields', jsonb_build_object('tab_id', v_task.tab_id, 'project_id', v_task.project_id, 'task_id', v_task.id, 'unit', v_unit, 'done_by', v_actor, 'done_at', now())));
  elsif not v_done and v_row.id is not null then
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'delete', 'table', 'tasks.task_units', 'id', v_row.id, 'expectedRevision', v_row.revision));
  end if;
  select count(*) into v_count from tasks.task_units where task_id = v_task.id and deleted_at is null and unit <= v_total;
  -- La tarea queda hecha con todas sus unidades; deja de estarlo si falta alguna.
  if (v_count = v_total) <> v_task.done then
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.tasks', 'id', v_task.id,
      'expectedRevision', v_task.revision, 'fields', jsonb_build_object('done', v_count = v_total)));
  end if;
  return jsonb_build_object('taskId', v_task.id, 'unit', v_unit, 'done', v_done, 'unitsDone', v_count, 'units', v_total, 'taskDone', v_count = v_total);
end $$;
select core.allow_procedure('tasks', 'tasks.unit_step');

select core.register_capability($cap${
  "id": "tasks.unit_step",
  "app": "tasks",
  "kind": "execute",
  "title": "Marcar una unidad de una tarea de Tasks",
  "description": "En una tarea con unidades («Montar bastidor · 2 de 4»), marca o desmarca una unidad. La tarea queda hecha cuando lo están todas sus unidades. Repetir no cambia nada.",
  "route": "POST tasks/unit-step",
  "roles": ["editor", "owner"],
  "risk": "low",
  "idempotent": true,
  "reversible": true,
  "input": {
    "type": "object",
    "required": ["taskId", "unit"],
    "additionalProperties": false,
    "properties": {
      "requestId": { "type": "string", "pattern": "^[A-Za-z0-9_.:-]{1,100}$" },
      "taskId": { "type": "string", "format": "uuid" },
      "unit": { "type": "integer", "minimum": 1, "maximum": 100 },
      "done": { "type": "boolean" }
    }
  },
  "output": {
    "type": "object",
    "required": ["taskId", "unit", "done", "unitsDone", "units", "taskDone"],
    "properties": { "taskId": { "type": "string", "format": "uuid" }, "unit": { "type": "integer" }, "done": { "type": "boolean" },
      "unitsDone": { "type": "integer" }, "units": { "type": "integer" }, "taskDone": { "type": "boolean" } }
  },
  "anchors": ["tasks.lista.tarea.completar"],
  "since": "0.1.0"
}$cap$::jsonb);

-- ---------------------------------------------------------------------------
-- Convertir un área en proyecto (copiada entera de 0334): las unidades pasan con su tarea.
-- ---------------------------------------------------------------------------
create or replace function tasks.convert_tab_into_project(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_app text := p->>'app';
  v_actor uuid := (p->>'actor')::uuid;
  v_role text := p->>'role';
  v_req text := p->>'requestId';
  v_cur bigint := (p->>'cursor')::bigint;
  v_src uuid;
  v_dst uuid;
  v_project uuid;
  v_title text := btrim(coalesce(v_args->>'title', ''));
  v_scopes jsonb;
  v_map jsonb := '{}'::jsonb;
  v_fam uuid;
  v_lab uuid;
  v_pos numeric;
  v_label uuid;
  v_archived boolean;
  v_counts jsonb := '{}'::jsonb;
  v_n int;
  r record;
begin
  begin
    v_src := (v_args->>'sourceTabId')::uuid; v_dst := (v_args->>'targetTabId')::uuid; v_project := (v_args->>'projectId')::uuid;
  exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'sourceTabId, targetTabId and projectId must be uuids'));
  end;
  if v_src is null or v_dst is null or v_project is null or v_src = v_dst or length(v_title) < 1 or length(v_title) > 300 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'two different areas and a title are required'));
  end if;
  select m.scopes into v_scopes from core.memberships m where m.app = v_app and m.user_id = v_actor;
  if v_role <> 'owner' or not tasks.scope_all(v_scopes) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'owner with full access')); end if;
  if not exists (select 1 from tasks.tabs where id = v_src and deleted_at is null) then perform core.fail('NOT_FOUND', 404, jsonb_build_object('kind', 'tab', 'id', v_src)); end if;
  if not exists (select 1 from tasks.tabs where id = v_dst and deleted_at is null) then perform core.fail('NOT_FOUND', 404, jsonb_build_object('kind', 'tab', 'id', v_dst)); end if;

  perform set_config('tasks.convert_mode', 'on', true);

  -- 1. El proyecto de destino, al final de su área.
  select coalesce(max(position), 0) + 1024 into v_pos from tasks.projects where tab_id = v_dst;
  perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.projects', 'id', v_project,
    'fields', jsonb_build_object('tab_id', v_dst, 'title', v_title, 'note', '', 'position', v_pos)));

  -- 2. Etiquetas usadas por las tareas vivas (como etiqueta o como responsable): las del destino con el mismo nombre en la
  --    misma familia (por su clave de sistema o, si no tiene, por nombre); las que falten, se crean.
  for r in
    select distinct lb.id, lb.name, fm.name fam_name, fm.color fam_color, fm.system_key fam_key, fm.id fam_id, fm.tab_id fam_tab
      from tasks.labels lb join tasks.families fm on fm.id = lb.family_id
     where lb.tab_id = v_src and lb.deleted_at is null
       and (exists (select 1 from tasks.task_labels tl join tasks.tasks t on t.id = tl.task_id and t.deleted_at is null where tl.label_id = lb.id and tl.deleted_at is null)
            or exists (select 1 from tasks.tasks t where t.owner_label_id = lb.id and t.deleted_at is null and t.tab_id = v_src)
            or exists (select 1 from tasks.request_routes rr where rr.owner_label_id = lb.id and rr.deleted_at is null and rr.tab_id = v_src))
  loop
    v_fam := null; v_lab := null;
    select f.id, f.archived into v_fam, v_archived from tasks.families f
      where (r.fam_tab is null and f.id = r.fam_id)
         or (r.fam_tab is not null and f.tab_id = v_dst and f.deleted_at is null
             and ((r.fam_key is not null and f.system_key = r.fam_key) or (r.fam_key is null and f.system_key is null and lower(f.name) = lower(r.fam_name))))
      order by f.archived, f.position limit 1;
    v_archived := coalesce(v_archived, false) and v_fam is not null;
    if v_fam is null then
      v_fam := gen_random_uuid();
      select coalesce(max(position), 0) + 1024 into v_pos from tasks.families where tab_id = v_dst;
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.families', 'id', v_fam,
        'fields', jsonb_build_object('tab_id', v_dst, 'name', r.fam_name, 'color', r.fam_color, 'position', v_pos, 'system_key', r.fam_key)));
      v_counts := v_counts || jsonb_build_object('familiesCreated', coalesce((v_counts->>'familiesCreated')::int, 0) + 1);
    end if;
    select lb.id into v_lab from tasks.labels lb
      where lb.tab_id = v_dst and lb.family_id = v_fam and lb.deleted_at is null and lower(lb.name) = lower(r.name)
      order by lb.archived, lb.position limit 1;
    if v_lab is null then
      v_lab := gen_random_uuid();
      select coalesce(max(position), 0) + 1024 into v_pos from tasks.labels where family_id = v_fam;
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.labels', 'id', v_lab,
        'fields', jsonb_build_object('tab_id', v_dst, 'family_id', v_fam, 'name', r.name, 'position', v_pos, 'archived', v_archived)));
      v_counts := v_counts || jsonb_build_object('labelsCreated', coalesce((v_counts->>'labelsCreated')::int, 0) + 1);
    end if;
    v_map := v_map || jsonb_build_object(r.id::text, v_lab);
  end loop;

  -- 3. Tareas vivas de todos los proyectos del origen, con los mismos ids (historial, adjuntos y enlaces de Finance siguen).
  v_n := 0;
  for r in select * from tasks.tasks where tab_id = v_src and deleted_at is null loop
    v_label := case when r.owner_label_id is null then null else coalesce((v_map->>r.owner_label_id::text)::uuid, (select g.id from tasks.labels g where g.id = r.owner_label_id and g.tab_id is null)) end;
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.tasks', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project, 'owner_label_id', v_label)));
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('tasks', v_n);

  -- 4. Sus etiquetas, dependencias y adjuntos (también los de los proyectos, que pasan al nuevo). Lo que está en la papelera
  --    se queda con el área antigua y vuelve con ella si se restaura.
  v_n := 0;
  for r in select tl.* from tasks.task_labels tl join tasks.tasks t on t.id = tl.task_id where tl.tab_id = v_src and tl.deleted_at is null and t.deleted_at is null loop
    v_label := coalesce((v_map->>r.label_id::text)::uuid, (select g.id from tasks.labels g where g.id = r.label_id and g.tab_id is null));
    if v_label is not null and not exists (select 1 from tasks.task_labels x where x.task_id = r.task_id and x.label_id = v_label and x.deleted_at is null and x.id <> r.id) then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.task_labels', 'id', r.id, 'expectedRevision', r.revision,
        'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project, 'label_id', v_label)));
    else
      -- Dos etiquetas del origen con el mismo nombre en la misma familia quedan en una sola.
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'delete', 'table', 'tasks.task_labels', 'id', r.id, 'expectedRevision', r.revision));
    end if;
  end loop;
  -- Espacios de las tareas (R2): pasan con su tarea, como sus etiquetas (son de toda la casa, no hay que convertirlos).
  for r in select ts.* from tasks.task_spaces ts join tasks.tasks t on t.id = ts.task_id
           where ts.tab_id = v_src and ts.deleted_at is null and t.deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.task_spaces', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project)));
  end loop;
  -- Oficios de las tareas (P2): pasan con su tarea, como sus espacios (son de toda la casa).
  for r in select tt.* from tasks.task_trades tt join tasks.tasks t on t.id = tt.task_id
           where tt.tab_id = v_src and tt.deleted_at is null and t.deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.task_trades', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project)));
  end loop;
  -- Personas de las tareas (P2, PR 3): pasan con su tarea, como sus oficios (son de toda la casa).
  for r in select tp.* from tasks.task_people tp join tasks.tasks t on t.id = tp.task_id
           where tp.tab_id = v_src and tp.deleted_at is null and t.deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.task_people', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project)));
  end loop;
  -- Comentarios de las tareas (O1, paso 2): pasan con su tarea, sean de quien sean.
  for r in select cm.* from tasks.task_comments cm join tasks.tasks t on t.id = cm.task_id
           where cm.tab_id = v_src and cm.deleted_at is null and t.deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.task_comments', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project)));
  end loop;
  -- Materiales y equipos de las tareas (R6 PR 3): pasan con su tarea.
  for r in select tm.* from tasks.task_materials tm join tasks.tasks t on t.id = tm.task_id
           where tm.tab_id = v_src and tm.deleted_at is null and t.deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.task_materials', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project)));
  end loop;
  -- Unidades hechas (0360): pasan con su tarea.
  for r in select tu.* from tasks.task_units tu join tasks.tasks t on t.id = tu.task_id
           where tu.tab_id = v_src and tu.deleted_at is null and t.deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.task_units', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project)));
  end loop;
  for r in select d.*, (dt.deleted_at is null) target_live from tasks.task_dependencies d join tasks.tasks t on t.id = d.task_id join tasks.tasks dt on dt.id = d.depends_on_id
           where d.tab_id = v_src and d.deleted_at is null and t.deleted_at is null loop
    if r.target_live then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.task_dependencies', 'id', r.id, 'expectedRevision', r.revision,
        'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project)));
      v_n := v_n + 1;
    else
      -- Depende de una tarea en la papelera (que se queda en el área antigua): la condición ya no aplica.
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'delete', 'table', 'tasks.task_dependencies', 'id', r.id, 'expectedRevision', r.revision));
    end if;
  end loop;
  v_counts := v_counts || jsonb_build_object('dependencies', v_n);
  v_n := 0;
  for r in select at.* from tasks.attachments at left join tasks.tasks t on t.id = at.task_id
           where at.tab_id = v_src and at.deleted_at is null and (at.task_id is null or t.deleted_at is null) loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.attachments', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project)));
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('attachments', v_n);

  -- 5. Compras vivas del área: pasan al destino (lo que era de un proyecto del origen, al proyecto nuevo). El almacén ya no
  --    es de Tasks: vive en Recursos, común a toda la casa (R6), y no se mueve.
  for r in select * from tasks.purchase_plans where tab_id = v_src and deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.purchase_plans', 'id', r.id, 'expectedRevision', r.revision, 'fields', jsonb_build_object('tab_id', v_dst)));
  end loop;
  for r in select * from tasks.purchase_plan_stops where tab_id = v_src and deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.purchase_plan_stops', 'id', r.id, 'expectedRevision', r.revision, 'fields', jsonb_build_object('tab_id', v_dst)));
  end loop;
  v_n := 0;
  for r in select rq.*, (t.id is null or t.deleted_at is null) task_live
             from tasks.purchase_requests rq left join tasks.tasks t on t.id = rq.task_id
            where rq.tab_id = v_src and rq.deleted_at is null loop
    -- El enlace a una tarea en la papelera (que se queda en el área antigua) se suelta.
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.purchase_requests', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', case when r.project_id is null then null else v_project end,
                                   'task_id', case when r.task_live then r.task_id end)));
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('purchaseRequests', v_n);

  -- 6. Reglas de entrada que apuntaban al origen: ahora, al proyecto nuevo.
  v_n := 0;
  for r in select * from tasks.request_routes where tab_id = v_src and deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.request_routes', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project, 'owner_label_id', case when r.owner_label_id is null then null else coalesce((v_map->>r.owner_label_id::text)::uuid, (select g.id from tasks.labels g where g.id = r.owner_label_id and g.tab_id is null)) end)));
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('routes', v_n);

  -- 7. El área de origen, ya vacía, a la papelera (se puede restaurar; sus proyectos quedan vacíos con ella).
  select * into r from tasks.tabs where id = v_src;
  perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'delete', 'table', 'tasks.tabs', 'id', v_src, 'expectedRevision', r.revision));

  return jsonb_build_object('projectId', v_project, 'counts', v_counts);
end $$;

-- ---------------------------------------------------------------------------
-- Vaciar papelera (copiada entera de 0356): las unidades de las tareas en la papelera también van a ella.
-- ---------------------------------------------------------------------------
create or replace function tasks.empty_trash_prepare(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role'; v_request text := p->>'requestId'; v_cursor bigint := (p->>'cursor')::bigint;
  v_scopes jsonb; v_count int := 0; v_step text; r record;
begin
  select m.scopes into v_scopes from core.memberships m where m.app = v_app and m.user_id = v_actor;
  if v_role is distinct from 'owner' or not tasks.scope_all(v_scopes) then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only owners with full access empty the trash'));
  end if;
  perform set_config('tasks.purge_mode', '1', true);
  -- Cada paso ve lo que borraron los anteriores: primero las tareas, después lo que cuelga de ellas y de sus contenedores.
  foreach v_step in array array['purchase_requests', 'purchase_plan_stops', 'purchase_plans', 'tasks', 'task_dependencies', 'task_labels', 'project_labels', 'task_spaces', 'project_spaces', 'task_trades', 'project_trades', 'task_people', 'project_people', 'task_comments', 'task_materials', 'task_units', 'attachments', 'saved_views', 'project_phases', 'projects', 'labels', 'families'] loop
    for r in execute case v_step
      when 'purchase_requests' then
        'select r.id, r.revision from tasks.purchase_requests r join tasks.tabs tb on tb.id = r.tab_id left join tasks.projects pr on pr.id = r.project_id
         where r.deleted_at is null and (tb.deleted_at is not null or pr.deleted_at is not null)'
      when 'purchase_plan_stops' then
        'select st.id, st.revision from tasks.purchase_plan_stops st join tasks.purchase_plans pl on pl.id = st.plan_id join tasks.tabs tb on tb.id = st.tab_id
         where st.deleted_at is null and (pl.deleted_at is not null or tb.deleted_at is not null)'
      when 'purchase_plans' then
        'select pl.id, pl.revision from tasks.purchase_plans pl join tasks.tabs tb on tb.id = pl.tab_id where pl.deleted_at is null and tb.deleted_at is not null'
      when 'tasks' then
        'select t.id, t.revision from tasks.tasks t join tasks.projects pr on pr.id = t.project_id join tasks.tabs tb on tb.id = t.tab_id
           left join tasks.tasks pa on pa.id = t.parent_id
         where t.deleted_at is null and (pr.deleted_at is not null or tb.deleted_at is not null or pa.deleted_at is not null)'
      when 'task_dependencies' then
        'select d.id, d.revision from tasks.task_dependencies d join tasks.tasks t on t.id = d.task_id join tasks.tasks dt on dt.id = d.depends_on_id
         where d.deleted_at is null and (t.deleted_at is not null or dt.deleted_at is not null)'
      when 'task_labels' then
        'select tl.id, tl.revision from tasks.task_labels tl join tasks.tasks t on t.id = tl.task_id join tasks.labels l on l.id = tl.label_id
         where tl.deleted_at is null and (t.deleted_at is not null or l.deleted_at is not null)'
      when 'project_labels' then
        'select pl.id, pl.revision from tasks.project_labels pl join tasks.projects pr on pr.id = pl.project_id join tasks.tabs tb on tb.id = pl.tab_id join tasks.labels l on l.id = pl.label_id
         where pl.deleted_at is null and (pr.deleted_at is not null or tb.deleted_at is not null or l.deleted_at is not null)'
      when 'task_spaces' then
        'select ts.id, ts.revision from tasks.task_spaces ts join tasks.tasks t on t.id = ts.task_id
         where ts.deleted_at is null and t.deleted_at is not null'
      when 'project_spaces' then
        'select ps.id, ps.revision from tasks.project_spaces ps join tasks.projects pr on pr.id = ps.project_id join tasks.tabs tb on tb.id = ps.tab_id
         where ps.deleted_at is null and (pr.deleted_at is not null or tb.deleted_at is not null)'
      when 'task_trades' then
        'select tt.id, tt.revision from tasks.task_trades tt join tasks.tasks t on t.id = tt.task_id
         where tt.deleted_at is null and t.deleted_at is not null'
      when 'project_trades' then
        'select pt.id, pt.revision from tasks.project_trades pt join tasks.projects pr on pr.id = pt.project_id join tasks.tabs tb on tb.id = pt.tab_id
         where pt.deleted_at is null and (pr.deleted_at is not null or tb.deleted_at is not null)'
      when 'task_people' then
        'select tp.id, tp.revision from tasks.task_people tp join tasks.tasks t on t.id = tp.task_id
         where tp.deleted_at is null and t.deleted_at is not null'
      when 'task_comments' then
        'select cm.id, cm.revision from tasks.task_comments cm join tasks.tasks t on t.id = cm.task_id
         where cm.deleted_at is null and t.deleted_at is not null'
      when 'task_materials' then
        'select tm.id, tm.revision from tasks.task_materials tm join tasks.tasks t on t.id = tm.task_id
         where tm.deleted_at is null and t.deleted_at is not null'
      when 'task_units' then
        'select tu.id, tu.revision from tasks.task_units tu join tasks.tasks t on t.id = tu.task_id
         where tu.deleted_at is null and t.deleted_at is not null'
      when 'project_people' then
        'select pp.id, pp.revision from tasks.project_people pp join tasks.projects pr on pr.id = pp.project_id join tasks.tabs tb on tb.id = pp.tab_id
         where pp.deleted_at is null and (pr.deleted_at is not null or tb.deleted_at is not null)'
      when 'attachments' then
        'select a.id, a.revision from tasks.attachments a join tasks.projects pr on pr.id = a.project_id join tasks.tabs tb on tb.id = a.tab_id left join tasks.tasks t on t.id = a.task_id
         where a.deleted_at is null and (pr.deleted_at is not null or tb.deleted_at is not null or t.deleted_at is not null)'
      when 'saved_views' then
        'select v.id, v.revision from tasks.saved_views v join tasks.tabs tb on tb.id = v.tab_id where v.deleted_at is null and tb.deleted_at is not null'
      when 'project_phases' then
        'select ph.id, ph.revision from tasks.project_phases ph join tasks.projects pr on pr.id = ph.project_id join tasks.tabs tb on tb.id = ph.tab_id
         where ph.deleted_at is null and (pr.deleted_at is not null or tb.deleted_at is not null)'
      when 'projects' then
        'select pr.id, pr.revision from tasks.projects pr join tasks.tabs tb on tb.id = pr.tab_id where pr.deleted_at is null and tb.deleted_at is not null'
      when 'labels' then
        'select l.id, l.revision from tasks.labels l join tasks.tabs tb on tb.id = l.tab_id where l.deleted_at is null and tb.deleted_at is not null'
      else
        'select f.id, f.revision from tasks.families f join tasks.tabs tb on tb.id = f.tab_id where f.deleted_at is null and tb.deleted_at is not null'
      end
    loop
      perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor,
        jsonb_build_object('op', 'delete', 'table', 'tasks.' || v_step, 'id', r.id, 'expectedRevision', r.revision));
      v_count := v_count + 1;
    end loop;
  end loop;
  return jsonb_build_object('trashed', v_count);
end $$;

do $$
declare f text;
begin
  for f in select 'tasks.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'tasks' loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
