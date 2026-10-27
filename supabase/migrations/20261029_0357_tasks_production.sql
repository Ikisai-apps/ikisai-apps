-- Ikisai Tasks · «Proyectos y producción», 7.2: la proyección de producción de un proyecto (diseño en
-- MUELA/equipo/feedback/tasks/PROYECTOS_PRODUCCION.md §7.2; encargo de Core, 27-10-2026; docs/tasks/API.md §52). Toca solo
-- el schema tasks y, del núcleo, solo usa fail, allow_read y register_capability.
-- - tasks.production_rows(proyecto): por tarea viva del proyecto, su fase (la de su madre si es un paso), si es contenedor
--   (tiene pasos vivos), si está hecha (un contenedor, cuando lo están todos sus pasos) y qué la bloquea: una dependencia
--   sin hacer (`dependency`) o el paso anterior sin hacer en una cadena en orden (`step`). Es la regla de «hoy» (§47) en un
--   solo sitio; el bloqueo por material (7.3) se añadirá aquí.
-- - tasks.project_production_projection(args {projectId}): el proyecto en el ámbito de quien lee (404 si no lo ve), con
--   sus fases (madres hechas, abiertas, bloqueadas y la siguiente acción), sus tareas (oficios, espacios, personas,
--   materiales, compras y bloqueo), los carriles (por oficio, espacio, fase y persona: solo ids y recuentos de trabajo, es
--   decir, de tareas que no son contenedor) y `next`, la siguiente acción por fase. Sin nombres de Central ni de Recursos:
--   los pone quien lee. También el outsider, en los proyectos que se le abren.
-- - Capacidad del catálogo `tasks.project_production` (lectura), `GET projects/production?projectId=…`.

create or replace function tasks.production_rows(p_project uuid)
returns table (id uuid, parent_id uuid, phase_id uuid, title text, priority text, due date, done_at timestamptz, "position" numeric,
               container boolean, done boolean, blocked_by text, blocked_ids jsonb, mother_position numeric)
language sql stable as $$
  with t as (
    select x.*,
      case when x.parent_id is null then x.phase_id else (select m.phase_id from tasks.tasks m where m.id = x.parent_id) end phase,
      exists (select 1 from tasks.tasks c where c.parent_id = x.id and c.deleted_at is null) is_container
    from tasks.tasks x where x.project_id = p_project and x.deleted_at is null
  ), s as (
    select t.*,
      case when t.is_container then not exists (select 1 from tasks.tasks c where c.parent_id = t.id and c.deleted_at is null and not c.done) else t.done end is_done,
      coalesce((select jsonb_agg(b.id order by b.position, b.id) from tasks.task_dependencies d join tasks.tasks b on b.id = d.depends_on_id
                 where d.task_id = t.id and d.deleted_at is null and b.deleted_at is null and not b.done), '[]'::jsonb) dep_ids,
      coalesce((select jsonb_agg(sib.id order by sib.position, sib.id) from tasks.tasks pa join tasks.tasks sib on sib.parent_id = pa.id
                 where pa.id = t.parent_id and pa.steps_in_order and not t.step_free and not sib.step_free
                   and sib.deleted_at is null and not sib.done and sib.position < t.position), '[]'::jsonb) step_ids
    from t
  )
  select s.id, s.parent_id, s.phase, s.title, s.priority, s.due, s.done_at, s.position, s.is_container, s.is_done,
    case when s.is_done then null when jsonb_array_length(s.dep_ids) > 0 then 'dependency' when jsonb_array_length(s.step_ids) > 0 then 'step' end,
    case when s.is_done then '[]'::jsonb when jsonb_array_length(s.dep_ids) > 0 then s.dep_ids else s.step_ids end,
    coalesce((select m.position from tasks.tasks m where m.id = s.parent_id), s.position)
  from s
$$;

create or replace function tasks.project_production_projection(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_scopes jsonb;
  v_role text;
  v_project uuid;
  pr tasks.projects;
  v_out jsonb;
begin
  select m.scopes, m.role into v_scopes, v_role from core.memberships m where m.app = p->>'app' and m.user_id = (p->>'actor')::uuid;
  -- El outsider solo ve lo que se le abre expresamente (como today_projection).
  if v_role = 'outsider' and tasks.scope_all(v_scopes) then v_scopes := '{"tabs": [], "projects": {}}'::jsonb; end if;
  begin
    v_project := (v_args->>'projectId')::uuid;
  exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'projectId is a uuid'));
  end;
  if v_project is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'projectId is required')); end if;
  select * into pr from tasks.projects where id = v_project and deleted_at is null;
  if pr.id is null or not tasks.scope_project(v_scopes, pr.tab_id, pr.id) then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('kind', 'project', 'id', v_project));
  end if;

  with b as (select * from tasks.production_rows(v_project)),
  work as (select * from b where not b.container),
  ph as (
    select f.id, f.name, f.position, f.status, f.start, f.due, f.closed_note,
      (select count(*) from b where b.phase_id = f.id and b.parent_id is null)::int n_total,
      (select count(*) from b where b.phase_id = f.id and b.parent_id is null and not b.done)::int n_open,
      (select count(*) from work w where w.phase_id = f.id and w.blocked_by is not null)::int blocked,
      (select w.id from work w where w.phase_id = f.id and not w.done and w.blocked_by is null
        order by w.mother_position, w.parent_id nulls first, w.position, w.id limit 1) next_id
    from tasks.project_phases f where f.project_id = v_project and f.deleted_at is null
  )
  select jsonb_build_object(
    'project', jsonb_build_object('id', pr.id, 'tabId', pr.tab_id, 'title', pr.title, 'status', pr.status, 'due', pr.due),
    'phases', coalesce((select jsonb_agg(jsonb_build_object('id', ph.id, 'name', ph.name, 'position', ph.position, 'status', ph.status,
        'start', ph.start, 'due', ph.due, 'closedNote', ph.closed_note, 'total', ph.n_total, 'open', ph.n_open,
        'done', ph.n_total > 0 and ph.n_open = 0, 'blocked', ph.blocked, 'nextTaskId', ph.next_id) order by ph.position, ph.id) from ph), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object(
        'id', b.id, 'parentId', b.parent_id, 'phaseId', b.phase_id, 'title', b.title, 'done', b.done, 'doneAt', b.done_at,
        'priority', b.priority, 'due', b.due, 'position', b.position, 'container', b.container,
        'trades', coalesce((select jsonb_agg(tt.trade_id) from tasks.task_trades tt where tt.task_id = b.id and tt.deleted_at is null), '[]'::jsonb),
        'spaces', coalesce((select jsonb_agg(ts.space_id) from tasks.task_spaces ts where ts.task_id = b.id and ts.deleted_at is null), '[]'::jsonb),
        'people', coalesce((select jsonb_agg(jsonb_build_object('personId', tp.person_id, 'houseLevel', tp.house_level)) from tasks.task_people tp
                             where tp.task_id = b.id and tp.deleted_at is null), '[]'::jsonb),
        'materials', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'itemId', m.item_id, 'quantity', m.quantity, 'consumed', m.consumed) order by m.position, m.id)
                                from tasks.task_materials m where m.task_id = b.id and m.deleted_at is null), '[]'::jsonb),
        'purchases', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'itemId', r.item_id) order by r.created_at, r.id)
                                from tasks.purchase_requests r where r.task_id = b.id and r.deleted_at is null), '[]'::jsonb),
        'blocked', jsonb_build_object('by', b.blocked_by, 'ids', b.blocked_ids)
      ) order by b.mother_position, b.parent_id nulls first, b.position, b.id) from b), '[]'::jsonb),
    'lanes', jsonb_build_object(
      'byTrade', (select coalesce(jsonb_object_agg(z.k, jsonb_build_object('open', z.o, 'done', z.d)), '{}'::jsonb) from (
          select tt.trade_id::text k, count(*) filter (where not w.done) o, count(*) filter (where w.done) d
            from work w join tasks.task_trades tt on tt.task_id = w.id and tt.deleted_at is null group by tt.trade_id) z),
      'bySpace', (select coalesce(jsonb_object_agg(z.k, jsonb_build_object('open', z.o, 'done', z.d)), '{}'::jsonb) from (
          select ts.space_id::text k, count(*) filter (where not w.done) o, count(*) filter (where w.done) d
            from work w join tasks.task_spaces ts on ts.task_id = w.id and ts.deleted_at is null group by ts.space_id) z),
      'byPerson', (select coalesce(jsonb_object_agg(z.k, jsonb_build_object('open', z.o, 'done', z.d)), '{}'::jsonb) from (
          select coalesce(tp.person_id::text, 'level:' || tp.house_level) k, count(*) filter (where not w.done) o, count(*) filter (where w.done) d
            from work w join tasks.task_people tp on tp.task_id = w.id and tp.deleted_at is null group by 1) z),
      'byPhase', (select coalesce(jsonb_object_agg(z.k, jsonb_build_object('open', z.o, 'done', z.d)), '{}'::jsonb) from (
          select coalesce(w.phase_id::text, 'none') k, count(*) filter (where not w.done) o, count(*) filter (where w.done) d
            from work w group by 1) z)),
    'next', coalesce((select jsonb_agg(jsonb_build_object('phaseId', ph.id, 'taskId', ph.next_id) order by ph.position, ph.id) from ph where ph.next_id is not null), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;
-- También el outsider (personal por nivel de casa): ve la producción de los proyectos que se le abren.
select core.allow_read('tasks', 'tasks.project_production_projection', 'function', '{reader,editor,owner,outsider}');

revoke all on function tasks.production_rows(uuid) from public, anon, authenticated;
grant execute on function tasks.production_rows(uuid) to service_role;
revoke all on function tasks.project_production_projection(jsonb) from public, anon, authenticated;
grant execute on function tasks.project_production_projection(jsonb) to service_role;

select core.register_capability($cap${
  "id": "tasks.project_production",
  "app": "tasks",
  "kind": "read",
  "title": "La producción de un proyecto de Tasks",
  "description": "Un proyecto que la persona ve, con sus fases (hechas, abiertas, bloqueadas y la siguiente acción), sus tareas con oficios, espacios, personas, materiales, compras y bloqueo, y los carriles por oficio, espacio, fase y persona (ids y recuentos). Sin nombres de Central ni de Recursos.",
  "route": "GET projects/production",
  "roles": ["reader", "editor", "owner", "outsider"],
  "risk": "low",
  "idempotent": true,
  "reversible": false,
  "input": {
    "type": "object",
    "required": ["projectId"],
    "additionalProperties": false,
    "properties": { "projectId": { "type": "string", "format": "uuid" } }
  },
  "output": {
    "type": "object",
    "required": ["project", "phases", "tasks", "lanes", "next"],
    "properties": {
      "project": { "type": "object", "required": ["id", "title", "status"] },
      "phases": { "type": "array", "items": { "type": "object", "required": ["id", "name", "status", "total", "open", "done", "blocked"], "properties": {
        "id": { "type": "string", "format": "uuid" }, "name": { "type": "string" }, "status": { "enum": ["pending", "active", "done"] },
        "total": { "type": "integer" }, "open": { "type": "integer" }, "done": { "type": "boolean" }, "blocked": { "type": "integer" }, "nextTaskId": { "type": ["string", "null"] } } } },
      "tasks": { "type": "array", "items": { "type": "object", "required": ["id", "title", "done", "blocked"], "properties": {
        "id": { "type": "string", "format": "uuid" }, "parentId": { "type": ["string", "null"] }, "phaseId": { "type": ["string", "null"] }, "title": { "type": "string" },
        "done": { "type": "boolean" }, "container": { "type": "boolean" }, "trades": { "type": "array" }, "spaces": { "type": "array" }, "people": { "type": "array" },
        "materials": { "type": "array" }, "purchases": { "type": "array" },
        "blocked": { "type": "object", "properties": { "by": { "enum": ["dependency", "step", null] }, "ids": { "type": "array" } } } } } },
      "lanes": { "type": "object", "properties": { "byTrade": { "type": "object" }, "bySpace": { "type": "object" }, "byPhase": { "type": "object" }, "byPerson": { "type": "object" } } },
      "next": { "type": "array", "items": { "type": "object", "required": ["phaseId", "taskId"] } }
    }
  },
  "anchors": ["tasks.fases.fase"],
  "since": "0.1.0"
}$cap$::jsonb);
