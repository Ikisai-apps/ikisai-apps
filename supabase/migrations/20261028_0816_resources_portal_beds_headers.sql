-- Ikisai Recursos · tipo de cama en la lectura de los portales y silueta de cabecera por app (27-10-2026). Toca solo el
-- schema resources.
-- 1. `plans_base` (0815) da `bedKind` en cada cama que lo tiene (`attributes.bed_kind`): el mapa del kit pinta el icono de
--    la cama («Ver en el plano» de Guests). Ningún otro atributo sale.
-- 2. `space_images.header_for`: apps de las que esa silueta es la cabecera (`central`, `guests`, `organizers`; encargo de
--    Core a Central). Solo en `kind = 'silueta'`, sin repetidas y como mucho una imagen viva por app: para cambiarla, el
--    mismo lote la quita de la anterior (`HEADER_TAKEN` si no). Escribe el owner, como el resto de la imagen. Las
--    lecturas dan `headerFor` en cada imagen.

alter table resources.space_images add column header_for text[] not null default '{}';
alter table resources.space_images add constraint space_images_header_for_check check (
  header_for <@ array['central', 'guests', 'organizers']::text[] and (cardinality(header_for) = 0 or kind = 'silueta'));
select core.register_table('resources', 'resources', 'space_images', array['space_id', 'kind', 'title', 'file_id', 'position', 'header_for'], '{reader,editor,owner}', '{owner}');

-- Una cabecera por app entre las imágenes vivas (al final del lote, para poder pasarla de una a otra en el mismo).
create or replace function resources.check_image_headers(p jsonb)
returns void language plpgsql as $$
declare v_app text;
begin
  if not exists (select 1 from core.changes c where c.app = 'resources' and c.cursor = (p->>'cursor')::bigint
                  and c.schema_name = 'resources' and c.table_name = 'space_images') then
    return;
  end if;
  -- También la misma app dos veces en una imagen.
  select x into v_app from resources.space_images m, unnest(m.header_for) x
   where m.deleted_at is null group by x having count(*) > 1 limit 1;
  if v_app is not null then
    perform core.fail('HEADER_TAKEN', 409, jsonb_build_object('table', 'resources.space_images', 'field', 'header_for', 'app', v_app));
  end if;
end $$;
select core.add_validate_hook('resources', 'resources.check_image_headers');

-- La de 0815 con `bedKind` en las camas y `headerFor` en las imágenes.
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
               || case when s.kind = 'cama' and s.attributes ? 'bed_kind' then jsonb_build_object('bedKind', s.attributes->'bed_kind') else '{}'::jsonb end
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
               'id', m.id, 'spaceId', m.space_id, 'kind', m.kind, 'title', m.title, 'position', m.position, 'headerFor', to_jsonb(m.header_for),
               'file', jsonb_build_object('id', cf.id, 'bucket', cf.bucket, 'path', cf.path, 'mime', cf.mime, 'sha256', cf.sha256, 'provider', cf.storage_provider))
             order by m.space_id, m.position)
        from resources.space_images m
        join core.files cf on cf.id = m.file_id and cf.app = 'resources' and cf.status = 'verified'
       where m.deleted_at is null), '[]'::jsonb))
$$;

revoke all on function resources.check_image_headers(jsonb), resources.plans_base() from public, anon, authenticated;
grant execute on function resources.check_image_headers(jsonb), resources.plans_base() to service_role;
