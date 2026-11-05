-- Ikisai Tasks · «Etapa» deja de ser etiqueta y pasa a ser la fase de la tarea (encargo de VG del 06-11-2026; docs/tasks/API.md
-- §61). Toca solo el schema tasks y, del núcleo, solo usa register_table, synced_tables, add_validate_hook, apply_migration_operations
-- y fail. Las fases son las del proyecto (0356, `tasks.project_phases`); aquí se añade la «actual» y la tarea madre lleva siempre una.
-- - tasks.project_phases.is_current: la fase «actual» del proyecto, la que se pone a las tareas nuevas. Como mucho una viva por
--   proyecto, comprobado al final del lote (hook tasks.validate_phase_current, INVALID_PHASE). Sin ninguna marcada vale la primera sin cerrar (o la primera).
-- - tasks.default_phase(project): esa fase por defecto (o null si el proyecto no tiene fases).
-- - tasks.task_phase_default (trigger, antes de insertar o actualizar): una tarea madre viva sin fase, en un proyecto con fases,
--   recibe la fase por defecto. Así siempre hay una, sin «sin fase», venga de la app, de un agente o de la API. Un paso no lleva
--   fase (hereda la de su madre). Va después de tasks_task_phase_follow (los triggers van por orden alfabético: se llama «zdefault»): la tarea que cambia de
--   proyecto suelta la fase vieja y recibe la actual del nuevo.
-- - Conversión, en lotes del núcleo (historial y sincronización), por proyecto:
--   - las etiquetas de la familia de sistema «phase» (en la app, «Fase» o «Etapa») que usan sus tareas o el propio proyecto pasan a
--     ser fases del proyecto, en el orden de las etiquetas (si ya hay una fase con ese nombre, se usa esa);
--   - cada madre sin fase toma la de su etiqueta (la suya, la de alguno de sus pasos o la del proyecto, la primera en orden) y, si no
--     tiene, la actual;
--   - la actual es la que ya estaba «en curso» o, si no, la primera sin cerrar;
--   - después, las etiquetas de etapa salen de tareas y proyectos y van a la papelera, y su familia queda archivada.

alter table tasks.project_phases add column is_current boolean not null default false;

do $$
declare r record;
begin
  for r in select * from core.synced_tables where app = 'tasks' and schema_name = 'tasks' and table_name = 'project_phases' loop
    perform core.register_table('tasks', 'tasks', r.table_name,
      r.writable_columns || array(select c from unnest(array['is_current']) c where not (c = any(r.writable_columns))),
      r.readable_roles, r.writable_roles, r.never_purge);
  end loop;
end $$;

create or replace function tasks.default_phase(p_project uuid)
returns uuid language sql stable as $$
  select ph.id from tasks.project_phases ph
   where ph.project_id = p_project and ph.deleted_at is null
   order by ph.is_current desc, (ph.status = 'done'), ph.position, ph.created_at, ph.id
   limit 1
$$;

create or replace function tasks.task_phase_default()
returns trigger language plpgsql as $$
begin
  if new.phase_id is null and new.parent_id is null and new.deleted_at is null
     and coalesce(current_setting('tasks.purge_mode', true), '') = '' then
    new.phase_id := tasks.default_phase(new.project_id);
  end if;
  return new;
end $$;
-- «zdefault»: los BEFORE van por orden alfabético y este tiene que ir después de tasks_task_phase_follow.
create trigger tasks_task_phase_zdefault before insert or update on tasks.tasks for each row execute function tasks.task_phase_default();

-- La actual: como mucho una viva por proyecto, al final del lote (cambiarla quita una y pone otra en cualquier orden).
create or replace function tasks.validate_phase_current(p jsonb)
returns void language plpgsql as $$
declare c record; ph tasks.project_phases;
begin
  for c in select ch.row_id from core.changes ch
            where ch.app = p->>'app' and ch.cursor = (p->>'cursor')::bigint and ch.schema_name = 'tasks' and ch.table_name = 'project_phases'
              and ch.op in ('insert', 'update', 'restore') and coalesce((ch.after->>'is_current')::boolean, false) loop
    select * into ph from tasks.project_phases where id = c.row_id;
    if ph.deleted_at is null and ph.is_current and exists (select 1 from tasks.project_phases o
         where o.project_id = ph.project_id and o.id <> ph.id and o.is_current and o.deleted_at is null) then
      perform core.fail('INVALID_PHASE', 422, jsonb_build_object('phaseId', ph.id, 'reason', 'one current phase per project'));
    end if;
  end loop;
end $$;
select core.add_validate_hook('tasks', 'tasks.validate_phase_current');

-- ---------------------------------------------------------------------------
-- Conversión de las etiquetas de etapa en fases
-- ---------------------------------------------------------------------------
-- tasks.stage_labels_to_phases(): la conversión; devuelve cuántos lotes aplicó. Repetirla no hace nada (ya no quedan
-- etiquetas de etapa vivas ni madres sin fase). Solo la usa la migración (y las pruebas).
create or replace function tasks.stage_labels_to_phases()
returns int language plpgsql as $$
declare
  pr record; st record; r record;
  v_ops jsonb; v_phase uuid; v_pos numeric; v_current uuid; v_n int := 0;
  v_names text[]; v_ids uuid[];
begin
  -- 1. Por proyecto con etiquetas de etapa en uso: sus fases
  for pr in
    select p.id, p.tab_id from tasks.projects p
     where p.deleted_at is null and exists (
       select 1 from tasks.labels l join tasks.families f on f.id = l.family_id
        where f.system_key = 'phase' and l.deleted_at is null
          and (exists (select 1 from tasks.task_labels tl join tasks.tasks t on t.id = tl.task_id
                        where tl.label_id = l.id and tl.project_id = p.id and tl.deleted_at is null and t.deleted_at is null)
               or exists (select 1 from tasks.project_labels pl where pl.label_id = l.id and pl.project_id = p.id and pl.deleted_at is null)))
     order by p.id
  loop
    v_ops := '[]'::jsonb;
    select coalesce(max(position), 0) into v_pos from tasks.project_phases where project_id = pr.id and deleted_at is null;
    v_names := '{}'; v_ids := '{}';
    for st in
      select lower(btrim(l.name)) as key, min(btrim(l.name)) as name, min(l.position) as pos from tasks.labels l join tasks.families f on f.id = l.family_id
       where f.system_key = 'phase' and l.deleted_at is null
         and (exists (select 1 from tasks.task_labels tl join tasks.tasks t on t.id = tl.task_id
                       where tl.label_id = l.id and tl.project_id = pr.id and tl.deleted_at is null and t.deleted_at is null)
              or exists (select 1 from tasks.project_labels pl where pl.label_id = l.id and pl.project_id = pr.id and pl.deleted_at is null))
       group by lower(btrim(l.name)) order by min(l.position), lower(btrim(l.name))
    loop
      select id into v_phase from tasks.project_phases where project_id = pr.id and deleted_at is null and lower(btrim(name)) = st.key
       order by position limit 1;
      if v_phase is null then
        v_phase := gen_random_uuid(); v_pos := v_pos + 1024;
        v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'tasks.project_phases', 'id', v_phase,
          'fields', jsonb_build_object('tab_id', pr.tab_id, 'project_id', pr.id, 'name', left(st.name, 120), 'position', v_pos));
      end if;
      v_names := v_names || st.key; v_ids := v_ids || v_phase;
    end loop;
    if jsonb_array_length(v_ops) > 0 then
      perform core.apply_migration_operations('tasks', 'migration:tasks-0367-fases-' || pr.id, v_ops);
      v_n := v_n + 1;
    end if;
    -- Cada madre sin fase, la de su etiqueta (suya, de un paso o del proyecto; la primera en el orden de las fases)
    v_ops := '[]'::jsonb;
    for r in
      select t.id, t.revision, (
        select ph.id from tasks.project_phases ph
         where ph.project_id = pr.id and ph.deleted_at is null and ph.id = any(v_ids)
           and lower(btrim(ph.name)) in (
             select lower(btrim(l.name)) from tasks.labels l join tasks.families f on f.id = l.family_id
              where f.system_key = 'phase' and l.deleted_at is null and (
                exists (select 1 from tasks.task_labels tl join tasks.tasks s on s.id = tl.task_id
                         where tl.label_id = l.id and tl.deleted_at is null and s.deleted_at is null and (s.id = t.id or s.parent_id = t.id))
                or exists (select 1 from tasks.project_labels pl where pl.label_id = l.id and pl.project_id = pr.id and pl.deleted_at is null)))
         order by (select exists (select 1 from tasks.task_labels tl join tasks.labels l on l.id = tl.label_id join tasks.tasks s on s.id = tl.task_id
                                   where lower(btrim(l.name)) = lower(btrim(ph.name)) and tl.deleted_at is null and s.deleted_at is null
                                     and (s.id = t.id or s.parent_id = t.id))) desc, ph.position
         limit 1) as phase
        from tasks.tasks t
       where t.project_id = pr.id and t.parent_id is null and t.deleted_at is null and t.phase_id is null
    loop
      continue when r.phase is null;
      v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'tasks.tasks', 'id', r.id, 'expectedRevision', r.revision,
        'fields', jsonb_build_object('phase_id', r.phase));
      if jsonb_array_length(v_ops) >= 400 then
        v_n := v_n + 1;
        perform core.apply_migration_operations('tasks', 'migration:tasks-0367-tareas-' || pr.id || '-' || v_n, v_ops);
        v_ops := '[]'::jsonb;
      end if;
    end loop;
    if jsonb_array_length(v_ops) > 0 then
      v_n := v_n + 1;
      perform core.apply_migration_operations('tasks', 'migration:tasks-0367-tareas-' || pr.id || '-' || v_n, v_ops);
    end if;
  end loop;

  -- 2. La actual de cada proyecto con fases y sin actual: la «en curso» o la primera sin cerrar
  v_ops := '[]'::jsonb;
  for pr in select distinct ph.project_id as id from tasks.project_phases ph join tasks.projects p on p.id = ph.project_id
             where ph.deleted_at is null and p.deleted_at is null
               and not exists (select 1 from tasks.project_phases o where o.project_id = ph.project_id and o.is_current and o.deleted_at is null)
  loop
    select ph.id into v_current from tasks.project_phases ph where ph.project_id = pr.id and ph.deleted_at is null
     order by (ph.status = 'active') desc, (ph.status = 'done'), ph.position, ph.created_at, ph.id limit 1;
    v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'tasks.project_phases', 'id', v_current,
      'expectedRevision', (select revision from tasks.project_phases where id = v_current), 'fields', jsonb_build_object('is_current', true));
    if jsonb_array_length(v_ops) >= 400 then
      v_n := v_n + 1;
      perform core.apply_migration_operations('tasks', 'migration:tasks-0367-actual-' || v_n, v_ops);
      v_ops := '[]'::jsonb;
    end if;
  end loop;
  if jsonb_array_length(v_ops) > 0 then
    v_n := v_n + 1;
    perform core.apply_migration_operations('tasks', 'migration:tasks-0367-actual-' || v_n, v_ops);
  end if;

  -- 3. Las madres que siguen sin fase en un proyecto con fases: la actual
  v_ops := '[]'::jsonb;
  for r in select t.id, t.revision, tasks.default_phase(t.project_id) as phase from tasks.tasks t
            where t.parent_id is null and t.deleted_at is null and t.phase_id is null and tasks.default_phase(t.project_id) is not null
  loop
    v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'tasks.tasks', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('phase_id', r.phase));
    if jsonb_array_length(v_ops) >= 400 then
      v_n := v_n + 1;
      perform core.apply_migration_operations('tasks', 'migration:tasks-0367-resto-' || v_n, v_ops);
      v_ops := '[]'::jsonb;
    end if;
  end loop;
  if jsonb_array_length(v_ops) > 0 then
    v_n := v_n + 1;
    perform core.apply_migration_operations('tasks', 'migration:tasks-0367-resto-' || v_n, v_ops);
  end if;

  -- 4. Las etiquetas de etapa salen de tareas y proyectos, van a la papelera (las hijas antes) y su familia se archiva
  v_ops := '[]'::jsonb;
  for r in
    select 1 as ord, 0 as depth, 'tasks.task_labels' as tbl, tl.id, tl.revision from tasks.task_labels tl
      join tasks.labels l on l.id = tl.label_id join tasks.families f on f.id = l.family_id
     where f.system_key = 'phase' and tl.deleted_at is null
    union all
    select 2, 0, 'tasks.project_labels', pl.id, pl.revision from tasks.project_labels pl
      join tasks.labels l on l.id = pl.label_id join tasks.families f on f.id = l.family_id
     where f.system_key = 'phase' and pl.deleted_at is null
    union all
    select 3, case when l.parent_id is null then 1 else 0 end, 'tasks.labels', l.id, l.revision from tasks.labels l
      join tasks.families f on f.id = l.family_id
     where f.system_key = 'phase' and l.deleted_at is null
    order by 1, 2
  loop
    v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', r.tbl, 'id', r.id, 'expectedRevision', r.revision);
    if jsonb_array_length(v_ops) >= 400 then
      v_n := v_n + 1;
      perform core.apply_migration_operations('tasks', 'migration:tasks-0367-etiquetas-' || v_n, v_ops);
      v_ops := '[]'::jsonb;
    end if;
  end loop;
  for r in select f.id, f.revision from tasks.families f where f.system_key = 'phase' and f.deleted_at is null and not f.archived loop
    v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'tasks.families', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('archived', true));
  end loop;
  if jsonb_array_length(v_ops) > 0 then
    v_n := v_n + 1;
    perform core.apply_migration_operations('tasks', 'migration:tasks-0367-etiquetas-' || v_n, v_ops);
  end if;
  return v_n;
end $$;
revoke all on function tasks.stage_labels_to_phases() from public, anon, authenticated;
select tasks.stage_labels_to_phases();
