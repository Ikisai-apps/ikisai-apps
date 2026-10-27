-- Ikisai Tasks · «Proyectos y producción», 7.5 (3): la producción y «hoy» con unidades y entregables (docs/tasks/API.md
-- §52, §47 y §58). Toca solo el schema tasks.
-- - tasks.production_rows (copia de 0358): también el entregable de cada tarea (el de su madre si es un paso) y, en una
--   tarea de trabajo con unidades, cuántas tiene y cuántas hay hechas.
-- - tasks.project_production_projection (copia de 0358): `deliverables` (con sus madres hechas, abiertas y `done`) y, por
--   tarea, `deliverableId` y `units: {total, done}` (nulo sin unidades).
-- - tasks.today_projection (copia de 0358): `units: {total, done}` por tarea.

drop function tasks.production_rows(uuid);
create or replace function tasks.production_rows(p_project uuid)
returns table (id uuid, parent_id uuid, phase_id uuid, title text, priority text, due date, done_at timestamptz, "position" numeric,
               container boolean, done boolean, blocked_by text, blocked_ids jsonb, mother_position numeric,
               deliverable_id uuid, units int, units_done int)
language sql stable as $$
  with t as (
    select x.*,
      case when x.parent_id is null then x.phase_id else (select m.phase_id from tasks.tasks m where m.id = x.parent_id) end phase,
      case when x.parent_id is null then x.deliverable_id else (select m.deliverable_id from tasks.tasks m where m.id = x.parent_id) end deliverable,
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
    coalesce((select m.position from tasks.tasks m where m.id = s.parent_id), s.position),
    s.deliverable,
    case when s.is_container then null else tasks.task_unit_total(s.id) end,
    case when s.is_container or tasks.task_unit_total(s.id) is null then null
         else (select count(*)::int from tasks.task_units u where u.task_id = s.id and u.deleted_at is null and u.unit <= tasks.task_unit_total(s.id)) end
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
    'deliverables', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'quantity', d.quantity, 'status', d.status, 'spaceId', d.space_id,
        'total', (select count(*) from b where b.deliverable_id = d.id and b.parent_id is null),
        'open', (select count(*) from b where b.deliverable_id = d.id and b.parent_id is null and not b.done),
        'done', exists (select 1 from b where b.deliverable_id = d.id and b.parent_id is null)
                and not exists (select 1 from b where b.deliverable_id = d.id and b.parent_id is null and not b.done)) order by d.position, d.id)
      from tasks.project_deliverables d where d.project_id = v_project and d.deleted_at is null), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object(
        'id', b.id, 'parentId', b.parent_id, 'phaseId', b.phase_id, 'title', b.title, 'done', b.done, 'doneAt', b.done_at,
        'priority', b.priority, 'due', b.due, 'position', b.position, 'container', b.container, 'deliverableId', b.deliverable_id,
        'units', case when b.units is null then null else jsonb_build_object('total', b.units, 'done', b.units_done) end,
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
      and tasks.scope_project(v_scopes, t.tab_id, t.project_id)
      and ((not t.done and t.due is not null and t.due <= v_day) or (t.done and (t.done_at at time zone 'Europe/Madrid')::date = v_day))
    limit 2000
  ) x;
  return jsonb_build_object('date', v_day, 'items', v_items);
end $$;

do $$
declare f text;
begin
  foreach f in array array['tasks.production_rows(uuid)', 'tasks.project_production_projection(jsonb)', 'tasks.today_projection(jsonb)'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
