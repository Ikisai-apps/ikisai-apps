-- Ikisai Tasks · «Solo de un área»: una etiqueta General vuelve a ser de un área (FB_2026_035; VG 27-10-2026 eligió
-- «volver a específica», sin exclusiones por área). Es la vuelta de «Hacer General» (tasks.merge_labels_into_general).
-- Toca solo el schema tasks y, del núcleo, solo usa apply_row_op, fail y allow_procedure.
--
-- tasks.general_label_to_area(args { labelId, tabId }): solo la propietaria con acceso a toda la app, en un lote con
-- historial (se deshace con el historial, como «Hacer General»).
-- - La General pasa al área elegida (su `tab_id`, en modo conversión: es inmutable fuera de él) y se queda en su familia.
--   Si esa área ya tenía viva una etiqueta igual (misma familia y mismo nombre, tasks.label_name_key), se usa esa y la
--   General queda archivada.
-- - Nada se pierde en las demás áreas: cada área que la usa (tareas, proyectos, responsables, reglas de entrada, hijas
--   propias y vistas guardadas) pasa a una copia propia: la viva igual del área, si la hay; si no, su copia archivada
--   (la que dejó «Hacer General»), desarchivada; y si no, una nueva en la misma familia y con la misma madre.
-- - Con hijas General no se puede (una hija General solo cuelga de una madre General): primero, ellas.
-- Devuelve { labelId, tabId, copies: {tabId: labelId}, counts }.

create or replace function tasks.general_label_to_area(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_app text := p->>'app';
  v_actor uuid := (p->>'actor')::uuid;
  v_role text := p->>'role';
  v_req text := p->>'requestId';
  v_cur bigint := (p->>'cursor')::bigint;
  v_scopes jsonb;
  v_label tasks.labels;
  v_fam tasks.families;
  v_target uuid;
  v_tabs uuid[];
  v_tab uuid;
  v_copy tasks.labels;
  v_copy_id uuid;
  v_map jsonb := '{}'::jsonb;      -- área → etiqueta que usa allí
  v_fam_map jsonb := '{}'::jsonb;  -- área → familia de esa etiqueta
  v_copies jsonb := '{}'::jsonb;
  v_moved boolean := false;
  v_pos numeric;
  v_counts jsonb := jsonb_build_object('copies', 0, 'restored', 0, 'taskLabels', 0, 'projectLabels', 0, 'owners', 0, 'routes', 0, 'children', 0, 'views', 0);
  v_filters jsonb; v_new jsonb; v_key text; v_val jsonb; v_id text; v_to text; v_to_key text; v_changed boolean;
  r record;
begin
  select m.scopes into v_scopes from core.memberships m where m.app = v_app and m.user_id = v_actor;
  if v_role <> 'owner' or not tasks.scope_all(v_scopes) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'owner with full access')); end if;
  begin
    select * into v_label from tasks.labels where id = (v_args->>'labelId')::uuid;
    v_target := (v_args->>'tabId')::uuid;
  exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'labelId and tabId must be uuids'));
  end;
  if v_label.id is null or v_label.deleted_at is not null or v_label.tab_id is not null or v_label.archived then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'a live General label', 'labelId', v_args->>'labelId'));
  end if;
  if v_target is null or not exists (select 1 from tasks.tabs t where t.id = v_target and t.deleted_at is null) then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('tabId', v_args->>'tabId'));
  end if;
  if exists (select 1 from tasks.labels ch where ch.parent_id = v_label.id and ch.deleted_at is null and ch.tab_id is null) then
    perform core.fail('LABEL_HAS_GENERAL_CHILDREN', 422, jsonb_build_object('labelId', v_label.id));
  end if;
  select * into v_fam from tasks.families where id = v_label.family_id;
  perform set_config('tasks.convert_mode', 'on', true);

  -- 1. Las áreas donde se usa, además de la elegida.
  select array_agg(distinct x.tab_id) into v_tabs from (
    select v_target tab_id
    union select tl.tab_id from tasks.task_labels tl where tl.label_id = v_label.id and tl.deleted_at is null
    union select pl.tab_id from tasks.project_labels pl where pl.label_id = v_label.id and pl.deleted_at is null
    union select t.tab_id from tasks.tasks t where t.owner_label_id = v_label.id and t.deleted_at is null
    union select pr.tab_id from tasks.projects pr where pr.owner_label_id = v_label.id and pr.deleted_at is null
    union select rr.tab_id from tasks.request_routes rr where rr.owner_label_id = v_label.id and rr.deleted_at is null
    union select ch.tab_id from tasks.labels ch where ch.parent_id = v_label.id and ch.deleted_at is null and ch.tab_id is not null
    union select sv.tab_id from tasks.saved_views sv where sv.deleted_at is null and sv.filters::text like '%' || v_label.id::text || '%'
  ) x;

  -- 2. La etiqueta de cada área: la viva igual; en la elegida, si no hay, la propia General; en las demás, la copia
  --    archivada o una nueva.
  foreach v_tab in array v_tabs loop
    v_copy := null;
    select l.* into v_copy from tasks.labels l join tasks.families f on f.id = l.family_id
      where l.tab_id = v_tab and l.deleted_at is null and l.id <> v_label.id
        and tasks.family_name_key(f.system_key, f.name) = tasks.family_name_key(v_fam.system_key, v_fam.name)
        and tasks.label_name_key(l.name) = tasks.label_name_key(v_label.name)
        and (not l.archived or (v_tab <> v_target and not f.archived))
        and not exists (select 1 from tasks.labels ch where ch.parent_id = l.id and ch.deleted_at is null and v_label.parent_id is not null)
      order by l.archived, (l.parent_id is not distinct from v_label.parent_id) desc, l.position limit 1;
    if v_copy.id is null and v_tab = v_target then
      v_copy_id := v_label.id; v_moved := true;
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.labels', 'id', v_label.id,
        'expectedRevision', v_label.revision, 'fields', jsonb_build_object('tab_id', v_target)));
      v_map := v_map || jsonb_build_object(v_tab::text, v_label.id); v_fam_map := v_fam_map || jsonb_build_object(v_tab::text, v_label.family_id);
      continue;
    end if;
    if v_copy.id is null then
      v_copy_id := gen_random_uuid();
      select coalesce(max(position), 0) + 1024 into v_pos from tasks.labels where family_id = v_label.family_id;
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.labels', 'id', v_copy_id,
        'fields', jsonb_build_object('tab_id', v_tab, 'family_id', v_label.family_id, 'parent_id', v_label.parent_id, 'name', v_label.name, 'position', v_pos)));
      v_counts := jsonb_set(v_counts, '{copies}', to_jsonb((v_counts->>'copies')::int + 1));
      v_map := v_map || jsonb_build_object(v_tab::text, v_copy_id); v_fam_map := v_fam_map || jsonb_build_object(v_tab::text, v_label.family_id);
    else
      if v_copy.archived then
        perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.labels', 'id', v_copy.id,
          'expectedRevision', v_copy.revision, 'fields', jsonb_build_object('archived', false)));
        v_counts := jsonb_set(v_counts, '{restored}', to_jsonb((v_counts->>'restored')::int + 1));
      end if;
      v_map := v_map || jsonb_build_object(v_tab::text, v_copy.id); v_fam_map := v_fam_map || jsonb_build_object(v_tab::text, v_copy.family_id);
    end if;
    if v_tab <> v_target then v_copies := v_copies || jsonb_build_object(v_tab::text, v_map->>v_tab::text); end if;
  end loop;

  -- 3. Repuntar en cada área lo que usaba la General (sin repetir la misma etiqueta en una tarea o un proyecto).
  for r in select tl.* from tasks.task_labels tl where tl.label_id = v_label.id and tl.deleted_at is null and (v_map->>tl.tab_id::text)::uuid <> v_label.id loop
    if exists (select 1 from tasks.task_labels x where x.task_id = r.task_id and x.label_id = (v_map->>r.tab_id::text)::uuid and x.deleted_at is null) then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'delete', 'table', 'tasks.task_labels', 'id', r.id, 'expectedRevision', r.revision));
    else
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.task_labels', 'id', r.id, 'expectedRevision', r.revision,
        'fields', jsonb_build_object('label_id', (v_map->>r.tab_id::text)::uuid)));
    end if;
    v_counts := jsonb_set(v_counts, '{taskLabels}', to_jsonb((v_counts->>'taskLabels')::int + 1));
  end loop;
  for r in select pl.* from tasks.project_labels pl where pl.label_id = v_label.id and pl.deleted_at is null and (v_map->>pl.tab_id::text)::uuid <> v_label.id loop
    if exists (select 1 from tasks.project_labels x where x.project_id = r.project_id and x.label_id = (v_map->>r.tab_id::text)::uuid and x.deleted_at is null) then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'delete', 'table', 'tasks.project_labels', 'id', r.id, 'expectedRevision', r.revision));
    else
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.project_labels', 'id', r.id, 'expectedRevision', r.revision,
        'fields', jsonb_build_object('label_id', (v_map->>r.tab_id::text)::uuid)));
    end if;
    v_counts := jsonb_set(v_counts, '{projectLabels}', to_jsonb((v_counts->>'projectLabels')::int + 1));
  end loop;
  for r in select t.* from tasks.tasks t where t.owner_label_id = v_label.id and t.deleted_at is null and (v_map->>t.tab_id::text)::uuid <> v_label.id loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.tasks', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('owner_label_id', (v_map->>r.tab_id::text)::uuid)));
    v_counts := jsonb_set(v_counts, '{owners}', to_jsonb((v_counts->>'owners')::int + 1));
  end loop;
  for r in select pr.* from tasks.projects pr where pr.owner_label_id = v_label.id and pr.deleted_at is null and (v_map->>pr.tab_id::text)::uuid <> v_label.id loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.projects', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('owner_label_id', (v_map->>r.tab_id::text)::uuid)));
    v_counts := jsonb_set(v_counts, '{owners}', to_jsonb((v_counts->>'owners')::int + 1));
  end loop;
  for r in select rr.* from tasks.request_routes rr where rr.owner_label_id = v_label.id and rr.deleted_at is null and (v_map->>rr.tab_id::text)::uuid <> v_label.id loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.request_routes', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('owner_label_id', (v_map->>r.tab_id::text)::uuid)));
    v_counts := jsonb_set(v_counts, '{routes}', to_jsonb((v_counts->>'routes')::int + 1));
  end loop;
  -- Hijas propias de otras áreas: cuelgan de la copia de su área, en su familia.
  for r in select l.* from tasks.labels l where l.parent_id = v_label.id and l.deleted_at is null and l.tab_id is not null and (v_map->>l.tab_id::text)::uuid <> v_label.id loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.labels', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('parent_id', (v_map->>r.tab_id::text)::uuid, 'family_id', (v_fam_map->>r.tab_id::text)::uuid)));
    v_counts := jsonb_set(v_counts, '{children}', to_jsonb((v_counts->>'children')::int + 1));
  end loop;

  -- 4. Vistas guardadas: la General pasa a la etiqueta de su área (bajo su familia; en `_exclude`, en su sitio).
  for r in select sv.* from tasks.saved_views sv where sv.deleted_at is null and sv.filters::text like '%' || v_label.id::text || '%' and (v_map->>sv.tab_id::text)::uuid <> v_label.id loop
    v_filters := coalesce(r.filters, '{}'::jsonb); v_new := '{}'::jsonb; v_changed := false; v_to := v_map->>r.tab_id::text;
    for v_key, v_val in select * from jsonb_each(v_filters) loop
      if jsonb_typeof(v_val) <> 'array' or (left(v_key, 1) = '_' and v_key <> '_exclude') then v_new := v_new || jsonb_build_object(v_key, v_val); continue; end if;
      v_new := v_new || jsonb_build_object(v_key, coalesce(v_new->v_key, '[]'::jsonb));
      for v_id in select * from jsonb_array_elements_text(v_val) loop
        v_to_key := case when v_id = v_label.id::text and v_key <> '_exclude' then v_fam_map->>r.tab_id::text else v_key end;
        if v_id = v_label.id::text then v_id := v_to; v_changed := true; end if;
        if not coalesce(v_new->v_to_key, '[]'::jsonb) ? v_id then
          v_new := v_new || jsonb_build_object(v_to_key, coalesce(v_new->v_to_key, '[]'::jsonb) || to_jsonb(v_id));
        end if;
      end loop;
    end loop;
    if v_changed then
      -- Una familia que se ha quedado sin etiquetas en el filtro sale de él.
      v_new := (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(v_new) e(k, v) where not (jsonb_typeof(v) = 'array' and jsonb_array_length(v) = 0 and left(k, 1) <> '_'));
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.saved_views', 'id', r.id, 'expectedRevision', r.revision,
        'fields', jsonb_build_object('filters', v_new)));
      v_counts := jsonb_set(v_counts, '{views}', to_jsonb((v_counts->>'views')::int + 1));
    end if;
  end loop;

  -- 5. Si en el área elegida ya había una igual, la General queda archivada (nada vivo la usa ya).
  if not v_moved then
    select * into v_label from tasks.labels where id = v_label.id;
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.labels', 'id', v_label.id,
      'expectedRevision', v_label.revision, 'fields', jsonb_build_object('archived', true)));
  end if;

  return jsonb_build_object('labelId', v_map->>v_target::text, 'tabId', v_target, 'copies', v_copies, 'counts', v_counts);
end $$;

select core.allow_procedure('tasks', 'tasks.general_label_to_area');

revoke all on function tasks.general_label_to_area(jsonb) from public, anon, authenticated;
grant execute on function tasks.general_label_to_area(jsonb) to service_role;
