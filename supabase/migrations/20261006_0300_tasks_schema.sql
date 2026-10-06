-- Ikisai Tasks · tablas sincronizables del schema tasks (docs/tasks/API.md §2). Toca solo el schema tasks.
-- Las reglas de dominio (ámbitos, invariantes, ciclos, bloqueo) están en la migración 0301.
-- La unicidad de filas puente, de la Entrada y de las familias de sistema la comprueba el hook con códigos de dominio,
-- no un índice único: todas las escrituras pasan por core.commit, que es serial por app.
select core.ensure_app('tasks', 'Ikisai Tasks', 'tasks.ikisai.com');

create schema if not exists tasks;
revoke all on schema tasks from public;
revoke all on schema tasks from anon, authenticated;
grant usage on schema tasks to service_role;

-- ---------------------------------------------------------------------------
-- Áreas
-- ---------------------------------------------------------------------------
create table tasks.tabs (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  name text not null check (length(btrim(name)) >= 1 and length(name) <= 200),
  color text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  position numeric not null default 0
);
create index tabs_position_idx on tasks.tabs (position) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Catálogo: familias y etiquetas
-- ---------------------------------------------------------------------------
create table tasks.families (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid not null references tasks.tabs(id),
  name text not null check (length(btrim(name)) >= 1 and length(name) <= 100),
  color text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  archived boolean not null default false,
  position numeric not null default 0,
  system_key text check (system_key is null or system_key in ('person','trade','phase','building','space'))
);
create index families_tab_idx on tasks.families (tab_id, position);

create table tasks.labels (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid not null references tasks.tabs(id),
  family_id uuid not null references tasks.families(id),
  parent_id uuid references tasks.labels(id) check (parent_id is null or parent_id <> id),
  name text not null check (length(btrim(name)) >= 1 and length(name) <= 200),
  archived boolean not null default false,
  archived_before_family boolean,
  position numeric not null default 0
);
create index labels_family_idx on tasks.labels (tab_id, family_id, position);
create index labels_parent_idx on tasks.labels (parent_id) where parent_id is not null;

-- ---------------------------------------------------------------------------
-- Proyectos y tareas
-- ---------------------------------------------------------------------------
create table tasks.projects (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid not null references tasks.tabs(id),
  title text not null check (length(btrim(title)) >= 1 and length(title) <= 300),
  note text not null default '',
  status text not null default 'active' check (status in ('active','paused','archived')),
  priority text not null default 'normal' check (priority in ('normal','high','critical')),
  due date,
  owner_label_id uuid references tasks.labels(id),
  color text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  budget numeric(14,2) check (budget is null or budget >= 0),
  position numeric not null default 0,
  system text check (system is null or system in ('inbox'))
);
create index projects_tab_idx on tasks.projects (tab_id, position) where deleted_at is null;
create index projects_inbox_idx on tasks.projects (tab_id) where system = 'inbox';

create table tasks.tasks (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid not null references tasks.tabs(id),
  project_id uuid not null references tasks.projects(id),
  parent_id uuid references tasks.tasks(id) check (parent_id is null or parent_id <> id),
  title text not null check (length(btrim(title)) >= 1 and length(title) <= 1000),
  note text not null default '',
  done boolean not null default false,
  done_at timestamptz,
  priority text not null default 'normal' check (priority in ('normal','high','critical')),
  due date,
  owner_label_id uuid references tasks.labels(id),
  cost numeric(14,2) check (cost is null or cost >= 0),
  position numeric not null default 0
);
create index tasks_project_idx on tasks.tasks (project_id, position) where deleted_at is null;
create index tasks_parent_idx on tasks.tasks (parent_id) where parent_id is not null;
create index tasks_tab_idx on tasks.tasks (tab_id);
create index tasks_owner_idx on tasks.tasks (owner_label_id) where owner_label_id is not null;

-- ---------------------------------------------------------------------------
-- Puentes: etiquetas de proyecto y de tarea, dependencias
-- ---------------------------------------------------------------------------
create table tasks.project_labels (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid not null references tasks.tabs(id),
  project_id uuid not null references tasks.projects(id),
  label_id uuid not null references tasks.labels(id)
);
create index project_labels_project_idx on tasks.project_labels (project_id, label_id) where deleted_at is null;
create index project_labels_label_idx on tasks.project_labels (label_id);

create table tasks.task_labels (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid not null references tasks.tabs(id),
  project_id uuid not null references tasks.projects(id),
  task_id uuid not null references tasks.tasks(id),
  label_id uuid not null references tasks.labels(id)
);
create index task_labels_task_idx on tasks.task_labels (task_id, label_id) where deleted_at is null;
create index task_labels_label_idx on tasks.task_labels (label_id);
create index task_labels_project_idx on tasks.task_labels (project_id);

create table tasks.task_dependencies (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid not null references tasks.tabs(id),
  project_id uuid not null references tasks.projects(id),
  task_id uuid not null references tasks.tasks(id),
  depends_on_id uuid not null references tasks.tasks(id),
  position numeric not null default 0,
  check (task_id <> depends_on_id)
);
create index task_dependencies_task_idx on tasks.task_dependencies (task_id, depends_on_id) where deleted_at is null;
create index task_dependencies_target_idx on tasks.task_dependencies (depends_on_id);
create index task_dependencies_tab_idx on tasks.task_dependencies (tab_id);

-- ---------------------------------------------------------------------------
-- Vistas guardadas y adjuntos
-- ---------------------------------------------------------------------------
create table tasks.saved_views (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid not null references tasks.tabs(id),
  name text not null check (length(btrim(name)) >= 1 and length(name) <= 100),
  search text not null default '' check (length(search) <= 1000),
  filters jsonb not null default '{}'::jsonb check (jsonb_typeof(filters) = 'object'),
  group_by text not null default 'project',
  position numeric not null default 0
);
create index saved_views_tab_idx on tasks.saved_views (tab_id, position) where deleted_at is null;

create table tasks.attachments (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid not null references tasks.tabs(id),
  project_id uuid not null references tasks.projects(id),
  task_id uuid references tasks.tasks(id),
  name text not null check (length(btrim(name)) >= 1 and length(name) <= 255),
  mime text not null,
  size bigint not null check (size >= 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  file_id uuid not null references core.files(id),
  position numeric not null default 0
);
create index attachments_project_idx on tasks.attachments (project_id) where deleted_at is null;
create index attachments_task_idx on tasks.attachments (task_id) where task_id is not null;
create index attachments_file_idx on tasks.attachments (file_id);

-- ---------------------------------------------------------------------------
-- Triggers propios: columnas inmutables y fecha de finalización
-- ---------------------------------------------------------------------------
-- TG_ARGV: columnas que solo se escriben en el insert.
create or replace function tasks.guard_immutable()
returns trigger language plpgsql as $$
declare v_col text; v_old jsonb := to_jsonb(old); v_new jsonb := to_jsonb(new);
begin
  foreach v_col in array tg_argv loop
    if v_old->v_col is distinct from v_new->v_col then
      perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('table', 'tasks.' || tg_table_name, 'field', v_col));
    end if;
  end loop;
  return new;
end $$;

create trigger tasks_guard_immutable before update on tasks.families for each row execute function tasks.guard_immutable('tab_id', 'system_key');
create trigger tasks_guard_immutable before update on tasks.labels for each row execute function tasks.guard_immutable('tab_id');
create trigger tasks_guard_immutable before update on tasks.projects for each row execute function tasks.guard_immutable('tab_id', 'system');
create trigger tasks_guard_immutable before update on tasks.tasks for each row execute function tasks.guard_immutable('tab_id');
create trigger tasks_guard_immutable before update on tasks.project_labels for each row execute function tasks.guard_immutable('tab_id', 'project_id', 'label_id');
create trigger tasks_guard_immutable before update on tasks.task_labels for each row execute function tasks.guard_immutable('tab_id', 'task_id', 'label_id');
create trigger tasks_guard_immutable before update on tasks.task_dependencies for each row execute function tasks.guard_immutable('tab_id', 'task_id', 'depends_on_id');
create trigger tasks_guard_immutable before update on tasks.saved_views for each row execute function tasks.guard_immutable('tab_id');
create trigger tasks_guard_immutable before update on tasks.attachments for each row execute function tasks.guard_immutable('tab_id', 'task_id', 'mime', 'size', 'sha256', 'file_id');

create or replace function tasks.touch_done_at()
returns trigger language plpgsql as $$
begin
  if not new.done then
    new.done_at := null;
  elsif tg_op = 'INSERT' or not old.done then
    new.done_at := now();
  else
    new.done_at := old.done_at;
  end if;
  return new;
end $$;
create trigger tasks_touch_done_at before insert or update on tasks.tasks for each row execute function tasks.touch_done_at();

-- ---------------------------------------------------------------------------
-- Registro en el núcleo (orden canónico)
-- ---------------------------------------------------------------------------
select core.register_table('tasks', 'tasks', 'tabs', array['name','color','position'], '{reader,editor,owner}', '{owner}');
select core.register_table('tasks', 'tasks', 'families', array['tab_id','name','color','archived','position','system_key']);
select core.register_table('tasks', 'tasks', 'labels', array['tab_id','family_id','parent_id','name','archived','archived_before_family','position']);
select core.register_table('tasks', 'tasks', 'projects', array['tab_id','title','note','status','priority','due','owner_label_id','color','budget','position','system']);
select core.register_table('tasks', 'tasks', 'tasks', array['tab_id','project_id','parent_id','title','note','done','priority','due','owner_label_id','cost','position']);
select core.register_table('tasks', 'tasks', 'project_labels', array['tab_id','project_id','label_id']);
select core.register_table('tasks', 'tasks', 'task_labels', array['tab_id','project_id','task_id','label_id']);
select core.register_table('tasks', 'tasks', 'task_dependencies', array['tab_id','project_id','task_id','depends_on_id','position']);
select core.register_table('tasks', 'tasks', 'saved_views', array['tab_id','name','search','filters','group_by','position']);
select core.register_table('tasks', 'tasks', 'attachments', array['tab_id','project_id','task_id','name','mime','size','sha256','file_id','position']);
