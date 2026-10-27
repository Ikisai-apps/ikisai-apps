-- Ikisai Core · catálogo de capacidades (Visión V0.2 de Flow §3.5 y §9.1, aprobada por VG el 27-10-2026).
-- Una capacidad es una operación o lectura que una app dueña publica para que otra (Flow, en primer lugar) la ofrezca y la
-- invoque **con los permisos reales de la persona**: nunca con un superusuario. El catálogo no ejecuta nada: dice qué
-- existe, de quién es, por qué ruta de la API del dueño se llama, qué rol hace falta, su riesgo, si es idempotente y si se
-- puede deshacer. La llamada la hace la Edge de la app que la ofrece (kit `invokeCapability`) a la API del dueño con el
-- token de la persona, y deja un recibo en core.capability_receipts. El editor de Flow ofrece capacidades del catálogo,
-- no scripts.

create table core.capabilities (
  id text primary key check (id ~ '^[a-z]+\.[a-z0-9_]+$'),
  app text not null references core.apps(id),
  version integer not null default 1 check (version >= 1),
  kind text not null check (kind in ('read', 'propose', 'execute')),
  title text not null check (length(title) between 1 and 120),
  description text not null default '',
  -- Ruta en la API del dueño, relativa a /api/v1/: 'POST purchases/quick'.
  route text not null check (route ~ '^(GET|POST) [a-z0-9_/:-]+$'),
  roles text[] not null default '{editor,owner}',
  risk text not null default 'low' check (risk in ('low', 'medium', 'high')),
  idempotent boolean not null default false,
  reversible boolean not null default false,
  input_schema jsonb not null default '{}'::jsonb,
  output_schema jsonb not null default '{}'::jsonb,
  -- Anclajes de pantalla donde la capacidad ya existe en la app dueña (ids de feedback), para la cobertura de Central.
  anchors jsonb not null default '[]'::jsonb,
  since text,
  deprecated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table core.capabilities enable row level security;
revoke all on core.capabilities from public, anon, authenticated;
grant all on core.capabilities to service_role;

-- Registro desde la migración de la app dueña: core.register_capability('{"id": "invoices.register_purchase_quick", ...}').
create or replace function core.register_capability(p jsonb) returns void language plpgsql as $$
begin
  if split_part(p->>'id', '.', 1) <> (p->>'app') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'capability id must start with its app', 'id', p->>'id'));
  end if;
  insert into core.capabilities (id, app, version, kind, title, description, route, roles, risk, idempotent, reversible, input_schema, output_schema, anchors, since)
  values (p->>'id', p->>'app', coalesce((p->>'version')::int, 1), coalesce(p->>'kind', 'execute'), p->>'title', coalesce(p->>'description', ''), p->>'route',
          coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p->'roles', '["editor","owner"]'::jsonb)) x), '{editor,owner}'),
          coalesce(p->>'risk', 'low'), coalesce((p->>'idempotent')::boolean, false), coalesce((p->>'reversible')::boolean, false),
          coalesce(p->'input', '{}'::jsonb), coalesce(p->'output', '{}'::jsonb), coalesce(p->'anchors', '[]'::jsonb), p->>'since')
  on conflict (id) do update set version = excluded.version, kind = excluded.kind, title = excluded.title, description = excluded.description,
    route = excluded.route, roles = excluded.roles, risk = excluded.risk, idempotent = excluded.idempotent, reversible = excluded.reversible,
    input_schema = excluded.input_schema, output_schema = excluded.output_schema, anchors = excluded.anchors, since = coalesce(core.capabilities.since, excluded.since),
    deprecated_at = null, updated_at = now();
end $$;

create or replace function core.deprecate_capability(p_id text) returns void language sql as $$
  update core.capabilities set deprecated_at = coalesce(deprecated_at, now()), updated_at = now() where id = p_id
$$;

-- Lo que una persona puede invocar: las capacidades vivas de las apps donde tiene pertenencia con un rol suficiente.
-- `allowed` dice si puede; las demás de esas apps se devuelven con allowed = false para que el editor explique el porqué.
create or replace function core.capabilities_for(p_actor uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'app', c.app, 'appName', a.name, 'version', c.version, 'kind', c.kind, 'title', c.title, 'description', c.description,
    'route', c.route, 'roles', to_jsonb(c.roles), 'risk', c.risk, 'idempotent', c.idempotent, 'reversible', c.reversible,
    'input', c.input_schema, 'output', c.output_schema, 'anchors', c.anchors, 'since', c.since,
    'allowed', m.role = any (c.roles)) order by a.sort, c.app, c.title), '[]'::jsonb)
  from core.capabilities c
  join core.apps a on a.id = c.app
  join core.memberships m on m.app = c.app and m.user_id = p_actor
  where c.deprecated_at is null
$$;

-- ¿Puede esta persona invocar esta capacidad? Devuelve la capacidad con el dominio de la app dueña, o falla.
create or replace function core.capability_check(p_actor uuid, p_id text) returns jsonb language plpgsql stable as $$
declare c core.capabilities; v_role text; v_domain text;
begin
  select * into c from core.capabilities where id = p_id;
  if c.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('capability', p_id)); end if;
  if c.deprecated_at is not null then perform core.fail('CAPABILITY_DEPRECATED', 410, jsonb_build_object('capability', p_id)); end if;
  select role into v_role from core.memberships where app = c.app and user_id = p_actor;
  if v_role is null then perform core.fail('NEEDS_ACCESS', 403, jsonb_build_object('app', c.app, 'capability', p_id, 'reason', 'no membership')); end if;
  if not (v_role = any (c.roles)) then perform core.fail('NEEDS_ACCESS', 403, jsonb_build_object('app', c.app, 'capability', p_id, 'role', v_role, 'roles', to_jsonb(c.roles))); end if;
  select domain into v_domain from core.apps where id = c.app;
  return jsonb_build_object('id', c.id, 'app', c.app, 'domain', v_domain, 'route', c.route, 'kind', c.kind, 'risk', c.risk, 'idempotent', c.idempotent, 'version', c.version);
end $$;

-- Recibos: cada invocación deja constancia (quién, desde qué app, qué pidió por requestId, qué contestó el dueño). Sin cuerpos.
create table core.capability_receipts (
  id uuid primary key default gen_random_uuid(),
  capability text not null,
  version integer not null,
  caller_app text not null references core.apps(id),
  actor_id uuid not null,
  request_id text,
  status integer not null,
  ok boolean not null,
  error_code text,
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index capability_receipts_actor_idx on core.capability_receipts (actor_id, created_at desc);
create index capability_receipts_capability_idx on core.capability_receipts (capability, created_at desc);
alter table core.capability_receipts enable row level security;
revoke all on core.capability_receipts from public, anon, authenticated;
grant all on core.capability_receipts to service_role;

create or replace function core.capability_receipt(p jsonb) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into core.capability_receipts (capability, version, caller_app, actor_id, request_id, status, ok, error_code, summary)
  values (p->>'capability', coalesce((p->>'version')::int, 1), p->>'callerApp', (p->>'actorId')::uuid, p->>'requestId', (p->>'status')::int,
          coalesce((p->>'ok')::boolean, false), p->>'errorCode', coalesce(p->'summary', '{}'::jsonb))
  returning id into v_id;
  return v_id;
end $$;

-- Los recibos de una persona (los suyos) o de todos (owner de la app que llama), para «lo que he hecho desde Flow».
-- Con p_all solo se ven los recibos ajenos de capacidades cuya app dueña también tiene al solicitante como miembro: ser
-- owner de Flow no da a ver la actividad de Invoices de los demás.
create or replace function core.capability_receipts_of(p_actor uuid, p_caller_app text, p_all boolean default false, p_limit int default 50) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'capability', r.capability, 'version', r.version, 'actorId', r.actor_id, 'requestId', r.request_id,
    'status', r.status, 'ok', r.ok, 'errorCode', r.error_code, 'summary', r.summary, 'createdAt', r.created_at) order by r.created_at desc), '[]'::jsonb)
  from (select * from core.capability_receipts r
         where r.caller_app = p_caller_app
           and (r.actor_id = p_actor or (p_all and exists (select 1 from core.memberships m where m.user_id = p_actor and m.app = split_part(r.capability, '.', 1))))
         order by r.created_at desc limit greatest(1, least(p_limit, 200))) r
$$;

create or replace function public.core_capabilities_for(p_actor uuid) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.capabilities_for(p_actor) $$;
create or replace function public.core_capability_check(p_actor uuid, p_id text) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.capability_check(p_actor, p_id) $$;
create or replace function public.core_capability_receipt(p jsonb) returns uuid
language sql security definer set search_path = '' as $$ select core.capability_receipt(p) $$;
create or replace function public.core_capability_receipts_of(p_actor uuid, p_caller_app text, p_all boolean default false, p_limit int default 50) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.capability_receipts_of(p_actor, p_caller_app, p_all, p_limit) $$;

revoke all on function core.register_capability(jsonb) from public, anon, authenticated;
revoke all on function core.deprecate_capability(text) from public, anon, authenticated;
revoke all on function core.capabilities_for(uuid) from public, anon, authenticated;
revoke all on function core.capability_check(uuid, text) from public, anon, authenticated;
revoke all on function core.capability_receipt(jsonb) from public, anon, authenticated;
revoke all on function core.capability_receipts_of(uuid, text, boolean, int) from public, anon, authenticated;
revoke all on function public.core_capabilities_for(uuid) from public, anon, authenticated;
revoke all on function public.core_capability_check(uuid, text) from public, anon, authenticated;
revoke all on function public.core_capability_receipt(jsonb) from public, anon, authenticated;
revoke all on function public.core_capability_receipts_of(uuid, text, boolean, int) from public, anon, authenticated;
grant execute on function public.core_capabilities_for(uuid) to service_role;
grant execute on function public.core_capability_check(uuid, text) to service_role;
grant execute on function public.core_capability_receipt(jsonb) to service_role;
grant execute on function public.core_capability_receipts_of(uuid, text, boolean, int) to service_role;
