-- C8 (portales): archivos de otra app publicados a un portal. La app dueña registra un resolutor
-- (`core.allow_portal_file('guests', 'organizers.guest_material_file')`), `fn(p_ctx jsonb {actor, portal, file_id, scopes})
-- returns boolean`, y la Edge del portal sirve `GET /api/v1/portal-files/:fileId` con una URL firmada corta si alguno dice
-- que sí. El resolutor decide con el ámbito del miembro (core.portal_in_scope) y el estado de su fila (publicado, ventana).
create table core.portal_file_resolvers (
  portal text not null references core.apps(id),
  procedure text not null check (procedure ~ '^[a-z]+\.[a-z_]+$'),
  primary key (portal, procedure)
);
alter table core.portal_file_resolvers enable row level security;
revoke all on core.portal_file_resolvers from public, anon, authenticated;
grant all on core.portal_file_resolvers to service_role;

create or replace function core.allow_portal_file(p_portal text, p_procedure text)
returns void language sql as $$
  insert into core.portal_file_resolvers (portal, procedure) values (p_portal, p_procedure) on conflict do nothing;
$$;

create or replace function core.portal_file_get(p_portal text, p_actor uuid, p_file uuid)
returns jsonb language plpgsql stable as $$
declare v_scopes jsonb; v_file core.files; v_proc text; v_ok boolean;
begin
  select scopes into v_scopes from core.memberships where app = p_portal and user_id = p_actor;
  if not found then perform core.fail('NO_MEMBERSHIP', 403); end if;
  select * into v_file from core.files where id = p_file and status = 'verified';
  if v_file.id is not null then
    for v_proc in select procedure from core.portal_file_resolvers where portal = p_portal loop
      execute format('select %s($1)', v_proc) into v_ok
        using jsonb_build_object('actor', p_actor, 'portal', p_portal, 'file_id', p_file, 'scopes', coalesce(v_scopes, '{}'::jsonb));
      if v_ok then return to_jsonb(v_file); end if;
    end loop;
  end if;
  -- inexistente, sin verificar y no publicado responden igual: el portal no averigua qué archivos existen
  perform core.fail('FILE_NOT_FOUND', 404, jsonb_build_object('id', p_file));
end $$;

create or replace function public.core_portal_file_get(p_portal text, p_actor uuid, p_file uuid) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.portal_file_get(p_portal, p_actor, p_file) $$;

revoke all on function core.allow_portal_file(text, text) from public, anon, authenticated;
revoke all on function core.portal_file_get(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.core_portal_file_get(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.core_portal_file_get(text, uuid, uuid) to service_role;
