-- Ikisai Tasks · corrección de tasks.validate_batch (docs/tasks/API.md §4.2 b). Toca solo el schema tasks.
-- El núcleo no permite actualizar una fila en papelera, así que al mover una tarea de proyecto sus filas puente,
-- adjuntos e hijas ya borrados conservan el project_id anterior. El hook dejaba de aceptar el movimiento por
-- INCONSISTENT_KEYS / INVALID_PARENT. Ahora la coherencia de claves y el «mismo proyecto que el padre» se exigen
-- solo a las filas vivas; restaurar una fila con claves antiguas sigue rechazándose.
create or replace function tasks.validate_batch(p jsonb)
returns void language plpgsql as $$
declare
  v_app text := p->>'app';
  v_actor uuid := (p->>'actor')::uuid;
  v_cursor bigint := (p->>'cursor')::bigint;
  v_scopes jsonb;
  v_import boolean := coalesce(current_setting('tasks.import_mode', true), '') <> '';
  v_tables text[];
  v_tabs uuid[];
  v_ok boolean;
  v_tab uuid;
  v_project uuid;
  v_id uuid;
  v_all int;
  v_good int;
  v_src uuid[];
  v_dst uuid[];
  v_before int;
  v_blockers jsonb;
  v_key text;
  v_value jsonb;
  c record;
  r record;
begin
  select array_agg(distinct ch.table_name) into v_tables
    from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.op <> 'call';
  if v_tables is null then return; end if;

  select array_agg(distinct x.tab) into v_tabs from (
    select case when ch.table_name = 'tabs' then ch.row_id else (coalesce(ch.after, ch.before)->>'tab_id')::uuid end tab
    from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.op <> 'call'
    union
    select (ch.before->>'tab_id')::uuid from core.changes ch
    where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.op <> 'call' and ch.table_name <> 'tabs' and ch.before is not null
  ) x where x.tab is not null;

  -- a) Ámbitos de escritura ---------------------------------------------------
  select m.scopes into v_scopes from core.memberships m where m.app = v_app and m.user_id = v_actor;
  if not tasks.scope_all(v_scopes) then
    for c in select ch.* from core.changes ch
             where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.op in ('insert','update','delete','restore') order by ch.seq loop
      v_tab := case when c.table_name = 'tabs' then c.row_id else (coalesce(c.after, c.before)->>'tab_id')::uuid end;
      case
        when c.table_name = 'tabs' then
          v_ok := c.op <> 'insert' and tasks.scope_full(v_scopes, c.row_id);
        when c.table_name in ('families', 'labels', 'saved_views') then
          v_ok := tasks.scope_full(v_scopes, v_tab);
        when c.table_name = 'projects' then
          v_ok := case when c.op = 'insert' then tasks.scope_full(v_scopes, v_tab) else tasks.scope_project(v_scopes, v_tab, c.row_id) end;
        else
          v_ok := tasks.scope_project(v_scopes, v_tab, (c.after->>'project_id')::uuid)
            and (c.before is null or tasks.scope_project(v_scopes, (c.before->>'tab_id')::uuid, (c.before->>'project_id')::uuid));
          if v_ok and c.table_name = 'task_dependencies' and c.op in ('insert', 'restore') then
            select t.project_id into v_project from tasks.tasks t where t.id = (c.after->>'depends_on_id')::uuid;
            v_ok := v_project is null or tasks.scope_project(v_scopes, v_tab, v_project);
          end if;
      end case;
      if not coalesce(v_ok, false) then
        perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'tasks.' || c.table_name, 'id', c.row_id, 'reason', 'outside scope'));
      end if;
    end loop;
  end if;

  -- b) Estructura -------------------------------------------------------------
  if 'tabs' = any(v_tables) and exists (select 1 from tasks.tabs) and not exists (select 1 from tasks.tabs where deleted_at is null) then
    perform core.fail('LAST_ACTIVE_TAB', 422);
  end if;

  -- No se toca el contenido de un área que ya estaba en la papelera antes de este lote.
  select t.id into v_id from tasks.tabs t
    where t.id = any(v_tabs) and t.deleted_at is not null
      and not exists (select 1 from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'tabs' and ch.row_id = t.id)
    limit 1;
  if v_id is not null then perform core.fail('TAB_DELETED', 422, jsonb_build_object('tabId', v_id)); end if;

  if v_tables && array['tabs', 'projects'] then
    for v_tab in select t.id from tasks.tabs t where t.id = any(v_tabs) and t.deleted_at is null loop
      select count(*), count(*) filter (where pr.deleted_at is null and pr.status <> 'archived' and pr.title = 'Entrada')
        into v_all, v_good from tasks.projects pr where pr.tab_id = v_tab and pr.system = 'inbox';
      if v_all <> 1 or v_good <> 1 then perform core.fail('INBOX_PROTECTED', 422, jsonb_build_object('tabId', v_tab)); end if;
    end loop;
  end if;

  if 'tasks' = any(v_tables) then
    if not v_import then
      select (ch.after->>'project_id')::uuid into v_id from core.changes ch join tasks.projects pr on pr.id = (ch.after->>'project_id')::uuid
        where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'tasks'
          and (ch.op = 'insert' or (ch.op = 'update' and ch.before->>'project_id' is distinct from ch.after->>'project_id'))
          and (pr.deleted_at is not null or pr.status = 'archived')
        limit 1;
      if v_id is not null then perform core.fail('PROJECT_UNAVAILABLE', 422, jsonb_build_object('projectId', v_id)); end if;
    end if;

    select ch.id into v_id from tasks.tasks ch join tasks.tasks pa on pa.id = ch.parent_id
      where ch.tab_id = any(v_tabs)
        and (pa.parent_id is not null or (ch.deleted_at is null and (pa.project_id <> ch.project_id or pa.deleted_at is not null)))
      limit 1;
    if v_id is not null then perform core.fail('INVALID_PARENT', 422, jsonb_build_object('taskId', v_id)); end if;
  end if;

  -- Claves desnormalizadas coherentes con su área y su proyecto reales.
  v_id := null;
  if v_tables && array['projects', 'tasks', 'project_labels', 'task_labels', 'task_dependencies', 'attachments'] then
    select x.id into v_id from (
      select t.id from tasks.tasks t join tasks.projects pr on pr.id = t.project_id where t.tab_id = any(v_tabs) and pr.tab_id <> t.tab_id
      union all
      select pl.id from tasks.project_labels pl join tasks.projects pr on pr.id = pl.project_id where pl.tab_id = any(v_tabs) and pl.deleted_at is null and pr.tab_id <> pl.tab_id
      union all
      select tl.id from tasks.task_labels tl join tasks.tasks t on t.id = tl.task_id where tl.tab_id = any(v_tabs) and tl.deleted_at is null and (t.tab_id <> tl.tab_id or t.project_id <> tl.project_id)
      union all
      select d.id from tasks.task_dependencies d join tasks.tasks t on t.id = d.task_id where d.tab_id = any(v_tabs) and d.deleted_at is null and (t.tab_id <> d.tab_id or t.project_id <> d.project_id)
      union all
      select a.id from tasks.attachments a join tasks.projects pr on pr.id = a.project_id where a.tab_id = any(v_tabs) and a.deleted_at is null and pr.tab_id <> a.tab_id
      union all
      select a.id from tasks.attachments a join tasks.tasks t on t.id = a.task_id where a.tab_id = any(v_tabs) and a.deleted_at is null and t.project_id <> a.project_id
    ) x limit 1;
    if v_id is not null then perform core.fail('INCONSISTENT_KEYS', 422, jsonb_build_object('id', v_id)); end if;
  end if;

  -- c) Catálogo ---------------------------------------------------------------
  if v_tables && array['families', 'labels', 'task_labels', 'project_labels', 'projects', 'tasks'] then
    select l.id into v_id from tasks.labels l join tasks.families f on f.id = l.family_id where l.tab_id = any(v_tabs) and f.tab_id <> l.tab_id limit 1;
    if v_id is not null then perform core.fail('INVALID_LABEL', 422, jsonb_build_object('labelId', v_id)); end if;

    select min(f.id::text)::uuid into v_id from tasks.families f where f.tab_id = any(v_tabs) and f.system_key is not null and f.deleted_at is null
      group by f.tab_id, f.system_key having count(*) > 1 limit 1;
    if v_id is not null then perform core.fail('INVALID_FAMILY', 422, jsonb_build_object('familyId', v_id, 'reason', 'duplicate system family')); end if;

    select l.id into v_id from tasks.labels l join tasks.labels pa on pa.id = l.parent_id where l.tab_id = any(v_tabs) and pa.tab_id <> l.tab_id limit 1;
    if v_id is null then
      with recursive up as (
        select l.id, l.parent_id, 1 depth from tasks.labels l where l.tab_id = any(v_tabs) and l.parent_id is not null
        union all
        select up.id, pa.parent_id, up.depth + 1 from up join tasks.labels pa on pa.id = up.parent_id where pa.parent_id is not null and up.depth < 64
      ) select up.id into v_id from up where up.parent_id = up.id or up.depth >= 64 limit 1;
    end if;
    if v_id is not null then perform core.fail('INVALID_LABEL_PARENT', 422, jsonb_build_object('labelId', v_id)); end if;

    select l.id into v_id from tasks.labels l join tasks.families f on f.id = l.family_id
      where l.tab_id = any(v_tabs) and f.archived and not l.archived and l.deleted_at is null limit 1;
    if v_id is not null then perform core.fail('FAMILY_ARCHIVED', 422, jsonb_build_object('labelId', v_id)); end if;

    v_id := null;
    select x.id into v_id from (
      select tl.id from tasks.task_labels tl join tasks.labels l on l.id = tl.label_id where tl.tab_id = any(v_tabs) and tl.deleted_at is null and l.tab_id <> tl.tab_id
      union all
      select pl.id from tasks.project_labels pl join tasks.labels l on l.id = pl.label_id where pl.tab_id = any(v_tabs) and pl.deleted_at is null and l.tab_id <> pl.tab_id
      union all
      select min(tl.id::text)::uuid from tasks.task_labels tl where tl.tab_id = any(v_tabs) and tl.deleted_at is null group by tl.task_id, tl.label_id having count(*) > 1
      union all
      select min(pl.id::text)::uuid from tasks.project_labels pl where pl.tab_id = any(v_tabs) and pl.deleted_at is null group by pl.project_id, pl.label_id having count(*) > 1
    ) x limit 1;
    if v_id is not null then perform core.fail('INVALID_LABELS', 422, jsonb_build_object('id', v_id)); end if;

    v_id := null;
    select x.id into v_id from (
      select l.id from tasks.labels l join tasks.task_labels tl on tl.label_id = l.id where l.tab_id = any(v_tabs) and l.deleted_at is not null and tl.deleted_at is null
      union all
      select l.id from tasks.labels l join tasks.project_labels pl on pl.label_id = l.id where l.tab_id = any(v_tabs) and l.deleted_at is not null and pl.deleted_at is null
      union all
      select l.id from tasks.labels l join tasks.tasks t on t.owner_label_id = l.id where l.tab_id = any(v_tabs) and l.deleted_at is not null and t.deleted_at is null
      union all
      select l.id from tasks.labels l join tasks.projects pr on pr.owner_label_id = l.id where l.tab_id = any(v_tabs) and l.deleted_at is not null and pr.deleted_at is null
      union all
      select l.id from tasks.labels l join tasks.labels ch on ch.parent_id = l.id where l.tab_id = any(v_tabs) and l.deleted_at is not null and ch.deleted_at is null
      union all
      select f.id from tasks.families f join tasks.labels l on l.family_id = f.id where f.tab_id = any(v_tabs) and f.deleted_at is not null and l.deleted_at is null
    ) x limit 1;
    if v_id is not null then perform core.fail('LABEL_IN_USE', 422, jsonb_build_object('id', v_id)); end if;

    v_id := null;
    select x.id into v_id from (
      select t.id from tasks.tasks t join tasks.labels l on l.id = t.owner_label_id join tasks.families f on f.id = l.family_id
        where t.tab_id = any(v_tabs) and (l.tab_id <> t.tab_id or f.system_key is distinct from 'person')
      union all
      select pr.id from tasks.projects pr join tasks.labels l on l.id = pr.owner_label_id join tasks.families f on f.id = l.family_id
        where pr.tab_id = any(v_tabs) and (l.tab_id <> pr.tab_id or f.system_key is distinct from 'person')
    ) x limit 1;
    if v_id is not null then perform core.fail('INVALID_OWNER', 422, jsonb_build_object('id', v_id)); end if;
  end if;

  if 'saved_views' = any(v_tables) then
    for r in select v.* from tasks.saved_views v
             where v.deleted_at is null and v.id in (select ch.row_id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'saved_views') loop
      v_ok := r.group_by in ('project', 'state') or exists (select 1 from tasks.families f where f.id::text = r.group_by and f.tab_id = r.tab_id);
      for v_key, v_value in select * from jsonb_each(r.filters) loop
        exit when not v_ok;
        if jsonb_typeof(v_value) <> 'array' then
          v_ok := false;
        elsif v_key = '_state' then
          v_ok := not exists (select 1 from jsonb_array_elements_text(v_value) e where e not in ('pending', 'done'));
        elsif v_key = '_availability' then
          v_ok := not exists (select 1 from jsonb_array_elements_text(v_value) e where e not in ('ready', 'blocked'));
        elsif v_key = '_project' then
          v_ok := not exists (select 1 from jsonb_array_elements_text(v_value) e where not exists (select 1 from tasks.projects pr where pr.id::text = e and pr.tab_id = r.tab_id));
        else
          v_ok := exists (select 1 from tasks.families f where f.id::text = v_key and f.tab_id = r.tab_id)
            and not exists (select 1 from jsonb_array_elements_text(v_value) e where not exists (select 1 from tasks.labels l where l.id::text = e and l.family_id::text = v_key));
        end if;
      end loop;
      if not v_ok then perform core.fail('INVALID_VIEW', 422, jsonb_build_object('viewId', r.id)); end if;
    end loop;
  end if;

  -- d) Dependencias -----------------------------------------------------------
  if v_tables && array['task_dependencies', 'tasks'] then
    v_id := null;
    select x.id into v_id from (
      select d.id from tasks.task_dependencies d join tasks.tasks dt on dt.id = d.depends_on_id where d.tab_id = any(v_tabs) and d.deleted_at is null and dt.tab_id <> d.tab_id
      union all
      select min(d.id::text)::uuid from tasks.task_dependencies d where d.tab_id = any(v_tabs) and d.deleted_at is null group by d.task_id, d.depends_on_id having count(*) > 1
    ) x limit 1;
    if v_id is not null then perform core.fail('INVALID_DEPENDENCIES', 422, jsonb_build_object('id', v_id)); end if;

    -- Ciclos: tarea → dependencia efectiva (propia o heredada del padre) y padre → hija. Se pelan los nodos sin salida
    -- hasta que no cambia nada; si quedan aristas, hay ciclo. Solo en áreas con dependencias vivas.
    if exists (
      select 1 from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks'
        and (ch.table_name = 'task_dependencies' or (ch.table_name = 'tasks' and (ch.op in ('insert', 'restore') or ch.before->>'parent_id' is distinct from ch.after->>'parent_id')))) then
      for v_tab in select t.id from tasks.tabs t where t.id = any(v_tabs)
                   and exists (select 1 from tasks.task_dependencies d where d.tab_id = t.id and d.deleted_at is null) loop
        select array_agg(e.src), array_agg(e.dst) into v_src, v_dst from (
          select d.task_id src, d.depends_on_id dst from tasks.task_dependencies d where d.tab_id = v_tab and d.deleted_at is null
          union
          select ch.id, d.depends_on_id from tasks.task_dependencies d join tasks.tasks ch on ch.parent_id = d.task_id where d.tab_id = v_tab and d.deleted_at is null
          union
          select ch.parent_id, ch.id from tasks.tasks ch where ch.tab_id = v_tab and ch.parent_id is not null
        ) e;
        loop
          v_before := coalesce(array_length(v_src, 1), 0);
          exit when v_before = 0;
          select array_agg(e.src), array_agg(e.dst) into v_src, v_dst
            from unnest(v_src, v_dst) e(src, dst) where e.dst in (select unnest(v_src));
          exit when coalesce(array_length(v_src, 1), 0) = v_before;
        end loop;
        if coalesce(array_length(v_src, 1), 0) > 0 then
          perform core.fail('DEPENDENCY_CYCLE', 422, jsonb_build_object('tabId', v_tab, 'taskIds', (select jsonb_agg(distinct s) from unnest(v_src) s)));
        end if;
      end loop;
    end if;
  end if;

  -- e) No se completa una tarea con condiciones incumplidas --------------------
  if 'tasks' = any(v_tables) and not v_import then
    for r in
      select t.* from tasks.tasks t join tasks.projects pr on pr.id = t.project_id
      where t.done and t.deleted_at is null and pr.deleted_at is null
        and not exists (select 1 from tasks.tasks k where k.parent_id = t.id and k.deleted_at is null)
        and t.id in (select ch.row_id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'tasks')
        and not coalesce((select (ch.before->>'done')::boolean from core.changes ch
                          where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'tasks' and ch.row_id = t.id
                          order by ch.seq limit 1), false)
    loop
      if exists (select 1 from tasks.task_dependencies d
                 where d.deleted_at is null and d.task_id in (r.id, r.parent_id) and not tasks.dependency_met(d.depends_on_id)) then
        select coalesce(jsonb_agg(distinct d.depends_on_id), '[]'::jsonb) into v_blockers
          from tasks.task_dependencies d join tasks.tasks dt on dt.id = d.depends_on_id
          where d.deleted_at is null and d.task_id in (r.id, r.parent_id) and not tasks.dependency_met(d.depends_on_id)
            and tasks.scope_project(v_scopes, dt.tab_id, dt.project_id);
        perform core.fail('TASK_BLOCKED', 422, jsonb_build_object('taskId', r.id, 'blockedBy', v_blockers));
      end if;
    end loop;
  end if;

  -- f) Adjuntos: el archivo existe, es de esta app, está verificado y coincide con lo declarado --------
  if 'attachments' = any(v_tables) then
    select a.id into v_id from tasks.attachments a
      where a.id in (select ch.row_id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'attachments' and ch.op = 'insert')
        and not exists (select 1 from core.files f where f.id = a.file_id and f.app = v_app and f.status = 'verified' and f.sha256 = a.sha256 and f.size = a.size)
      limit 1;
    if v_id is not null then perform core.fail('FILE_NOT_UPLOADED', 422, jsonb_build_object('attachmentId', v_id)); end if;
  end if;
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
