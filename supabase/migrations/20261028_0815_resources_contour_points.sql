-- Ikisai Recursos · la curva de nivel de cada altura, ajustable a mano (VG, por Core, 28-10-2026). Toca solo el schema resources.
-- `floor_plans.contours` (0814) admite además `points: [[x, y], …]` por altura (relativos 0..1, de 2 a 200 puntos): la
-- curva ajustada en «Colocar» de Central. El ancla `x`/`y` de la etiqueta se mantiene. Sin `points`, la curva la trae el
-- dibujo (`<path data-contour="Altura N">`).

-- Curvas: de 1 a 20, cada una {spaceId (uuid), x, y, points?} con x, y y cada punto en 0..1.
create or replace function resources.valid_plan_contours(p jsonb)
returns boolean language sql immutable as $$
  select p is null or (
    jsonb_typeof(p) = 'array' and jsonb_array_length(p) between 1 and 20
    and not exists (
      select 1 from jsonb_array_elements(p) c
       where jsonb_typeof(c) <> 'object' or jsonb_typeof(c->'spaceId') <> 'string'
          or (c->>'spaceId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          or jsonb_typeof(c->'x') <> 'number' or jsonb_typeof(c->'y') <> 'number'
          or (c->>'x')::numeric not between 0 and 1 or (c->>'y')::numeric not between 0 and 1
          or (c->'points' is not null and not (
                jsonb_typeof(c->'points') = 'array' and jsonb_array_length(c->'points') between 2 and 200
                and not exists (
                  select 1 from jsonb_array_elements(c->'points') pt
                   where jsonb_typeof(pt) <> 'array' or jsonb_array_length(pt) <> 2
                      or jsonb_typeof(pt->0) <> 'number' or jsonb_typeof(pt->1) <> 'number'
                      or (pt->>0)::numeric not between 0 and 1 or (pt->>1)::numeric not between 0 and 1)))))
$$;

-- La de 0814 con los puntos de cada curva en `contours`, solo si los tiene (sin ellos, la forma de 0814).
create or replace function resources.plans_base()
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'plans', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', f.id, 'buildingId', f.building_id, 'floor', f.floor, 'position', f.position, 'kind', f.kind,
               'width', f.width, 'height', f.height, 'grid', f.grid, 'bands', f.bands,
               'contours', (select jsonb_agg(jsonb_build_object('spaceId', s.id, 'label', coalesce(s.public_name, s.name),
                                    'elevationM', s.attributes->'elevation_m', 'x', c->'x', 'y', c->'y')
                                    || case when c ? 'points' then jsonb_build_object('points', c->'points') else '{}'::jsonb end)
                              from jsonb_array_elements(f.contours) c join resources.spaces s on s.id = (c->>'spaceId')::uuid and s.deleted_at is null),
               'file', case when cf.id is null then null else jsonb_build_object(
                 'id', cf.id, 'bucket', cf.bucket, 'path', cf.path, 'mime', cf.mime, 'sha256', cf.sha256, 'provider', cf.storage_provider) end)
             order by f.position, f.floor)
        from resources.floor_plans f
        left join core.files cf on cf.id = f.file_id and cf.app = 'resources' and cf.status = 'verified' and cf.mime like 'image/%'
       where f.deleted_at is null), '[]'::jsonb),
    'spaces', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'parentId', s.parent_id, 'kind', s.kind, 'name', coalesce(s.public_name, s.name),
               'planId', s.plan_id, 'planShape', s.plan_shape, 'position', s.position)
             order by s.position, s.name)
        from resources.spaces s
       where s.deleted_at is null and s.active), '[]'::jsonb),
    'icons', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'name', i.name, 'category', i.category, 'defaultSize', i.default_size,
               'file', jsonb_build_object('id', cf.id, 'bucket', cf.bucket, 'path', cf.path, 'mime', cf.mime, 'sha256', cf.sha256, 'provider', cf.storage_provider))
             order by i.category, i.name)
        from resources.decor_icons i
        join core.files cf on cf.id = i.file_id and cf.app = 'resources' and cf.status = 'verified'
       where i.deleted_at is null), '[]'::jsonb),
    'images', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'spaceId', m.space_id, 'kind', m.kind, 'title', m.title, 'position', m.position,
               'file', jsonb_build_object('id', cf.id, 'bucket', cf.bucket, 'path', cf.path, 'mime', cf.mime, 'sha256', cf.sha256, 'provider', cf.storage_provider))
             order by m.space_id, m.position)
        from resources.space_images m
        join core.files cf on cf.id = m.file_id and cf.app = 'resources' and cf.status = 'verified'
       where m.deleted_at is null), '[]'::jsonb))
$$;

revoke all on function resources.valid_plan_contours(jsonb), resources.plans_base() from public, anon, authenticated;
grant execute on function resources.valid_plan_contours(jsonb), resources.plans_base() to service_role;
