-- Ikisai Tasks · «Trabajos de hoy» para Flow (encargo de Core, 27-10-2026; docs/tasks/API.md §47). Toca solo el schema
-- tasks y, del núcleo, solo usa fail, allow_read y register_capability.
-- - tasks.today_projection(args {date?, projectId?}): lo de hoy del equipo, en el ámbito de quien lee. «Hoy» es lo que
--   vence ese día o antes y sigue abierto, más lo hecho ese día. El Plan de hoy (tasks.day_plans) NO entra: es privado
--   por persona (decisión de VG, 0339). Por tarea: proyecto, madre, título, prioridad, vencimiento, estado (open | done),
--   si está bloqueada (una dependencia o el paso anterior sin hacer), y las personas (`person_id`, `house_level`), los
--   oficios y los espacios. Los nombres de personas, oficios y espacios los pone quien lee con su app (ids de Central y
--   de Recursos). Fecha por defecto: hoy en Europa/Madrid.
-- - Capacidades del catálogo: `tasks.today_projection` (lectura) y `tasks.complete` (marcar hecha; editor u owner;
--   idempotente: repetir con una ya hecha devuelve lo que hay).

create or replace function tasks.today_projection(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_scopes jsonb;
  v_role text;
  v_day date;
  v_project uuid;
  v_items jsonb;
begin
  select m.scopes, m.role into v_scopes, v_role from core.memberships m where m.app = p->>'app' and m.user_id = (p->>'actor')::uuid;
  -- El outsider solo ve lo que se le abre expresamente: vacío o «*» es nada (como effectiveScopes de la Edge).
  if v_role = 'outsider' and tasks.scope_all(v_scopes) then v_scopes := '{"tabs": [], "projects": {}}'::jsonb; end if;
  begin
    v_day := coalesce(nullif(v_args->>'date', '')::date, (now() at time zone 'Europe/Madrid')::date);
    v_project := nullif(v_args->>'projectId', '')::uuid;
  exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'date is AAAA-MM-DD; projectId is a uuid'));
  end;
  select coalesce(jsonb_agg(x.item order by x.prio, x.due nulls last, x.title), '[]'::jsonb) into v_items from (
    select case t.priority when 'critical' then 0 when 'high' then 1 else 2 end prio, t.due, t.title,
      jsonb_build_object(
        'id', t.id, 'tabId', t.tab_id, 'projectId', t.project_id, 'project', pr.title, 'parentId', t.parent_id, 'title', t.title,
        'priority', t.priority, 'due', t.due, 'status', case when t.done then 'done' else 'open' end, 'doneAt', t.done_at,
        'overdue', not t.done and t.due < v_day,
        'blocked', not t.done and (
          exists (select 1 from tasks.task_dependencies d join tasks.tasks b on b.id = d.depends_on_id
                   where d.task_id = t.id and d.deleted_at is null and b.deleted_at is null and not b.done)
          or exists (select 1 from tasks.tasks pa join tasks.tasks sib on sib.parent_id = pa.id
                      where pa.id = t.parent_id and pa.steps_in_order and not t.step_free and not sib.step_free
                        and sib.deleted_at is null and not sib.done and sib.position < t.position)),
        'people', coalesce((select jsonb_agg(jsonb_build_object('personId', tp.person_id, 'houseLevel', tp.house_level)) from tasks.task_people tp
                             where tp.task_id = t.id and tp.deleted_at is null), '[]'::jsonb),
        'trades', coalesce((select jsonb_agg(tt.trade_id) from tasks.task_trades tt where tt.task_id = t.id and tt.deleted_at is null), '[]'::jsonb),
        'spaces', coalesce((select jsonb_agg(ts.space_id) from tasks.task_spaces ts where ts.task_id = t.id and ts.deleted_at is null), '[]'::jsonb)
      ) item
    from tasks.tasks t join tasks.projects pr on pr.id = t.project_id
    where t.deleted_at is null and pr.deleted_at is null and pr.status <> 'archived'
      and (v_project is null or t.project_id = v_project)
      and tasks.scope_project(v_scopes, t.tab_id, t.project_id)
      and ((not t.done and t.due is not null and t.due <= v_day) or (t.done and (t.done_at at time zone 'Europe/Madrid')::date = v_day))
    limit 2000
  ) x;
  return jsonb_build_object('date', v_day, 'items', v_items);
end $$;
-- También el outsider (personal por nivel de casa): ve lo de hoy de los proyectos que se le abren.
select core.allow_read('tasks', 'tasks.today_projection', 'function', '{reader,editor,owner,outsider}');

revoke all on function tasks.today_projection(jsonb) from public, anon, authenticated;
grant execute on function tasks.today_projection(jsonb) to service_role;

select core.register_capability($cap${
  "id": "tasks.today_projection",
  "app": "tasks",
  "kind": "read",
  "title": "Lo de hoy del equipo en Tasks",
  "description": "Las tareas de hoy en lo que ve la persona: lo que vence ese día o antes y sigue abierto, y lo hecho ese día. Con proyecto, prioridad, estado, si está bloqueada, y las personas, oficios y espacios (ids). Sin el Plan de hoy de cada cual, que es privado.",
  "route": "GET today/projection",
  "roles": ["reader", "editor", "owner", "outsider"],
  "risk": "low",
  "idempotent": true,
  "reversible": false,
  "input": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "date": { "type": "string", "format": "date" },
      "projectId": { "type": "string", "format": "uuid" }
    }
  },
  "output": {
    "type": "object",
    "required": ["date", "items"],
    "properties": {
      "date": { "type": "string", "format": "date" },
      "items": { "type": "array", "items": { "type": "object", "required": ["id", "projectId", "title", "status", "blocked"], "properties": {
        "id": { "type": "string", "format": "uuid" }, "projectId": { "type": "string", "format": "uuid" }, "project": { "type": "string" }, "parentId": { "type": ["string", "null"] },
        "title": { "type": "string" }, "priority": { "enum": ["normal", "high", "critical"] }, "due": { "type": ["string", "null"] }, "status": { "enum": ["open", "done"] },
        "overdue": { "type": "boolean" }, "blocked": { "type": "boolean" }, "people": { "type": "array" }, "trades": { "type": "array" }, "spaces": { "type": "array" } } } }
    }
  },
  "anchors": ["tasks.hoy.lista"],
  "since": "0.1.0"
}$cap$::jsonb);

select core.register_capability($cap${
  "id": "tasks.complete",
  "app": "tasks",
  "kind": "execute",
  "title": "Marcar una tarea de Tasks como hecha",
  "description": "Marca hecha una tarea que la persona ve. Si ya estaba hecha, devuelve lo que hay sin cambiar nada. No marca sus hijas.",
  "route": "POST tasks/complete",
  "roles": ["editor", "owner"],
  "risk": "low",
  "idempotent": true,
  "reversible": true,
  "input": {
    "type": "object",
    "required": ["taskId"],
    "additionalProperties": false,
    "properties": {
      "requestId": { "type": "string", "pattern": "^[A-Za-z0-9_.:-]{1,100}$" },
      "taskId": { "type": "string", "format": "uuid" }
    }
  },
  "output": {
    "type": "object",
    "required": ["taskId", "done", "changed"],
    "properties": { "taskId": { "type": "string", "format": "uuid" }, "done": { "type": "boolean" }, "changed": { "type": "boolean" }, "revision": { "type": "integer" } }
  },
  "anchors": ["tasks.lista.tarea.completar"],
  "since": "0.1.0"
}$cap$::jsonb);
