-- Ikisai Core · módulo común «Recursos» (`resources`): espacios e inventario compartidos por todas las apps.
-- Diseño aprobado por el usuario el 13-10-2026 (coordinacion/ampliacion/RECURSOS.md §3). Toca solo el schema core.
--
-- Un «módulo» es una app del núcleo sin dominio ni PWA propios: sus tablas se sincronizan con core.commit como las de
-- cualquier app, pero se sirven desde la Edge de cada app que lo usa (`/api/v1/resources/…`, _kit/handler.ts) y sus
-- pantallas son componentes del kit. Su pertenencia no se da a mano: se deriva de las apps que lo usan.

alter table core.apps drop constraint if exists apps_kind_check;
alter table core.apps add constraint apps_kind_check check (kind in ('internal', 'portal', 'module'));

select core.ensure_app('resources', 'Ikisai Recursos');
update core.apps set kind = 'module', sort = 900, description = 'Espacios e inventario comunes' where id = 'resources';

-- Apps cuya pertenencia da acceso a cada módulo.
create table core.module_sources (
  module text not null references core.apps(id),
  source text not null references core.apps(id),
  primary key (module, source)
);
alter table core.module_sources enable row level security;
revoke all on core.module_sources from public, anon, authenticated;
insert into core.module_sources (module, source) values
  ('resources', 'booking'), ('resources', 'tasks'), ('resources', 'food'), ('resources', 'invoices'), ('resources', 'central')
on conflict do nothing;

-- Recalcula la pertenencia de un usuario a los módulos: el rol más alto que tenga en sus apps de origen
-- (un agente, como mucho editor). Sin ninguna, se quita.
create or replace function core.sync_module_memberships(p_user uuid)
returns void language plpgsql as $$
declare v_module text; v_role text; v_agent boolean;
begin
  select coalesce(kind, 'human') = 'agent' into v_agent from core.profiles where user_id = p_user;
  for v_module in select distinct module from core.module_sources loop
    select case max(case m.role when 'owner' then 3 when 'editor' then 2 else 1 end)
             when 3 then 'owner' when 2 then 'editor' when 1 then 'reader' end
      into v_role
      from core.memberships m join core.module_sources s on s.source = m.app and s.module = v_module
     where m.user_id = p_user;
    if v_role = 'owner' and coalesce(v_agent, false) then v_role := 'editor'; end if;
    if v_role is null then
      delete from core.memberships where app = v_module and user_id = p_user;
    else
      insert into core.memberships (app, user_id, role, scopes) values (v_module, p_user, v_role, null)
      on conflict (app, user_id) do update set role = excluded.role, scopes = null, updated_at = now(), revision = core.memberships.revision + 1
        where core.memberships.role is distinct from excluded.role;
    end if;
  end loop;
end $$;

create or replace function core.module_membership_trigger()
returns trigger language plpgsql as $$
begin
  if tg_op in ('INSERT', 'UPDATE') and exists (select 1 from core.module_sources where source = new.app) then
    perform core.sync_module_memberships(new.user_id);
  end if;
  if tg_op in ('DELETE', 'UPDATE') and exists (select 1 from core.module_sources where source = old.app)
     and (tg_op = 'DELETE' or old.user_id is distinct from new.user_id) then
    perform core.sync_module_memberships(old.user_id);
  end if;
  return null;
end $$;

drop trigger if exists memberships_modules on core.memberships;
create trigger memberships_modules after insert or update of role, app, user_id or delete on core.memberships
  for each row execute function core.module_membership_trigger();

-- Estado inicial: todos los que ya tienen alguna app de origen.
select core.sync_module_memberships(u.user_id)
  from (select distinct m.user_id from core.memberships m join core.module_sources s on s.source = m.app) u;

-- El lanzador y la administración de cuentas no enseñan los módulos: no se entra en ellos ni se dan a mano.
create or replace function core.my_apps(p_user uuid)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'domain', a.domain, 'aliasDomain', a.alias_domain,
           'kind', a.kind, 'description', a.description, 'role', m.role) order by a.sort, a.id), '[]'::jsonb)
  from core.apps a join core.memberships m on m.app = a.id and m.user_id = p_user
  where a.kind <> 'module';
$$;

create or replace function core.admin_accounts(p_actor uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform core.require_admin(p_actor);
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'userId', u.id, 'email', u.email, 'displayName', coalesce(p.display_name, ''), 'kind', coalesce(p.kind, 'human'),
      'createdAt', u.created_at, 'lastSignInAt', u.last_sign_in_at,
      'disabled', u.banned_until is not null and u.banned_until > now(), 'bannedUntil', u.banned_until,
      'memberships', coalesce((select jsonb_agg(jsonb_build_object('app', m.app, 'role', m.role, 'scopes', m.scopes, 'revision', m.revision, 'updatedAt', m.updated_at) order by a.sort, m.app)
                               from core.memberships m join core.apps a on a.id = m.app where m.user_id = u.id and a.kind <> 'module'), '[]'::jsonb),
      'agentKeys', (select count(*) from core.agent_keys k where k.user_id = u.id and k.revoked_at is null))
    order by coalesce(p.kind, 'human'), lower(coalesce(nullif(p.display_name, ''), u.email))), '[]'::jsonb)
    from auth.users u left join core.profiles p on p.user_id = u.id
    where exists (select 1 from core.memberships m where m.user_id = u.id) or p.user_id is not null);
end $$;

create or replace function core.admin_agents(p_actor uuid)
returns jsonb language plpgsql stable as $$
begin
  perform core.require_admin(p_actor);
  return (select coalesce(jsonb_agg(jsonb_build_object('keyId', k.id, 'userId', k.user_id, 'name', k.name, 'hint', k.hint, 'createdAt', k.created_at,
            'expiresAt', k.expires_at, 'lastUsedAt', k.last_used_at, 'revokedAt', k.revoked_at,
            'memberships', coalesce((select jsonb_agg(jsonb_build_object('app', m.app, 'role', m.role, 'scopes', m.scopes) order by m.app)
                                     from core.memberships m join core.apps a on a.id = m.app where m.user_id = k.user_id and a.kind <> 'module'), '[]'::jsonb))
          order by k.created_at desc), '[]'::jsonb) from core.agent_keys k);
end $$;

-- Dar a mano el acceso a un módulo no tiene sentido: se deriva. Se rechaza el alta o el cambio directos (los borrados
-- en cascada, al eliminar una cuenta, sí pasan).
create or replace function core.reject_module_membership()
returns trigger language plpgsql as $$
begin
  if pg_trigger_depth() = 1 and exists (select 1 from core.apps where id = new.app and kind = 'module') then
    perform core.fail('MODULE_MEMBERSHIP_DERIVED', 422, jsonb_build_object('app', new.app,
      'reason', 'module access comes from the apps that use it'));
  end if;
  return new;
end $$;

drop trigger if exists memberships_reject_module on core.memberships;
create trigger memberships_reject_module before insert or update on core.memberships
  for each row execute function core.reject_module_membership();

do $$
declare f text;
begin
  for f in select 'core.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'core' loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
