-- Ikisai Core · visitantes anónimos (contrato C11; Visión V0.2 de Flow aprobada por VG el 27-10-2026).
-- Quien escanea el QR de un evento entra en ven.ikisai.com (o en la carta de Flow) sin invitación y sin cuenta: una
-- identidad anónima del núcleo con su token en el móvil. Un visitante nunca es miembro de nada: no tiene sesión de
-- Supabase, ni pertenencias, ni ámbitos. Solo sirve para dos cosas:
--   1. que las escrituras públicas (0094) lleven autor estable (visitor_id) y las apps puedan limitar «una por visitante»;
--   2. que las lecturas públicas de «lo mío» reciban su visitor_id, resuelto por la Edge a partir del token, nunca del cliente.
-- La Edge guarda solo el resumen SHA-256 del token; el token lo tiene únicamente el navegador. Sin datos personales:
-- la recuperación por correo y el paso a otro móvil quedan para la v2.

create table core.visitors (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  event_code text check (event_code is null or event_code ~ '^[A-Za-z0-9_-]{1,40}$'),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);
alter table core.visitors enable row level security;
revoke all on core.visitors from public, anon, authenticated;
grant all on core.visitors to service_role;

-- Alta: la Edge genera el token, lo resume y guarda el resumen. El código del evento es orientativo (de dónde entró).
-- Freno: como mucho 120 altas por minuto en total y 60 por código de evento (un QR en una pared no da para más; un
-- script sí). visitor_id identifica un móvil, no una persona: no garantiza unicidad y las apps no deben contar con ella.
create or replace function core.visitor_create(p_token_hash text, p_event_code text default null)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'token hash must be sha-256 hex')); end if;
  if (select count(*) from core.visitors where created_at > now() - interval '1 minute') >= 120
     or (p_event_code is not null and (select count(*) from core.visitors where event_code = p_event_code and created_at > now() - interval '1 minute') >= 60) then
    perform core.fail('RATE_LIMITED', 429, jsonb_build_object('reason', 'too many visitors created'));
  end if;
  insert into core.visitors (token_hash, event_code) values (p_token_hash, nullif(p_event_code, '')) returning id into v_id;
  return v_id;
end $$;

-- Resolución: {id, eventCode} o null si no existe o está revocado. Deja constancia de la última visita (como mucho una vez por minuto).
create or replace function core.visitor_resolve(p_token_hash text)
returns jsonb language plpgsql as $$
declare v core.visitors;
begin
  select * into v from core.visitors where token_hash = p_token_hash and revoked_at is null;
  if v.id is null then return null; end if;
  if v.last_seen_at < now() - interval '1 minute' then update core.visitors set last_seen_at = now() where id = v.id; end if;
  return jsonb_build_object('id', v.id, 'eventCode', v.event_code);
end $$;

create or replace function core.visitor_revoke(p_id uuid) returns void language sql as $$
  update core.visitors set revoked_at = coalesce(revoked_at, now()) where id = p_id
$$;

-- Lecturas públicas que el navegador puede pedir directamente (`GET /api/v1/public/<nombre>?args`), con sus argumentos.
-- Hasta ahora toda lectura pública la pedía código de la Edge que controlaba los argumentos (flow_mine recibe token_hash);
-- por eso exponerla al cliente es una decisión explícita de la app dueña: core.allow_public_read(nombre, fn, true).
alter table core.public_reads add column client boolean not null default false;
drop function core.allow_public_read(text, text);
create function core.allow_public_read(p_name text, p_procedure text, p_client boolean default false)
returns void language sql as $$
  insert into core.public_reads (name, procedure, client) values (p_name, p_procedure, p_client)
  on conflict (name) do update set procedure = excluded.procedure, client = excluded.client;
$$;
create or replace function core.public_read_client(p_name text, p_args jsonb)
returns jsonb language plpgsql stable as $$
begin
  if not exists (select 1 from core.public_reads where name = p_name and client) then perform core.fail('NOT_FOUND', 404, jsonb_build_object('name', p_name)); end if;
  return core.public_read(p_name, p_args);
end $$;
create or replace function public.core_public_read_client(p_name text, p_args jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.public_read_client(p_name, p_args) $$;
revoke all on function core.allow_public_read(text, text, boolean) from public, anon, authenticated;
revoke all on function core.public_read_client(text, jsonb) from public, anon, authenticated;
revoke all on function public.core_public_read_client(text, jsonb) from public, anon, authenticated;
grant execute on function public.core_public_read_client(text, jsonb) to service_role;

-- Para los hooks y disparadores de las apps: el visitante del lote público en curso (null si el lote no lleva visitante).
create or replace function core.current_visitor() returns uuid language sql stable as $$
  select nullif(current_setting('core.visitor', true), '')::uuid
$$;

-- El lote público puede llevar visitante: se expone a los hooks mientras dura el lote y queda en core.changes como contexto.
drop function if exists public.core_apply_public_operations(text, jsonb);
drop function if exists core.apply_public_operations(text, jsonb);
create or replace function core.apply_public_operations(p_app text, p_operations jsonb, p_visitor uuid default null)
returns jsonb language plpgsql as $$
declare
  v_actor uuid := core.service_actor(p_app);
  v_cursor bigint; v_next bigint; v_results jsonb; v_op jsonb;
  v_request text := 'public:' || p_app || ':' || gen_random_uuid();
begin
  if not exists (select 1 from core.public_writes where app = p_app) then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'app has no public writes', 'app', p_app));
  end if;
  if v_actor is null then perform core.fail('SERVICE_NOT_READY', 503, jsonb_build_object('service', p_app)); end if;
  if p_visitor is not null and not exists (select 1 from core.visitors where id = p_visitor and revoked_at is null) then
    perform core.fail('VISITOR_INVALID', 401, jsonb_build_object('reason', 'unknown or revoked visitor'));
  end if;
  if jsonb_typeof(p_operations) <> 'array' or jsonb_array_length(p_operations) = 0 or jsonb_array_length(p_operations) > 50 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'operations must be an array of 1 to 50'));
  end if;
  for v_op in select * from jsonb_array_elements(p_operations) loop
    if coalesce(v_op->>'op', '') not in ('insert', 'update') then
      perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'public batches take insert and update only', 'op', v_op->>'op'));
    end if;
    if not exists (select 1 from core.public_writes where app = p_app and table_name = v_op->>'table') then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'table not open to public writes', 'table', v_op->>'table'));
    end if;
  end loop;
  select cursor into v_cursor from core.app_state where app = p_app for update;
  v_next := v_cursor + 1;
  perform set_config('core.public', 'on', true);
  perform set_config('core.visitor', coalesce(p_visitor::text, ''), true);
  v_results := core.apply_operations(p_app, v_actor, 'editor', v_request, v_next, p_operations);
  perform set_config('core.public', 'off', true);
  perform set_config('core.visitor', '', true);
  update core.app_state set cursor = v_next where app = p_app;
  return jsonb_build_object('cursor', v_next, 'results', v_results);
exception when others then
  perform set_config('core.public', 'off', true);
  perform set_config('core.visitor', '', true);
  raise;
end $$;

create or replace function public.core_apply_public_operations(p_app text, p_operations jsonb, p_visitor uuid default null) returns jsonb
language sql security definer set search_path = '' as $$ select core.apply_public_operations(p_app, p_operations, p_visitor) $$;
create or replace function public.core_visitor_create(p_token_hash text, p_event_code text default null) returns uuid
language sql security definer set search_path = '' as $$ select core.visitor_create(p_token_hash, p_event_code) $$;
create or replace function public.core_visitor_resolve(p_token_hash text) returns jsonb
language sql security definer set search_path = '' as $$ select core.visitor_resolve(p_token_hash) $$;

revoke all on function core.visitor_create(text, text) from public, anon, authenticated;
revoke all on function core.visitor_resolve(text) from public, anon, authenticated;
revoke all on function core.visitor_revoke(uuid) from public, anon, authenticated;
revoke all on function core.apply_public_operations(text, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.core_apply_public_operations(text, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.core_visitor_create(text, text) from public, anon, authenticated;
revoke all on function public.core_visitor_resolve(text) from public, anon, authenticated;
grant execute on function public.core_apply_public_operations(text, jsonb, uuid) to service_role;
grant execute on function public.core_visitor_create(text, text) to service_role;
grant execute on function public.core_visitor_resolve(text) to service_role;
grant execute on function core.current_visitor() to service_role;
