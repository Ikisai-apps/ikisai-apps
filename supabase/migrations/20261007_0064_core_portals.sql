-- Ikisai Core · portales externos Organizers y Guests: enlaces personales y accesos con ámbito (contrato §3.6).
-- Diseño acordado con el usuario el 7 oct 2026 (coordinacion/ampliacion/PORTALES.md).
--
-- Un organizador o un huésped es un usuario de Auth (con su correo real si se conoce; así repite cuenta en el siguiente
-- retiro) con pertenencia a `organizers` o `guests` y ámbito por reserva o por huésped. Entra por un **enlace personal**
-- (`https://<portal>/i/<token>`; en base de datos solo el sha256) que se canjea por una sesión propia, como el pase de la
-- sesión única. La validez del enlace la decide, en cada uso, la app dueña del dato (Booking) mediante un procedimiento
-- registrado (`core.allow_portal_resolver`): si la fecha del retiro se mueve, el enlace se amplía o se reduce solo.

select core.ensure_app('organizers', 'Ikisai Organizers', 'organizers.ikisai.com');
select core.ensure_app('guests', 'Ikisai Guests', 'guests.ikisai.com');
update core.apps set kind = 'portal', sort = 60, alias_domain = 'organiza.ikisai.com', description = 'Portal de organizadores de retiros' where id = 'organizers';
update core.apps set kind = 'portal', sort = 70, alias_domain = 'ven.ikisai.com', description = 'Portal personal de huéspedes' where id = 'guests';
insert into core.app_state (app, cursor) values ('organizers', 0), ('guests', 0) on conflict do nothing;

-- Procedimientos que dicen hasta cuándo vale un enlace según su ámbito: f(p_scope jsonb) returns timestamptz (null = no vale).
create table core.portal_resolvers (
  app text not null references core.apps(id),           -- portal al que da acceso el enlace
  procedure text not null check (procedure ~ '^[a-z_]+\.[a-z0-9_]+$'),
  primary key (app)
);
alter table core.portal_resolvers enable row level security;
revoke all on core.portal_resolvers from public, anon, authenticated;
grant all on core.portal_resolvers to service_role;

create or replace function core.allow_portal_resolver(p_app text, p_procedure text)
returns void language sql as $$
  insert into core.portal_resolvers (app, procedure) values (p_app, p_procedure)
  on conflict (app) do update set procedure = excluded.procedure;
$$;

create table core.portal_links (
  id uuid primary key default gen_random_uuid(),
  app text not null references core.apps(id),            -- organizers | guests
  user_id uuid not null references auth.users(id) on delete cascade,
  digest text not null unique check (digest ~ '^[0-9a-f]{64}$'),
  scope jsonb not null,                                    -- p. ej. {"reservation_id": …} o {"reservation_id": …, "guest_id": …}
  label text,                                              -- a quién se dio («Paco · organizador»), para la lista de enlaces
  created_by uuid not null references auth.users(id),
  issuer_app text not null references core.apps(id),       -- app desde la que se generó (booking, organizers)
  created_at timestamptz not null default now(),
  extended_until timestamptz,                               -- ampliación manual del personal (manda si es posterior)
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index portal_links_user_idx on core.portal_links (user_id);
create index portal_links_scope_idx on core.portal_links using gin (scope);
alter table core.portal_links enable row level security;
revoke all on core.portal_links from public, anon, authenticated;
grant all on core.portal_links to service_role;

-- Hasta cuándo vale un enlace: lo que diga el procedimiento del dueño del dato o la ampliación manual, lo que sea posterior.
create or replace function core.portal_link_valid_until(p_link core.portal_links)
returns timestamptz language plpgsql stable as $$
declare v_proc text; v_until timestamptz;
begin
  select procedure into v_proc from core.portal_resolvers where app = p_link.app;
  if v_proc is not null then
    execute format('select %s($1)', v_proc) into v_until using p_link.scope;
  end if;
  if p_link.extended_until is not null and (v_until is null or p_link.extended_until > v_until) then v_until := p_link.extended_until; end if;
  return v_until;
end $$;

-- Añade el ámbito a la pertenencia del usuario al portal (organizers: lista de reservas; guests: lista de huéspedes).
create or replace function core.portal_grant(p_app text, p_user uuid, p_scope jsonb, p_display_name text)
returns void language plpgsql as $$
declare v_scopes jsonb; v_entry jsonb;
begin
  insert into core.profiles (user_id, display_name) values (p_user, coalesce(p_display_name, ''))
  on conflict (user_id) do update set display_name = case when core.profiles.display_name = '' then coalesce(p_display_name, '') else core.profiles.display_name end;
  select scopes into v_scopes from core.memberships where app = p_app and user_id = p_user;
  v_entry := p_scope;
  if v_scopes is null or jsonb_typeof(v_scopes->'grants') <> 'array' then
    v_scopes := jsonb_build_object('grants', jsonb_build_array(v_entry));
  elsif not (v_scopes->'grants') @> jsonb_build_array(v_entry) then
    v_scopes := jsonb_set(v_scopes, '{grants}', (v_scopes->'grants') || jsonb_build_array(v_entry));
  end if;
  insert into core.memberships (app, user_id, role, scopes) values (p_app, p_user, 'editor', v_scopes)
  on conflict (app, user_id) do update set scopes = excluded.scopes, updated_at = now(), revision = core.memberships.revision + 1;
end $$;

-- Emite un enlace. Lo llama la Edge de la app emisora tras autorizar (Booking: editor u owner; Organizers: el organizador de
-- esa reserva, solo enlaces de huésped). La cuenta de Auth la crea o la reutiliza la Edge (por correo) antes de llamar.
create or replace function core.portal_link_issue(p_issuer_app text, p_actor uuid, p_app text, p_user uuid, p_digest text, p_scope jsonb, p_label text, p_display_name text)
returns jsonb language plpgsql as $$
declare v_role text; v_link core.portal_links; v_until timestamptz;
begin
  if p_app not in ('organizers', 'guests') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'unknown portal')); end if;
  if p_digest !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_scope) <> 'object' then perform core.fail('INVALID_OPERATION', 422); end if;
  select role into v_role from core.memberships where app = p_issuer_app and user_id = p_actor;
  if v_role is null or v_role = 'reader' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'cannot issue portal links')); end if;
  if p_issuer_app = 'organizers' then
    -- Un organizador solo emite enlaces de huésped de sus propias reservas.
    if p_app <> 'guests' or not exists (select 1 from core.memberships m where m.app = 'organizers' and m.user_id = p_actor
          and (m.scopes->'grants') @> jsonb_build_array(jsonb_build_object('reservation_id', p_scope->'reservation_id'))) then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'organizers issue guest links for their own reservations only'));
    end if;
  elsif p_issuer_app <> 'booking' then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'issuer not allowed'));
  end if;
  if (select kind from core.profiles where user_id = p_user) = 'agent' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'agents cannot use portals')); end if;
  insert into core.portal_links (app, user_id, digest, scope, label, created_by, issuer_app)
  values (p_app, p_user, p_digest, p_scope, nullif(btrim(coalesce(p_label, '')), ''), p_actor, p_issuer_app) returning * into v_link;
  perform core.portal_grant(p_app, p_user, p_scope, p_display_name);
  v_until := core.portal_link_valid_until(v_link);
  perform core.log_access(p_app, p_actor, null, 'member_invited', jsonb_build_object('userId', p_user, 'portalLink', v_link.id, 'scope', p_scope, 'by', p_issuer_app));
  return jsonb_build_object('linkId', v_link.id, 'app', p_app, 'userId', p_user, 'scope', p_scope, 'validUntil', v_until);
end $$;

-- Canjea un enlace: devuelve el usuario si vale (y anota el uso); null si no existe, está revocado o caducado.
create or replace function core.portal_link_resolve(p_app text, p_digest text)
returns jsonb language plpgsql as $$
declare v_link core.portal_links; v_until timestamptz;
begin
  select * into v_link from core.portal_links where digest = p_digest and app = p_app for update;
  if v_link.id is null or v_link.revoked_at is not null then return null; end if;
  v_until := core.portal_link_valid_until(v_link);
  if v_until is null or v_until < now() then return jsonb_build_object('expired', true, 'validUntil', v_until); end if;
  update core.portal_links set last_used_at = now() where id = v_link.id;
  return jsonb_build_object('userId', v_link.user_id, 'linkId', v_link.id, 'scope', v_link.scope, 'validUntil', v_until);
end $$;

-- Enlaces de un ámbito (para la lista de la reserva en Booking u Organizers) y su gestión.
create or replace function core.portal_links_list(p_issuer_app text, p_actor uuid, p_reservation uuid)
returns jsonb language plpgsql stable as $$
declare v_role text;
begin
  select role into v_role from core.memberships where app = p_issuer_app and user_id = p_actor;
  if v_role is null then perform core.fail('NO_MEMBERSHIP', 403); end if;
  if p_issuer_app = 'organizers' and not exists (select 1 from core.memberships m where m.app = 'organizers' and m.user_id = p_actor
        and (m.scopes->'grants') @> jsonb_build_array(jsonb_build_object('reservation_id', p_reservation))) then
    perform core.fail('FORBIDDEN', 403);
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('linkId', l.id, 'app', l.app, 'userId', l.user_id, 'label', l.label, 'scope', l.scope,
            'createdAt', l.created_at, 'lastUsedAt', l.last_used_at, 'revokedAt', l.revoked_at, 'extendedUntil', l.extended_until,
            'validUntil', core.portal_link_valid_until(l), 'issuerApp', l.issuer_app) order by l.created_at desc), '[]'::jsonb)
          from core.portal_links l where l.scope->>'reservation_id' = p_reservation::text
            and (p_issuer_app = 'booking' or l.app = 'guests'));
end $$;

create or replace function core.portal_link_manage(p_issuer_app text, p_actor uuid, p_link uuid, p_action text, p_until timestamptz)
returns jsonb language plpgsql as $$
declare v_role text; v_link core.portal_links;
begin
  select role into v_role from core.memberships where app = p_issuer_app and user_id = p_actor;
  if v_role is null or v_role = 'reader' then perform core.fail('FORBIDDEN', 403); end if;
  select * into v_link from core.portal_links where id = p_link for update;
  if v_link.id is null then perform core.fail('NOT_FOUND', 404); end if;
  if p_issuer_app = 'organizers' and (v_link.app <> 'guests' or not exists (select 1 from core.memberships m where m.app = 'organizers' and m.user_id = p_actor
        and (m.scopes->'grants') @> jsonb_build_array(jsonb_build_object('reservation_id', v_link.scope->'reservation_id')))) then
    perform core.fail('FORBIDDEN', 403);
  elsif p_issuer_app not in ('organizers', 'booking') then
    perform core.fail('FORBIDDEN', 403);
  end if;
  if p_action = 'revoke' then
    update core.portal_links set revoked_at = coalesce(revoked_at, now()) where id = p_link returning * into v_link;
  elsif p_action = 'extend' then
    if p_issuer_app <> 'booking' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only staff extend links')); end if;
    if p_until is null or p_until < now() then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'until must be in the future')); end if;
    update core.portal_links set extended_until = p_until where id = p_link returning * into v_link;
  else
    perform core.fail('INVALID_OPERATION', 422);
  end if;
  perform core.log_access(v_link.app, p_actor, null, 'member_changed', jsonb_build_object('portalLink', p_link, 'action', p_action));
  return jsonb_build_object('linkId', v_link.id, 'revokedAt', v_link.revoked_at, 'extendedUntil', v_link.extended_until, 'validUntil', core.portal_link_valid_until(v_link));
end $$;

-- En los portales, un miembro que no es owner solo se ve a sí mismo: un organizador no ve a otros organizadores ni un
-- huésped a otros huéspedes.
create or replace function core.list_memberships(p_app text, p_actor uuid)
returns jsonb language plpgsql stable as $$
declare v_role text; v_portal boolean;
begin
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is null then perform core.fail('NO_MEMBERSHIP', 403); end if;
  v_portal := coalesce((select kind = 'portal' from core.apps where id = p_app), false);
  return (select coalesce(jsonb_agg(jsonb_build_object('userId', m.user_id, 'role', m.role, 'scopes', m.scopes, 'displayName', coalesce(p.display_name, ''), 'kind', coalesce(p.kind, 'human')) order by m.created_at), '[]'::jsonb)
          from core.memberships m left join core.profiles p on p.user_id = m.user_id
          where m.app = p_app and (not v_portal or v_role = 'owner' or m.user_id = p_actor));
end $$;

create or replace function public.core_portal_link_issue(p_issuer_app text, p_actor uuid, p_app text, p_user uuid, p_digest text, p_scope jsonb, p_label text, p_display_name text) returns jsonb
language sql security definer set search_path = '' as $$ select core.portal_link_issue(p_issuer_app, p_actor, p_app, p_user, p_digest, p_scope, p_label, p_display_name) $$;
create or replace function public.core_portal_link_resolve(p_app text, p_digest text) returns jsonb
language sql security definer set search_path = '' as $$ select core.portal_link_resolve(p_app, p_digest) $$;
create or replace function public.core_portal_links_list(p_issuer_app text, p_actor uuid, p_reservation uuid) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.portal_links_list(p_issuer_app, p_actor, p_reservation) $$;
create or replace function public.core_portal_link_manage(p_issuer_app text, p_actor uuid, p_link uuid, p_action text, p_until timestamptz) returns jsonb
language sql security definer set search_path = '' as $$ select core.portal_link_manage(p_issuer_app, p_actor, p_link, p_action, p_until) $$;

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
