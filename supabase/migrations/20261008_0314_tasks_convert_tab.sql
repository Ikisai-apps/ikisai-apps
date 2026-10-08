-- Ikisai Tasks · convertir un área en proyecto de otra (docs/tasks/API.md §24.4; aprobado por el usuario el 8-10-2026).
-- Toca solo el schema tasks. La acción es de la propietaria con acceso completo, desde la app y tras una vista previa; la
-- lanza la ruta `tabs/:id/convert` de tasks-api (los `call` no pasan por `commands`).
-- 1. tasks.guard_immutable admite el modo conversión (tasks.convert_mode, solo dentro de tasks.convert_tab_into_project):
--    es el único camino por el que tab_id, project_id o label_id de una fila cambian después de crearla.
-- 2. tasks.convert_tab_into_project: en un lote y con historial, crea el proyecto en el área de destino y le pasa, con los
--    mismos ids, las tareas vivas del área de origen (de todos sus proyectos), sus etiquetas (convertidas por nombre a las
--    del destino, creando las que falten), dependencias y adjuntos; mueve compras, planes, suministros y movimientos;
--    redirige las reglas de entrada; y envía el área de origen, ya vacía, a la papelera (restaurable).

create or replace function tasks.guard_immutable()
returns trigger language plpgsql as $$
declare v_col text; v_old jsonb := to_jsonb(old); v_new jsonb := to_jsonb(new);
begin
  -- Convertir un área en proyecto de otra (§24.4): solo dentro de tasks.convert_tab_into_project.
  if coalesce(current_setting('tasks.convert_mode', true), '') = 'on' then return new; end if;
  foreach v_col in array tg_argv loop
    if v_old->v_col is distinct from v_new->v_col then
      perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('table', 'tasks.' || tg_table_name, 'field', v_col));
    end if;
  end loop;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Procedimiento: convertir un área en proyecto de otra
-- args: { "sourceTabId": uuid, "targetTabId": uuid, "projectId": uuid, "title": text }
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
    select distinct lb.id, lb.name, fm.name fam_name, fm.color fam_color, fm.system_key fam_key
      from tasks.labels lb join tasks.families fm on fm.id = lb.family_id
     where lb.tab_id = v_src and lb.deleted_at is null
       and (exists (select 1 from tasks.task_labels tl join tasks.tasks t on t.id = tl.task_id and t.deleted_at is null where tl.label_id = lb.id and tl.deleted_at is null)
            or exists (select 1 from tasks.tasks t where t.owner_label_id = lb.id and t.deleted_at is null and t.tab_id = v_src)
            or exists (select 1 from tasks.request_routes rr where rr.owner_label_id = lb.id and rr.deleted_at is null and rr.tab_id = v_src))
  loop
    v_fam := null; v_lab := null;
    select f.id, f.archived into v_fam, v_archived from tasks.families f
      where f.tab_id = v_dst and f.deleted_at is null
        and ((r.fam_key is not null and f.system_key = r.fam_key) or (r.fam_key is null and f.system_key is null and lower(f.name) = lower(r.fam_name)))
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
    v_label := case when r.owner_label_id is null then null else (v_map->>r.owner_label_id::text)::uuid end;
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.tasks', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project, 'owner_label_id', v_label)));
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('tasks', v_n);

  -- 4. Sus etiquetas, dependencias y adjuntos (también los de los proyectos, que pasan al nuevo). Lo que está en la papelera
  --    se queda con el área antigua y vuelve con ella si se restaura.
  v_n := 0;
  for r in select tl.* from tasks.task_labels tl join tasks.tasks t on t.id = tl.task_id where tl.tab_id = v_src and tl.deleted_at is null and t.deleted_at is null loop
    v_label := (v_map->>r.label_id::text)::uuid;
    if v_label is not null and not exists (select 1 from tasks.task_labels x where x.task_id = r.task_id and x.label_id = v_label and x.deleted_at is null and x.id <> r.id) then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.task_labels', 'id', r.id, 'expectedRevision', r.revision,
        'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project, 'label_id', v_label)));
    else
      -- Dos etiquetas del origen con el mismo nombre en la misma familia quedan en una sola.
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'delete', 'table', 'tasks.task_labels', 'id', r.id, 'expectedRevision', r.revision));
    end if;
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
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project, 'owner_label_id', case when r.owner_label_id is null then null else (v_map->>r.owner_label_id::text)::uuid end)));
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('routes', v_n);

  -- 7. El área de origen, ya vacía, a la papelera (se puede restaurar; sus proyectos quedan vacíos con ella).
  select * into r from tasks.tabs where id = v_src;
  perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'delete', 'table', 'tasks.tabs', 'id', v_src, 'expectedRevision', r.revision));

  return jsonb_build_object('projectId', v_project, 'counts', v_counts);
end $$;

select core.allow_procedure('tasks', 'tasks.convert_tab_into_project');

do $$
declare f text;
begin
  for f in select 'tasks.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'tasks' loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
