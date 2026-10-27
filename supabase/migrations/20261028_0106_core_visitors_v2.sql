-- 0106 · Visitantes v2 (contrato C11 v2; entrada pública de Guests, VG 27-10-2026: «todo para ya»).
--
-- A. Varios móviles por visitante: los tokens salen de core.visitors a core.visitor_tokens (uno por móvil, revocable por separado).
-- B. Guardar y recuperar el acceso con un código por correo (Supabase Auth OTP): core.visitors.auth_user_id apunta a la cuenta
--    de Auth del correo verificado; el núcleo nunca guarda el correo en claro. Frenos por correo (hash) y por IP.
-- C. Vínculo visitante ↔ huésped (core.visitor_links), consentido, deshacible y auditado, por dos vías: el huésped con sesión
--    une su móvil («guest»), o el visitante reclama la ficha de su petición aceptada («claim») por un resolutor de la app dueña
--    y recibe un enlace de portal de un solo uso y diez minutos.
-- Nada de esto da sesión por sí solo: un visitante sigue sin pertenencias; solo el enlace de portal abre la ficha.

-- ---------------------------------------------------------------------------------------------------------------------------
-- A · tokens por móvil
create table core.visitor_tokens (
  id uuid primary key default gen_random_uuid(),
  visitor_id uuid not null references core.visitors(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index visitor_tokens_visitor_idx on core.visitor_tokens (visitor_id) where revoked_at is null;
alter table core.visitor_tokens enable row level security;
revoke all on core.visitor_tokens from public, anon, authenticated;
grant all on core.visitor_tokens to service_role;

-- Los tokens que ya existían pasan a la tabla nueva; la columna antigua deja de ser obligatoria (se conserva por las filas viejas).
insert into core.visitor_tokens (visitor_id, token_hash, created_at, last_used_at, revoked_at)
select id, token_hash, created_at, last_seen_at, revoked_at from core.visitors where token_hash is not null;
alter table core.visitors alter column token_hash drop not null;

-- Registro propio de los hechos del visitante (sin datos personales: solo ids y hashes).
create table core.visitor_events (
  id bigint generated always as identity primary key,
  visitor_id uuid references core.visitors(id) on delete set null,
  event text not null check (event in ('created','token_added','token_revoked','email_requested','email_saved','email_recovered','email_forgotten','linked','unlinked','claimed','claim_redeemed')),
  meta jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
alter table core.visitor_events enable row level security;
revoke all on core.visitor_events from public, anon, authenticated;
grant all on core.visitor_events to service_role;

create or replace function core.visitor_create(p_token_hash text, p_event_code text default null)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'token hash must be sha-256 hex')); end if;
  if (select count(*) from core.visitors where created_at > now() - interval '1 minute') >= 120
     or (p_event_code is not null and (select count(*) from core.visitors where event_code = p_event_code and created_at > now() - interval '1 minute') >= 60) then
    perform core.fail('RATE_LIMITED', 429, jsonb_build_object('reason', 'too many visitors created'));
  end if;
  insert into core.visitors (event_code) values (nullif(p_event_code, '')) returning id into v_id;
  insert into core.visitor_tokens (visitor_id, token_hash) values (v_id, p_token_hash);
  insert into core.visitor_events (visitor_id, event, meta) values (v_id, 'created', jsonb_build_object('eventCode', nullif(p_event_code, '')));
  return v_id;
end $$;

-- Un token más para un visitante que ya existe (recuperación en otro móvil). Como mucho 10 móviles vivos por visitante.
create or replace function core.visitor_token_add(p_visitor uuid, p_token_hash text)
returns void language plpgsql as $$
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'token hash must be sha-256 hex')); end if;
  if not exists (select 1 from core.visitors where id = p_visitor and revoked_at is null) then perform core.fail('VISITOR_INVALID', 401); end if;
  if (select count(*) from core.visitor_tokens where visitor_id = p_visitor and revoked_at is null) >= 10 then
    perform core.fail('RATE_LIMITED', 429, jsonb_build_object('reason', 'too many devices'));
  end if;
  insert into core.visitor_tokens (visitor_id, token_hash) values (p_visitor, p_token_hash);
  insert into core.visitor_events (visitor_id, event) values (p_visitor, 'token_added');
end $$;

-- Salir de este móvil: revoca solo ese token. Devuelve si había algo que revocar.
create or replace function core.visitor_token_revoke(p_token_hash text)
returns boolean language plpgsql as $$
declare v_visitor uuid;
begin
  update core.visitor_tokens set revoked_at = now() where token_hash = p_token_hash and revoked_at is null returning visitor_id into v_visitor;
  if v_visitor is null then return false; end if;
  insert into core.visitor_events (visitor_id, event) values (v_visitor, 'token_revoked');
  return true;
end $$;

create or replace function core.visitor_resolve(p_token_hash text)
returns jsonb language plpgsql as $$
declare v core.visitors; v_token core.visitor_tokens;
begin
  select t.* into v_token from core.visitor_tokens t where t.token_hash = p_token_hash and t.revoked_at is null;
  if v_token.id is null then return null; end if;
  select * into v from core.visitors where id = v_token.visitor_id and revoked_at is null;
  if v.id is null then return null; end if;
  if v_token.last_used_at < now() - interval '1 minute' then
    update core.visitor_tokens set last_used_at = now() where id = v_token.id;
    update core.visitors set last_seen_at = now() where id = v.id;
  end if;
  return jsonb_build_object('id', v.id, 'eventCode', v.event_code);
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- B · correo optativo para guardar y recuperar el acceso
alter table core.visitors add column auth_user_id uuid unique references auth.users(id) on delete set null;

create table core.visitor_email_requests (
  id bigint generated always as identity primary key,
  email_hash text not null check (email_hash ~ '^[0-9a-f]{64}$'),
  ip text,
  created_at timestamptz not null default now()
);
create index visitor_email_requests_hash_idx on core.visitor_email_requests (email_hash, created_at);
create index visitor_email_requests_ip_idx on core.visitor_email_requests (ip, created_at);
alter table core.visitor_email_requests enable row level security;
revoke all on core.visitor_email_requests from public, anon, authenticated;
grant all on core.visitor_email_requests to service_role;

-- Freno antes de pedir el código a Auth: 5 por hora y correo, 20 por hora e IP. La respuesta de la Edge es siempre «enviado».
create or replace function core.visitor_email_request(p_email_hash text, p_ip text, p_visitor uuid default null)
returns void language plpgsql as $$
begin
  if p_email_hash !~ '^[0-9a-f]{64}$' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'email hash must be sha-256 hex')); end if;
  if (select count(*) from core.visitor_email_requests where email_hash = p_email_hash and created_at > now() - interval '1 hour') >= 5
     or (p_ip is not null and (select count(*) from core.visitor_email_requests where ip = p_ip and created_at > now() - interval '1 hour') >= 20) then
    perform core.fail('RATE_LIMITED', 429, jsonb_build_object('reason', 'too many email codes requested'));
  end if;
  insert into core.visitor_email_requests (email_hash, ip) values (p_email_hash, nullif(p_ip, ''));
  insert into core.visitor_events (visitor_id, event) values (p_visitor, 'email_requested');
end $$;

-- Tras verificar el código: liga la cuenta de Auth a este visitante, o devuelve el visitante que ya la tenía (recuperación).
-- Sin visitante y sin ligar a nadie, nace un visitante nuevo ya ligado. La identidad anónima del móvil que recupera queda huérfana.
create or replace function core.visitor_email_link(p_visitor uuid, p_auth_user uuid)
returns jsonb language plpgsql as $$
declare v_other uuid; v_id uuid;
begin
  select id into v_other from core.visitors where auth_user_id = p_auth_user and revoked_at is null;
  if v_other is not null then
    if p_visitor is not null and v_other = p_visitor then return jsonb_build_object('visitorId', p_visitor, 'saved', true, 'recovered', false); end if;
    insert into core.visitor_events (visitor_id, event, meta) values (v_other, 'email_recovered', jsonb_build_object('from', p_visitor));
    return jsonb_build_object('visitorId', v_other, 'recovered', true);
  end if;
  if p_visitor is null then
    insert into core.visitors (auth_user_id) values (p_auth_user) returning id into v_id;
    insert into core.visitor_events (visitor_id, event) values (v_id, 'email_saved');
    return jsonb_build_object('visitorId', v_id, 'recovered', true, 'created', true);
  end if;
  update core.visitors set auth_user_id = p_auth_user where id = p_visitor and revoked_at is null;
  if not found then perform core.fail('VISITOR_INVALID', 401); end if;
  insert into core.visitor_events (visitor_id, event) values (p_visitor, 'email_saved');
  return jsonb_build_object('visitorId', p_visitor, 'saved', true, 'recovered', false);
end $$;

create or replace function core.visitor_email_forget(p_visitor uuid)
returns void language plpgsql as $$
begin
  update core.visitors set auth_user_id = null where id = p_visitor and revoked_at is null;
  if not found then perform core.fail('VISITOR_INVALID', 401); end if;
  insert into core.visitor_events (visitor_id, event) values (p_visitor, 'email_forgotten');
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- C · vínculo visitante ↔ huésped
create table core.visitor_links (
  id uuid primary key default gen_random_uuid(),
  visitor_id uuid not null references core.visitors(id) on delete cascade,
  app text not null references core.apps(id),
  guest_id uuid not null,
  reservation_id uuid,
  user_id uuid references auth.users(id) on delete set null,   -- la cuenta del huésped que consiente (vía guest), o null (vía claim)
  via text not null check (via in ('guest', 'claim')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index visitor_links_live_idx on core.visitor_links (visitor_id, guest_id) where revoked_at is null;
create index visitor_links_guest_idx on core.visitor_links (guest_id) where revoked_at is null;
alter table core.visitor_links enable row level security;
revoke all on core.visitor_links from public, anon, authenticated;
grant all on core.visitor_links to service_role;

-- Para Booking (join_from_visitor reutiliza la ficha ya ligada) y Flow («Mi pedido» sigue al huésped). Permitido en el lint.
create or replace function core.visitor_guest_ids(p_visitor uuid)
returns uuid[] language sql stable as $$
  select coalesce(array_agg(guest_id order by created_at), '{}'::uuid[]) from core.visitor_links where visitor_id = p_visitor and revoked_at is null
$$;

-- Lo que el visitante sabe de sí mismo. El correo no está aquí: la Edge pide a Auth la cuenta y devuelve solo una pista (v•••@g•••.com).
create or replace function core.visitor_me(p_visitor uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object('visitorId', v.id, 'emailSaved', v.auth_user_id is not null, 'authUserId', v.auth_user_id,
                            'devices', (select count(*) from core.visitor_tokens t where t.visitor_id = v.id and t.revoked_at is null),
                            'guestIds', core.visitor_guest_ids(v.id))
    from core.visitors v where v.id = p_visitor and v.revoked_at is null
$$;

create or replace function core.visitor_link_set(p_visitor uuid, p_app text, p_guest uuid, p_reservation uuid, p_user uuid, p_via text)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  if not exists (select 1 from core.visitors where id = p_visitor and revoked_at is null) then perform core.fail('VISITOR_INVALID', 401); end if;
  if p_via not in ('guest', 'claim') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'via must be guest or claim')); end if;
  insert into core.visitor_links (visitor_id, app, guest_id, reservation_id, user_id, via) values (p_visitor, p_app, p_guest, p_reservation, p_user, p_via)
  on conflict (visitor_id, guest_id) where revoked_at is null do update set reservation_id = coalesce(excluded.reservation_id, core.visitor_links.reservation_id),
      user_id = coalesce(excluded.user_id, core.visitor_links.user_id)
  returning id into v_id;
  insert into core.visitor_events (visitor_id, event, meta) values (p_visitor, 'linked', jsonb_build_object('guestId', p_guest, 'via', p_via));
  return v_id;
end $$;

-- Deshacer el vínculo (lo pide el huésped con su sesión; la Edge ya comprobó que el huésped es suyo). Devuelve cuántos había.
create or replace function core.visitor_link_revoke(p_guest uuid, p_user uuid)
returns integer language plpgsql as $$
declare v_n int;
begin
  with done as (update core.visitor_links set revoked_at = now() where guest_id = p_guest and revoked_at is null returning visitor_id)
  insert into core.visitor_events (visitor_id, event, meta) select visitor_id, 'unlinked', jsonb_build_object('guestId', p_guest, 'by', p_user) from done;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Resolutores de reclamación: la app dueña dice, para una petición, de qué huésped y reserva es, solo si la petición es de
-- core.current_visitor(), está aceptada y tiene ficha; si no, null. fn(p jsonb {request_id}) returns jsonb {guest_id, reservation_id}.
create table core.visitor_claim_resolvers (
  app text primary key references core.apps(id),
  procedure text not null check (procedure ~ '^[a-z_]+\.[a-z0-9_]+$')
);
create or replace function core.allow_visitor_claim(p_app text, p_procedure text)
returns void language sql as $$
  insert into core.visitor_claim_resolvers (app, procedure) values (p_app, p_procedure) on conflict (app) do update set procedure = excluded.procedure
$$;

create or replace function core.visitor_claim_resolve(p_visitor uuid, p_request uuid)
returns jsonb language plpgsql as $$
declare r record; v_out jsonb;
begin
  if not exists (select 1 from core.visitors where id = p_visitor and revoked_at is null) then perform core.fail('VISITOR_INVALID', 401); end if;
  for r in select app, procedure from core.visitor_claim_resolvers order by app loop
    perform set_config('core.visitor', p_visitor::text, true);
    begin
      execute format('select %s($1)', r.procedure) into v_out using jsonb_build_object('request_id', p_request);
    exception when others then
      perform set_config('core.visitor', '', true);
      raise;
    end;
    perform set_config('core.visitor', '', true);
    if v_out is not null and (v_out->>'guest_id') is not null then
      return v_out || jsonb_build_object('app', r.app);
    end if;
  end loop;
  perform core.fail('NOT_FOUND', 404, jsonb_build_object('reason', 'no accepted request with a guest for this visitor'));
end $$;

-- Enlaces de portal de un solo uso y con caducidad propia (la reclamación): expires_at manda sobre el resolutor; one_shot se
-- agota con el primer canje.
alter table core.portal_links add column expires_at timestamptz, add column one_shot boolean not null default false;

create or replace function core.portal_link_resolve(p_app text, p_digest text)
returns jsonb language plpgsql as $$
declare v_link core.portal_links; v_until timestamptz;
begin
  select * into v_link from core.portal_links where digest = p_digest and app = p_app for update;
  if v_link.id is null or v_link.revoked_at is not null then return null; end if;
  -- Un enlace solo abre una cuenta de portal: nunca la de alguien del personal (0103).
  if not core.is_portal_account(v_link.user_id) then return null; end if;
  if v_link.one_shot and v_link.last_used_at is not null then return null; end if;
  v_until := core.portal_link_valid_until(v_link);
  if v_link.expires_at is not null then v_until := v_link.expires_at; end if;
  if v_until is null or v_until < now() then return jsonb_build_object('expired', true, 'validUntil', v_until); end if;
  update core.portal_links set last_used_at = now() where id = v_link.id;
  if v_link.one_shot then
    insert into core.visitor_events (visitor_id, event, meta) select l.visitor_id, 'claim_redeemed', jsonb_build_object('linkId', v_link.id)
      from core.visitor_links l where l.guest_id = (v_link.scope->>'guest_id')::uuid and l.via = 'claim' and l.revoked_at is null;
  end if;
  return jsonb_build_object('userId', v_link.user_id, 'linkId', v_link.id, 'scope', v_link.scope, 'validUntil', v_until);
end $$;

-- Cierra la reclamación: vínculo (vía claim), enlace de portal de un solo uso (10 minutos) para la cuenta de portal del huésped
-- (la Edge la creó o reutilizó, nunca una cuenta del personal) y permiso en el portal.
create or replace function core.visitor_claim_finish(p_visitor uuid, p_app text, p_guest uuid, p_reservation uuid, p_user uuid, p_digest text)
returns jsonb language plpgsql as $$
declare v_scope jsonb; v_until timestamptz := now() + interval '10 minutes'; v_link core.portal_links;
begin
  if p_app <> 'guests' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'claims open the guests portal only')); end if;
  if not core.is_portal_account(p_user) and exists (select 1 from core.memberships where user_id = p_user) then
    perform core.fail('PORTAL_EMAIL_STAFF', 409, jsonb_build_object('reason', 'the account is not a portal account'));
  end if;
  if p_digest !~ '^[0-9a-f]{64}$' then perform core.fail('INVALID_OPERATION', 422); end if;
  perform core.visitor_link_set(p_visitor, p_app, p_guest, p_reservation, null, 'claim');
  v_scope := jsonb_build_object('reservation_id', p_reservation, 'guest_id', p_guest);
  insert into core.portal_links (app, user_id, digest, scope, label, created_by, issuer_app, expires_at, one_shot)
  values (p_app, p_user, p_digest, v_scope, 'Tu ficha está lista', p_user, p_app, v_until, true) returning * into v_link;
  perform core.portal_grant(p_app, p_user, v_scope, null);
  insert into core.visitor_events (visitor_id, event, meta) values (p_visitor, 'claimed', jsonb_build_object('guestId', p_guest, 'linkId', v_link.id));
  return jsonb_build_object('linkId', v_link.id, 'guestId', p_guest, 'reservationId', p_reservation, 'validUntil', v_until);
end $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- D · traspaso de la identidad entre dominios del proyecto (la carta de Flow enlaza a «Alójate aquí» de Guests): el navegador
-- de origen pide un código de un solo uso (5 minutos) y el de destino lo canjea por un token propio del mismo visitante.
create table core.visitor_handoffs (
  id uuid primary key default gen_random_uuid(),
  visitor_id uuid not null references core.visitors(id) on delete cascade,
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '5 minutes',
  ip text,                                                 -- el código solo se canjea desde la misma IP (mismo móvil, otro dominio)
  used_at timestamptz
);
alter table core.visitor_handoffs enable row level security;
revoke all on core.visitor_handoffs from public, anon, authenticated;
grant all on core.visitor_handoffs to service_role;

create or replace function core.visitor_handoff_create(p_visitor uuid, p_code_hash text, p_ip text default null)
returns timestamptz language plpgsql as $$
declare v_until timestamptz;
begin
  if p_code_hash !~ '^[0-9a-f]{64}$' then perform core.fail('INVALID_OPERATION', 422); end if;
  if not exists (select 1 from core.visitors where id = p_visitor and revoked_at is null) then perform core.fail('VISITOR_INVALID', 401); end if;
  if (select count(*) from core.visitor_handoffs where visitor_id = p_visitor and created_at > now() - interval '1 minute') >= 10 then
    perform core.fail('RATE_LIMITED', 429, jsonb_build_object('reason', 'too many handoffs'));
  end if;
  insert into core.visitor_handoffs (visitor_id, code_hash, ip) values (p_visitor, p_code_hash, nullif(p_ip, '')) returning expires_at into v_until;
  return v_until;
end $$;

-- Canje: el visitante del código, una sola vez, dentro del plazo y desde la misma IP que lo pidió (contra la fijación de
-- identidad: un enlace ajeno no puede plantar su visitante en otro móvil); null si no vale.
create or replace function core.visitor_handoff_redeem(p_code_hash text, p_ip text default null)
returns uuid language plpgsql as $$
declare v_visitor uuid;
begin
  update core.visitor_handoffs set used_at = now()
   where code_hash = p_code_hash and used_at is null and expires_at > now() and (ip is null or p_ip is null or ip = p_ip)
   returning visitor_id into v_visitor;
  return v_visitor;
end $$;

create or replace function public.core_visitor_handoff_create(p_visitor uuid, p_code_hash text, p_ip text default null) returns timestamptz
language sql security definer set search_path = '' as $$ select core.visitor_handoff_create(p_visitor, p_code_hash, p_ip) $$;
create or replace function public.core_visitor_handoff_redeem(p_code_hash text, p_ip text default null) returns uuid
language sql security definer set search_path = '' as $$ select core.visitor_handoff_redeem(p_code_hash, p_ip) $$;
revoke all on function core.visitor_handoff_create(uuid, text, text), core.visitor_handoff_redeem(text, text), public.core_visitor_handoff_create(uuid, text, text), public.core_visitor_handoff_redeem(text, text) from public, anon, authenticated;
grant execute on function public.core_visitor_handoff_create(uuid, text, text), public.core_visitor_handoff_redeem(text, text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Envoltorios para la Edge (service_role) y permisos.
create or replace function public.core_visitor_token_add(p_visitor uuid, p_token_hash text) returns void
language sql security definer set search_path = '' as $$ select core.visitor_token_add(p_visitor, p_token_hash) $$;
create or replace function public.core_visitor_token_revoke(p_token_hash text) returns boolean
language sql security definer set search_path = '' as $$ select core.visitor_token_revoke(p_token_hash) $$;
create or replace function public.core_visitor_email_request(p_email_hash text, p_ip text, p_visitor uuid default null) returns void
language sql security definer set search_path = '' as $$ select core.visitor_email_request(p_email_hash, p_ip, p_visitor) $$;
create or replace function public.core_visitor_email_link(p_visitor uuid, p_auth_user uuid) returns jsonb
language sql security definer set search_path = '' as $$ select core.visitor_email_link(p_visitor, p_auth_user) $$;
create or replace function public.core_visitor_email_forget(p_visitor uuid) returns void
language sql security definer set search_path = '' as $$ select core.visitor_email_forget(p_visitor) $$;
create or replace function public.core_visitor_me(p_visitor uuid) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.visitor_me(p_visitor) $$;
create or replace function public.core_visitor_link_set(p_visitor uuid, p_app text, p_guest uuid, p_reservation uuid, p_user uuid, p_via text) returns uuid
language sql security definer set search_path = '' as $$ select core.visitor_link_set(p_visitor, p_app, p_guest, p_reservation, p_user, p_via) $$;
create or replace function public.core_visitor_link_revoke(p_guest uuid, p_user uuid) returns integer
language sql security definer set search_path = '' as $$ select core.visitor_link_revoke(p_guest, p_user) $$;
create or replace function public.core_visitor_claim_resolve(p_visitor uuid, p_request uuid) returns jsonb
language sql security definer set search_path = '' as $$ select core.visitor_claim_resolve(p_visitor, p_request) $$;
create or replace function public.core_visitor_claim_finish(p_visitor uuid, p_app text, p_guest uuid, p_reservation uuid, p_user uuid, p_digest text) returns jsonb
language sql security definer set search_path = '' as $$ select core.visitor_claim_finish(p_visitor, p_app, p_guest, p_reservation, p_user, p_digest) $$;

revoke all on function core.visitor_token_add(uuid, text), core.visitor_token_revoke(text), core.visitor_email_request(text, text, uuid),
  core.visitor_email_link(uuid, uuid), core.visitor_email_forget(uuid), core.visitor_me(uuid), core.visitor_link_set(uuid, text, uuid, uuid, uuid, text),
  core.visitor_link_revoke(uuid, uuid), core.visitor_claim_resolve(uuid, uuid), core.visitor_claim_finish(uuid, text, uuid, uuid, uuid, text),
  core.allow_visitor_claim(text, text) from public, anon, authenticated;
revoke all on function public.core_visitor_token_add(uuid, text), public.core_visitor_token_revoke(text), public.core_visitor_email_request(text, text, uuid),
  public.core_visitor_email_link(uuid, uuid), public.core_visitor_email_forget(uuid), public.core_visitor_me(uuid),
  public.core_visitor_link_set(uuid, text, uuid, uuid, uuid, text), public.core_visitor_link_revoke(uuid, uuid),
  public.core_visitor_claim_resolve(uuid, uuid), public.core_visitor_claim_finish(uuid, text, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.core_visitor_token_add(uuid, text), public.core_visitor_token_revoke(text), public.core_visitor_email_request(text, text, uuid),
  public.core_visitor_email_link(uuid, uuid), public.core_visitor_email_forget(uuid), public.core_visitor_me(uuid),
  public.core_visitor_link_set(uuid, text, uuid, uuid, uuid, text), public.core_visitor_link_revoke(uuid, uuid),
  public.core_visitor_claim_resolve(uuid, uuid), public.core_visitor_claim_finish(uuid, text, uuid, uuid, uuid, text) to service_role;
grant execute on function core.visitor_guest_ids(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Retirar un procedimiento del navegador (FL8 de la auditoría: allow_procedure de funciones que ya no existen o que pasan a la Edge).
create or replace function core.disallow_procedure(p_app text, p_procedure text)
returns void language sql as $$
  delete from core.allowed_procedures where app = p_app and procedure = p_procedure
$$;
revoke all on function core.disallow_procedure(text, text) from public, anon, authenticated;
