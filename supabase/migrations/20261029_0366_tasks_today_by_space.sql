-- Ikisai Tasks · «Hoy» por espacio, también para Central (encargo de Core, 27-10-2026; docs/tasks/API.md §60). Toca solo el
-- schema tasks; de Recursos solo lee los espacios (su árbol: altura › edificio o exterior › espacio › subespacio).
-- - tasks.space_within(espacio, nodo): si el espacio es el nodo o está dentro de él.
-- - tasks.space_top(espacio): su primer nivel, como el filtro de la pantalla «Hoy» (#1134): su altura o, si la altura tiene una
--   sola cosa dentro, esa cosa.
-- - tasks.today_projection (copia de 0362): `spaceId` opcional, un espacio (con todo lo de dentro) o 'none' (sin espacio).
--   La capacidad `tasks.today_projection` lo declara.
-- - tasks.central_blocked_by_space (vista para Central, como central_kpi_projection): por espacio de primer nivel (nulo = sin
--   espacio), las tareas pendientes y cuántas están bloqueadas, con la misma regla que el indicador `tasks.blocked` (0358:
--   dependencia, paso anterior o material). Solo ids y recuentos: los nombres los pone Central.

create or replace function tasks.space_within(p_space uuid, p_node uuid)
returns boolean language sql stable as $$
  with recursive up as (
    select s.id, s.parent_id, 1 depth from resources.spaces s where s.id = p_space
    union all
    select s.id, s.parent_id, up.depth + 1 from up join resources.spaces s on s.id = up.parent_id where up.depth < 12
  ) select exists (select 1 from up where up.id = p_node)
$$;

create or replace function tasks.space_top(p_space uuid)
returns uuid language sql stable as $$
  with recursive up as (
    select s.id, s.parent_id, s.kind, 1 depth from resources.spaces s where s.id = p_space
    union all
    select s.id, s.parent_id, s.kind, up.depth + 1 from up join resources.spaces s on s.id = up.parent_id where up.depth < 12
  ), root as (select * from up order by depth desc limit 1),
  only_child as (
    select (array_agg(c.id))[1] id from resources.spaces c, root
     where c.parent_id = root.id and c.deleted_at is null and coalesce(c.active, true)
    having count(*) = 1
  )
  select case when (select kind from root) = 'altura' and (select id from only_child) in (select id from up) then (select id from only_child)
              else (select id from root) end
$$;

create or replace function tasks.today_projection(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_scopes jsonb;
  v_role text;
  v_day date;
  v_project uuid;
  v_space text;
  v_items jsonb;
begin
  select m.scopes, m.role into v_scopes, v_role from core.memberships m where m.app = p->>'app' and m.user_id = (p->>'actor')::uuid;
  -- El outsider solo ve lo que se le abre expresamente: vacío o «*» es nada (como effectiveScopes de la Edge).
  if v_role = 'outsider' and tasks.scope_all(v_scopes) then v_scopes := '{"tabs": [], "projects": {}}'::jsonb; end if;
  begin
    v_day := coalesce(nullif(v_args->>'date', '')::date, (now() at time zone 'Europe/Madrid')::date);
    v_project := nullif(v_args->>'projectId', '')::uuid;
    -- 0366: un espacio (con todo lo que tiene dentro) o 'none' (las que no tienen espacio).
    v_space := nullif(v_args->>'spaceId', '');
    if v_space is not null and v_space <> 'none' then perform v_space::uuid; end if;
  exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'date is AAAA-MM-DD; projectId is a uuid; spaceId is a uuid or none'));
  end;
  select coalesce(jsonb_agg(x.item order by x.prio, x.due nulls last, x.title), '[]'::jsonb) into v_items from (
    select case t.priority when 'critical' then 0 when 'high' then 1 else 2 end prio, t.due, t.title,
      jsonb_build_object(
        'id', t.id, 'tabId', t.tab_id, 'projectId', t.project_id, 'project', pr.title, 'parentId', t.parent_id, 'title', t.title,
        'priority', t.priority, 'due', t.due, 'status', case when t.done then 'done' else 'open' end, 'doneAt', t.done_at,
        'overdue', not t.done and t.due < v_day,
        -- 0362: las unidades de una tarea con unidades («2 de 4»).
        'units', case when tasks.task_unit_total(t.id) is null or exists (select 1 from tasks.tasks c where c.parent_id = t.id and c.deleted_at is null) then null
                 else jsonb_build_object('total', tasks.task_unit_total(t.id), 'done', (select count(*) from tasks.task_units u
                   where u.task_id = t.id and u.deleted_at is null and u.unit <= tasks.task_unit_total(t.id))) end,
        'blocked', not t.done and (
          exists (select 1 from tasks.task_dependencies d join tasks.tasks b on b.id = d.depends_on_id
                   where d.task_id = t.id and d.deleted_at is null and b.deleted_at is null and not b.done)
          or exists (select 1 from tasks.tasks pa join tasks.tasks sib on sib.parent_id = pa.id
                      where pa.id = t.parent_id and pa.steps_in_order and not t.step_free and not sib.step_free
                        and sib.deleted_at is null and not sib.done and sib.position < t.position)
          -- 0358: o le falta material (tasks.material_shortage), aunque no haya compra.
          or t.id in (select sh.task_id from tasks.material_shortage(null) sh where sh.missing > 0)),
        'people', coalesce((select jsonb_agg(jsonb_build_object('personId', tp.person_id, 'houseLevel', tp.house_level)) from tasks.task_people tp
                             where tp.task_id = t.id and tp.deleted_at is null), '[]'::jsonb),
        'trades', coalesce((select jsonb_agg(tt.trade_id) from tasks.task_trades tt where tt.task_id = t.id and tt.deleted_at is null), '[]'::jsonb),
        'spaces', coalesce((select jsonb_agg(ts.space_id) from tasks.task_spaces ts where ts.task_id = t.id and ts.deleted_at is null), '[]'::jsonb)
      ) item
    from tasks.tasks t join tasks.projects pr on pr.id = t.project_id
    where t.deleted_at is null and pr.deleted_at is null and pr.status <> 'archived'
      and (v_project is null or t.project_id = v_project)
      and (v_space is null
           or (v_space = 'none' and not exists (select 1 from tasks.task_spaces ts where ts.task_id = t.id and ts.deleted_at is null))
           or (v_space <> 'none' and exists (select 1 from tasks.task_spaces ts where ts.task_id = t.id and ts.deleted_at is null
                                              and tasks.space_within(ts.space_id, v_space::uuid))))
      and tasks.scope_project(v_scopes, t.tab_id, t.project_id)
      and ((not t.done and t.due is not null and t.due <= v_day) or (t.done and (t.done_at at time zone 'Europe/Madrid')::date = v_day))
    limit 2000
  ) x;
  return jsonb_build_object('date', v_day, 'items', v_items);
end $$;

create or replace view tasks.central_blocked_by_space as
with today as (select (now() at time zone 'Europe/Madrid')::date as d),
-- Tareas pendientes: hojas (sin hijas vivas) sin completar. Un padre se calcula por sus hijas, así que no cuenta aparte.
pending as (
  select t.id, t.due
    from tasks.tasks t
    join tasks.projects pr on pr.id = t.project_id and pr.deleted_at is null and pr.status <> 'archived'
    join tasks.tabs tb on tb.id = t.tab_id and tb.deleted_at is null
   where t.deleted_at is null and not t.done
     and not exists (select 1 from tasks.tasks c where c.parent_id = t.id and c.deleted_at is null)),
-- Bloqueadas (0354): pendientes que esperan a una dependencia sin hacer, o al paso anterior en una madre con pasos en orden.
blocked as (
  select p.id from pending p join tasks.tasks t on t.id = p.id
   where exists (select 1 from tasks.task_dependencies d join tasks.tasks b on b.id = d.depends_on_id
                  where d.task_id = t.id and d.deleted_at is null and b.deleted_at is null and not b.done)
      or exists (select 1 from tasks.tasks pa join tasks.tasks sib on sib.parent_id = pa.id
                  where pa.id = t.parent_id and pa.steps_in_order and not t.step_free and not sib.step_free
                    and sib.deleted_at is null and not sib.done and sib.position < t.position)
      -- 0358: o le falta material.
      or p.id in (select sh.task_id from tasks.material_shortage(null) sh where sh.missing > 0)),
per_space as (
  select tasks.space_top(ts.space_id) space_id, p.id task_id from pending p
    join tasks.task_spaces ts on ts.task_id = p.id and ts.deleted_at is null
  union
  select null::uuid, p.id from pending p
   where not exists (select 1 from tasks.task_spaces ts where ts.task_id = p.id and ts.deleted_at is null)
)
select ps.space_id, count(distinct ps.task_id)::int as open, count(distinct ps.task_id) filter (where ps.task_id in (select id from blocked))::int as blocked,
       now() as computed_at
  from per_space ps group by ps.space_id;

select core.allow_read('central', 'tasks.central_blocked_by_space', 'view');
revoke all on tasks.central_blocked_by_space from public, anon, authenticated;
grant select on tasks.central_blocked_by_space to service_role;

select core.register_capability($cap${
  "id": "tasks.today_projection",
  "app": "tasks",
  "kind": "read",
  "title": "Lo de hoy del equipo en Tasks",
  "description": "Las tareas de hoy en lo que ve la persona: lo que vence ese día o antes y sigue abierto, y lo hecho ese día. Con proyecto, prioridad, estado, si está bloqueada, y las personas, oficios y espacios (ids). Sin el Plan de hoy de cada cual, que es privado. Con spaceId, solo lo de ese espacio (con todo lo que tiene dentro) o, con «none», lo que no tiene espacio.",
  "route": "GET today/projection",
  "roles": [
    "reader",
    "editor",
    "owner",
    "outsider"
  ],
  "risk": "low",
  "idempotent": true,
  "reversible": false,
  "input": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "date": {
        "type": "string",
        "format": "date"
      },
      "projectId": {
        "type": "string",
        "format": "uuid"
      },
      "spaceId": {
        "type": "string",
        "pattern": "^(none|[0-9a-fA-F-]{36})$"
      }
    }
  },
  "output": {
    "type": "object",
    "required": [
      "date",
      "items"
    ],
    "properties": {
      "date": {
        "type": "string",
        "format": "date"
      },
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "id",
            "projectId",
            "title",
            "status",
            "blocked"
          ],
          "properties": {
            "id": {
              "type": "string",
              "format": "uuid"
            },
            "projectId": {
              "type": "string",
              "format": "uuid"
            },
            "project": {
              "type": "string"
            },
            "parentId": {
              "type": [
                "string",
                "null"
              ]
            },
            "title": {
              "type": "string"
            },
            "priority": {
              "enum": [
                "normal",
                "high",
                "critical"
              ]
            },
            "due": {
              "type": [
                "string",
                "null"
              ]
            },
            "status": {
              "enum": [
                "open",
                "done"
              ]
            },
            "overdue": {
              "type": "boolean"
            },
            "blocked": {
              "type": "boolean"
            },
            "people": {
              "type": "array"
            },
            "trades": {
              "type": "array"
            },
            "spaces": {
              "type": "array"
            }
          }
        }
      }
    }
  },
  "anchors": [
    "tasks.hoy.lista"
  ],
  "since": "0.1.0",
  "reads": [
    "resources.spaces.parent_id",
    "tasks.projects.title",
    "tasks.task_dependencies.depends_on_id",
    "tasks.task_people.house_level",
    "tasks.task_people.person_id",
    "tasks.task_spaces.space_id",
    "tasks.task_trades.trade_id",
    "tasks.task_units.unit",
    "tasks.tasks.done",
    "tasks.tasks.done_at",
    "tasks.tasks.due",
    "tasks.tasks.parent_id",
    "tasks.tasks.priority",
    "tasks.tasks.project_id",
    "tasks.tasks.title"
  ],
  "writes": []
}$cap$::jsonb);

do $$
declare f text;
begin
  foreach f in array array['tasks.space_within(uuid, uuid)', 'tasks.space_top(uuid)', 'tasks.today_projection(jsonb)'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
