-- Ikisai Tasks · deshacer una compra marcada por error (RESPUESTAS de Core del 20-10-2026, a petición de VG). Toca solo el
-- schema tasks.
-- Una solicitud `purchased` puede volver a `approved` («No se compró»): `touch_purchase_status` le borra `purchased_at` y,
-- si su plan ya está terminado, sale de la parada para poder entrar en otro plan. Volver a aprobada no es aprobar: lo hace
-- quien puede marcarla comprada, no solo el responsable de compras (también al desmarcar la casilla de un plan abierto).
-- `received` no cambia. Reabrir un plan terminado (`done` → `shopping`) ya lo admitía el servidor.
-- Con una factura ligada, la pantalla no lo ofrece. Que el servidor también lo rechace necesita una comprobación publicada
-- por Finance (como `central.person_alive`): pedida a Core; irá en otra migración.
-- tasks.validate_batch: copia entera de 0333 con esas dos reglas.

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
    -- Salvo «No se compró» (0337): una compra que vuelve a aprobada puede salir de su parada para entrar en otro plan.
    select ch.row_id into v_id from core.changes ch join tasks.purchase_requests rq on rq.id = ch.row_id
      where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'purchase_requests' and ch.op = 'update'
        and (ch.before->>'plan_stop_id') is not null and (ch.before->>'plan_stop_id') is distinct from (ch.after->>'plan_stop_id')
        and (ch.before->>'status') in ('purchased', 'received')
        and not ((ch.before->>'status') = 'purchased' and (ch.after->>'status') = 'approved')
      limit 1;
    if v_id is not null then perform core.fail('INVALID_PURCHASE', 422, jsonb_build_object('id', v_id, 'reason', 'purchased requests stay in their plan; finish the plan instead')); end if;

  end if;

  -- Aprobar o rechazar una solicitud: solo el responsable de compras del área o, si no hay, una propietaria con el área.
  if 'purchase_requests' = any(v_tables) and not v_purge then
    for c in select ch.* from core.changes ch
             where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'purchase_requests' and ch.op in ('insert', 'update', 'restore') loop
      -- «No se compró» (0337) no es aprobar: lo hace quien puede marcarla comprada.
      if (c.after->>'status') in ('approved', 'rejected') and (c.before is null or (c.before->>'status') is distinct from (c.after->>'status'))
         and not coalesce((c.before->>'status') = 'purchased' and (c.after->>'status') = 'approved', false) then
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
