-- Ikisai Core · administración común del ecosistema (contrato §3.5), base de la app Central.
-- Quien es `owner` de la app `central` administra cuentas, accesos, agentes y registro de todas las apps.
-- Un agente nunca administra. Las apps siguen gestionando sus propios miembros (owner de cada app) como hasta ahora.

select core.ensure_app('central', 'Ikisai Central', 'central.ikisai.com');
update core.apps set kind = 'internal', sort = 50, alias_domain = 'encarna.ikisai.com', description = 'Dirección, cuentas, permisos y cumplimiento' where id = 'central';
insert into core.app_state (app, cursor) values ('central', 0) on conflict do nothing;

-- El propietario actual de las cuatro apps pasa a administrar el ecosistema (hoy hay una sola cuenta propietaria).
insert into core.memberships (app, user_id, role)
select distinct 'central', m.user_id, 'owner' from core.memberships m
where m.role = 'owner' and m.app in ('tasks', 'booking', 'food', 'invoices')
  and coalesce((select kind from core.profiles p where p.user_id = m.user_id), 'human') = 'human'
  and (select count(distinct app) from core.memberships x where x.user_id = m.user_id and x.role = 'owner' and x.app in ('tasks', 'booking', 'food', 'invoices')) = 4
on conflict (app, user_id) do nothing;

create or replace function core.require_admin(p_actor uuid)
returns void language plpgsql stable as $$
begin
  if not exists (select 1 from core.memberships where app = 'central' and user_id = p_actor and role = 'owner')
     or coalesce((select kind from core.profiles where user_id = p_actor), 'human') = 'agent' then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'ecosystem administrators only'));
  end if;
end $$;

-- Cuentas del ecosistema con sus accesos por app. Lee el correo de auth.users (función de servicio).
create or replace function core.admin_accounts(p_actor uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform core.require_admin(p_actor);
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'userId', u.id, 'email', u.email, 'displayName', coalesce(p.display_name, ''), 'kind', coalesce(p.kind, 'human'),
      'createdAt', u.created_at, 'lastSignInAt', u.last_sign_in_at,
      'memberships', coalesce((select jsonb_agg(jsonb_build_object('app', m.app, 'role', m.role, 'scopes', m.scopes, 'revision', m.revision) order by a.sort, m.app)
                               from core.memberships m join core.apps a on a.id = m.app where m.user_id = u.id), '[]'::jsonb),
      'agentKeys', (select count(*) from core.agent_keys k where k.user_id = u.id and k.revoked_at is null))
    order by coalesce(p.kind, 'human'), lower(coalesce(nullif(p.display_name, ''), u.email))), '[]'::jsonb)
    from auth.users u left join core.profiles p on p.user_id = u.id
    where exists (select 1 from core.memberships m where m.user_id = u.id) or p.user_id is not null);
end $$;

-- Da, cambia o quita (p_role null) el acceso de una cuenta a cualquier app.
create or replace function core.admin_set_membership(p_actor uuid, p_app text, p_user uuid, p_role text, p_scopes jsonb, p_display_name text)
returns jsonb language plpgsql as $$
declare v_kind text; v_owners int;
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

-- Registro de accesos de todas las apps (o de una), más reciente primero.
create or replace function core.admin_access_log(p_actor uuid, p_app text, p_before bigint, p_limit int)
returns jsonb language plpgsql stable as $$
declare v_limit int := greatest(1, least(coalesce(p_limit, 100), 500)); v_items jsonb; v_count int;
begin
  perform core.require_admin(p_actor);
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'app', e.app, 'event', e.event, 'actorId', e.actor_id, 'keyId', e.key_id, 'meta', e.meta) order by e.id desc), '[]'::jsonb), count(*)
    into v_items, v_count
    from (select * from core.access_events where (p_app is null or app = p_app) and (p_before is null or id < p_before) order by id desc limit v_limit + 1) e;
  if v_count > v_limit then v_items := (select jsonb_agg(t.x order by t.o) from jsonb_array_elements(v_items) with ordinality as t(x, o) where t.o <= v_limit); end if;
  return jsonb_build_object('items', coalesce(v_items, '[]'::jsonb), 'hasMore', v_count > v_limit,
    'nextBefore', case when v_count > v_limit then (v_items->(v_limit - 1)->>'id')::bigint else null end);
end $$;

-- Agentes de todas las apps: claves y sus pertenencias.
create or replace function core.admin_agents(p_actor uuid)
returns jsonb language plpgsql stable as $$
begin
  perform core.require_admin(p_actor);
  return (select coalesce(jsonb_agg(jsonb_build_object('keyId', k.id, 'userId', k.user_id, 'name', k.name, 'hint', k.hint, 'createdAt', k.created_at,
            'expiresAt', k.expires_at, 'lastUsedAt', k.last_used_at, 'revokedAt', k.revoked_at,
            'memberships', coalesce((select jsonb_agg(jsonb_build_object('app', m.app, 'role', m.role, 'scopes', m.scopes) order by m.app) from core.memberships m where m.user_id = k.user_id), '[]'::jsonb))
          order by k.created_at desc), '[]'::jsonb) from core.agent_keys k);
end $$;

-- Revoca una clave de agente desde Central (en todas las apps) y sus propuestas abiertas.
create or replace function core.admin_revoke_agent_key(p_actor uuid, p_key uuid)
returns jsonb language plpgsql as $$
declare v_key core.agent_keys; v_n int;
begin
  perform core.require_admin(p_actor);
  select * into v_key from core.agent_keys where id = p_key;
  if v_key.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('keyId', p_key)); end if;
  update core.agent_keys set revoked_at = coalesce(revoked_at, now()) where id = p_key;
  update core.proposals set status = 'revoked', reason = 'key revoked' where user_id = v_key.user_id and status in ('pending', 'approved');
  get diagnostics v_n = row_count;
  perform core.log_access(null, p_actor, p_key, 'key_revoked', jsonb_build_object('userId', v_key.user_id, 'proposalsRevoked', v_n, 'by', 'central'));
  return jsonb_build_object('keyId', p_key, 'revoked', true, 'proposalsRevoked', v_n);
end $$;

-- Ningún agente en Central, tampoco desde la ruta `agents` del kit.
create or replace function core.agent_key_issue(p_app text, p_actor uuid, p_user uuid, p_name text, p_role text, p_scopes jsonb, p_digest text, p_hint text, p_expires_at timestamptz)
returns jsonb language plpgsql as $$
declare v_role text; v_kind text; v_key core.agent_keys; v_member core.memberships;
begin
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is distinct from 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only owners manage agents')); end if;
  if (select kind from core.profiles where user_id = p_actor) = 'agent' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'agents cannot manage agents')); end if;
  if p_app = 'central' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'agents have no access to central')); end if;
  if p_role not in ('reader','editor') then perform core.fail('INVALID_ROLE', 422, jsonb_build_object('reason', 'an agent is reader or editor')); end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 100 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid name')); end if;
  select kind into v_kind from core.profiles where user_id = p_user;
  if v_kind = 'human' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'user is not an agent')); end if;
  if v_kind is null and p_digest is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('reason', 'unknown agent')); end if;
  insert into core.profiles (user_id, display_name, kind) values (p_user, btrim(p_name), 'agent')
  on conflict (user_id) do update set display_name = btrim(p_name), updated_at = now(), revision = core.profiles.revision + 1;
  insert into core.memberships (app, user_id, role, scopes) values (p_app, p_user, p_role, p_scopes)
  on conflict (app, user_id) do update set role = excluded.role, scopes = excluded.scopes, updated_at = now(), revision = core.memberships.revision + 1
  returning * into v_member;
  perform core.log_access(p_app, p_actor, null, 'member_invited', jsonb_build_object('userId', p_user, 'role', p_role, 'kind', 'agent'));
  if p_digest is not null then
    if p_digest !~ '^[0-9a-f]{64}$' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid digest')); end if;
    insert into core.agent_keys (user_id, name, digest, hint, created_by, expires_at) values (p_user, btrim(p_name), p_digest, coalesce(p_hint, ''), p_actor, p_expires_at) returning * into v_key;
    perform core.log_access(p_app, p_actor, v_key.id, 'key_issued', jsonb_build_object('userId', p_user, 'name', btrim(p_name), 'hint', v_key.hint, 'expiresAt', p_expires_at));
  else
    select * into v_key from core.agent_keys where user_id = p_user and revoked_at is null order by created_at desc limit 1;
  end if;
  return jsonb_build_object('keyId', v_key.id, 'userId', p_user, 'name', btrim(p_name), 'hint', v_key.hint, 'role', v_member.role, 'scopes', v_member.scopes,
    'expiresAt', v_key.expires_at, 'createdAt', v_key.created_at);
end $$;

create or replace function public.core_admin_accounts(p_actor uuid) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.admin_accounts(p_actor) $$;
create or replace function public.core_admin_set_membership(p_actor uuid, p_app text, p_user uuid, p_role text, p_scopes jsonb, p_display_name text) returns jsonb
language sql security definer set search_path = '' as $$ select core.admin_set_membership(p_actor, p_app, p_user, p_role, p_scopes, p_display_name) $$;
create or replace function public.core_admin_access_log(p_actor uuid, p_app text, p_before bigint, p_limit int) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.admin_access_log(p_actor, p_app, p_before, p_limit) $$;
create or replace function public.core_admin_agents(p_actor uuid) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.admin_agents(p_actor) $$;
create or replace function public.core_admin_revoke_agent_key(p_actor uuid, p_key uuid) returns jsonb
language sql security definer set search_path = '' as $$ select core.admin_revoke_agent_key(p_actor, p_key) $$;

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
