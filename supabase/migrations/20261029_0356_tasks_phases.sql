-- Ikisai Tasks · «Proyectos y producción», 7.1: fases del proyecto (diseño en MUELA/equipo/feedback/tasks/
-- PROYECTOS_PRODUCCION.md §7.1; encargo de Core del 27-10-2026; docs/tasks/API.md §51). Toca solo el schema tasks y, del
-- núcleo, solo usa register_table, synced_tables, add_validate_hook, apply_row_op y fail.
-- - tasks.project_phases: las fases de un proyecto («Cortar», «Montar», «Acabar»), en orden (`position`), con su estado
--   (`pending`, `active` o `done`), fechas opcionales (`start`, `due`) y la nota de cierre (`closed_note`). La visibilidad
--   es la de su proyecto (`tab_id` y `project_id`, inmutables). Leen todos los roles con acceso; escriben editor y owner.
-- - tasks.tasks.phase_id: la fase de una tarea madre. Las hijas (pasos) no la llevan: heredan la de su madre al leer.
-- - tasks.task_phase_follow (trigger): si una tarea cambia de proyecto o pasa a ser hija, suelta la fase que ya no le toca
--   (mover, convertir un área en proyecto, restaurar con otro padre). Así ninguna copia de esos procedimientos cambia.
-- - tasks.validate_phases (hook):
--   - la fase de una tarea es una fase viva de su mismo proyecto y la tarea es madre (INVALID_PHASE);
--   - empieza antes de acabar (INVALID_PHASE);
--   - una fase nueva o restaurada va en un proyecto vivo de su área (INCONSISTENT_KEYS / PROJECT_UNAVAILABLE);
--   - cerrar una fase (`done`) con tareas abiertas necesita nota (PHASE_OPEN_TASKS; decisión recomendada en vg-37: el
--     cierre es a mano y, con pendientes, con nota);
--   - una fase con tareas vivas no se borra (PHASE_NOT_EMPTY): antes se sueltan sus tareas (la Edge lo hace en el mismo lote).
-- - tasks.empty_trash_prepare (copiada entera de 0334): las fases de los proyectos y áreas en la papelera van a ella después
--   de sus tareas, para que la purga (orden inverso de las tablas) las pueda borrar.

create table tasks.project_phases (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid not null references tasks.tabs(id),
  project_id uuid not null references tasks.projects(id),
  name text not null check (length(btrim(name)) between 1 and 120),
  position numeric not null default 0,
  status text not null default 'pending' check (status in ('pending', 'active', 'done')),
  start date,
  due date,
  closed_note text not null default '' check (length(closed_note) <= 2000)
);
create index project_phases_project_idx on tasks.project_phases (project_id, position) where deleted_at is null;
create trigger tasks_guard_immutable before update on tasks.project_phases for each row execute function tasks.guard_immutable('tab_id', 'project_id');
select core.register_table('tasks', 'tasks', 'project_phases', array['tab_id','project_id','name','position','status','start','due','closed_note'],
  '{reader,outsider,editor,owner}', '{editor,owner}');

alter table tasks.tasks add column phase_id uuid references tasks.project_phases(id);
create index tasks_phase_idx on tasks.tasks (phase_id) where deleted_at is null and phase_id is not null;

-- Escribible, sin perder los roles que tenga la tabla (el outsider solo cambia `done`: lo limita tasks.validate_comments).
do $$
declare r record;
begin
  for r in select * from core.synced_tables where app = 'tasks' and schema_name = 'tasks' and table_name = 'tasks' loop
    perform core.register_table('tasks', 'tasks', r.table_name,
      r.writable_columns || array(select c from unnest(array['phase_id']) c where not (c = any(r.writable_columns))),
      r.readable_roles, r.writable_roles, r.never_purge);
  end loop;
end $$;

-- Una tarea que cambia de proyecto o pasa a ser hija suelta la fase que ya no le toca. Solo en ese cambio: escribir a
-- propósito una fase que no vale sigue dando INVALID_PHASE (hook de abajo).
create or replace function tasks.task_phase_follow()
returns trigger language plpgsql as $$
begin
  if new.phase_id is not null
     and (new.project_id is distinct from old.project_id or (new.parent_id is not null and old.parent_id is null))
     and (new.parent_id is not null
          or not exists (select 1 from tasks.project_phases ph where ph.id = new.phase_id and ph.project_id = new.project_id)) then
    new.phase_id := null;
  end if;
  return new;
end $$;
create trigger tasks_task_phase_follow before update on tasks.tasks for each row execute function tasks.task_phase_follow();

-- Abierta: una madre viva sin hacer (con pasos, alguno vivo sin hacer; sin pasos, ella misma).
create or replace function tasks.phase_open_tasks(p_phase uuid)
returns int language sql stable as $$
  select count(*)::int from tasks.tasks t
   where t.phase_id = p_phase and t.deleted_at is null and t.parent_id is null
     and case when exists (select 1 from tasks.tasks c where c.parent_id = t.id and c.deleted_at is null)
              then exists (select 1 from tasks.tasks c where c.parent_id = t.id and c.deleted_at is null and not c.done)
              else not t.done end
$$;

create or replace function tasks.validate_phases(p jsonb)
returns void language plpgsql as $$
declare
  v_app text := p->>'app';
  v_cursor bigint := (p->>'cursor')::bigint;
  v_purge boolean := coalesce(current_setting('tasks.purge_mode', true), '') <> '';
  c record;
  ph tasks.project_phases;
  pr tasks.projects;
  t tasks.tasks;
begin
  for c in select ch.table_name, ch.row_id, ch.op, ch.before, ch.after from core.changes ch
            where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name in ('tasks', 'project_phases')
              and ch.op in ('insert', 'update', 'delete', 'restore') order by ch.seq loop
    if c.table_name = 'tasks' then
      continue when c.op = 'delete' or c.after->>'phase_id' is null;
      continue when c.op = 'update' and c.before->>'phase_id' is not distinct from c.after->>'phase_id'
        and c.before->>'project_id' is not distinct from c.after->>'project_id' and c.before->>'parent_id' is not distinct from c.after->>'parent_id';
      select * into t from tasks.tasks where id = c.row_id;
      select * into ph from tasks.project_phases where id = t.phase_id;
      if t.phase_id is not null and (ph.id is null or ph.deleted_at is not null or ph.project_id <> t.project_id) then
        perform core.fail('INVALID_PHASE', 422, jsonb_build_object('taskId', c.row_id, 'phaseId', t.phase_id, 'reason', 'a live phase of the same project'));
      end if;
      if t.phase_id is not null and t.parent_id is not null then
        perform core.fail('INVALID_PHASE', 422, jsonb_build_object('taskId', c.row_id, 'phaseId', t.phase_id, 'reason', 'a step takes the phase of its mother'));
      end if;
      continue;
    end if;
    select * into ph from tasks.project_phases where id = c.row_id;
    if c.op in ('insert', 'restore') and not v_purge then
      select * into pr from tasks.projects where id = ph.project_id;
      if pr.tab_id is distinct from ph.tab_id then
        perform core.fail('INCONSISTENT_KEYS', 422, jsonb_build_object('id', c.row_id));
      end if;
      if pr.deleted_at is not null then
        perform core.fail('PROJECT_UNAVAILABLE', 422, jsonb_build_object('projectId', pr.id));
      end if;
    end if;
    if c.op in ('insert', 'update', 'restore') and ph.start is not null and ph.due is not null and ph.start > ph.due then
      perform core.fail('INVALID_PHASE', 422, jsonb_build_object('phaseId', c.row_id, 'reason', 'start after due'));
    end if;
    if c.op in ('insert', 'update', 'restore') and ph.status = 'done' and btrim(ph.closed_note) = ''
       and (c.before is null or c.before->>'status' is distinct from 'done') and tasks.phase_open_tasks(ph.id) > 0 then
      perform core.fail('PHASE_OPEN_TASKS', 422, jsonb_build_object('phaseId', c.row_id, 'open', tasks.phase_open_tasks(ph.id),
        'reason', 'closing a phase with open tasks needs a note'));
    end if;
    if c.op = 'delete' and not v_purge and exists (select 1 from tasks.tasks x where x.phase_id = c.row_id and x.deleted_at is null) then
      perform core.fail('PHASE_NOT_EMPTY', 422, jsonb_build_object('phaseId', c.row_id, 'reason', 'release its tasks first'));
    end if;
  end loop;
end $$;
select core.add_validate_hook('tasks', 'tasks.validate_phases');

-- ---------------------------------------------------------------------------
-- Vaciar papelera (copiada entera de 0334): las fases de los proyectos y áreas en la papelera, después de sus tareas.
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
  foreach v_step in array array['purchase_requests', 'purchase_plan_stops', 'purchase_plans', 'tasks', 'task_dependencies', 'task_labels', 'project_labels', 'task_spaces', 'project_spaces', 'task_trades', 'project_trades', 'task_people', 'project_people', 'task_comments', 'task_materials', 'attachments', 'saved_views', 'project_phases', 'projects', 'labels', 'families'] loop
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
