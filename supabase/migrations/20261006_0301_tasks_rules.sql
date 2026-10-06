-- Ikisai Tasks · reglas de dominio dentro de la transacción de core.commit (docs/tasks/API.md §3.2, §4.2, §5, §6).
-- Toca solo el schema tasks. Lee core.changes (el lote), core.memberships (ámbitos del actor) y core.files (adjuntos).
-- Los errores usan core.fail para conservar el código de dominio (TASK_BLOCKED, DEPENDENCY_CYCLE…).

-- ---------------------------------------------------------------------------
-- Ámbitos (mismas reglas que supabase/functions/_domain/tasks/scopes.ts)
--   "*" | null | ["<tab>", …] | { "tabs": [...], "projects": { "<tab>": ["<project>", …] } }
-- ---------------------------------------------------------------------------
create or replace function tasks.scope_all(p_scopes jsonb)
returns boolean language sql immutable as $$
  select p_scopes is null or jsonb_typeof(p_scopes) = 'null' or p_scopes = '"*"'::jsonb;
$$;

create or replace function tasks.scope_full(p_scopes jsonb, p_tab uuid)
returns boolean language sql immutable as $$
  select tasks.scope_all(p_scopes) or coalesce(
    case jsonb_typeof(p_scopes)
      when 'array' then p_scopes ? p_tab::text
      when 'object' then jsonb_typeof(p_scopes->'tabs') = 'array' and (p_scopes->'tabs') ? p_tab::text
      else false end, false);
$$;

create or replace function tasks.scope_project(p_scopes jsonb, p_tab uuid, p_project uuid)
returns boolean language sql immutable as $$
  select tasks.scope_full(p_scopes, p_tab) or coalesce(
    jsonb_typeof(p_scopes) = 'object' and jsonb_typeof(p_scopes->'projects'->(p_tab::text)) = 'array'
      and (p_scopes->'projects'->(p_tab::text)) ? p_project::text, false);
$$;

create or replace function tasks.scope_some(p_scopes jsonb, p_tab uuid)
returns boolean language sql immutable as $$
  select tasks.scope_full(p_scopes, p_tab) or coalesce(
    jsonb_typeof(p_scopes) = 'object' and jsonb_typeof(p_scopes->'projects'->(p_tab::text)) = 'array'
      and jsonb_array_length(p_scopes->'projects'->(p_tab::text)) > 0, false);
$$;

-- ---------------------------------------------------------------------------
-- Finalización calculada: una tarea con hijas vivas está hecha cuando lo están todas ellas
-- ---------------------------------------------------------------------------
create or replace function tasks.task_done(p_id uuid)
returns boolean language sql stable as $$
  select case
    when exists (select 1 from tasks.tasks c where c.parent_id = p_id and c.deleted_at is null)
      then not exists (select 1 from tasks.tasks c where c.parent_id = p_id and c.deleted_at is null and not c.done)
    else coalesce((select t.done from tasks.tasks t where t.id = p_id), false) end;
$$;

-- Una condición está cumplida si la tarea existe, está viva, en un proyecto vivo, y hecha.
create or replace function tasks.dependency_met(p_id uuid)
returns boolean language sql stable as $$
  select coalesce((
    select t.deleted_at is null and p.deleted_at is null and tasks.task_done(t.id)
    from tasks.tasks t join tasks.projects p on p.id = t.project_id where t.id = p_id), false);
$$;

-- ---------------------------------------------------------------------------
-- Hook de validación del lote
-- ---------------------------------------------------------------------------
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
        and (pa.project_id <> ch.project_id or pa.parent_id is not null or (ch.deleted_at is null and pa.deleted_at is not null))
      limit 1;
    if v_id is not null then perform core.fail('INVALID_PARENT', 422, jsonb_build_object('taskId', v_id)); end if;
  end if;

  -- Claves desnormalizadas coherentes con su área y su proyecto reales.
  v_id := null;
  if v_tables && array['projects', 'tasks', 'project_labels', 'task_labels', 'task_dependencies', 'attachments'] then
    select x.id into v_id from (
      select t.id from tasks.tasks t join tasks.projects pr on pr.id = t.project_id where t.tab_id = any(v_tabs) and pr.tab_id <> t.tab_id
      union all
      select pl.id from tasks.project_labels pl join tasks.projects pr on pr.id = pl.project_id where pl.tab_id = any(v_tabs) and pr.tab_id <> pl.tab_id
      union all
      select tl.id from tasks.task_labels tl join tasks.tasks t on t.id = tl.task_id where tl.tab_id = any(v_tabs) and (t.tab_id <> tl.tab_id or t.project_id <> tl.project_id)
      union all
      select d.id from tasks.task_dependencies d join tasks.tasks t on t.id = d.task_id where d.tab_id = any(v_tabs) and (t.tab_id <> d.tab_id or t.project_id <> d.project_id)
      union all
      select a.id from tasks.attachments a join tasks.projects pr on pr.id = a.project_id where a.tab_id = any(v_tabs) and pr.tab_id <> a.tab_id
      union all
      select a.id from tasks.attachments a join tasks.tasks t on t.id = a.task_id where a.tab_id = any(v_tabs) and t.project_id <> a.project_id
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

select core.add_validate_hook('tasks', 'tasks.validate_batch');

-- ---------------------------------------------------------------------------
-- Procedimiento: importar filas ya remapeadas (copia portable) como áreas nuevas
-- args: { "mode": "portable", "rows": { "tasks.tabs": [ { "id": uuid, "fields": {…}, "deleted": bool? } ], … } }
-- ---------------------------------------------------------------------------
create or replace function tasks.import_rows(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_rows jsonb := coalesce(v_args->'rows', '{}'::jsonb);
  v_order text[] := array['tasks.tabs','tasks.families','tasks.labels','tasks.projects','tasks.tasks','tasks.project_labels','tasks.task_labels','tasks.task_dependencies','tasks.saved_views','tasks.attachments'];
  v_table text; v_row jsonb; v_total int := 0; v_count int; v_inserted jsonb := '{}'::jsonb; v_key text;
begin
  if jsonb_typeof(v_rows) <> 'object' then perform core.fail('INVALID_IMPORT', 422, jsonb_build_object('reason', 'rows must be an object')); end if;
  for v_key in select jsonb_object_keys(v_rows) loop
    if not (v_key = any(v_order)) then perform core.fail('INVALID_IMPORT', 422, jsonb_build_object('reason', 'unknown table', 'table', v_key)); end if;
    if jsonb_typeof(v_rows->v_key) <> 'array' then perform core.fail('INVALID_IMPORT', 422, jsonb_build_object('reason', 'rows must be arrays', 'table', v_key)); end if;
    v_total := v_total + jsonb_array_length(v_rows->v_key);
  end loop;
  if v_total = 0 or v_total > 20000 then perform core.fail('INVALID_IMPORT', 422, jsonb_build_object('reason', 'between 1 and 20000 rows', 'rows', v_total)); end if;

  perform set_config('tasks.import_mode', coalesce(v_args->>'mode', 'portable'), true);
  foreach v_table in array v_order loop
    v_count := 0;
    for v_row in select * from jsonb_array_elements(coalesce(v_rows->v_table, '[]'::jsonb)) loop
      if v_row->>'id' is null or jsonb_typeof(coalesce(v_row->'fields', '{}'::jsonb)) <> 'object' then
        perform core.fail('INVALID_IMPORT', 422, jsonb_build_object('reason', 'row needs id and fields', 'table', v_table));
      end if;
      perform core.apply_row_op(p->>'app', (p->>'actor')::uuid, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
        jsonb_build_object('op', 'insert', 'table', v_table, 'id', v_row->>'id', 'fields', coalesce(v_row->'fields', '{}'::jsonb)));
      if coalesce((v_row->>'deleted')::boolean, false) then
        perform core.apply_row_op(p->>'app', (p->>'actor')::uuid, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
          jsonb_build_object('op', 'delete', 'table', v_table, 'id', v_row->>'id', 'expectedRevision', 1));
      end if;
      v_count := v_count + 1;
    end loop;
    if v_count > 0 then v_inserted := v_inserted || jsonb_build_object(v_table, v_count); end if;
  end loop;
  return jsonb_build_object('inserted', v_inserted, 'rows', v_total);
end $$;

select core.allow_procedure('tasks', 'tasks.import_rows');

-- ---------------------------------------------------------------------------
-- Lectura registrada: destinos visibles para el usuario (áreas → proyectos → tareas). La usa Invoices.
-- args: {} | { "tabId": uuid } | { "kind": "tab"|"project"|"task", "id": uuid }
--       "includeArchived": bool (proyectos archivados), "includeDeleted": bool (papelera)
-- ---------------------------------------------------------------------------
create or replace function tasks.targets(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_scopes jsonb;
  v_kind text := v_args->>'kind';
  v_id uuid;
  v_tab uuid;
  v_archived boolean := coalesce((v_args->>'includeArchived')::boolean, false);
  v_deleted boolean := coalesce((v_args->>'includeDeleted')::boolean, false);
  v_out jsonb;
begin
  select m.scopes into v_scopes from core.memberships m where m.app = p->>'app' and m.user_id = (p->>'actor')::uuid;

  if v_kind is not null then
    begin v_id := (v_args->>'id')::uuid; exception when others then v_id := null; end;
    if v_id is null or v_kind not in ('tab', 'project', 'task') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'kind and id required')); end if;
    if v_kind = 'tab' then
      select jsonb_build_object('kind', 'tab', 'id', t.id, 'tabId', t.id, 'projectId', null, 'title', t.name, 'revision', t.revision, 'deleted', t.deleted_at is not null, 'archived', false)
        into v_out from tasks.tabs t where t.id = v_id and tasks.scope_some(v_scopes, t.id);
    elsif v_kind = 'project' then
      select jsonb_build_object('kind', 'project', 'id', pr.id, 'tabId', pr.tab_id, 'projectId', pr.id, 'title', pr.title, 'revision', pr.revision, 'deleted', pr.deleted_at is not null, 'archived', pr.status = 'archived')
        into v_out from tasks.projects pr where pr.id = v_id and tasks.scope_project(v_scopes, pr.tab_id, pr.id);
    else
      select jsonb_build_object('kind', 'task', 'id', t.id, 'tabId', t.tab_id, 'projectId', t.project_id, 'title', t.title, 'revision', t.revision, 'deleted', t.deleted_at is not null, 'archived', pr.status = 'archived', 'done', tasks.task_done(t.id))
        into v_out from tasks.tasks t join tasks.projects pr on pr.id = t.project_id where t.id = v_id and tasks.scope_project(v_scopes, t.tab_id, t.project_id);
    end if;
    if v_out is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('kind', v_kind, 'id', v_id)); end if;
    return v_out;
  end if;

  if v_args->>'tabId' is not null then
    begin v_tab := (v_args->>'tabId')::uuid; exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid tabId')); end;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'name', t.name, 'color', t.color, 'revision', t.revision, 'deleted', t.deleted_at is not null,
      'projects', (
        select coalesce(jsonb_agg(jsonb_build_object(
            'id', pr.id, 'title', pr.title, 'status', pr.status, 'system', pr.system, 'color', pr.color, 'revision', pr.revision, 'deleted', pr.deleted_at is not null,
            'tasks', (
              select coalesce(jsonb_agg(jsonb_build_object(
                  'id', k.id, 'parentId', k.parent_id, 'title', k.title, 'done', tasks.task_done(k.id), 'revision', k.revision, 'deleted', k.deleted_at is not null
                ) order by k.position, k.id), '[]'::jsonb)
              from tasks.tasks k where k.project_id = pr.id and (v_deleted or k.deleted_at is null))
          ) order by pr.position, pr.id), '[]'::jsonb)
        from tasks.projects pr
        where pr.tab_id = t.id and tasks.scope_project(v_scopes, pr.tab_id, pr.id)
          and (v_deleted or pr.deleted_at is null) and (v_archived or pr.status <> 'archived'))
    ) order by t.position, t.id), '[]'::jsonb)
    into v_out
    from tasks.tabs t
    where tasks.scope_some(v_scopes, t.id) and (v_tab is null or t.id = v_tab) and (v_deleted or t.deleted_at is null);
  return jsonb_build_object('tabs', v_out);
end $$;

select core.allow_read('tasks', 'tasks.targets', 'function');

-- Las funciones del schema solo las ejecuta service_role (vía core.commit y core.read).
do $$
declare f text;
begin
  for f in select 'tasks.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'tasks' loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
