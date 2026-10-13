-- Ikisai Tasks · R2, arreglo de la vista previa tras pasarla con los datos reales (13-10-2026). Toca solo el schema tasks.
-- Una zona sin espacio que solo se usa junto con una hija («Exteriores» con «Porche») no salía en ningún sitio: los usos se
-- contaban solo por la zona más honda. Ahora:
-- - tasks.zone_uses: todos los usos de cada zona y si la tarea o el proyecto conserva algún espacio sin ella.
-- - tasks.zones_preview (copiada de 0322): una zona sin espacio que no deja a nadie sin espacio sale en `removed`
--   (`reason: 'covered'`); si deja a alguien, en `doubtful`. Cada una con `withoutSpace`, y el total en `counts`.
-- - tasks.zones_to_spaces (copiada de 0322): solo se niega por una zona que deje a alguien sin espacio.

create or replace function tasks.zone_uses(p_remove jsonb)
returns table (label_id uuid, kind text, owner_id uuid, covered boolean) language sql stable as $$
  with m as (select * from tasks.zone_label_map()),
  links as (
    select 'task'::text kind, tl.task_id owner_id, tl.label_id
      from tasks.task_labels tl join m on m.label_id = tl.label_id
      join tasks.tasks t on t.id = tl.task_id and t.deleted_at is null
      join tasks.tabs tb on tb.id = tl.tab_id and tb.deleted_at is null
     where tl.deleted_at is null
    union
    select 'project', pl.project_id, pl.label_id
      from tasks.project_labels pl join m on m.label_id = pl.label_id
      join tasks.projects pr on pr.id = pl.project_id and pr.deleted_at is null
      join tasks.tabs tb on tb.id = pl.tab_id and tb.deleted_at is null
     where pl.deleted_at is null)
  select a.label_id, a.kind, a.owner_id,
         exists (select 1 from links b join m on m.label_id = b.label_id
                  where b.kind = a.kind and b.owner_id = a.owner_id and m.space_id is not null
                    and b.label_id::text not in (select jsonb_array_elements_text(coalesce(p_remove, '[]'::jsonb))))
    from links a
$$;

create or replace function tasks.zones_preview(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_scopes jsonb;
  v_role text;
  v_remove jsonb := coalesce(p->'args'->'remove', '[]'::jsonb);
  v_fam uuid := tasks.zone_family();
  v_out jsonb;
begin
  select m.scopes, m.role into v_scopes, v_role from core.memberships m where m.app = p->>'app' and m.user_id = (p->>'actor')::uuid;
  if v_role is distinct from 'owner' or not tasks.scope_all(v_scopes) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'owner with full access')); end if;
  if jsonb_typeof(v_remove) <> 'array' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'remove: list of label ids')); end if;

  if tasks.zone_source() = 'spaces' then
    select jsonb_build_object(
      'source', 'spaces', 'familyId', v_fam,
      'counts', jsonb_build_object(
        'tasks', (select count(distinct ts.task_id) from tasks.task_spaces ts where ts.deleted_at is null),
        'projects', (select count(distinct ps.project_id) from tasks.project_spaces ps where ps.deleted_at is null)),
      -- Espacios puestos que no vienen de ninguna etiqueta de zona: al volver atrás se perderían.
      'lost', coalesce((select jsonb_agg(jsonb_build_object('spaceId', x.space_id, 'name', s.name, 'tasks', x.tasks, 'projects', x.projects) order by s.name)
                          from (select u.space_id, count(*) filter (where u.kind = 'task') tasks, count(*) filter (where u.kind = 'project') projects
                                  from (select 'task' kind, ts.space_id from tasks.task_spaces ts where ts.deleted_at is null
                                        union all select 'project', ps.space_id from tasks.project_spaces ps where ps.deleted_at is null) u
                                 where tasks.space_zone_label(u.space_id) is null group by u.space_id) x
                          left join resources.spaces s on s.id = x.space_id), '[]'::jsonb))
      into v_out;
    return v_out;
  end if;

  with m as (select * from tasks.zone_label_map()),
  k as (select * from tasks.zone_links()),
  u as (select * from tasks.zone_uses(v_remove)),
  per0 as (
    select m.label_id, m.name, m.parent_id, m.space_id, m.reason,
           (m.label_id::text in (select jsonb_array_elements_text(v_remove))) marked,
           -- Con espacio: las tareas y proyectos que lo recibirán (donde es la zona más honda). Sin él: todos sus usos.
           case when m.space_id is not null then (select count(*) from k where k.label_id = m.label_id and k.kind = 'task')
                else (select count(*) from u where u.label_id = m.label_id and u.kind = 'task') end tasks,
           case when m.space_id is not null then (select count(*) from k where k.label_id = m.label_id and k.kind = 'project')
                else (select count(*) from u where u.label_id = m.label_id and u.kind = 'project') end projects,
           (select count(*) from u where u.label_id = m.label_id and not u.covered) without_space,
           (select jsonb_agg(t.title order by t.title) from (select t.title from u u2 join tasks.tasks t on t.id = u2.owner_id
                                                               where u2.kind = 'task' and u2.label_id = m.label_id order by t.title limit 3) t) sample
      from m),
  per as (
    select per0.*, per0.marked or (per0.space_id is null and per0.tasks + per0.projects > 0 and per0.without_space = 0) removed
      from per0)
  select jsonb_build_object(
    'source', 'labels', 'familyId', v_fam,
    'counts', jsonb_build_object(
      'tasks', (select count(distinct k.owner_id) from k where k.kind = 'task' and k.label_id in (select per.label_id from per where per.space_id is not null and not per.removed)),
      'projects', (select count(distinct k.owner_id) from k where k.kind = 'project' and k.label_id in (select per.label_id from per where per.space_id is not null and not per.removed)),
      -- Tareas y proyectos que se quedarían sin ningún espacio (sus zonas no tienen espacio o se quitan).
      'withoutSpace', (select count(distinct u.kind || u.owner_id::text) from u where not u.covered),
      'views', (select count(*) from tasks.saved_views v where v.deleted_at is null and v_fam is not null
                 and (v.filters ? v_fam::text or v.group_by = v_fam::text
                      or exists (select 1 from jsonb_array_elements_text(coalesce(v.filters->'_exclude', '[]'::jsonb)) e where e in (select per.label_id::text from per))))),
    'mapped', coalesce((select jsonb_agg(jsonb_build_object('labelId', per.label_id, 'name', per.name, 'parentId', per.parent_id, 'spaceId', per.space_id,
                                                            'spaceName', s.name, 'tasks', per.tasks, 'projects', per.projects, 'sample', coalesce(per.sample, '[]'::jsonb)) order by per.name)
                          from per join resources.spaces s on s.id = per.space_id where not per.removed), '[]'::jsonb),
    -- Quitadas: las marcadas y las «cubiertas» (sin espacio, pero cada tarea y proyecto que las usa tiene otra zona con
    -- espacio: «Exteriores» con «Porche»). `withoutSpace`: cuántos se quedan sin ningún espacio.
    'removed', coalesce((select jsonb_agg(jsonb_build_object('labelId', per.label_id, 'name', per.name, 'reason', case when per.marked then 'marked' else 'covered' end,
                                                             'tasks', per.tasks, 'projects', per.projects, 'withoutSpace', per.without_space, 'sample', coalesce(per.sample, '[]'::jsonb)) order by per.name)
                           from per where per.removed), '[]'::jsonb),
    -- Dudosas: en uso y sin un único espacio activo. Hasta que se resuelvan (o se marquen para quitar), no se aplica.
    'doubtful', coalesce((select jsonb_agg(jsonb_build_object('labelId', per.label_id, 'name', per.name, 'reason', per.reason, 'tasks', per.tasks, 'projects', per.projects,
                                                              'withoutSpace', per.without_space, 'sample', coalesce(per.sample, '[]'::jsonb)) order by per.name)
                            from per where per.space_id is null and not per.removed), '[]'::jsonb))
    into v_out;
  return v_out;
end $$;

create or replace function tasks.zones_to_spaces(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_app text := p->>'app';
  v_actor uuid := (p->>'actor')::uuid;
  v_role text := p->>'role';
  v_req text := p->>'requestId';
  v_cur bigint := (p->>'cursor')::bigint;
  v_scopes jsonb;
  v_remove jsonb := coalesce(v_args->'remove', '[]'::jsonb);
  v_fam uuid := tasks.zone_family();
  v_bad jsonb;
  v_filters jsonb;
  v_spaces jsonb;
  v_exclude jsonb;
  v_group text;
  v_counts jsonb := jsonb_build_object('taskSpaces', 0, 'projectSpaces', 0, 'views', 0, 'labels', 0);
  r record;
begin
  select m.scopes into v_scopes from core.memberships m where m.app = v_app and m.user_id = v_actor;
  if v_role <> 'owner' or not tasks.scope_all(v_scopes) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'owner with full access')); end if;
  if jsonb_typeof(v_remove) <> 'array' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'remove: list of label ids')); end if;
  if tasks.zone_source() = 'spaces' then perform core.fail('INVALID_OPERATION', 409, jsonb_build_object('reason', 'zones are already spaces')); end if;

  create temp table if not exists tasks_zone_map on commit drop as select * from tasks.zone_label_map() limit 0;
  truncate tasks_zone_map;
  insert into tasks_zone_map select * from tasks.zone_label_map();
  create temp table if not exists tasks_zone_links on commit drop as select * from tasks.zone_links() limit 0;
  truncate tasks_zone_links;
  insert into tasks_zone_links select * from tasks.zone_links();

  select jsonb_agg(jsonb_build_object('labelId', m.label_id, 'name', m.name, 'reason', m.reason)) into v_bad
    from tasks_zone_map m
   where m.space_id is null and m.label_id::text not in (select jsonb_array_elements_text(v_remove))
     and exists (select 1 from tasks.zone_uses(v_remove) u where u.label_id = m.label_id and not u.covered);
  if v_bad is not null then perform core.fail('ZONES_DOUBTFUL', 422, jsonb_build_object('labels', v_bad)); end if;

  perform set_config('tasks.convert_mode', 'on', true);

  -- 1. Un espacio por zona más honda de cada tarea y proyecto (sin repetir los que ya tenga).
  for r in select distinct k.kind, k.owner_id, k.tab_id, k.project_id, m.space_id
             from tasks_zone_links k join tasks_zone_map m on m.label_id = k.label_id
            where m.space_id is not null and m.label_id::text not in (select jsonb_array_elements_text(v_remove)) loop
    if r.kind = 'task' then
      continue when exists (select 1 from tasks.task_spaces ts where ts.task_id = r.owner_id and ts.space_id = r.space_id and ts.deleted_at is null);
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.task_spaces', 'id', gen_random_uuid(),
        'fields', jsonb_build_object('tab_id', r.tab_id, 'project_id', r.project_id, 'task_id', r.owner_id, 'space_id', r.space_id)));
      v_counts := jsonb_set(v_counts, '{taskSpaces}', to_jsonb((v_counts->>'taskSpaces')::int + 1));
    else
      continue when exists (select 1 from tasks.project_spaces ps where ps.project_id = r.owner_id and ps.space_id = r.space_id and ps.deleted_at is null);
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.project_spaces', 'id', gen_random_uuid(),
        'fields', jsonb_build_object('tab_id', r.tab_id, 'project_id', r.project_id, 'space_id', r.space_id)));
      v_counts := jsonb_set(v_counts, '{projectSpaces}', to_jsonb((v_counts->>'projectSpaces')::int + 1));
    end if;
  end loop;

  -- 2. Vistas guardadas: el filtro y el «sin» por zona pasan a `_space`; agrupar por la familia, a agrupar por espacio.
  if v_fam is not null then
    for r in select v.* from tasks.saved_views v
              where v.deleted_at is null and exists (select 1 from tasks.tabs tb where tb.id = v.tab_id and tb.deleted_at is null)
                and (v.filters ? v_fam::text or v.group_by = v_fam::text
                     or exists (select 1 from jsonb_array_elements_text(coalesce(v.filters->'_exclude', '[]'::jsonb)) e where e in (select m.label_id::text from tasks_zone_map m))) loop
      -- Los valores que ya eran espacios se conservan; las zonas sin espacio se caen.
      select coalesce(jsonb_agg(distinct coalesce(m.space_id::text, e)) filter (where m.label_id is null or m.space_id is not null), '[]'::jsonb) into v_spaces
        from jsonb_array_elements_text(coalesce(r.filters->v_fam::text, '[]'::jsonb) || coalesce(r.filters->'_space', '[]'::jsonb)) e
        left join tasks_zone_map m on m.label_id::text = e;
      select coalesce(jsonb_agg(distinct coalesce(m.space_id::text, e)) filter (where m.label_id is null or m.space_id is not null), '[]'::jsonb) into v_exclude
        from jsonb_array_elements_text(coalesce(r.filters->'_exclude', '[]'::jsonb)) e
        left join tasks_zone_map m on m.label_id::text = e;
      v_filters := r.filters - v_fam::text - '_space' - '_exclude';
      if jsonb_array_length(v_spaces) > 0 then v_filters := v_filters || jsonb_build_object('_space', v_spaces); end if;
      if jsonb_array_length(v_exclude) > 0 then v_filters := v_filters || jsonb_build_object('_exclude', v_exclude); end if;
      v_group := case when r.group_by = v_fam::text then '_space' else r.group_by end;
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.saved_views', 'id', r.id, 'expectedRevision', r.revision,
        'fields', jsonb_build_object('filters', v_filters, 'group_by', v_group)));
      v_counts := jsonb_set(v_counts, '{views}', to_jsonb((v_counts->>'views')::int + 1));
    end loop;

    -- 3. La familia General de zona y sus etiquetas se archivan (nunca se borran); cada etiqueta recuerda si ya lo estaba.
    for r in select l.* from tasks.labels l where l.family_id = v_fam and l.deleted_at is null loop
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.labels', 'id', r.id, 'expectedRevision', r.revision,
        'fields', jsonb_build_object('archived', true, 'archived_before_family', r.archived)));
      v_counts := jsonb_set(v_counts, '{labels}', to_jsonb((v_counts->>'labels')::int + 1));
    end loop;
    select * into r from tasks.families where id = v_fam;
    if not r.archived then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.families', 'id', v_fam, 'expectedRevision', r.revision,
        'fields', jsonb_build_object('archived', true)));
    end if;
  end if;

  -- 4. Desde ahora la zona sale de los espacios.
  perform tasks.set_zone_source(v_app, v_actor, v_role, v_req, v_cur, 'spaces');
  return jsonb_build_object('source', 'spaces', 'counts', v_counts);
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
