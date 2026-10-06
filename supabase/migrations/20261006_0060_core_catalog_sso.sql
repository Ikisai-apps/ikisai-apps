-- Ikisai Core · catálogo de apps (lanzador común) y sesión única entre los dominios de ikisai.com (contrato §3.3 y §3.4).
-- Decisión del usuario (6 oct 2026): cada app tiene identificador y dominio en inglés y un alias en español que redirige.

-- ---------------------------------------------------------------------------
-- Catálogo
-- ---------------------------------------------------------------------------
alter table core.apps add column if not exists kind text not null default 'internal' check (kind in ('internal', 'portal'));
alter table core.apps add column if not exists sort int not null default 100;
alter table core.apps add column if not exists alias_domain text;
alter table core.apps add column if not exists description text;

update core.apps set sort = 10, alias_domain = 'cuida.ikisai.com', description = 'Tareas, proyectos y mantenimiento' where id = 'tasks';
update core.apps set sort = 20, alias_domain = 'acoge.ikisai.com', description = 'Reservas, eventos y huéspedes' where id = 'booking';
update core.apps set sort = 30, alias_domain = 'papeaki.ikisai.com', description = 'Cocina, menús y compras' where id = 'food';
update core.apps set sort = 40, alias_domain = 'tramita.ikisai.com', description = 'Facturas y finanzas' where id = 'invoices';

-- Apps a las que la cuenta tiene acceso, en el orden del lanzador.
create or replace function core.my_apps(p_user uuid)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'domain', a.domain, 'aliasDomain', a.alias_domain,
           'kind', a.kind, 'description', a.description, 'role', m.role) order by a.sort, a.id), '[]'::jsonb)
  from core.apps a join core.memberships m on m.app = a.id and m.user_id = p_user;
$$;

-- ---------------------------------------------------------------------------
-- Sesión única: pase propio del núcleo en una cookie HttpOnly de .ikisai.com
-- ---------------------------------------------------------------------------
-- Los tokens de refresco de Supabase son de un solo uso: compartir una sesión entre apps haría que una invalidara a la
-- otra. El pase solo sirve para pedir una sesión nueva e independiente para cada app (`POST /api/v1/auth/sso`).
create table core.sso_passes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  digest text not null unique check (digest ~ '^[0-9a-f]{64}$'),   -- sha256 del pase; el pase no se guarda
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index sso_passes_user_idx on core.sso_passes (user_id);
alter table core.sso_passes enable row level security;
revoke all on core.sso_passes from public, anon, authenticated;
grant all on core.sso_passes to service_role;

create or replace function core.sso_issue(p_user uuid, p_digest text, p_days int default 30)
returns void language plpgsql as $$
begin
  if p_digest !~ '^[0-9a-f]{64}$' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid digest')); end if;
  -- limpieza oportunista de pases caducados o revocados hace tiempo
  delete from core.sso_passes where user_id = p_user and (expires_at < now() - interval '7 days' or revoked_at < now() - interval '7 days');
  insert into core.sso_passes (user_id, digest, expires_at) values (p_user, p_digest, now() + make_interval(days => greatest(1, least(p_days, 90))));
end $$;

-- Devuelve el usuario del pase si es válido y alarga su vida (caducidad deslizante); null si no vale.
create or replace function core.sso_resolve(p_digest text, p_days int default 30)
returns uuid language plpgsql as $$
declare v_pass core.sso_passes;
begin
  select * into v_pass from core.sso_passes where digest = p_digest for update;
  if v_pass.id is null or v_pass.revoked_at is not null or v_pass.expires_at < now() then return null; end if;
  update core.sso_passes set last_used_at = now(), expires_at = greatest(expires_at, now() + make_interval(days => greatest(1, least(p_days, 90)))) where id = v_pass.id;
  return v_pass.user_id;
end $$;

-- Revoca un pase (cerrar sesión) o, con p_all, todos los de su usuario (cerrar en todas partes, cambio de contraseña).
create or replace function core.sso_revoke(p_digest text, p_all boolean default false)
returns int language plpgsql as $$
declare v_user uuid; v_n int;
begin
  select user_id into v_user from core.sso_passes where digest = p_digest;
  if v_user is null then return 0; end if;
  if p_all then
    update core.sso_passes set revoked_at = now() where user_id = v_user and revoked_at is null;
  else
    update core.sso_passes set revoked_at = now() where digest = p_digest and revoked_at is null;
  end if;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function core.sso_revoke_user(p_user uuid)
returns int language plpgsql as $$
declare v_n int;
begin
  update core.sso_passes set revoked_at = now() where user_id = p_user and revoked_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- Wrappers (solo service_role)
-- ---------------------------------------------------------------------------
create or replace function public.core_my_apps(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.my_apps(p_user) $$;
create or replace function public.core_sso_issue(p_user uuid, p_digest text, p_days int) returns void
language sql security definer set search_path = '' as $$ select core.sso_issue(p_user, p_digest, p_days) $$;
create or replace function public.core_sso_resolve(p_digest text, p_days int) returns uuid
language sql security definer set search_path = '' as $$ select core.sso_resolve(p_digest, p_days) $$;
create or replace function public.core_sso_revoke(p_digest text, p_all boolean) returns int
language sql security definer set search_path = '' as $$ select core.sso_revoke(p_digest, p_all) $$;
create or replace function public.core_sso_revoke_user(p_user uuid) returns int
language sql security definer set search_path = '' as $$ select core.sso_revoke_user(p_user) $$;

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
