-- Ikisai core · C24 (Tasks, O1 «Abrir a…», aprobado por el usuario el 18-10-2026): la propietaria de una app cambia los ámbitos
-- (`scopes`) de una pertenencia que ya es `outsider`, con la API normal (`POST members`, `core.set_membership`).
-- - El rol `outsider` no se da ni se quita aquí: lo da y lo quita el nivel de casa (`core.apply_house_level`).
-- - Para un outsider, los ámbitos tienen que ser un objeto: nunca nulo ni «*» (para él, vacío = nada).
-- - Lo demás no cambia.
create or replace function core.set_membership(p_app text, p_actor uuid, p_user uuid, p_role text, p_scopes jsonb, p_display_name text)
returns jsonb language plpgsql as $$
declare v_role text; v_current text;
begin
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is distinct from 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only owners manage memberships')); end if;
  if p_role = 'outsider' then
    select role into v_current from core.memberships where app = p_app and user_id = p_user;
    if v_current is distinct from 'outsider' then
      perform core.fail('INVALID_ROLE', 422, jsonb_build_object('reason', 'the outsider role comes from the house level'));
    end if;
    if p_scopes is null or jsonb_typeof(p_scopes) <> 'object' then
      perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('argument', 'scopes', 'reason', 'an outsider needs explicit scopes'));
    end if;
    update core.memberships set scopes = p_scopes, updated_at = now(), revision = revision + 1 where app = p_app and user_id = p_user;
    perform core.log_access(p_app, p_actor, null, 'member_changed', jsonb_build_object('userId', p_user, 'role', p_role, 'scopes', true));
    return (select to_jsonb(m) from core.memberships m where app = p_app and user_id = p_user);
  end if;
  if p_role not in ('reader','editor','owner') then perform core.fail('INVALID_ROLE', 422); end if;
  if p_actor = p_user and p_role <> 'owner' then perform core.fail('CURRENT_ACCOUNT', 422, jsonb_build_object('reason', 'an owner cannot demote themselves')); end if;
  if p_role = 'owner' and (select kind from core.profiles where user_id = p_user) = 'agent' then perform core.fail('INVALID_ROLE', 422, jsonb_build_object('reason', 'an agent cannot be owner')); end if;
  insert into core.profiles (user_id, display_name) values (p_user, coalesce(p_display_name, ''))
  on conflict (user_id) do update set display_name = coalesce(p_display_name, core.profiles.display_name), updated_at = now(), revision = core.profiles.revision + 1;
  insert into core.memberships (app, user_id, role, scopes) values (p_app, p_user, p_role, p_scopes)
  on conflict (app, user_id) do update set role = excluded.role, scopes = excluded.scopes, updated_at = now(), revision = core.memberships.revision + 1;
  perform core.log_access(p_app, p_actor, null, 'member_changed', jsonb_build_object('userId', p_user, 'role', p_role));
  return (select to_jsonb(m) from core.memberships m where app = p_app and user_id = p_user);
end $$;
