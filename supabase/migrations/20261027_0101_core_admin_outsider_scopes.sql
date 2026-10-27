-- Ikisai Core · Central cambia los ámbitos de un outsider (P14 de Central, #763; cierra lo que #757 dejó a medias).
-- Como core.set_membership (C24, migración 0097 del 19-10): el rol `outsider` no se da ni se quita desde Central (lo da el
-- nivel de casa); si la pertenencia ya es outsider, la administración puede cambiarle los ámbitos, que tienen que ser un
-- objeto. Lo demás de core.admin_set_membership no cambia.
create or replace function core.admin_set_membership(p_actor uuid, p_app text, p_user uuid, p_role text, p_scopes jsonb, p_display_name text)
returns jsonb language plpgsql as $$
declare v_kind text; v_owners int; v_current text;
begin
  perform core.require_admin(p_actor);
  if not exists (select 1 from core.apps where id = p_app) then perform core.fail('APP_NOT_FOUND', 404, jsonb_build_object('app', p_app)); end if;
  select kind into v_kind from core.profiles where user_id = p_user;
  if p_role is null then
    -- Quitar: nunca dejar una app sin propietario humano, ni quitarse a uno mismo la administración.
    if p_app = 'central' and p_user = p_actor then perform core.fail('CURRENT_ACCOUNT', 422, jsonb_build_object('reason', 'an administrator cannot remove themselves')); end if;
    select count(*) into v_owners from core.memberships m left join core.profiles p on p.user_id = m.user_id
      where m.app = p_app and m.role = 'owner' and m.user_id <> p_user and coalesce(p.kind, 'human') = 'human';
    if v_owners = 0 and exists (select 1 from core.memberships where app = p_app and user_id = p_user and role = 'owner') then
      perform core.fail('LAST_OWNER', 422, jsonb_build_object('app', p_app));
    end if;
    delete from core.memberships where app = p_app and user_id = p_user;
    update core.proposals set status = 'revoked', reason = 'membership removed' where app = p_app and user_id = p_user and status in ('pending', 'approved');
    perform core.log_access(p_app, p_actor, null, 'member_changed', jsonb_build_object('userId', p_user, 'removed', true, 'by', 'central'));
    return jsonb_build_object('app', p_app, 'userId', p_user, 'removed', true);
  end if;
  if p_role = 'outsider' then
    select role into v_current from core.memberships where app = p_app and user_id = p_user;
    if v_current is distinct from 'outsider' then
      perform core.fail('INVALID_ROLE', 422, jsonb_build_object('reason', 'the outsider role comes from the house level'));
    end if;
    if p_scopes is null or jsonb_typeof(p_scopes) <> 'object' then
      perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('argument', 'scopes', 'reason', 'an outsider needs explicit scopes'));
    end if;
    update core.memberships set scopes = p_scopes, updated_at = now(), revision = revision + 1 where app = p_app and user_id = p_user;
    perform core.log_access(p_app, p_actor, null, 'member_changed', jsonb_build_object('userId', p_user, 'role', p_role, 'scopes', true, 'by', 'central'));
    return (select to_jsonb(m) from core.memberships m where app = p_app and user_id = p_user);
  end if;
  if p_role not in ('reader', 'editor', 'owner') then perform core.fail('INVALID_ROLE', 422); end if;
  if p_role = 'owner' and v_kind = 'agent' then perform core.fail('INVALID_ROLE', 422, jsonb_build_object('reason', 'an agent cannot be owner')); end if;
  if p_app = 'central' and v_kind = 'agent' then perform core.fail('INVALID_ROLE', 422, jsonb_build_object('reason', 'agents have no access to central')); end if;
  if p_user = p_actor and p_app = 'central' and p_role <> 'owner' then perform core.fail('CURRENT_ACCOUNT', 422, jsonb_build_object('reason', 'an administrator cannot demote themselves')); end if;
  if p_role <> 'owner' and exists (select 1 from core.memberships where app = p_app and user_id = p_user and role = 'owner')
     and not exists (select 1 from core.memberships m left join core.profiles p on p.user_id = m.user_id
                     where m.app = p_app and m.role = 'owner' and m.user_id <> p_user and coalesce(p.kind, 'human') = 'human') then
    perform core.fail('LAST_OWNER', 422, jsonb_build_object('app', p_app));
  end if;
  insert into core.profiles (user_id, display_name) values (p_user, coalesce(p_display_name, ''))
  on conflict (user_id) do update set display_name = coalesce(p_display_name, core.profiles.display_name), updated_at = now(), revision = core.profiles.revision + 1;
  insert into core.memberships (app, user_id, role, scopes) values (p_app, p_user, p_role, p_scopes)
  on conflict (app, user_id) do update set role = excluded.role, scopes = excluded.scopes, updated_at = now(), revision = core.memberships.revision + 1;
  perform core.log_access(p_app, p_actor, null, 'member_changed', jsonb_build_object('userId', p_user, 'role', p_role, 'by', 'central'));
  return (select to_jsonb(m) from core.memberships m where app = p_app and user_id = p_user);
end $$;
