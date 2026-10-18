-- Ikisai Tasks · O1, paso 2: el outsider marca hecha, y comentarios para todos, con fotos (RECURSOS.md §14.2; decisiones
-- del usuario del 18-10-2026; docs/tasks/API.md §31). Toca el schema tasks y, del núcleo, solo llama a sus registros.
-- - tasks.task_comments: comentarios de una tarea (cuerpo de 1 a 2000 caracteres y, opcionalmente, una foto de core.files).
--   `author_id` y `author_name` los pone el trigger con el actor del lote (`updated_by` del alta, que fija
--   core.apply_row_op) y su perfil: el cliente no los escribe.
--   La visibilidad es la de su tarea (`tab_id` y `project_id` desnormalizados, como task_labels).
--   Leen todos los roles con acceso; escriben editor, propietario y outsider (el lector no).
-- - El outsider (tasks.validate_comments, segundo hook de validación):
--   · en tasks.tasks solo cambia `done` (marcar y desmarcar), de tareas de lo que tiene abierto;
--   · comenta en tareas de lo que tiene abierto;
--   · nada más: ni insertar ni borrar tareas, ni ninguna otra tabla (FORBIDDEN). Los procedimientos (`call`) los decide el
--     núcleo (`core.allow_outsider_procedure`; Tasks no abre ninguno), pero sus filas también pasan por aquí.
--   Para él, ámbitos vacíos o «*» son nada (tasks.effective_scopes, como `effectiveScopes` de scopes.ts).
-- - Comentarios, para todos: cada uno edita, borra o restaura solo los suyos; la propietaria (rol owner) borra o restaura
--   cualquiera. Quien mueve la tarea puede mover sus comentarios (solo cambian `tab_id` y `project_id`, nunca el texto ni
--   la foto). Los comentarios vivos siguen a su tarea (INCONSISTENT_KEYS) y nacen en una tarea viva.
-- - La foto: un archivo verificado de esta app, imagen (webp, jpeg o png) y subido por quien comenta (FILE_NOT_UPLOADED).
--   Campo de archivo operativo para la recogida de huérfanos.
-- - tasks.empty_trash_prepare y tasks.convert_tab_into_project (copiadas enteras de 0327): los comentarios van a la
--   papelera con su tarea y pasan de área con ella.

create table tasks.task_comments (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid not null references tasks.tabs(id),
  project_id uuid not null references tasks.projects(id),
  task_id uuid not null references tasks.tasks(id),
  author_id uuid not null references auth.users(id),
  author_name text not null default '' check (length(author_name) <= 200),
  body text not null check (length(btrim(body)) >= 1 and length(body) <= 2000),
  file_id uuid references core.files(id)
);
create index task_comments_task_idx on tasks.task_comments (task_id, created_at) where deleted_at is null;
create index task_comments_project_idx on tasks.task_comments (project_id);
create index task_comments_file_idx on tasks.task_comments (file_id) where file_id is not null;

-- Autor: el actor del lote (core.apply_row_op pone `updated_by` en el alta) y su nombre de perfil. No cambian después.
create or replace function tasks.comment_author()
returns trigger language plpgsql as $$
declare v_actor uuid := new.updated_by;
begin
  if tg_op = 'INSERT' then
    if v_actor is null then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'a comment needs an author')); end if;
    new.author_id := v_actor;
    new.author_name := left(coalesce((select p.display_name from core.profiles p where p.user_id = v_actor), ''), 200);
  else
    new.author_id := old.author_id;
    new.author_name := old.author_name;
  end if;
  return new;
end $$;
create trigger tasks_comment_author before insert or update on tasks.task_comments for each row execute function tasks.comment_author();
create trigger tasks_guard_immutable before update on tasks.task_comments for each row execute function tasks.guard_immutable('tab_id', 'task_id');

select core.register_table('tasks', 'tasks', 'task_comments', array['tab_id','project_id','task_id','body','file_id'],
  '{reader,outsider,editor,owner}', '{editor,owner,outsider}');
select core.register_file_field('tasks', 'tasks', 'task_comments', 'file_id', 'operational');

-- El outsider escribe en tasks.tasks (solo `done`, lo limita tasks.validate_comments).
update core.synced_tables
   set writable_roles = array_append(writable_roles, 'outsider')
 where app = 'tasks' and schema_name = 'tasks' and table_name = 'tasks' and not ('outsider' = any(writable_roles));

-- Ámbitos efectivos (scopes.ts, `effectiveScopes`): para el outsider, vacío o «*» es nada.
create or replace function tasks.effective_scopes(p_role text, p_scopes jsonb)
returns jsonb language sql immutable as $$
  select case when p_role = 'outsider' and tasks.scope_all(p_scopes) then '{"tabs": [], "projects": {}}'::jsonb else p_scopes end;
$$;

create or replace function tasks.validate_comments(p jsonb)
returns void language plpgsql as $$
declare
  v_app text := p->>'app';
  v_actor uuid := (p->>'actor')::uuid;
  v_cursor bigint := (p->>'cursor')::bigint;
  v_role text;
  v_scopes jsonb;
  v_ok boolean;
  v_id uuid;
  c record;
begin
  select m.role, tasks.effective_scopes(m.role, m.scopes) into v_role, v_scopes from core.memberships m where m.app = v_app and m.user_id = v_actor;

  -- a) El outsider: marcar hecha y comentar, en lo que tiene abierto; nada más ------------------------------------
  if v_role = 'outsider' then
    for c in select ch.* from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.op <> 'call' order by ch.seq loop
      if c.schema_name = 'tasks' and c.table_name = 'tasks' and c.op = 'update' then
        v_ok := c.before->>'deleted_at' is null
          and tasks.scope_project(v_scopes, (c.before->>'tab_id')::uuid, (c.before->>'project_id')::uuid)
          and not exists (select 1 from jsonb_each(c.after) a
                           where a.key not in ('revision', 'updated_at', 'updated_by', 'done', 'done_at')
                             and (c.before->a.key) is distinct from a.value);
      elsif c.schema_name = 'tasks' and c.table_name = 'task_comments' and c.op in ('insert', 'update', 'delete', 'restore') then
        v_ok := tasks.scope_project(v_scopes, (coalesce(c.after, c.before)->>'tab_id')::uuid, (coalesce(c.after, c.before)->>'project_id')::uuid)
          and (c.before is null or tasks.scope_project(v_scopes, (c.before->>'tab_id')::uuid, (c.before->>'project_id')::uuid));
      else
        v_ok := false;
      end if;
      if not coalesce(v_ok, false) then
        perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', c.schema_name || '.' || c.table_name, 'id', c.row_id, 'reason', 'outsider'));
      end if;
    end loop;
  end if;

  -- b) Comentarios, para todos ---------------------------------------------------------------------------------
  for c in select ch.* from core.changes ch
           where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'task_comments'
             and ch.op in ('insert', 'update', 'delete', 'restore') order by ch.seq loop
    if c.op = 'insert' then
      if not exists (select 1 from tasks.tasks t where t.id = (c.after->>'task_id')::uuid and t.deleted_at is null) then
        perform core.fail('TASK_UNAVAILABLE', 422, jsonb_build_object('commentId', c.row_id, 'taskId', c.after->>'task_id'));
      end if;
    elsif c.before->>'author_id' is distinct from v_actor::text then
      -- De otra persona: mover con su tarea (sin tocar el texto ni la foto), o la propietaria borra o restaura.
      if c.op = 'update' then
        v_ok := (c.before->>'body') is not distinct from (c.after->>'body') and (c.before->>'file_id') is not distinct from (c.after->>'file_id');
      else
        v_ok := v_role = 'owner';
      end if;
      if not v_ok then
        perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'tasks.task_comments', 'id', c.row_id, 'reason', 'only the author'));
      end if;
    end if;
    if c.after->>'file_id' is not null and (c.before is null or (c.before->>'file_id') is distinct from (c.after->>'file_id')) then
      if not exists (select 1 from core.files f where f.id = (c.after->>'file_id')::uuid and f.app = v_app and f.status = 'verified'
                       and f.created_by = v_actor and f.mime in ('image/webp', 'image/jpeg', 'image/png')) then
        perform core.fail('FILE_NOT_UPLOADED', 422, jsonb_build_object('commentId', c.row_id));
      end if;
    end if;
  end loop;

  -- c) Los comentarios vivos siguen a su tarea (los del lote y los de las tareas del lote) --------------------------
  select cm.id into v_id from tasks.task_comments cm join tasks.tasks t on t.id = cm.task_id
   where cm.deleted_at is null and (cm.tab_id <> t.tab_id or cm.project_id <> t.project_id)
     and (cm.id in (select ch.row_id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'task_comments')
          or cm.task_id in (select ch.row_id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'tasks'))
   limit 1;
  if v_id is not null then perform core.fail('INCONSISTENT_KEYS', 422, jsonb_build_object('id', v_id)); end if;
end $$;
select core.add_validate_hook('tasks', 'tasks.validate_comments');

-- ---------------------------------------------------------------------------
-- Vaciar papelera (copiada entera de 0327): los comentarios de las tareas en la papelera también van a ella.
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
  foreach v_step in array array['supply_movements', 'purchase_requests', 'purchase_plan_stops', 'purchase_plans', 'supply_items', 'tasks', 'task_dependencies', 'task_labels', 'project_labels', 'task_spaces', 'project_spaces', 'task_trades', 'project_trades', 'task_people', 'project_people', 'task_comments', 'attachments', 'saved_views', 'projects', 'labels', 'families'] loop
    for r in execute case v_step
      when 'supply_movements' then
        'select m.id, m.revision from tasks.supply_movements m join tasks.supply_items s on s.id = m.supply_item_id join tasks.tabs tb on tb.id = m.tab_id
         where m.deleted_at is null and (s.deleted_at is not null or tb.deleted_at is not null)'
      when 'purchase_requests' then
        'select r.id, r.revision from tasks.purchase_requests r join tasks.tabs tb on tb.id = r.tab_id left join tasks.projects pr on pr.id = r.project_id
         where r.deleted_at is null and (tb.deleted_at is not null or pr.deleted_at is not null)'
      when 'purchase_plan_stops' then
        'select st.id, st.revision from tasks.purchase_plan_stops st join tasks.purchase_plans pl on pl.id = st.plan_id join tasks.tabs tb on tb.id = st.tab_id
         where st.deleted_at is null and (pl.deleted_at is not null or tb.deleted_at is not null)'
      when 'purchase_plans' then
        'select pl.id, pl.revision from tasks.purchase_plans pl join tasks.tabs tb on tb.id = pl.tab_id where pl.deleted_at is null and tb.deleted_at is not null'
      when 'supply_items' then
        'select s.id, s.revision from tasks.supply_items s join tasks.tabs tb on tb.id = s.tab_id where s.deleted_at is null and tb.deleted_at is not null'
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
      when 'project_people' then
        'select pp.id, pp.revision from tasks.project_people pp join tasks.projects pr on pr.id = pp.project_id join tasks.tabs tb on tb.id = pp.tab_id
         where pp.deleted_at is null and (pr.deleted_at is not null or tb.deleted_at is not null)'
      when 'attachments' then
        'select a.id, a.revision from tasks.attachments a join tasks.projects pr on pr.id = a.project_id join tasks.tabs tb on tb.id = a.tab_id left join tasks.tasks t on t.id = a.task_id
         where a.deleted_at is null and (pr.deleted_at is not null or tb.deleted_at is not null or t.deleted_at is not null)'
      when 'saved_views' then
        'select v.id, v.revision from tasks.saved_views v join tasks.tabs tb on tb.id = v.tab_id where v.deleted_at is null and tb.deleted_at is not null'
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

-- ---------------------------------------------------------------------------
-- Convertir un área en proyecto (copiada entera de 0327): los comentarios pasan con su tarea.
-- ---------------------------------------------------------------------------
create or replace function tasks.convert_tab_into_project(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_app text := p->>'app';
  v_actor uuid := (p->>'actor')::uuid;
  v_role text := p->>'role';
  v_req text := p->>'requestId';
  v_cur bigint := (p->>'cursor')::bigint;
  v_src uuid;
  v_dst uuid;
  v_project uuid;
  v_title text := btrim(coalesce(v_args->>'title', ''));
  v_scopes jsonb;
  v_map jsonb := '{}'::jsonb;
  v_fam uuid;
  v_lab uuid;
  v_pos numeric;
  v_label uuid;
  v_archived boolean;
  v_name text;
  v_counts jsonb := '{}'::jsonb;
  v_n int;
  r record;
begin
  begin
    v_src := (v_args->>'sourceTabId')::uuid; v_dst := (v_args->>'targetTabId')::uuid; v_project := (v_args->>'projectId')::uuid;
  exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'sourceTabId, targetTabId and projectId must be uuids'));
  end;
  if v_src is null or v_dst is null or v_project is null or v_src = v_dst or length(v_title) < 1 or length(v_title) > 300 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'two different areas and a title are required'));
  end if;
  select m.scopes into v_scopes from core.memberships m where m.app = v_app and m.user_id = v_actor;
  if v_role <> 'owner' or not tasks.scope_all(v_scopes) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'owner with full access')); end if;
  if not exists (select 1 from tasks.tabs where id = v_src and deleted_at is null) then perform core.fail('NOT_FOUND', 404, jsonb_build_object('kind', 'tab', 'id', v_src)); end if;
  if not exists (select 1 from tasks.tabs where id = v_dst and deleted_at is null) then perform core.fail('NOT_FOUND', 404, jsonb_build_object('kind', 'tab', 'id', v_dst)); end if;

  perform set_config('tasks.convert_mode', 'on', true);

  -- 1. El proyecto de destino, al final de su área.
  select coalesce(max(position), 0) + 1024 into v_pos from tasks.projects where tab_id = v_dst;
  perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.projects', 'id', v_project,
    'fields', jsonb_build_object('tab_id', v_dst, 'title', v_title, 'note', '', 'position', v_pos)));

  -- 2. Etiquetas usadas por las tareas vivas (como etiqueta o como responsable): las del destino con el mismo nombre en la
  --    misma familia (por su clave de sistema o, si no tiene, por nombre); las que falten, se crean.
  for r in
    select distinct lb.id, lb.name, fm.name fam_name, fm.color fam_color, fm.system_key fam_key, fm.id fam_id, fm.tab_id fam_tab
      from tasks.labels lb join tasks.families fm on fm.id = lb.family_id
     where lb.tab_id = v_src and lb.deleted_at is null
       and (exists (select 1 from tasks.task_labels tl join tasks.tasks t on t.id = tl.task_id and t.deleted_at is null where tl.label_id = lb.id and tl.deleted_at is null)
            or exists (select 1 from tasks.tasks t where t.owner_label_id = lb.id and t.deleted_at is null and t.tab_id = v_src)
            or exists (select 1 from tasks.request_routes rr where rr.owner_label_id = lb.id and rr.deleted_at is null and rr.tab_id = v_src))
  loop
    v_fam := null; v_lab := null;
    select f.id, f.archived into v_fam, v_archived from tasks.families f
      where (r.fam_tab is null and f.id = r.fam_id)
         or (r.fam_tab is not null and f.tab_id = v_dst and f.deleted_at is null
             and ((r.fam_key is not null and f.system_key = r.fam_key) or (r.fam_key is null and f.system_key is null and lower(f.name) = lower(r.fam_name))))
      order by f.archived, f.position limit 1;
    v_archived := coalesce(v_archived, false) and v_fam is not null;
    if v_fam is null then
      v_fam := gen_random_uuid();
      select coalesce(max(position), 0) + 1024 into v_pos from tasks.families where tab_id = v_dst;
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.families', 'id', v_fam,
        'fields', jsonb_build_object('tab_id', v_dst, 'name', r.fam_name, 'color', r.fam_color, 'position', v_pos, 'system_key', r.fam_key)));
      v_counts := v_counts || jsonb_build_object('familiesCreated', coalesce((v_counts->>'familiesCreated')::int, 0) + 1);
    end if;
    select lb.id into v_lab from tasks.labels lb
      where lb.tab_id = v_dst and lb.family_id = v_fam and lb.deleted_at is null and lower(lb.name) = lower(r.name)
      order by lb.archived, lb.position limit 1;
    if v_lab is null then
      v_lab := gen_random_uuid();
      select coalesce(max(position), 0) + 1024 into v_pos from tasks.labels where family_id = v_fam;
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.labels', 'id', v_lab,
        'fields', jsonb_build_object('tab_id', v_dst, 'family_id', v_fam, 'name', r.name, 'position', v_pos, 'archived', v_archived)));
      v_counts := v_counts || jsonb_build_object('labelsCreated', coalesce((v_counts->>'labelsCreated')::int, 0) + 1);
    end if;
    v_map := v_map || jsonb_build_object(r.id::text, v_lab);
  end loop;

  -- 3. Tareas vivas de todos los proyectos del origen, con los mismos ids (historial, adjuntos y enlaces de Finance siguen).
  v_n := 0;
  for r in select * from tasks.tasks where tab_id = v_src and deleted_at is null loop
    v_label := case when r.owner_label_id is null then null else coalesce((v_map->>r.owner_label_id::text)::uuid, (select g.id from tasks.labels g where g.id = r.owner_label_id and g.tab_id is null)) end;
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.tasks', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project, 'owner_label_id', v_label)));
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('tasks', v_n);

  -- 4. Sus etiquetas, dependencias y adjuntos (también los de los proyectos, que pasan al nuevo). Lo que está en la papelera
  --    se queda con el área antigua y vuelve con ella si se restaura.
  v_n := 0;
  for r in select tl.* from tasks.task_labels tl join tasks.tasks t on t.id = tl.task_id where tl.tab_id = v_src and tl.deleted_at is null and t.deleted_at is null loop
    v_label := coalesce((v_map->>r.label_id::text)::uuid, (select g.id from tasks.labels g where g.id = r.label_id and g.tab_id is null));
    if v_label is not null and not exists (select 1 from tasks.task_labels x where x.task_id = r.task_id and x.label_id = v_label and x.deleted_at is null and x.id <> r.id) then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.task_labels', 'id', r.id, 'expectedRevision', r.revision,
        'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project, 'label_id', v_label)));
    else
      -- Dos etiquetas del origen con el mismo nombre en la misma familia quedan en una sola.
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'delete', 'table', 'tasks.task_labels', 'id', r.id, 'expectedRevision', r.revision));
    end if;
  end loop;
  -- Espacios de las tareas (R2): pasan con su tarea, como sus etiquetas (son de toda la casa, no hay que convertirlos).
  for r in select ts.* from tasks.task_spaces ts join tasks.tasks t on t.id = ts.task_id
           where ts.tab_id = v_src and ts.deleted_at is null and t.deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.task_spaces', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project)));
  end loop;
  -- Oficios de las tareas (P2): pasan con su tarea, como sus espacios (son de toda la casa).
  for r in select tt.* from tasks.task_trades tt join tasks.tasks t on t.id = tt.task_id
           where tt.tab_id = v_src and tt.deleted_at is null and t.deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.task_trades', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project)));
  end loop;
  -- Personas de las tareas (P2, PR 3): pasan con su tarea, como sus oficios (son de toda la casa).
  for r in select tp.* from tasks.task_people tp join tasks.tasks t on t.id = tp.task_id
           where tp.tab_id = v_src and tp.deleted_at is null and t.deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.task_people', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project)));
  end loop;
  -- Comentarios de las tareas (O1, paso 2): pasan con su tarea, sean de quien sean.
  for r in select cm.* from tasks.task_comments cm join tasks.tasks t on t.id = cm.task_id
           where cm.tab_id = v_src and cm.deleted_at is null and t.deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.task_comments', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project)));
  end loop;
  for r in select d.*, (dt.deleted_at is null) target_live from tasks.task_dependencies d join tasks.tasks t on t.id = d.task_id join tasks.tasks dt on dt.id = d.depends_on_id
           where d.tab_id = v_src and d.deleted_at is null and t.deleted_at is null loop
    if r.target_live then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.task_dependencies', 'id', r.id, 'expectedRevision', r.revision,
        'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project)));
      v_n := v_n + 1;
    else
      -- Depende de una tarea en la papelera (que se queda en el área antigua): la condición ya no aplica.
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'delete', 'table', 'tasks.task_dependencies', 'id', r.id, 'expectedRevision', r.revision));
    end if;
  end loop;
  v_counts := v_counts || jsonb_build_object('dependencies', v_n);
  v_n := 0;
  for r in select at.* from tasks.attachments at left join tasks.tasks t on t.id = at.task_id
           where at.tab_id = v_src and at.deleted_at is null and (at.task_id is null or t.deleted_at is null) loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.attachments', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project)));
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('attachments', v_n);

  -- 5. Almacén y compras vivos del área: pasan al destino (lo que era de un proyecto del origen, al proyecto nuevo). Un
  --    suministro con el nombre de uno del destino se renombra «<nombre> · <área de origen>».
  select name into v_name from tasks.tabs where id = v_src;
  v_n := 0;
  for r in select * from tasks.supply_items where tab_id = v_src and deleted_at is null loop
    if exists (select 1 from tasks.supply_items s where s.tab_id = v_dst and s.deleted_at is null and lower(btrim(s.name)) = lower(btrim(r.name))) then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.supply_items', 'id', r.id, 'expectedRevision', r.revision,
        'fields', jsonb_build_object('tab_id', v_dst, 'name', left(btrim(r.name) || ' · ' || v_name, 200))));
      v_counts := v_counts || jsonb_build_object('suppliesRenamed', coalesce((v_counts->>'suppliesRenamed')::int, 0) + 1);
    else
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.supply_items', 'id', r.id, 'expectedRevision', r.revision, 'fields', jsonb_build_object('tab_id', v_dst)));
    end if;
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('supplies', v_n);
  for r in select * from tasks.purchase_plans where tab_id = v_src and deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.purchase_plans', 'id', r.id, 'expectedRevision', r.revision, 'fields', jsonb_build_object('tab_id', v_dst)));
  end loop;
  for r in select * from tasks.purchase_plan_stops where tab_id = v_src and deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.purchase_plan_stops', 'id', r.id, 'expectedRevision', r.revision, 'fields', jsonb_build_object('tab_id', v_dst)));
  end loop;
  v_n := 0;
  for r in select rq.*, (t.id is null or t.deleted_at is null) task_live, (s.id is null or s.deleted_at is null) supply_live
             from tasks.purchase_requests rq left join tasks.tasks t on t.id = rq.task_id left join tasks.supply_items s on s.id = rq.supply_item_id
            where rq.tab_id = v_src and rq.deleted_at is null loop
    -- El enlace a una tarea o a un suministro en la papelera (que se quedan en el área antigua) se suelta.
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.purchase_requests', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', case when r.project_id is null then null else v_project end,
                                   'task_id', case when r.task_live then r.task_id end, 'supply_item_id', case when r.supply_live then r.supply_item_id end)));
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('purchaseRequests', v_n);
  for r in select m.*, (rq.id is null or rq.deleted_at is null) request_live from tasks.supply_movements m left join tasks.purchase_requests rq on rq.id = m.purchase_request_id
            where m.tab_id = v_src and m.deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.supply_movements', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'purchase_request_id', case when r.request_live then r.purchase_request_id end)));
  end loop;

  -- 6. Reglas de entrada que apuntaban al origen: ahora, al proyecto nuevo.
  v_n := 0;
  for r in select * from tasks.request_routes where tab_id = v_src and deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.request_routes', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project, 'owner_label_id', case when r.owner_label_id is null then null else coalesce((v_map->>r.owner_label_id::text)::uuid, (select g.id from tasks.labels g where g.id = r.owner_label_id and g.tab_id is null)) end)));
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('routes', v_n);

  -- 7. El área de origen, ya vacía, a la papelera (se puede restaurar; sus proyectos quedan vacíos con ella).
  select * into r from tasks.tabs where id = v_src;
  perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'delete', 'table', 'tasks.tabs', 'id', v_src, 'expectedRevision', r.revision));

  return jsonb_build_object('projectId', v_project, 'counts', v_counts);
end $$;
