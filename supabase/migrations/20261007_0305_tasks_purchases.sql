-- Ikisai Tasks · compras no alimentarias (docs/tasks/API.md §18). Toca solo el schema tasks.
-- Solicitudes de compra con aprobación del responsable de compras del área, suministros con stock por movimientos
-- (solo se insertan; el stock es la suma de los movimientos vivos y lo calcula quien lee, así no hay conflictos entre
-- dispositivos sin red) y planes de compra por proveedor con su hoja de ruta. tasks.validate_batch se copia entera de
-- 0304 con sus reglas añadidas; tasks.empty_trash_prepare, de 0303, con los pasos de las tablas nuevas.

-- ---------------------------------------------------------------------------
-- Responsable de compras del área
-- ---------------------------------------------------------------------------
alter table tasks.tabs add column purchase_approver_id uuid references auth.users(id);
select core.register_table('tasks', 'tasks', 'tabs', array['name','color','position','purchase_approver_id'], '{reader,editor,owner}', '{owner}');

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------
create table tasks.supply_items (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid not null references tasks.tabs(id),
  name text not null check (length(btrim(name)) >= 1 and length(name) <= 200),
  category text not null default 'other' check (category in ('cleaning','pool','maintenance','textile','other')),
  unit text not null default 'ud' check (length(btrim(unit)) >= 1 and length(unit) <= 20),
  location text not null default '' check (length(location) <= 200),
  min_quantity numeric(12,3) not null default 0 check (min_quantity >= 0),
  reorder_quantity numeric(12,3) check (reorder_quantity is null or reorder_quantity > 0),
  supplier_id text check (supplier_id is null or length(supplier_id) between 1 and 100),
  supplier_name text check (supplier_name is null or length(supplier_name) <= 200),
  note text not null default '' check (length(note) <= 5000),
  archived boolean not null default false,
  position numeric not null default 0
);
create index supply_items_tab_idx on tasks.supply_items (tab_id, position) where deleted_at is null;

create table tasks.purchase_plans (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid not null references tasks.tabs(id),
  title text not null check (length(btrim(title)) >= 1 and length(title) <= 200),
  planned_for date,
  status text not null default 'draft' check (status in ('draft','shopping','done')),
  note text not null default '' check (length(note) <= 5000)
);
create index purchase_plans_tab_idx on tasks.purchase_plans (tab_id) where deleted_at is null;

create table tasks.purchase_plan_stops (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid not null references tasks.tabs(id),
  plan_id uuid not null references tasks.purchase_plans(id),
  supplier_id text check (supplier_id is null or length(supplier_id) between 1 and 100),
  supplier_name text not null check (length(btrim(supplier_name)) >= 1 and length(supplier_name) <= 200),
  position numeric not null default 0,
  note text not null default '' check (length(note) <= 2000)
);
create index purchase_plan_stops_plan_idx on tasks.purchase_plan_stops (plan_id, position) where deleted_at is null;

create table tasks.purchase_requests (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid not null references tasks.tabs(id),
  project_id uuid references tasks.projects(id),
  -- Referencias opcionales: si lo referido se purga de la papelera, la solicitud se queda sin el enlace.
  task_id uuid references tasks.tasks(id) on delete set null,
  supply_item_id uuid references tasks.supply_items(id) on delete set null,
  plan_stop_id uuid references tasks.purchase_plan_stops(id) on delete set null,
  title text not null check (length(btrim(title)) >= 1 and length(title) <= 300),
  note text not null default '' check (length(note) <= 5000),
  quantity numeric(12,3) check (quantity is null or quantity > 0),
  unit text check (unit is null or length(unit) <= 20),
  estimated_amount numeric(12,2) check (estimated_amount is null or estimated_amount >= 0),
  priority text not null default 'normal' check (priority in ('normal','high','critical')),
  status text not null default 'requested' check (status in ('requested','approved','purchased','received','rejected')),
  needs_invoice boolean not null default true,
  repeat_days int check (repeat_days is null or repeat_days between 1 and 366),
  due date,
  supplier_id text check (supplier_id is null or length(supplier_id) between 1 and 100),
  supplier_name text check (supplier_name is null or length(supplier_name) <= 200),
  approved_at timestamptz,
  purchased_at timestamptz,
  received_at timestamptz,
  position numeric not null default 0
);
create index purchase_requests_tab_idx on tasks.purchase_requests (tab_id, status, position) where deleted_at is null;
create index purchase_requests_stop_idx on tasks.purchase_requests (plan_stop_id) where deleted_at is null;

create table tasks.supply_movements (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid not null references tasks.tabs(id),
  supply_item_id uuid not null references tasks.supply_items(id),
  kind text not null check (kind in ('in','out','adjust')),
  delta numeric(12,3) not null check (delta <> 0),
  purchase_request_id uuid references tasks.purchase_requests(id) on delete set null,
  note text not null default '' check (length(note) <= 2000),
  constraint supply_movement_sign check ((kind = 'in' and delta > 0) or (kind = 'out' and delta < 0) or kind = 'adjust')
);
create index supply_movements_item_idx on tasks.supply_movements (supply_item_id) where deleted_at is null;

create trigger tasks_guard_immutable before update on tasks.supply_items for each row execute function tasks.guard_immutable('tab_id');
create trigger tasks_guard_immutable before update on tasks.purchase_plans for each row execute function tasks.guard_immutable('tab_id');
create trigger tasks_guard_immutable before update on tasks.purchase_plan_stops for each row execute function tasks.guard_immutable('tab_id', 'plan_id');
create trigger tasks_guard_immutable before update on tasks.purchase_requests for each row execute function tasks.guard_immutable('tab_id');
-- Un movimiento no se edita (solo su nota): corregir es otro movimiento o enviarlo a la papelera.
create trigger tasks_guard_immutable before update on tasks.supply_movements for each row
  execute function tasks.guard_immutable('tab_id', 'supply_item_id', 'kind', 'delta', 'purchase_request_id');

-- Fechas de cada paso de una solicitud: las pone el servidor al cambiar el estado (como done_at en tareas).
create or replace function tasks.touch_purchase_status()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    new.approved_at := old.approved_at; new.purchased_at := old.purchased_at; new.received_at := old.received_at;
    return new;
  end if;
  new.approved_at := case when new.status in ('approved','purchased','received') then coalesce(case when tg_op = 'UPDATE' then old.approved_at end, now()) end;
  new.purchased_at := case when new.status in ('purchased','received') then coalesce(case when tg_op = 'UPDATE' then old.purchased_at end, now()) end;
  new.received_at := case when new.status = 'received' then coalesce(case when tg_op = 'UPDATE' then old.received_at end, now()) end;
  return new;
end $$;
create trigger tasks_touch_purchase_status before insert or update on tasks.purchase_requests for each row execute function tasks.touch_purchase_status();

-- ---------------------------------------------------------------------------
-- Registro en el núcleo (orden canónico: primero lo referido)
-- ---------------------------------------------------------------------------
select core.register_table('tasks', 'tasks', 'supply_items', array['tab_id','name','category','unit','location','min_quantity','reorder_quantity','supplier_id','supplier_name','note','archived','position']);
select core.register_table('tasks', 'tasks', 'purchase_plans', array['tab_id','title','planned_for','status','note']);
select core.register_table('tasks', 'tasks', 'purchase_plan_stops', array['tab_id','plan_id','supplier_id','supplier_name','position','note']);
select core.register_table('tasks', 'tasks', 'purchase_requests', array['tab_id','project_id','task_id','supply_item_id','plan_stop_id','title','note','quantity','unit','estimated_amount','priority','status','needs_invoice','repeat_days','due','supplier_id','supplier_name','position']);
select core.register_table('tasks', 'tasks', 'supply_movements', array['tab_id','supply_item_id','kind','delta','purchase_request_id','note']);

-- ---------------------------------------------------------------------------
-- Reglas
-- ---------------------------------------------------------------------------
create or replace function tasks.validate_batch(p jsonb)
returns void language plpgsql as $$
declare
  v_app text := p->>'app';
  v_actor uuid := (p->>'actor')::uuid;
  v_cursor bigint := (p->>'cursor')::bigint;
  v_scopes jsonb;
  v_import boolean := coalesce(current_setting('tasks.import_mode', true), '') <> '';
  v_purge boolean := coalesce(current_setting('tasks.purge_mode', true), '') <> '';
  v_tables text[];
  v_tabs uuid[];
  v_ok boolean;
  v_tab uuid;
  v_project uuid;
  v_id uuid;
  v_role text;
  v_approver uuid;
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
  select m.scopes, m.role into v_scopes, v_role from core.memberships m where m.app = v_app and m.user_id = v_actor;
  if not tasks.scope_all(v_scopes) then
    for c in select ch.* from core.changes ch
             where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.op in ('insert','update','delete','restore') order by ch.seq loop
      v_tab := case when c.table_name = 'tabs' then c.row_id else (coalesce(c.after, c.before)->>'tab_id')::uuid end;
      case
        when c.table_name = 'tabs' then
          v_ok := c.op <> 'insert' and tasks.scope_full(v_scopes, c.row_id);
        when c.table_name in ('families', 'labels', 'saved_views', 'supply_items', 'supply_movements', 'purchase_plans', 'purchase_plan_stops') then
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
    where not v_purge and t.id = any(v_tabs) and t.deleted_at is not null
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

    -- Etiquetas padre e hija (aceptación V1, 9): dos niveles como máximo y dentro de la misma familia. Se aplica a las
    -- etiquetas vivas que este lote crea con padre o a las que cambia el padre; los vínculos anteriores (la app antigua
    -- permitía colgar un espacio de un edificio, de otra familia) se conservan y la interfaz los muestra sin «Padre:».
    v_id := null;
    select l.id into v_id from tasks.labels l
      where l.deleted_at is null
        and l.id in (select ch.row_id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'labels'
                       and (ch.op in ('insert', 'restore') or ch.before->>'parent_id' is distinct from ch.after->>'parent_id'))
        and (
          exists (select 1 from tasks.labels pa where pa.id = l.parent_id and (pa.family_id <> l.family_id or pa.parent_id is not null))
          or (l.parent_id is not null and exists (select 1 from tasks.labels ch where ch.parent_id = l.id and ch.deleted_at is null))
        )
      limit 1;
    if v_id is not null then perform core.fail('INVALID_LABEL_PARENT', 422, jsonb_build_object('labelId', v_id, 'reason', 'two levels in one family')); end if;

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

  -- g) Compras no alimentarias (docs/tasks/API.md §18) ------------------------------------------------------------
  if v_tables && array['supply_items', 'supply_movements', 'purchase_plans', 'purchase_plan_stops', 'purchase_requests', 'projects', 'tasks'] then
    -- Claves coherentes con su área y, en las solicitudes con tarea, con su proyecto.
    v_id := null;
    select x.id into v_id from (
      select rq.id from tasks.purchase_requests rq join tasks.projects pr on pr.id = rq.project_id where rq.tab_id = any(v_tabs) and rq.deleted_at is null and pr.tab_id <> rq.tab_id
      union all
      select rq.id from tasks.purchase_requests rq join tasks.tasks t on t.id = rq.task_id where rq.tab_id = any(v_tabs) and rq.deleted_at is null and (t.tab_id <> rq.tab_id or t.project_id is distinct from rq.project_id)
      union all
      select rq.id from tasks.purchase_requests rq join tasks.supply_items s on s.id = rq.supply_item_id where rq.tab_id = any(v_tabs) and rq.deleted_at is null and s.tab_id <> rq.tab_id
      union all
      select rq.id from tasks.purchase_requests rq join tasks.purchase_plan_stops st on st.id = rq.plan_stop_id where rq.tab_id = any(v_tabs) and rq.deleted_at is null and st.tab_id <> rq.tab_id
      union all
      select st.id from tasks.purchase_plan_stops st join tasks.purchase_plans pl on pl.id = st.plan_id where st.tab_id = any(v_tabs) and st.deleted_at is null and pl.tab_id <> st.tab_id
      union all
      select m.id from tasks.supply_movements m join tasks.supply_items s on s.id = m.supply_item_id where m.tab_id = any(v_tabs) and m.deleted_at is null and s.tab_id <> m.tab_id
      union all
      select m.id from tasks.supply_movements m join tasks.purchase_requests rq on rq.id = m.purchase_request_id where m.tab_id = any(v_tabs) and m.deleted_at is null and rq.tab_id <> m.tab_id
    ) x limit 1;
    if v_id is not null then perform core.fail('INCONSISTENT_KEYS', 422, jsonb_build_object('id', v_id)); end if;

    -- Lo vivo cuelga de algo vivo (la cascada la construye el cliente): movimientos de un suministro vivo, paradas de un
    -- plan vivo y solicitudes de una parada viva.
    v_id := null;
    select x.id into v_id from (
      select m.id from tasks.supply_movements m join tasks.supply_items s on s.id = m.supply_item_id where m.tab_id = any(v_tabs) and m.deleted_at is null and s.deleted_at is not null
      union all
      select st.id from tasks.purchase_plan_stops st join tasks.purchase_plans pl on pl.id = st.plan_id where st.tab_id = any(v_tabs) and st.deleted_at is null and pl.deleted_at is not null
      union all
      select rq.id from tasks.purchase_requests rq join tasks.purchase_plan_stops st on st.id = rq.plan_stop_id where rq.tab_id = any(v_tabs) and rq.deleted_at is null and st.deleted_at is not null
    ) x limit 1;
    if v_id is not null then perform core.fail('INVALID_PURCHASE', 422, jsonb_build_object('id', v_id, 'reason', 'parent in trash')); end if;

    -- En un plan solo entran solicitudes aprobadas (o ya compradas o recibidas).
    select rq.id into v_id from tasks.purchase_requests rq
      where rq.tab_id = any(v_tabs) and rq.deleted_at is null and rq.plan_stop_id is not null and rq.status not in ('approved', 'purchased', 'received') limit 1;
    if v_id is not null then perform core.fail('INVALID_PURCHASE', 422, jsonb_build_object('id', v_id, 'reason', 'only approved requests go into a plan')); end if;

    -- Una sola entrada de stock viva por solicitud recibida.
    select min(m.purchase_request_id::text)::uuid into v_id from tasks.supply_movements m
      where m.tab_id = any(v_tabs) and m.deleted_at is null and m.purchase_request_id is not null
      group by m.purchase_request_id having count(*) > 1 limit 1;
    if v_id is not null then perform core.fail('INVALID_PURCHASE', 422, jsonb_build_object('id', v_id, 'reason', 'one stock entry per request')); end if;

    -- Nombre de suministro único entre los vivos del área.
    select min(s.id::text)::uuid into v_id from tasks.supply_items s
      where s.tab_id = any(v_tabs) and s.deleted_at is null group by s.tab_id, lower(btrim(s.name)) having count(*) > 1 limit 1;
    if v_id is not null then perform core.fail('SUPPLY_NAME_TAKEN', 422, jsonb_build_object('id', v_id)); end if;

    -- Lo ya comprado o recibido no sale de su parada: es la historia del plan (y por eso un plan así no se borra, se termina).
    select ch.row_id into v_id from core.changes ch join tasks.purchase_requests rq on rq.id = ch.row_id
      where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'purchase_requests' and ch.op = 'update'
        and (ch.before->>'plan_stop_id') is not null and (ch.before->>'plan_stop_id') is distinct from (ch.after->>'plan_stop_id')
        and (ch.before->>'status') in ('purchased', 'received')
      limit 1;
    if v_id is not null then perform core.fail('INVALID_PURCHASE', 422, jsonb_build_object('id', v_id, 'reason', 'purchased requests stay in their plan; finish the plan instead')); end if;
  end if;

  -- Aprobar o rechazar una solicitud: solo el responsable de compras del área o, si no hay, una propietaria con el área.
  if 'purchase_requests' = any(v_tables) and not v_purge then
    for c in select ch.* from core.changes ch
             where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'purchase_requests' and ch.op in ('insert', 'update', 'restore') loop
      if (c.after->>'status') in ('approved', 'rejected') and (c.before is null or (c.before->>'status') is distinct from (c.after->>'status')) then
        v_tab := (c.after->>'tab_id')::uuid;
        select t.purchase_approver_id into v_approver from tasks.tabs t where t.id = v_tab;
        if not (v_actor is not distinct from v_approver and v_approver is not null
                or (v_approver is null and v_role = 'owner' and tasks.scope_full(v_scopes, v_tab))) then
          perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'tasks.purchase_requests', 'id', c.row_id, 'reason', 'purchase approver'));
        end if;
      end if;
    end loop;
  end if;

  -- El responsable de compras es una cuenta con acceso completo al área.
  if 'tabs' = any(v_tables) then
    select t.id into v_id from tasks.tabs t
      where t.id = any(v_tabs) and t.deleted_at is null and t.purchase_approver_id is not null
        and not exists (select 1 from core.memberships m where m.app = v_app and m.user_id = t.purchase_approver_id
                        and m.role in ('editor', 'owner') and tasks.scope_full(m.scopes, t.id))
      limit 1;
    if v_id is not null then perform core.fail('INVALID_APPROVER', 422, jsonb_build_object('tabId', v_id)); end if;
  end if;
end $$;

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
  foreach v_step in array array['supply_movements', 'purchase_requests', 'purchase_plan_stops', 'purchase_plans', 'supply_items', 'tasks', 'task_dependencies', 'task_labels', 'project_labels', 'attachments', 'saved_views', 'projects', 'labels', 'families'] loop
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

-- Permisos de las funciones nuevas o reescritas: solo service_role.
do $$
declare f text;
begin
  for f in select 'tasks.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'tasks' loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
