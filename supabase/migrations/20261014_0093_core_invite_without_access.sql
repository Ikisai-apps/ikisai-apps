-- Ikisai Core · petición P9 de Central (O4): dar cuenta sin accesos manuales. Un outsider recibe los suyos del nivel de
-- casa al enlazar la ficha, así que `admin/invite` admite `memberships: []` y crea solo la cuenta y su perfil.
-- Para eso, `admin_set_display_name` crea el perfil (humano) si aún no existe. Lo demás, igual que en 0086.
create or replace function core.admin_set_display_name(p_actor uuid, p_user uuid, p_name text)
returns jsonb language plpgsql as $$
declare v_name text := btrim(coalesce(p_name, '')); v_kind text;
begin
  perform core.require_admin(p_actor);
  if length(v_name) < 1 or length(v_name) > 120 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'displayName must have 1–120 characters'));
  end if;
  select kind into v_kind from core.profiles where user_id = p_user;
  if v_kind is null then
    if not exists (select 1 from auth.users where id = p_user) then perform core.fail('NOT_FOUND', 404, jsonb_build_object('userId', p_user)); end if;
    insert into core.profiles (user_id, display_name) values (p_user, v_name);
  elsif v_kind = 'service' then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'service accounts keep their name'));
  else
    update core.profiles set display_name = v_name where user_id = p_user;
  end if;
  perform core.log_access('central', p_actor, null, 'member_changed', jsonb_build_object('userId', p_user, 'event', 'display_name_changed'));
  return jsonb_build_object('userId', p_user, 'displayName', v_name);
end $$;

revoke all on function core.admin_set_display_name(uuid, uuid, text) from public, anon, authenticated;
grant execute on function core.admin_set_display_name(uuid, uuid, text) to service_role;
