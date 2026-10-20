-- Ikisai Recursos · el mapa de zonas en los portales (MUELA-024 bloque A para Guests; la pieza ya está en el kit 0.52).
-- Los portales no son miembros de Recursos: leen los dibujos y las formas con esta función, que solo devuelve la
-- geometría y los nombres públicos de los espacios (camas incluidas, sin ocupación), nunca personas, notas ni datos internos.
-- La ocupación de cada cama la sigue dando Booking (`portal_lodging`), solo «Libre», «Ocupada» o «Tuya». El archivo de cada dibujo lo
-- firma la Edge del portal con `createStorage` (como el logotipo de Central, 0550): aquí solo se dice dónde vive.
-- Toca solo el schema resources.

create or replace function resources.portal_plans(p jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'plans', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', f.id, 'buildingId', f.building_id, 'floor', f.floor, 'position', f.position,
               'width', f.width, 'height', f.height,
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
       where s.deleted_at is null and s.active), '[]'::jsonb))
$$;

select core.allow_read('guests', 'resources.portal_plans', 'function', '{outsider,editor,owner}');

revoke all on function resources.portal_plans(jsonb) from public, anon, authenticated;
grant execute on function resources.portal_plans(jsonb) to service_role;
