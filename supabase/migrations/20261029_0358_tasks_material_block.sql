-- Ikisai Tasks · «Proyectos y producción», 7.3: el material bloquea (diseño en MUELA/equipo/feedback/tasks/
-- PROYECTOS_PRODUCCION.md §7.3; decisión de VG en vg-37: bloquea también si falta stock sin compra, con «Pedir»;
-- docs/tasks/API.md §53). Toca solo el schema tasks; de Recursos solo lee (artículos, tipos y movimientos).
-- - tasks.material_shortage(proyecto?): por material pendiente (sin consumir, con cantidad) de una tarea abierta de un
--   proyecto vivo, si es consumible: lo que hace falta (`need`), el stock del artículo (suma de sus movimientos), lo que
--   piden antes otras tareas abiertas del mismo artículo (por vencimiento, sin fecha al final) y lo que falta:
--   max(0, need − max(0, stock − lo pedido antes)). Los equipos (no consumibles) no bloquean. Sin proyecto, toda la casa.
-- - Una tarea abierta con algo que falta queda bloqueada por `material` (después de dependencia y paso), aunque no haya
--   compra; la compra abierta del artículo (de la tarea o de su proyecto) se dice aparte (`purchaseOpen`).
-- - La misma regla en las tres lecturas: tasks.production_rows (y la proyección de producción, con `need`, `stock`,
--   `missing` y `purchaseOpen` por material), tasks.today_projection (`blocked`) y el indicador `tasks.blocked` de
--   tasks.central_kpi_projection. Copias de 0357, 0352 y 0354 con eso.
-- - Capacidad `tasks.request_purchase`: declara `item_id` (que ya aceptaba desde #874) y el nuevo `task_id` (una tarea
--   viva del mismo proyecto, que quien pide ve: así «Pedir» desde la tarea deja la compra ligada a ella).

create or replace function tasks.material_shortage(p_project uuid default null)
returns table (material_id uuid, task_id uuid, project_id uuid, item_id uuid, need numeric, stock numeric, before_need numeric, missing numeric)
language sql stable as $$
  with needs as (
    select m.id material_id, m.task_id, t.project_id, m.item_id, m.quantity need, t.due
      from tasks.task_materials m
      join tasks.tasks t on t.id = m.task_id and t.deleted_at is null and not t.done
      join tasks.projects pr on pr.id = t.project_id and pr.deleted_at is null and pr.status <> 'archived'
      join resources.items i on i.id = m.item_id
      join resources.item_kinds k on k.kind = i.kind and k.consumable
     where m.deleted_at is null and m.consumed is null and m.quantity is not null
  ), ranked as (
    select n.*, coalesce(sum(n.need) over (partition by n.item_id order by n.due nulls last, n.task_id, n.material_id
                                           rows between unbounded preceding and 1 preceding), 0) before_need
      from needs n
  ), stock as (
    select mv.item_id, sum(mv.quantity) qty from resources.movements mv
     where mv.deleted_at is null and mv.item_id in (select distinct item_id from needs) group by mv.item_id
  )
  select r.material_id, r.task_id, r.project_id, r.item_id, r.need, coalesce(s.qty, 0), r.before_need,
         greatest(0, r.need - greatest(0, coalesce(s.qty, 0) - r.before_need))
    from ranked r left join stock s on s.item_id = r.item_id
   where p_project is null or r.project_id = p_project
$$;

-- La fila de producción gana el bloqueo por material (cambia lo que devuelve: se vuelve a crear).
drop function tasks.production_rows(uuid);
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
  ), short as (
    select sh.task_id, jsonb_agg(distinct sh.item_id) items from tasks.material_shortage(p_project) sh where sh.missing > 0 group by sh.task_id
  )
  select s.id, s.parent_id, s.phase, s.title, s.priority, s.due, s.done_at, s.position, s.is_container, s.is_done,
    case when s.is_done then null when jsonb_array_length(s.dep_ids) > 0 then 'dependency' when jsonb_array_length(s.step_ids) > 0 then 'step' when sh.items is not null then 'material' end,
    case when s.is_done then '[]'::jsonb when jsonb_array_length(s.dep_ids) > 0 then s.dep_ids when jsonb_array_length(s.step_ids) > 0 then s.step_ids
         else coalesce(sh.items, '[]'::jsonb) end,
    coalesce((select m.position from tasks.tasks m where m.id = s.parent_id), s.position)
  from s left join short sh on sh.task_id = s.id
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
  short as (select * from tasks.material_shortage(v_project)),
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
        'materials', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'itemId', m.item_id, 'quantity', m.quantity, 'consumed', m.consumed,
                                  'need', sh.need, 'stock', sh.stock, 'missing', coalesce(sh.missing, 0),
                                  'purchaseOpen', exists (select 1 from tasks.purchase_requests r where r.item_id = m.item_id and r.deleted_at is null
                                                            and r.status in ('requested', 'approved', 'purchased') and (r.task_id = b.id or r.project_id = v_project)))
                                order by m.position, m.id)
                                from tasks.task_materials m left join short sh on sh.material_id = m.id where m.task_id = b.id and m.deleted_at is null), '[]'::jsonb),
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
      and tasks.scope_project(v_scopes, t.tab_id, t.project_id)
      and ((not t.done and t.due is not null and t.due <= v_day) or (t.done and (t.done_at at time zone 'Europe/Madrid')::date = v_day))
    limit 2000
  ) x;
  return jsonb_build_object('date', v_day, 'items', v_items);
end $$;

create or replace view tasks.central_kpi_projection as
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
supplies as (
  select i.id, i.min_quantity,
         coalesce((select sum(mv.quantity) from resources.movements mv where mv.item_id = i.id and mv.deleted_at is null), 0) as stock
    from resources.items i
   where i.deleted_at is null and i.active and tasks.supply_kind(i.kind) and i.min_quantity is not null)
select k.kpi, k.label, k.value, k.unit, 'actual'::text as period, (select d from today) as period_start, (select d from today) as period_end,
       k.direction, k.link, now() as computed_at
  from (values
    ('tasks.open', 'Tareas pendientes', (select count(*) from pending)::numeric, 'count', null, 'https://tasks.ikisai.com/#/tasks'),
    ('tasks.overdue', 'Tareas vencidas', (select count(*) from pending, today where pending.due < today.d)::numeric, 'count', 'down', 'https://tasks.ikisai.com/#/tasks'),
    ('tasks.purchase_requests_open', 'Compras pedidas sin recibir',
      (select count(*) from tasks.purchase_requests rq join tasks.tabs tb on tb.id = rq.tab_id and tb.deleted_at is null
        where rq.deleted_at is null and rq.status in ('requested', 'approved', 'purchased'))::numeric, 'count', 'down', 'https://tasks.ikisai.com/#/purchases'),
    ('tasks.supplies_below_min', 'Suministros bajo mínimo', (select count(*) from supplies where stock < min_quantity)::numeric, 'count', 'down', 'https://tasks.ikisai.com/#/supplies'),
    ('tasks.blocked', 'Tareas bloqueadas', (select count(*) from blocked)::numeric, 'count', 'down', 'https://tasks.ikisai.com/#/tasks'),
    ('tasks.reviews_open', 'Revisiones de apertura sin cerrar',
      (select count(*) from tasks.reviews rv join tasks.projects pr on pr.id = rv.project_id and pr.deleted_at is null and pr.status <> 'archived'
        join tasks.tabs tb on tb.id = rv.tab_id and tb.deleted_at is null
        where rv.deleted_at is null and rv.status <> 'opened')::numeric, 'count', 'down', 'https://tasks.ikisai.com/#/projects'),
    ('tasks.requests_pending', 'Peticiones por clasificar',
      (select count(*) from tasks.requests r where r.deleted_at is null and r.status = 'pending')::numeric, 'count', 'down', 'https://tasks.ikisai.com/#/triage')
  ) as k(kpi, label, value, unit, direction, link);

select core.register_capability($cap${
  "id": "tasks.request_purchase",
  "app": "tasks",
  "kind": "execute",
  "title": "Pedir una compra a Tasks",
  "description": "Crea en un proyecto de Tasks, una sola vez por referencia, una solicitud de compra pedida desde otra app: nace «pedida», con la procedencia en la nota y un enlace de vuelta. Sale en Suministros › «Compras del evento»; al recibirla, el stock entra por Recursos. Con `task_id`, ligada a esa tarea del proyecto (p. ej. «Pedir» lo que le falta). Repetir con la misma referencia devuelve la que ya hay.",
  "route": "POST requests/purchase",
  "roles": ["editor", "owner"],
  "risk": "low",
  "idempotent": true,
  "reversible": true,
  "input": {
    "type": "object",
    "required": ["source", "external_ref", "title", "project_id"],
    "additionalProperties": false,
    "properties": {
      "requestId": { "type": "string", "pattern": "^[A-Za-z0-9_.:-]{1,100}$" },
      "source": { "type": "string", "pattern": "^[a-z][a-z0-9_-]{1,30}$" },
      "external_ref": { "type": "string", "minLength": 1, "maxLength": 150 },
      "title": { "type": "string", "minLength": 1, "maxLength": 300 },
      "project_id": { "type": "string", "format": "uuid" },
      "task_id": { "type": "string", "format": "uuid" },
      "item_id": { "type": "string", "format": "uuid" },
      "quantity": { "type": "number", "exclusiveMinimum": 0, "exclusiveMaximum": 1000000000 },
      "unit": { "type": "string", "maxLength": 20 },
      "note": { "type": "string", "maxLength": 4000 },
      "due": { "type": "string", "format": "date" },
      "priority": { "enum": ["normal", "high", "critical"] },
      "external_url": { "type": "string", "maxLength": 500, "pattern": "^https://([a-z0-9-]+\\.)*ikisai\\.com(/|$)" }
    }
  },
  "output": {
    "type": "object",
    "required": ["created", "purchase"],
    "properties": {
      "created": { "type": "boolean" },
      "purchase": { "type": "object", "properties": { "kind": { "const": "purchase_request" }, "id": { "type": "string", "format": "uuid" }, "tabId": { "type": "string" }, "projectId": { "type": "string" }, "taskId": { "type": ["string", "null"] }, "itemId": { "type": ["string", "null"] }, "status": { "type": "string" }, "quantity": { "type": ["number", "null"] }, "unit": { "type": ["string", "null"] }, "externalRef": { "type": "string" }, "externalUrl": { "type": ["string", "null"] } } }
    }
  },
  "anchors": ["tasks.suministros.evento.abrir", "tasks.suministros.evento.siguiente", "tasks.compras.lista.solicitud"],
  "since": "0.1.0"
}$cap$::jsonb);

do $$
declare f text;
begin
  foreach f in array array['tasks.material_shortage(uuid)', 'tasks.production_rows(uuid)', 'tasks.project_production_projection(jsonb)', 'tasks.today_projection(jsonb)'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
revoke all on tasks.central_kpi_projection from public, anon, authenticated;
grant select on tasks.central_kpi_projection to service_role;
