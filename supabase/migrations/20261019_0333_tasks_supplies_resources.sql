-- Ikisai Tasks · R6: Compras y Suministros sobre Recursos (RECURSOS §6 «Tasks»; docs/tasks/API.md §18).
--
-- Decisión del usuario del 19-10-2026 a la vista de los recuentos de producción (0 suministros, movimientos, solicitudes y
-- planes): sin migración de datos. El almacén de Tasks deja de existir y pasa al inventario común de Recursos.
-- - `tasks.purchase_requests` gana `item_id` (artículo de `resources.items`, sin FK entre esquemas: lo comprueba
--   `validate_batch`) y pierde `supply_item_id`.
-- - `tasks.supply_items` y `tasks.supply_movements` se retiran, **solo si están vacías** (también la papelera): si alguien
--   hubiera creado algo antes de publicar, la migración falla y no se pierde nada.
-- - Las funciones que las usaban se copian enteras sin esa parte: `validate_batch` (de 0327), `convert_tab_into_project`
--   y `empty_trash_prepare` (de 0328). La lectura `tasks.low_stock` y el indicador de Central leen ahora Recursos.
-- Toca solo el schema tasks; de Recursos solo lee.

-- 1. Comprobación: las tablas que se retiran están vacías -----------------------------------------------------------
do $$
declare v_items bigint; v_moves bigint; v_links bigint;
begin
  select count(*) into v_items from tasks.supply_items;
  select count(*) into v_moves from tasks.supply_movements;
  select count(*) into v_links from tasks.purchase_requests where supply_item_id is not null;
  if v_items + v_moves + v_links > 0 then
    raise exception 'R6: el almacén de Tasks no está vacío (% suministros, % movimientos, % solicitudes enlazadas). No se retira: avisa a Tasks.', v_items, v_moves, v_links;
  end if;
end $$;

-- 2. Funciones que usaban el almacén de Tasks, sin él -------------------------------------------------------------------

create or replace function tasks.validate_batch(p jsonb)
returns void language plpgsql as $$
declare
  v_app text := p->>'app';
  v_actor uuid := (p->>'actor')::uuid;
  v_cursor bigint := (p->>'cursor')::bigint;
  v_scopes jsonb;
  v_import boolean := coalesce(current_setting('tasks.import_mode', true), '') <> '';
  v_purge boolean := coalesce(current_setting('tasks.purge_mode', true), '') <> '';
  -- Lo que escribe tasks.request_task (§19, §20): la referencia y el id de la tarea o petición que da de alta.
  v_ext text := coalesce(current_setting('tasks.external_request', true), '');
  v_ext_id text := coalesce(current_setting('tasks.external_request_id', true), '');
  v_tables text[];
  v_tabs uuid[];
  v_general boolean;
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
  v_prev jsonb;
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
  -- Catálogo General (FB_2026_023): familias y etiquetas con tab_id nulo, válidas en todas las áreas. Si el lote toca
  -- alguna, las comprobaciones del catálogo incluyen también las General.
  v_general := exists (select 1 from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.op <> 'call'
    and ch.table_name in ('families', 'labels') and coalesce(ch.after, ch.before)->>'tab_id' is null);

  -- a) Ámbitos de escritura ---------------------------------------------------
  select m.scopes, m.role into v_scopes, v_role from core.memberships m where m.app = v_app and m.user_id = v_actor;
  if not tasks.scope_all(v_scopes) then
    for c in select ch.* from core.changes ch
             where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.op in ('insert','update','delete','restore') order by ch.seq loop
      v_tab := case when c.table_name = 'tabs' then c.row_id else (coalesce(c.after, c.before)->>'tab_id')::uuid end;
      -- Buzón (§20.4): la tarea o petición que da de alta tasks.request_task entra aunque su destino quede fuera del
      -- alcance de quien pide (lo decide una regla del usuario); solo ese insert y las etiquetas de esa tarea.
      continue when v_ext_id <> '' and c.op = 'insert'
        and (c.row_id::text = v_ext_id or (c.table_name in ('task_labels', 'task_spaces', 'task_trades', 'task_people') and c.after->>'task_id' = v_ext_id));
      case
        when c.table_name = 'tabs' then
          v_ok := c.op <> 'insert' and tasks.scope_full(v_scopes, c.row_id);
        when c.table_name in ('families', 'labels', 'saved_views', 'purchase_plans', 'purchase_plan_stops', 'request_routes') then
          v_ok := tasks.scope_full(v_scopes, v_tab);
        when c.table_name = 'settings' then
          -- Los ajustes solo los cambian los procedimientos de la propietaria con acceso completo (más abajo).
          v_ok := false;
        when c.table_name = 'requests' then
          -- Las peticiones pendientes no tienen área: son de quien tiene acceso a toda la app.
          v_ok := false;
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
    select l.id into v_id from tasks.labels l join tasks.families f on f.id = l.family_id
      where (l.tab_id = any(v_tabs) or f.tab_id = any(v_tabs) or (v_general and l.tab_id is null)) and f.tab_id is not null and f.tab_id is distinct from l.tab_id limit 1;
    if v_id is not null then perform core.fail('INVALID_LABEL', 422, jsonb_build_object('labelId', v_id)); end if;

    select min(f.id::text)::uuid into v_id from tasks.families f where (f.tab_id = any(v_tabs) or (v_general and f.tab_id is null)) and f.system_key is not null and f.deleted_at is null
      group by f.tab_id, f.system_key having count(*) > 1 limit 1;
    if v_id is not null then perform core.fail('INVALID_FAMILY', 422, jsonb_build_object('familyId', v_id, 'reason', 'duplicate system family')); end if;

    select l.id into v_id from tasks.labels l join tasks.labels pa on pa.id = l.parent_id
      where (l.tab_id = any(v_tabs) or (v_general and l.tab_id is null)) and pa.tab_id is not null and pa.tab_id is distinct from l.tab_id limit 1;
    if v_id is null then
      with recursive up as (
        select l.id, l.parent_id, 1 depth from tasks.labels l where (l.tab_id = any(v_tabs) or (v_general and l.tab_id is null)) and l.parent_id is not null
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
      where (l.tab_id = any(v_tabs) or (v_general and f.tab_id is null)) and f.archived and not l.archived and l.deleted_at is null limit 1;
    if v_id is not null then perform core.fail('FAMILY_ARCHIVED', 422, jsonb_build_object('labelId', v_id)); end if;

    v_id := null;
    select x.id into v_id from (
      select tl.id from tasks.task_labels tl join tasks.labels l on l.id = tl.label_id where tl.tab_id = any(v_tabs) and tl.deleted_at is null and l.tab_id is not null and l.tab_id <> tl.tab_id
      union all
      select pl.id from tasks.project_labels pl join tasks.labels l on l.id = pl.label_id where pl.tab_id = any(v_tabs) and pl.deleted_at is null and l.tab_id is not null and l.tab_id <> pl.tab_id
      union all
      select min(tl.id::text)::uuid from tasks.task_labels tl where tl.tab_id = any(v_tabs) and tl.deleted_at is null group by tl.task_id, tl.label_id having count(*) > 1
      union all
      select min(pl.id::text)::uuid from tasks.project_labels pl where pl.tab_id = any(v_tabs) and pl.deleted_at is null group by pl.project_id, pl.label_id having count(*) > 1
    ) x limit 1;
    if v_id is not null then perform core.fail('INVALID_LABELS', 422, jsonb_build_object('id', v_id)); end if;

    v_id := null;
    select x.id into v_id from (
      select l.id from tasks.labels l join tasks.task_labels tl on tl.label_id = l.id where (l.tab_id = any(v_tabs) or (v_general and l.tab_id is null)) and l.deleted_at is not null and tl.deleted_at is null
      union all
      select l.id from tasks.labels l join tasks.project_labels pl on pl.label_id = l.id where (l.tab_id = any(v_tabs) or (v_general and l.tab_id is null)) and l.deleted_at is not null and pl.deleted_at is null
      union all
      select l.id from tasks.labels l join tasks.tasks t on t.owner_label_id = l.id where (l.tab_id = any(v_tabs) or (v_general and l.tab_id is null)) and l.deleted_at is not null and t.deleted_at is null
      union all
      select l.id from tasks.labels l join tasks.projects pr on pr.owner_label_id = l.id where (l.tab_id = any(v_tabs) or (v_general and l.tab_id is null)) and l.deleted_at is not null and pr.deleted_at is null
      union all
      select l.id from tasks.labels l join tasks.labels ch on ch.parent_id = l.id where (l.tab_id = any(v_tabs) or (v_general and l.tab_id is null)) and l.deleted_at is not null and ch.deleted_at is null
      union all
      select f.id from tasks.families f join tasks.labels l on l.family_id = f.id where (f.tab_id = any(v_tabs) or (v_general and f.tab_id is null)) and f.deleted_at is not null and l.deleted_at is null
    ) x limit 1;
    if v_id is not null then perform core.fail('LABEL_IN_USE', 422, jsonb_build_object('id', v_id)); end if;

    v_id := null;
    select x.id into v_id from (
      select t.id from tasks.tasks t join tasks.labels l on l.id = t.owner_label_id join tasks.families f on f.id = l.family_id
        where t.tab_id = any(v_tabs) and (l.tab_id is not null and l.tab_id <> t.tab_id or f.system_key is distinct from 'person')
      union all
      select pr.id from tasks.projects pr join tasks.labels l on l.id = pr.owner_label_id join tasks.families f on f.id = l.family_id
        where pr.tab_id = any(v_tabs) and (l.tab_id is not null and l.tab_id <> pr.tab_id or f.system_key is distinct from 'person')
    ) x limit 1;
    if v_id is not null then perform core.fail('INVALID_OWNER', 422, jsonb_build_object('id', v_id)); end if;
  end if;

  if 'saved_views' = any(v_tables) then
    for r in select v.* from tasks.saved_views v
             where v.deleted_at is null and v.id in (select ch.row_id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'saved_views') loop
      -- Oficios y personas que la vista ya tenía antes del lote: uno que Central archive después no impide editarla.
      select coalesce(ch.before->'filters', '{}'::jsonb) into v_prev from core.changes ch
        where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'saved_views' and ch.row_id = r.id order by ch.seq limit 1;
      v_prev := coalesce(v_prev->'_trade', '[]'::jsonb) || coalesce(v_prev->'_person', '[]'::jsonb) || coalesce(v_prev->'_exclude', '[]'::jsonb);
      v_ok := r.group_by in ('project', 'state', '_space', '_trade', '_person') or exists (select 1 from tasks.families f where f.id::text = r.group_by and (f.tab_id = r.tab_id or f.tab_id is null));
      for v_key, v_value in select * from jsonb_each(r.filters) loop
        exit when not v_ok;
        if jsonb_typeof(v_value) <> 'array' then
          v_ok := false;
        elsif v_key = '_state' then
          v_ok := not exists (select 1 from jsonb_array_elements_text(v_value) e where e not in ('pending', 'done'));
        elsif v_key = '_availability' then
          v_ok := not exists (select 1 from jsonb_array_elements_text(v_value) e where e not in ('ready', 'blocked'));
        elsif v_key = '_priority' then
          v_ok := not exists (select 1 from jsonb_array_elements_text(v_value) e where e not in ('normal', 'high', 'critical'));
        elsif v_key = '_exclude' then
          v_ok := not exists (select 1 from jsonb_array_elements_text(v_value) e where not exists (select 1 from tasks.labels l where l.id::text = e and (l.tab_id = r.tab_id or l.tab_id is null))
                                                                                  and not exists (select 1 from resources.spaces s where s.id::text = e and s.deleted_at is null)
                                                                                  and not tasks.view_trade_ok(e, v_prev)
                                                                                  and not tasks.view_person_ok(e, v_prev));
        elsif v_key = '_space' then
          v_ok := not exists (select 1 from jsonb_array_elements_text(v_value) e where not exists (select 1 from resources.spaces s where s.id::text = e and s.deleted_at is null));
        elsif v_key = '_trade' then
          v_ok := not exists (select 1 from jsonb_array_elements_text(v_value) e where not tasks.view_trade_ok(e, v_prev));
        elsif v_key = '_person' then
          -- Personas de Central (P2, PR 3): ids de persona viva o `level:<nivel>` (todo el staff, la dirección o los outsiders).
          v_ok := not exists (select 1 from jsonb_array_elements_text(v_value) e where not tasks.view_person_ok(e, v_prev));
        elsif v_key = '_project' then
          v_ok := not exists (select 1 from jsonb_array_elements_text(v_value) e where not exists (select 1 from tasks.projects pr where pr.id::text = e and pr.tab_id = r.tab_id));
        else
          v_ok := exists (select 1 from tasks.families f where f.id::text = v_key and (f.tab_id = r.tab_id or f.tab_id is null))
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
      -- Pasos en orden (FB_2026_041): la hija anterior de la cadena, si no está hecha, también bloquea.
      v_id := tasks.step_blocker(r.id);
      if v_id is not null or exists (select 1 from tasks.task_dependencies d
                 where d.deleted_at is null and d.task_id in (r.id, r.parent_id) and not tasks.dependency_met(d.depends_on_id)) then
        select coalesce(jsonb_agg(distinct d.depends_on_id), '[]'::jsonb) into v_blockers
          from tasks.task_dependencies d join tasks.tasks dt on dt.id = d.depends_on_id
          where d.deleted_at is null and d.task_id in (r.id, r.parent_id) and not tasks.dependency_met(d.depends_on_id)
            and tasks.scope_project(v_scopes, dt.tab_id, dt.project_id);
        if v_id is not null then v_blockers := v_blockers || jsonb_build_array(v_id); end if;
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
  if v_tables && array['purchase_plans', 'purchase_plan_stops', 'purchase_requests', 'projects', 'tasks'] then
    -- Claves coherentes con su área y, en las solicitudes con tarea, con su proyecto.
    v_id := null;
    select x.id into v_id from (
      select rq.id from tasks.purchase_requests rq join tasks.projects pr on pr.id = rq.project_id where rq.tab_id = any(v_tabs) and rq.deleted_at is null and pr.tab_id <> rq.tab_id
      union all
      select rq.id from tasks.purchase_requests rq join tasks.tasks t on t.id = rq.task_id where rq.tab_id = any(v_tabs) and rq.deleted_at is null and (t.tab_id <> rq.tab_id or t.project_id is distinct from rq.project_id)
      union all
      select rq.id from tasks.purchase_requests rq join tasks.purchase_plan_stops st on st.id = rq.plan_stop_id where rq.tab_id = any(v_tabs) and rq.deleted_at is null and st.tab_id <> rq.tab_id
      union all
      select st.id from tasks.purchase_plan_stops st join tasks.purchase_plans pl on pl.id = st.plan_id where st.tab_id = any(v_tabs) and st.deleted_at is null and pl.tab_id <> st.tab_id
    ) x limit 1;
    if v_id is not null then perform core.fail('INCONSISTENT_KEYS', 422, jsonb_build_object('id', v_id)); end if;

    -- Lo vivo cuelga de algo vivo (la cascada la construye el cliente): paradas de un plan vivo y solicitudes de una parada
    -- viva.
    v_id := null;
    select x.id into v_id from (
      select st.id from tasks.purchase_plan_stops st join tasks.purchase_plans pl on pl.id = st.plan_id where st.tab_id = any(v_tabs) and st.deleted_at is null and pl.deleted_at is not null
      union all
      select rq.id from tasks.purchase_requests rq join tasks.purchase_plan_stops st on st.id = rq.plan_stop_id where rq.tab_id = any(v_tabs) and rq.deleted_at is null and st.deleted_at is not null
    ) x limit 1;
    if v_id is not null then perform core.fail('INVALID_PURCHASE', 422, jsonb_build_object('id', v_id, 'reason', 'parent in trash')); end if;

    -- En un plan solo entran solicitudes aprobadas (o ya compradas o recibidas).
    select rq.id into v_id from tasks.purchase_requests rq
      where rq.tab_id = any(v_tabs) and rq.deleted_at is null and rq.plan_stop_id is not null and rq.status not in ('approved', 'purchased', 'received') limit 1;
    if v_id is not null then perform core.fail('INVALID_PURCHASE', 422, jsonb_build_object('id', v_id, 'reason', 'only approved requests go into a plan')); end if;

    -- El artículo de Recursos de una solicitud (R6): al ponerlo o cambiarlo, tiene que existir y no estar en la papelera.
    select rq.id into v_id from tasks.purchase_requests rq
      join core.changes ch on ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'purchase_requests' and ch.row_id = rq.id
     where rq.deleted_at is null and rq.item_id is not null and (ch.before is null or (ch.before->>'item_id') is distinct from (ch.after->>'item_id'))
       and not exists (select 1 from resources.items i where i.id = rq.item_id and i.deleted_at is null)
     limit 1;
    if v_id is not null then perform core.fail('INVALID_ITEM', 422, jsonb_build_object('id', v_id, 'reason', 'item not found in resources')); end if;

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

  -- Procedencia de una tarea pedida desde otra app (§19, §20): `external_ref`, `external_kind` y `external_url` solo se
  -- fijan en el insert de la tarea, por tasks.request_task o al clasificar su petición (que pasa a `routed` en el mismo
  -- lote, con el mismo id y los mismos datos de origen).
  if 'tasks' = any(v_tables) and not v_purge then
    select ch.row_id into v_id from core.changes ch
      where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'tasks' and ch.op in ('insert', 'update', 'restore')
        and ((ch.after->>'external_ref') is distinct from (ch.before->>'external_ref')
             or (ch.after->>'external_kind') is distinct from (ch.before->>'external_kind')
             or (ch.after->>'external_url') is distinct from (ch.before->>'external_url')
             or (ch.after->>'external_on_behalf') is distinct from (ch.before->>'external_on_behalf'))
        and not (ch.op = 'insert' and (
              (ch.row_id::text = v_ext_id and (ch.after->>'external_ref') = v_ext)
              or exists (select 1 from core.changes rq
                         where rq.app = v_app and rq.cursor = v_cursor and rq.schema_name = 'tasks' and rq.table_name = 'requests' and rq.row_id = ch.row_id
                           and rq.after->>'status' = 'routed' and rq.after->>'external_ref' = ch.after->>'external_ref'
                           and (rq.after->>'kind') is not distinct from (ch.after->>'external_kind')
                           and (rq.after->>'external_url') is not distinct from (ch.after->>'external_url')
                           and (rq.after->'on_behalf_of'->>'kind') is not distinct from (ch.after->>'external_on_behalf'))))
      limit 1;
    if v_id is not null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'tasks.tasks', 'id', v_id, 'field', 'external_ref', 'reason', 'set only by requests/task or by routing its request')); end if;
  end if;

  -- Proyecto por retiro (§23): `external_ref` de un proyecto solo lo fija tasks.request_project, en el insert.
  if 'projects' = any(v_tables) and not v_purge then
    select ch.row_id into v_id from core.changes ch
      where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'projects' and ch.op in ('insert', 'update', 'restore')
        and (ch.after->>'external_ref') is distinct from (ch.before->>'external_ref')
        and not (ch.op = 'insert' and (ch.after->>'external_ref') = coalesce(current_setting('tasks.external_project', true), ''))
      limit 1;
    if v_id is not null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'tasks.projects', 'id', v_id, 'field', 'external_ref', 'reason', 'set only by requests/project')); end if;
  end if;

  -- Peticiones (§20): solo las da de alta tasks.request_task; después solo cambia su estado. Una petición `routed` tiene
  -- su tarea viva con el mismo id; una pendiente o descartada, no.
  if 'requests' = any(v_tables) and not v_purge then
    select ch.row_id into v_id from core.changes ch
      where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'requests'
        and ((ch.op = 'insert' and ch.row_id::text <> v_ext_id)
             or (ch.op = 'update' and (ch.before - array['status', 'routed_by', 'revision', 'updated_at', 'updated_by', 'deleted_at'])
                                       is distinct from (ch.after - array['status', 'routed_by', 'revision', 'updated_at', 'updated_by', 'deleted_at'])))
      limit 1;
    if v_id is not null then perform core.fail('INVALID_REQUEST', 422, jsonb_build_object('id', v_id, 'reason', 'requests are created by requests/task; only their status changes')); end if;
    select rq.id into v_id from tasks.requests rq
      where rq.deleted_at is null
        and rq.id in (select ch.row_id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'requests')
        and (rq.status = 'routed') is distinct from exists (select 1 from tasks.tasks t where t.id = rq.id and t.deleted_at is null)
      limit 1;
    if v_id is not null then perform core.fail('INVALID_REQUEST', 422, jsonb_build_object('id', v_id, 'reason', 'a routed request has its live task; a pending or dismissed one has none')); end if;
  end if;

  -- Reglas de entrada (§20): destino coherente; el proyecto, del área y no archivado; el responsable, una etiqueta
  -- Persona de esa área.
  if 'request_routes' = any(v_tables) and not v_purge then
    select ch.row_id into v_id from core.changes ch
      join tasks.request_routes rr on rr.id = ch.row_id and rr.deleted_at is null
      where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'request_routes' and ch.op in ('insert', 'update', 'restore')
        and (((coalesce(current_setting('tasks.convert_mode', true), '') <> 'on' or ch.before is null
               or ch.before->>'tab_id' is distinct from ch.after->>'tab_id' or ch.before->>'project_id' is distinct from ch.after->>'project_id')
              and (not exists (select 1 from tasks.tabs tb where tb.id = rr.tab_id and tb.deleted_at is null)
                   or (rr.project_id is not null and not exists (select 1 from tasks.projects pr where pr.id = rr.project_id and pr.tab_id = rr.tab_id and pr.deleted_at is null and pr.status <> 'archived'))))
             or (rr.owner_label_id is not null and not exists (select 1 from tasks.labels l join tasks.families f on f.id = l.family_id
                                                               where l.id = rr.owner_label_id and (l.tab_id = rr.tab_id or l.tab_id is null) and l.deleted_at is null and f.system_key = 'person')))
      limit 1;
    if v_id is not null then perform core.fail('INVALID_ROUTE', 422, jsonb_build_object('id', v_id)); end if;
  end if;

  -- h) Espacios de Recursos (R2) ----------------------------------------------------------------------------------
  if v_tables && array['task_spaces', 'project_spaces', 'tasks', 'projects'] then
    v_id := null;
    select x.id into v_id from (
      select ts.id from tasks.task_spaces ts join tasks.tasks t on t.id = ts.task_id where ts.tab_id = any(v_tabs) and ts.deleted_at is null and (t.tab_id <> ts.tab_id or t.project_id <> ts.project_id)
      union all
      select ps.id from tasks.project_spaces ps join tasks.projects pr on pr.id = ps.project_id where ps.tab_id = any(v_tabs) and ps.deleted_at is null and pr.tab_id <> ps.tab_id
    ) x limit 1;
    if v_id is not null then perform core.fail('INCONSISTENT_KEYS', 422, jsonb_build_object('id', v_id)); end if;
    select x.id into v_id from (
      select min(ts.id::text)::uuid id from tasks.task_spaces ts where ts.tab_id = any(v_tabs) and ts.deleted_at is null group by ts.task_id, ts.space_id having count(*) > 1
      union all
      select min(ps.id::text)::uuid from tasks.project_spaces ps where ps.tab_id = any(v_tabs) and ps.deleted_at is null group by ps.project_id, ps.space_id having count(*) > 1
    ) x limit 1;
    if v_id is not null then perform core.fail('INVALID_SPACES', 422, jsonb_build_object('id', v_id, 'reason', 'duplicate')); end if;
    -- El espacio existe, está vivo y activo cuando se pone (no hay clave foránea entre schemas: docs/resources/API.md §2.5).
    select ch.row_id into v_id from core.changes ch
      where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name in ('task_spaces', 'project_spaces') and ch.op in ('insert', 'restore')
        and not exists (select 1 from resources.spaces s where s.id = (ch.after->>'space_id')::uuid and s.deleted_at is null and s.active)
      limit 1;
    if v_id is not null then perform core.fail('INVALID_SPACE', 422, jsonb_build_object('id', v_id, 'reason', 'space not found or archived')); end if;
  end if;

  -- i) Oficios de Central (P2) ------------------------------------------------------------------------------------
  if v_tables && array['task_trades', 'project_trades', 'tasks', 'projects'] then
    v_id := null;
    select x.id into v_id from (
      select tt.id from tasks.task_trades tt join tasks.tasks t on t.id = tt.task_id where tt.tab_id = any(v_tabs) and tt.deleted_at is null and (t.tab_id <> tt.tab_id or t.project_id <> tt.project_id)
      union all
      select pt.id from tasks.project_trades pt join tasks.projects pr on pr.id = pt.project_id where pt.tab_id = any(v_tabs) and pt.deleted_at is null and pr.tab_id <> pt.tab_id
    ) x limit 1;
    if v_id is not null then perform core.fail('INCONSISTENT_KEYS', 422, jsonb_build_object('id', v_id)); end if;
    select x.id into v_id from (
      select min(tt.id::text)::uuid id from tasks.task_trades tt where tt.tab_id = any(v_tabs) and tt.deleted_at is null group by tt.task_id, tt.trade_id having count(*) > 1
      union all
      select min(pt.id::text)::uuid from tasks.project_trades pt where pt.tab_id = any(v_tabs) and pt.deleted_at is null group by pt.project_id, pt.trade_id having count(*) > 1
    ) x limit 1;
    if v_id is not null then perform core.fail('INVALID_TRADES', 422, jsonb_build_object('id', v_id, 'reason', 'duplicate')); end if;
    -- El oficio existe, está vivo y activo cuando se pone (sin clave foránea entre schemas; central.trade_alive, 1508).
    select ch.row_id into v_id from core.changes ch
      where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name in ('task_trades', 'project_trades') and ch.op in ('insert', 'restore')
        and not central.trade_alive((ch.after->>'trade_id')::uuid)
      limit 1;
    if v_id is not null then perform core.fail('INVALID_TRADE', 422, jsonb_build_object('id', v_id, 'reason', 'trade not found or archived')); end if;
  end if;

  -- j) Personas de Central (P2, PR 3) ---------------------------------------------------------------------------
  if v_tables && array['task_people', 'project_people', 'tasks', 'projects'] then
    v_id := null;
    select x.id into v_id from (
      select tp.id from tasks.task_people tp join tasks.tasks t on t.id = tp.task_id where tp.tab_id = any(v_tabs) and tp.deleted_at is null and (t.tab_id <> tp.tab_id or t.project_id <> tp.project_id)
      union all
      select pp.id from tasks.project_people pp join tasks.projects pr on pr.id = pp.project_id where pp.tab_id = any(v_tabs) and pp.deleted_at is null and pr.tab_id <> pp.tab_id
    ) x limit 1;
    if v_id is not null then perform core.fail('INCONSISTENT_KEYS', 422, jsonb_build_object('id', v_id)); end if;
    select x.id into v_id from (
      select min(tp.id::text)::uuid id from tasks.task_people tp where tp.tab_id = any(v_tabs) and tp.deleted_at is null group by tp.task_id, tp.person_id, tp.house_level having count(*) > 1
      union all
      select min(pp.id::text)::uuid from tasks.project_people pp where pp.tab_id = any(v_tabs) and pp.deleted_at is null group by pp.project_id, pp.person_id, pp.house_level having count(*) > 1
    ) x limit 1;
    if v_id is not null then perform core.fail('INVALID_PEOPLE', 422, jsonb_build_object('id', v_id, 'reason', 'duplicate')); end if;
    -- La persona existe, está viva y activa cuando se pone (sin clave foránea entre schemas; central.person_alive, 1508).
    select ch.row_id into v_id from core.changes ch
      where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name in ('task_people', 'project_people') and ch.op in ('insert', 'restore')
        and ch.after->>'person_id' is not null and not central.person_alive((ch.after->>'person_id')::uuid)
      limit 1;
    if v_id is not null then perform core.fail('INVALID_PERSON', 422, jsonb_build_object('id', v_id, 'reason', 'person not found or inactive')); end if;
  end if;

  -- Responsable principal: como mucho uno (etiqueta, persona o grupo) y, si es una persona que cambia, viva en Central.
  if v_tables && array['tasks', 'projects', 'request_routes'] and not v_purge then
    select ch.row_id into v_id from core.changes ch
      where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name in ('tasks', 'projects', 'request_routes') and ch.op in ('insert', 'update', 'restore')
        and (num_nonnulls(ch.after->>'owner_label_id', ch.after->>'owner_person_id', ch.after->>'owner_house_level') > 1
             or (ch.after->>'owner_person_id' is not null and (ch.after->>'owner_person_id') is distinct from (ch.before->>'owner_person_id')
                 and not central.person_alive((ch.after->>'owner_person_id')::uuid)))
      limit 1;
    if v_id is not null then perform core.fail('INVALID_OWNER', 422, jsonb_build_object('id', v_id, 'reason', 'one owner: a label, a live person or a house level')); end if;
  end if;

  -- Ajustes de la app: solo dentro de «Pasar las zonas a espacios», «Pasar las acciones a oficios», «Pasar las personas
  -- a Central» o sus marchas atrás.
  if 'settings' = any(v_tables) and coalesce(current_setting('tasks.convert_mode', true), '') <> 'on' then
    perform core.fail('INVALID_SETTING', 422, jsonb_build_object('reason', 'settings change only through the app actions'));
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

  -- 5. Compras vivas del área: pasan al destino (lo que era de un proyecto del origen, al proyecto nuevo). El almacén ya no
  --    es de Tasks: vive en Recursos, común a toda la casa (R6), y no se mueve.
  for r in select * from tasks.purchase_plans where tab_id = v_src and deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.purchase_plans', 'id', r.id, 'expectedRevision', r.revision, 'fields', jsonb_build_object('tab_id', v_dst)));
  end loop;
  for r in select * from tasks.purchase_plan_stops where tab_id = v_src and deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.purchase_plan_stops', 'id', r.id, 'expectedRevision', r.revision, 'fields', jsonb_build_object('tab_id', v_dst)));
  end loop;
  v_n := 0;
  for r in select rq.*, (t.id is null or t.deleted_at is null) task_live
             from tasks.purchase_requests rq left join tasks.tasks t on t.id = rq.task_id
            where rq.tab_id = v_src and rq.deleted_at is null loop
    -- El enlace a una tarea en la papelera (que se queda en el área antigua) se suelta.
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.purchase_requests', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', case when r.project_id is null then null else v_project end,
                                   'task_id', case when r.task_live then r.task_id end)));
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('purchaseRequests', v_n);

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
  foreach v_step in array array['purchase_requests', 'purchase_plan_stops', 'purchase_plans', 'tasks', 'task_dependencies', 'task_labels', 'project_labels', 'task_spaces', 'project_spaces', 'task_trades', 'project_trades', 'task_people', 'project_people', 'task_comments', 'attachments', 'saved_views', 'projects', 'labels', 'families'] loop
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

-- 3. Lecturas sobre Recursos ------------------------------------------------------------------------------------------
-- Tipos de artículo que son «suministros» de la casa (lo que no es cocina): Food lleva ingredientes, bebidas y menaje.
create or replace function tasks.supply_kind(p_kind text)
returns boolean language sql immutable as $$
  select p_kind is not null and p_kind not in ('ingrediente', 'bebida', 'menaje');
$$;

-- «Queda poco»: artículos de Recursos de tipo suministro, activos, con mínimo y con menos stock (todos los sitios) que ese
-- mínimo; con la solicitud abierta que ya lo pide, si la hay. El inventario es de toda la casa: `tabId` ya no filtra
-- artículos (decisión del usuario, R6), solo la solicitud abierta que se enseña. Para quien tiene alguna área entera.
create or replace function tasks.low_stock(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_scopes jsonb;
  v_tab uuid;
  v_out jsonb;
begin
  select m.scopes into v_scopes from core.memberships m where m.app = p->>'app' and m.user_id = (p->>'actor')::uuid;
  if v_args->>'tabId' is not null then
    begin v_tab := (v_args->>'tabId')::uuid; exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid tabId')); end;
  end if;
  if not exists (select 1 from tasks.tabs tb where tb.deleted_at is null and tasks.scope_full(v_scopes, tb.id)) then
    return jsonb_build_object('items', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'name', i.name, 'kind', i.kind, 'category', i.category, 'unit', i.base_unit, 'defaultSpaceId', i.default_space_id,
      'stock', st.stock, 'minQuantity', i.min_quantity, 'reorderQuantity', i.reorder_quantity, 'supplierId', i.default_supplier_id,
      'openRequestId', (select rq.id from tasks.purchase_requests rq
                        where rq.item_id = i.id and rq.deleted_at is null and rq.status in ('requested', 'approved', 'purchased')
                          and tasks.scope_full(v_scopes, rq.tab_id) and (v_tab is null or rq.tab_id = v_tab)
                        order by rq.created_at desc limit 1)
    ) order by lower(i.name), i.id), '[]'::jsonb)
    into v_out
    from resources.items i
    cross join lateral (select coalesce(sum(mv.quantity), 0) stock from resources.movements mv where mv.item_id = i.id and mv.deleted_at is null) st
    where i.deleted_at is null and i.active and tasks.supply_kind(i.kind) and i.min_quantity is not null and st.stock < i.min_quantity;
  return jsonb_build_object('items', v_out);
end $$;

-- Un artículo de Recursos con su stock en toda la casa (para «Queda poco: pedir» desde MCP). args: { "itemId": uuid }.
-- Devuelve { item: null } si no existe o está en la papelera.
create or replace function tasks.supply_item(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_id uuid;
  v_out jsonb;
begin
  begin v_id := (p->'args'->>'itemId')::uuid; exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid itemId')); end;
  if v_id is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'itemId required')); end if;
  select jsonb_build_object('id', i.id, 'name', i.name, 'kind', i.kind, 'base_unit', i.base_unit, 'min_quantity', i.min_quantity,
           'reorder_quantity', i.reorder_quantity, 'default_space_id', i.default_space_id, 'default_supplier_id', i.default_supplier_id,
           'active', i.active, 'deleted_at', i.deleted_at,
           'stock', coalesce((select sum(mv.quantity) from resources.movements mv where mv.item_id = i.id and mv.deleted_at is null), 0))
    into v_out
    from resources.items i where i.id = v_id and i.deleted_at is null;
  return jsonb_build_object('item', v_out);
end $$;

select core.allow_read('tasks', 'tasks.supply_item', 'function');

-- Indicadores para Central (de 0309): «Suministros bajo mínimo» cuenta ahora los artículos de Recursos de tipo suministro.
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
    ('tasks.requests_pending', 'Peticiones por clasificar',
      (select count(*) from tasks.requests r where r.deleted_at is null and r.status = 'pending')::numeric, 'count', 'down', 'https://tasks.ikisai.com/#/triage')
  ) as k(kpi, label, value, unit, direction, link);

revoke all on tasks.central_kpi_projection from public, anon, authenticated;
grant select on tasks.central_kpi_projection to service_role;

-- 4. Retirada de las tablas viejas y artículo en las solicitudes --------------------------------------------------------
select core.unregister_table('tasks', 'tasks', 'supply_movements');
select core.unregister_table('tasks', 'tasks', 'supply_items');
alter table tasks.purchase_requests drop column supply_item_id;
drop table tasks.supply_movements;
drop table tasks.supply_items;

alter table tasks.purchase_requests add column item_id uuid;
create index purchase_requests_item_idx on tasks.purchase_requests (item_id) where deleted_at is null and item_id is not null;
select core.register_table('tasks', 'tasks', 'purchase_requests', array['tab_id','project_id','task_id','item_id','plan_stop_id','title','note','quantity','unit','estimated_amount','priority','status','needs_invoice','repeat_days','due','supplier_id','supplier_name','position']);

do $$
declare f text;
begin
  for f in select 'tasks.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'tasks' loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
