-- Ikisai Tasks · «Proyectos y producción», 7.5 (2): entregables del proyecto (diseño en MUELA/equipo/feedback/tasks/
-- PROYECTOS_PRODUCCION.md §7.5; docs/tasks/API.md §57). Toca solo el schema tasks; de Recursos solo lee los espacios.
-- - tasks.project_deliverables: lo que el proyecto entrega («4 marcos acústicos para la sala grande»): nombre, cantidad,
--   estado a mano (`todo`, `delivered` = entregado, `installed` = instalado), espacio de Recursos (dónde va, opcional) y
--   orden. «Hecho» no se guarda: se calcula al leer (todas sus tareas hechas). La visibilidad es la de su proyecto.
-- - tasks.tasks.deliverable_id: el entregable de una tarea madre (como la fase, 0356): los pasos lo heredan al leer.
-- - tasks.task_deliverable_follow (trigger): si una tarea cambia de proyecto o pasa a ser hija, suelta el entregable.
-- - tasks.validate_deliverables (hook): el entregable de una tarea es uno vivo de su proyecto y la tarea es madre
--   (INVALID_DELIVERABLE); uno nuevo va en un proyecto vivo de su área; su espacio existe y está vivo (INVALID_SPACE); no se
--   borra con tareas vivas (DELIVERABLE_NOT_EMPTY).
-- - tasks.empty_trash_prepare (copia de 0360): los entregables de los proyectos y áreas en la papelera van a ella.

create table tasks.project_deliverables (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid not null references tasks.tabs(id),
  project_id uuid not null references tasks.projects(id),
  name text not null check (length(btrim(name)) between 1 and 200),
  quantity numeric(12,3) check (quantity is null or quantity > 0),
  status text not null default 'todo' check (status in ('todo', 'delivered', 'installed')),
  space_id uuid,
  note text not null default '' check (length(note) <= 2000),
  position numeric not null default 0
);
create index project_deliverables_project_idx on tasks.project_deliverables (project_id, position) where deleted_at is null;
create trigger tasks_guard_immutable before update on tasks.project_deliverables for each row execute function tasks.guard_immutable('tab_id', 'project_id');
select core.register_table('tasks', 'tasks', 'project_deliverables', array['tab_id','project_id','name','quantity','status','space_id','note','position'],
  '{reader,outsider,editor,owner}', '{editor,owner}');

alter table tasks.tasks add column deliverable_id uuid references tasks.project_deliverables(id);
create index tasks_deliverable_idx on tasks.tasks (deliverable_id) where deleted_at is null and deliverable_id is not null;
do $$
declare r record;
begin
  for r in select * from core.synced_tables where app = 'tasks' and schema_name = 'tasks' and table_name = 'tasks' loop
    perform core.register_table('tasks', 'tasks', r.table_name,
      r.writable_columns || array(select c from unnest(array['deliverable_id']) c where not (c = any(r.writable_columns))),
      r.readable_roles, r.writable_roles, r.never_purge);
  end loop;
end $$;

create or replace function tasks.task_deliverable_follow()
returns trigger language plpgsql as $$
begin
  if new.deliverable_id is not null
     and (new.project_id is distinct from old.project_id or (new.parent_id is not null and old.parent_id is null))
     and (new.parent_id is not null
          or not exists (select 1 from tasks.project_deliverables d where d.id = new.deliverable_id and d.project_id = new.project_id)) then
    new.deliverable_id := null;
  end if;
  return new;
end $$;
create trigger tasks_task_deliverable_follow before update on tasks.tasks for each row execute function tasks.task_deliverable_follow();

create or replace function tasks.validate_deliverables(p jsonb)
returns void language plpgsql as $$
declare
  v_app text := p->>'app';
  v_cursor bigint := (p->>'cursor')::bigint;
  v_purge boolean := coalesce(current_setting('tasks.purge_mode', true), '') <> '';
  c record;
  d tasks.project_deliverables;
  pr tasks.projects;
  t tasks.tasks;
begin
  for c in select ch.table_name, ch.row_id, ch.op, ch.before, ch.after from core.changes ch
            where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name in ('tasks', 'project_deliverables')
              and ch.op in ('insert', 'update', 'delete', 'restore') order by ch.seq loop
    if c.table_name = 'tasks' then
      continue when c.op = 'delete' or c.after->>'deliverable_id' is null;
      continue when c.op = 'update' and c.before->>'deliverable_id' is not distinct from c.after->>'deliverable_id'
        and c.before->>'project_id' is not distinct from c.after->>'project_id' and c.before->>'parent_id' is not distinct from c.after->>'parent_id';
      select * into t from tasks.tasks where id = c.row_id;
      select * into d from tasks.project_deliverables where id = t.deliverable_id;
      if t.deliverable_id is not null and (d.id is null or d.deleted_at is not null or d.project_id <> t.project_id or t.parent_id is not null) then
        perform core.fail('INVALID_DELIVERABLE', 422, jsonb_build_object('taskId', c.row_id, 'deliverableId', t.deliverable_id,
          'reason', 'a live deliverable of the same project, on a mother task'));
      end if;
      continue;
    end if;
    select * into d from tasks.project_deliverables where id = c.row_id;
    if c.op in ('insert', 'restore') and not v_purge then
      select * into pr from tasks.projects where id = d.project_id;
      if pr.tab_id is distinct from d.tab_id then perform core.fail('INCONSISTENT_KEYS', 422, jsonb_build_object('id', c.row_id)); end if;
      if pr.deleted_at is not null then perform core.fail('PROJECT_UNAVAILABLE', 422, jsonb_build_object('projectId', pr.id)); end if;
    end if;
    if c.op in ('insert', 'update', 'restore') and d.space_id is not null and (c.before is null or c.before->>'space_id' is distinct from d.space_id::text)
       and not exists (select 1 from resources.spaces s where s.id = d.space_id and s.deleted_at is null) then
      perform core.fail('INVALID_SPACE', 422, jsonb_build_object('deliverableId', c.row_id, 'reason', 'space not found'));
    end if;
    if c.op = 'delete' and not v_purge and exists (select 1 from tasks.tasks x where x.deliverable_id = c.row_id and x.deleted_at is null) then
      perform core.fail('DELIVERABLE_NOT_EMPTY', 422, jsonb_build_object('deliverableId', c.row_id, 'reason', 'release its tasks first'));
    end if;
  end loop;
end $$;
select core.add_validate_hook('tasks', 'tasks.validate_deliverables');

-- ---------------------------------------------------------------------------
-- Vaciar papelera (copiada entera de 0360): los entregables de los proyectos y áreas en la papelera, después de sus tareas.
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
  foreach v_step in array array['purchase_requests', 'purchase_plan_stops', 'purchase_plans', 'tasks', 'task_dependencies', 'task_labels', 'project_labels', 'task_spaces', 'project_spaces', 'task_trades', 'project_trades', 'task_people', 'project_people', 'task_comments', 'task_materials', 'task_units', 'attachments', 'saved_views', 'project_phases', 'project_deliverables', 'projects', 'labels', 'families'] loop
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
      when 'project_deliverables' then
        'select dv.id, dv.revision from tasks.project_deliverables dv join tasks.projects pr on pr.id = dv.project_id join tasks.tabs tb on tb.id = dv.tab_id
         where dv.deleted_at is null and (pr.deleted_at is not null or tb.deleted_at is not null)'
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
