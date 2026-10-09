-- Ikisai Tasks · catálogo General, arreglos tras el primer uso real (FB_2026_023, 9-10-2026). Toca solo el schema tasks.
-- tasks.merge_labels_into_general (copiada de 0317) con tres cambios:
-- 1. «Hacer General»: un grupo puede tener una sola etiqueta.
-- 2. Misma familia por el nombre normalizado aunque las claves de sistema no coincidan (o alguna sea nula); la familia
--    General solo hereda la clave si todas la comparten.
-- 3. Grupos con madres distintas (VG en la raíz en unas áreas y bajo «Staff» en otra): `root: true` la deja en la raíz.
-- Y tasks.guard_family_key (de 0304) deja quitar cualquier clave de sistema (dejarla nula): es como se corrige una familia
-- con una clave equivocada («Zona: Espacio» marcada como responsables, «Persona» marcada como fases). Poner una clave que no
-- sea `person` sigue sin poderse; el hook sigue exigiendo que los responsables sean de la familia `person`.

create or replace function tasks.guard_family_key()
returns trigger language plpgsql as $g$
begin
  if old.system_key is distinct from new.system_key and new.system_key is not null
     and not (coalesce(old.system_key, 'person') = 'person' and new.system_key = 'person') then
    perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('table', 'tasks.families', 'field', 'system_key'));
  end if;
  return new;
end $g$;

-- ---------------------------------------------------------------------------
-- Procedimiento: fusionar en General etiquetas repetidas entre áreas
-- args: { "groups": [grupo, …] }, cada grupo una lista de ids o { "ids": [...], "root": true }: la misma etiqueta en una o
-- más áreas (una por área): misma familia (mismo nombre de familia, o la misma clave de sistema en todas) y mismo nombre
-- sin mayúsculas. Con una sola, «Hacer General». Una hija solo se fusiona si su madre se fusiona en el mismo lote (o ya es
-- General); con madres distintas, `root: true` la deja en la raíz. La General toma el nombre de la primera del grupo, y la
-- clave de sistema de su familia solo si todas la comparten (si no, ninguna). Devuelve { generals, counts }.
-- ---------------------------------------------------------------------------
create or replace function tasks.merge_labels_into_general(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_app text := p->>'app';
  v_actor uuid := (p->>'actor')::uuid;
  v_role text := p->>'role';
  v_req text := p->>'requestId';
  v_cur bigint := (p->>'cursor')::bigint;
  v_scopes jsonb;
  v_groups jsonb := v_args->'groups';
  v_group jsonb;
  v_ids uuid[];
  v_map jsonb := '{}'::jsonb;      -- etiqueta de área → General
  v_fam_map jsonb := '{}'::jsonb;  -- etiqueta de área → familia General
  v_first record;
  v_parent uuid;
  v_fam uuid;
  v_gen uuid;
  v_pos numeric;
  v_counts jsonb := jsonb_build_object('groups', 0, 'labels', 0, 'familiesCreated', 0, 'taskLabels', 0, 'projectLabels', 0, 'owners', 0, 'routes', 0, 'children', 0, 'views', 0);
  v_filters jsonb;
  v_new jsonb;
  v_key text;
  v_val jsonb;
  v_id text;
  v_target text;
  v_target_fam text;
  v_changed boolean;
  v_round int;
  v_root boolean;
  v_fam_key text;
  v_pending jsonb;
  v_next jsonb;
  r record;
begin
  select m.scopes into v_scopes from core.memberships m where m.app = v_app and m.user_id = v_actor;
  if v_role <> 'owner' or not tasks.scope_all(v_scopes) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'owner with full access')); end if;
  if jsonb_typeof(v_groups) <> 'array' or jsonb_array_length(v_groups) = 0 or jsonb_array_length(v_groups) > 500 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'groups: 1 to 500 lists of label ids'));
  end if;
  perform set_config('tasks.convert_mode', 'on', true);

  -- 1. Las General, por rondas: primero los grupos sin madre (o con madre ya General) y después sus hijas.
  v_pending := v_groups;
  for v_round in 1..3 loop
    exit when jsonb_array_length(v_pending) = 0;
    v_next := '[]'::jsonb;
    for v_group in select * from jsonb_array_elements(v_pending) loop
      v_root := jsonb_typeof(v_group) = 'object' and coalesce((v_group->>'root')::boolean, false);
      if jsonb_typeof(v_group) = 'object' then v_group := coalesce(v_group->'ids', '[]'::jsonb); end if;
      begin
        select array_agg(distinct x::uuid) into v_ids from jsonb_array_elements_text(v_group) x;
      exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'label ids must be uuids'));
      end;
      if coalesce(array_length(v_ids, 1), 0) < 1 then perform core.fail('INVALID_MERGE', 422, jsonb_build_object('reason', 'a group needs at least one label', 'group', v_group)); end if;
      -- Todas vivas, de áreas distintas, con el mismo nombre y la misma familia (por clave o por nombre).
      if exists (select 1 from unnest(v_ids) i left join tasks.labels l on l.id = i where l.id is null or l.deleted_at is not null or l.tab_id is null)
         or (select count(distinct l.tab_id) from tasks.labels l where l.id = any(v_ids)) <> array_length(v_ids, 1)
         or (select count(distinct lower(btrim(l.name))) from tasks.labels l where l.id = any(v_ids)) <> 1
         or not ((select count(distinct lower(btrim(f.name))) from tasks.labels l join tasks.families f on f.id = l.family_id where l.id = any(v_ids)) = 1
                 or (select count(distinct f.system_key) = 1 and bool_and(f.system_key is not null) from tasks.labels l join tasks.families f on f.id = l.family_id where l.id = any(v_ids))) then
        perform core.fail('INVALID_MERGE', 422, jsonb_build_object('reason', 'same label (family and name) in different areas', 'group', v_group));
      end if;
      -- La madre: ninguna, o la General de las madres de todas (fusionadas en este lote o ya General).
      v_parent := null;
      if not v_root and exists (select 1 from tasks.labels l where l.id = any(v_ids) and l.parent_id is not null) then
        select case when count(distinct coalesce(v_map->>l.parent_id::text, case when pa.tab_id is null then pa.id::text end)) = 1
                     and bool_and(coalesce(v_map->>l.parent_id::text, case when pa.tab_id is null then pa.id::text end) is not null)
                    then min(coalesce(v_map->>l.parent_id::text, case when pa.tab_id is null then pa.id::text end)) end::uuid
          into v_parent
          from tasks.labels l left join tasks.labels pa on pa.id = l.parent_id where l.id = any(v_ids);
        if v_parent is null then
          if v_round < 3 then v_next := v_next || jsonb_build_array(v_group); continue; end if;
          perform core.fail('INVALID_MERGE', 422, jsonb_build_object('reason', 'merge the mother label too', 'group', v_group));
        end if;
      end if;
      select l.*, f.name fam_name, f.color fam_color, f.system_key fam_key, f.tab_id fam_tab, f.id fam_id into v_first
        from tasks.labels l join tasks.families f on f.id = l.family_id where l.id = (v_group->>0)::uuid;
      -- La clave de sistema, solo si todas las familias del grupo la comparten (una «Zona» marcada como Persona en un área
      -- no convierte las zonas en responsables).
      select case when count(distinct f.system_key) = 1 and bool_and(f.system_key is not null) then min(f.system_key) end into v_fam_key
        from tasks.labels l join tasks.families f on f.id = l.family_id where l.id = any(v_ids);
      -- La familia General: la de la madre, si la hay; si no, la General con la misma clave o nombre; si no, se crea.
      v_fam := null;
      if v_parent is not null then select family_id into v_fam from tasks.labels where id = v_parent; end if;
      if v_fam is null then
        select f.id into v_fam from tasks.families f
          where f.tab_id is null and f.deleted_at is null
            and ((v_fam_key is not null and f.system_key = v_fam_key) or (v_fam_key is null and f.system_key is null and lower(btrim(f.name)) = lower(btrim(v_first.fam_name))))
          order by f.archived, f.position limit 1;
      end if;
      if v_fam is null then
        v_fam := gen_random_uuid();
        select coalesce(max(position), 0) + 1024 into v_pos from tasks.families where tab_id is null;
        perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.families', 'id', v_fam,
          'fields', jsonb_build_object('tab_id', null, 'name', v_first.fam_name, 'color', v_first.fam_color, 'position', v_pos, 'system_key', v_fam_key)));
        v_counts := jsonb_set(v_counts, '{familiesCreated}', to_jsonb((v_counts->>'familiesCreated')::int + 1));
      end if;
      v_gen := gen_random_uuid();
      select coalesce(max(position), 0) + 1024 into v_pos from tasks.labels where family_id = v_fam;
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.labels', 'id', v_gen,
        'fields', jsonb_build_object('tab_id', null, 'family_id', v_fam, 'parent_id', v_parent, 'name', btrim(v_first.name), 'position', v_pos,
                                     'archived', coalesce((select archived from tasks.families where id = v_fam), false))));
      for r in select unnest(v_ids) id loop v_map := v_map || jsonb_build_object(r.id::text, v_gen); v_fam_map := v_fam_map || jsonb_build_object(r.id::text, v_fam); end loop;
      v_counts := jsonb_set(jsonb_set(v_counts, '{groups}', to_jsonb((v_counts->>'groups')::int + 1)), '{labels}', to_jsonb((v_counts->>'labels')::int + array_length(v_ids, 1)));
    end loop;
    v_pending := v_next;
  end loop;

  -- 2. Repuntar lo vivo: etiquetas de tareas y proyectos (sin repetir), responsables y reglas.
  for r in select tl.* from tasks.task_labels tl where tl.deleted_at is null and v_map ? tl.label_id::text loop
    if exists (select 1 from tasks.task_labels x where x.task_id = r.task_id and x.label_id = (v_map->>r.label_id::text)::uuid and x.deleted_at is null) then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'delete', 'table', 'tasks.task_labels', 'id', r.id, 'expectedRevision', r.revision));
    else
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.task_labels', 'id', r.id, 'expectedRevision', r.revision,
        'fields', jsonb_build_object('label_id', (v_map->>r.label_id::text)::uuid)));
    end if;
    v_counts := jsonb_set(v_counts, '{taskLabels}', to_jsonb((v_counts->>'taskLabels')::int + 1));
  end loop;
  for r in select pl.* from tasks.project_labels pl where pl.deleted_at is null and v_map ? pl.label_id::text loop
    if exists (select 1 from tasks.project_labels x where x.project_id = r.project_id and x.label_id = (v_map->>r.label_id::text)::uuid and x.deleted_at is null) then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'delete', 'table', 'tasks.project_labels', 'id', r.id, 'expectedRevision', r.revision));
    else
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.project_labels', 'id', r.id, 'expectedRevision', r.revision,
        'fields', jsonb_build_object('label_id', (v_map->>r.label_id::text)::uuid)));
    end if;
    v_counts := jsonb_set(v_counts, '{projectLabels}', to_jsonb((v_counts->>'projectLabels')::int + 1));
  end loop;
  for r in select t.* from tasks.tasks t where t.deleted_at is null and t.owner_label_id is not null and v_map ? t.owner_label_id::text loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.tasks', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('owner_label_id', (v_map->>r.owner_label_id::text)::uuid)));
    v_counts := jsonb_set(v_counts, '{owners}', to_jsonb((v_counts->>'owners')::int + 1));
  end loop;
  for r in select pr.* from tasks.projects pr where pr.deleted_at is null and pr.owner_label_id is not null and v_map ? pr.owner_label_id::text loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.projects', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('owner_label_id', (v_map->>r.owner_label_id::text)::uuid)));
    v_counts := jsonb_set(v_counts, '{owners}', to_jsonb((v_counts->>'owners')::int + 1));
  end loop;
  for r in select rr.* from tasks.request_routes rr where rr.deleted_at is null and rr.owner_label_id is not null and v_map ? rr.owner_label_id::text loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.request_routes', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('owner_label_id', (v_map->>r.owner_label_id::text)::uuid)));
    v_counts := jsonb_set(v_counts, '{routes}', to_jsonb((v_counts->>'routes')::int + 1));
  end loop;

  -- 3. Hijas de una madre fusionada que se quedan en su área: cuelgan de la madre General, en su familia.
  for r in select l.* from tasks.labels l where l.deleted_at is null and l.parent_id is not null and v_map ? l.parent_id::text and not (v_map ? l.id::text) loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.labels', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('parent_id', (v_map->>r.parent_id::text)::uuid, 'family_id', (v_fam_map->>r.parent_id::text)::uuid)));
    v_counts := jsonb_set(v_counts, '{children}', to_jsonb((v_counts->>'children')::int + 1));
  end loop;

  -- 4. Vistas guardadas: las etiquetas fusionadas pasan a la General, bajo su familia General.
  for r in select v.* from tasks.saved_views v where v.deleted_at is null loop
    v_filters := coalesce(r.filters, '{}'::jsonb); v_new := '{}'::jsonb; v_changed := false;
    for v_key, v_val in select * from jsonb_each(v_filters) loop
      if left(v_key, 1) = '_' or jsonb_typeof(v_val) <> 'array' then v_new := v_new || jsonb_build_object(v_key, v_val); continue; end if;
      for v_id in select * from jsonb_array_elements_text(v_val) loop
        v_target := coalesce(v_map->>v_id, v_id);
        v_target_fam := case when v_map ? v_id then v_fam_map->>v_id else v_key end;
        if v_map ? v_id then v_changed := true; end if;
        if not coalesce(v_new->v_target_fam, '[]'::jsonb) ? v_target then
          v_new := v_new || jsonb_build_object(v_target_fam, coalesce(v_new->v_target_fam, '[]'::jsonb) || to_jsonb(v_target));
        end if;
      end loop;
    end loop;
    if v_changed then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.saved_views', 'id', r.id, 'expectedRevision', r.revision,
        'fields', jsonb_build_object('filters', v_new)));
      v_counts := jsonb_set(v_counts, '{views}', to_jsonb((v_counts->>'views')::int + 1));
    end if;
  end loop;

  -- 5. Las copias de cada área, archivadas (siguen en el historial; nada vivo las usa ya).
  for r in select l.* from tasks.labels l where v_map ? l.id::text and not l.archived loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.labels', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('archived', true)));
  end loop;

  return jsonb_build_object('generals', v_map, 'counts', v_counts);
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
