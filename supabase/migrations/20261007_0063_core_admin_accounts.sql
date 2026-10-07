-- Ikisai Core · administración común (§3.5): estado de las cuentas y operaciones de Auth autorizadas por el núcleo
-- (peticiones P2 y P4 de Central).

create or replace function core.admin_accounts(p_actor uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform core.require_admin(p_actor);
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'userId', u.id, 'email', u.email, 'displayName', coalesce(p.display_name, ''), 'kind', coalesce(p.kind, 'human'),
      'createdAt', u.created_at, 'lastSignInAt', u.last_sign_in_at,
      'disabled', u.banned_until is not null and u.banned_until > now(), 'bannedUntil', u.banned_until,
      'memberships', coalesce((select jsonb_agg(jsonb_build_object('app', m.app, 'role', m.role, 'scopes', m.scopes, 'revision', m.revision, 'updatedAt', m.updated_at) order by a.sort, m.app)
                               from core.memberships m join core.apps a on a.id = m.app where m.user_id = u.id), '[]'::jsonb),
      'agentKeys', (select count(*) from core.agent_keys k where k.user_id = u.id and k.revoked_at is null))
    order by coalesce(p.kind, 'human'), lower(coalesce(nullif(p.display_name, ''), u.email))), '[]'::jsonb)
    from auth.users u left join core.profiles p on p.user_id = u.id
    where exists (select 1 from core.memberships m where m.user_id = u.id) or p.user_id is not null);
end $$;

-- La Edge llama a esto antes de tocar Auth (restablecer contraseña, desactivar o reactivar): autoriza, protege y registra.
create or replace function core.admin_account_event(p_actor uuid, p_user uuid, p_event text)
returns void language plpgsql as $$
begin
  perform core.require_admin(p_actor);
  if p_event not in ('password_reset', 'account_disabled', 'account_enabled') then perform core.fail('INVALID_OPERATION', 422); end if;
  if p_user = p_actor and p_event = 'account_disabled' then
    perform core.fail('CURRENT_ACCOUNT', 422, jsonb_build_object('reason', 'an administrator cannot disable themselves'));
  end if;
  if p_event <> 'account_enabled' then
    update core.sso_passes set revoked_at = now() where user_id = p_user and revoked_at is null;
  end if;
  perform core.log_access('central', p_actor, null, 'member_changed', jsonb_build_object('userId', p_user, 'event', p_event));
end $$;

create or replace function public.core_admin_account_event(p_actor uuid, p_user uuid, p_event text) returns void
language sql security definer set search_path = '' as $$ select core.admin_account_event(p_actor, p_user, p_event) $$;

do $$
declare f text;
begin
  for f in select 'public.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'core\_%' loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
  for f in select 'core.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'core' loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
