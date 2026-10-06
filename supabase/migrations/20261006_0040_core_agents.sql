-- Ikisai Core · agentes de IA en el núcleo: claves de agente, ensayo de lotes (commit_preview), propuestas con aprobación
-- humana y registro de accesos. Base: docs/tasks/AGENTES.md (adoptada por Core el 6 de octubre de 2026); contrato §3 y §9.
-- Decisiones del usuario: umbral de lote masivo 10 filas (configurable por app), caducidad de las propuestas 24 horas.
-- Decisiones de Core: clave por agente con pertenencias por app (A1); procedimientos y acciones exigen aprobación salvo
-- que la app los marque seguros (A4); las propuestas se aprueban en la app a la que pertenecen (A5); commit_preview es
-- pieza general del contrato (A6).

-- ---------------------------------------------------------------------------
-- Columnas nuevas en tablas existentes
-- ---------------------------------------------------------------------------
alter table core.apps add column if not exists bulk_threshold int not null default 10 check (bulk_threshold between 1 and 10000);
-- `agent_confirmation`: un agente necesita propuesta aprobada para usar el procedimiento (commit `call`) o la acción (`invoke`).
alter table core.allowed_procedures add column if not exists agent_confirmation boolean not null default true;
alter table core.allowed_reads add column if not exists agent_confirmation boolean not null default true;

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------
create table core.agent_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,   -- usuario Auth sintético del agente
  name text not null check (length(btrim(name)) between 1 and 100),
  digest text not null unique check (digest ~ '^[0-9a-f]{64}$'),      -- sha256 de la clave; la clave no se guarda
  hint text not null,                                                   -- últimos 4 caracteres
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index agent_keys_user_idx on core.agent_keys (user_id);

create table core.proposals (
  id uuid primary key default gen_random_uuid(),
  app text not null references core.apps(id),
  user_id uuid not null references auth.users(id),                    -- el agente
  key_id uuid references core.agent_keys(id),
  request_id text not null,
  digest text not null,                                                 -- sha256(stable(operations)), el mismo que recibe core.commit
  operations jsonb not null,
  risk jsonb not null,                                                  -- { required, destructive, bulk, affected, bulkThreshold, reasons }
  summary jsonb not null,                                               -- cambios del ensayo: [{table, id, op, before, after}]
  status text not null check (status in ('pending','approved','rejected','consumed','revoked')),
  reason text,
  expires_at timestamptz not null,
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  consumed_cursor bigint,
  created_at timestamptz not null default now(),
  unique (app, user_id, request_id)
);
create index proposals_app_idx on core.proposals (app, created_at desc);

create table core.access_events (
  id bigint generated always as identity primary key,
  app text references core.apps(id),
  actor_id uuid references auth.users(id),
  key_id uuid references core.agent_keys(id),
  event text not null check (event in ('key_issued','key_revoked','member_invited','member_changed','proposal_prepared','proposal_approved','proposal_rejected','proposal_consumed','proposal_revoked')),
  meta jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index access_events_app_idx on core.access_events (app, id desc);

alter table core.agent_keys enable row level security;
alter table core.proposals enable row level security;
alter table core.access_events enable row level security;
revoke all on core.agent_keys, core.proposals, core.access_events from public, anon, authenticated;
grant all on core.agent_keys, core.proposals, core.access_events to service_role;

-- ---------------------------------------------------------------------------
-- Registro de accesos
-- ---------------------------------------------------------------------------
create or replace function core.log_access(p_app text, p_actor uuid, p_key uuid, p_event text, p_meta jsonb default '{}'::jsonb)
returns void language sql as $$
  insert into core.access_events (app, actor_id, key_id, event, meta) values (p_app, p_actor, p_key, p_event, coalesce(p_meta, '{}'::jsonb));
$$;

create or replace function core.access_log(p_app text, p_actor uuid, p_before bigint, p_limit int)
returns jsonb language plpgsql stable as $$
declare v_role text; v_limit int := greatest(1, least(coalesce(p_limit, 50), 200)); v_items jsonb; v_count int;
begin
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is distinct from 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only owners read the access log')); end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'event', e.event, 'actorId', e.actor_id, 'keyId', e.key_id, 'meta', e.meta) order by e.id desc), '[]'::jsonb), count(*)
    into v_items, v_count
    from (select * from core.access_events where app = p_app and (p_before is null or id < p_before) order by id desc limit v_limit + 1) e;
  if v_count > v_limit then v_items := (select jsonb_agg(t.x order by t.o) from jsonb_array_elements(v_items) with ordinality as t(x, o) where t.o <= v_limit); end if;
  return jsonb_build_object('items', coalesce(v_items, '[]'::jsonb), 'hasMore', v_count > v_limit,
    'nextBefore', case when v_count > v_limit then (v_items->(v_limit - 1)->>'id')::bigint else null end);
end $$;

-- ---------------------------------------------------------------------------
-- Claves de agente
-- ---------------------------------------------------------------------------
-- Identidad por clave: la Edge manda el sha256 de `ika_…`. Sin sesión ni refresco; revocación inmediata.
create or replace function core.agent_identity(p_digest text)
returns jsonb language plpgsql as $$
declare v_key core.agent_keys;
begin
  select * into v_key from core.agent_keys where digest = p_digest;
  if v_key.id is null then perform core.fail('UNAUTHORIZED', 401, jsonb_build_object('reason', 'unknown key')); end if;
  if v_key.revoked_at is not null then perform core.fail('UNAUTHORIZED', 401, jsonb_build_object('reason', 'revoked')); end if;
  if v_key.expires_at is not null and v_key.expires_at < now() then perform core.fail('UNAUTHORIZED', 401, jsonb_build_object('reason', 'expired')); end if;
  if v_key.last_used_at is null or v_key.last_used_at < now() - interval '1 minute' then
    update core.agent_keys set last_used_at = now() where id = v_key.id;
  end if;
  return jsonb_build_object('id', v_key.user_id, 'kind', 'agent', 'keyId', v_key.id, 'name', v_key.name);
end $$;

-- Alta: perfil `agent`, pertenencia a la app y, si viene digest, la clave. El usuario Auth lo crea la Edge (admin API).
-- Con p_digest null solo añade la pertenencia a esta app a un agente ya existente.
create or replace function core.agent_key_issue(p_app text, p_actor uuid, p_user uuid, p_name text, p_role text, p_scopes jsonb, p_digest text, p_hint text, p_expires_at timestamptz)
returns jsonb language plpgsql as $$
declare v_role text; v_kind text; v_key core.agent_keys; v_member core.memberships;
begin
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is distinct from 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only owners manage agents')); end if;
  if (select kind from core.profiles where user_id = p_actor) = 'agent' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'agents cannot manage agents')); end if;
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

-- Baja: revoca la clave (en todas las apps) y sus propuestas abiertas; con p_only_membership solo quita la pertenencia a esta app.
create or replace function core.agent_key_revoke(p_app text, p_actor uuid, p_key uuid, p_only_membership boolean)
returns jsonb language plpgsql as $$
declare v_role text; v_key core.agent_keys; v_revoked int;
begin
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is distinct from 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only owners manage agents')); end if;
  if (select kind from core.profiles where user_id = p_actor) = 'agent' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'agents cannot manage agents')); end if;
  select * into v_key from core.agent_keys where id = p_key;
  if v_key.id is null or not exists (select 1 from core.memberships where app = p_app and user_id = v_key.user_id) then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('keyId', p_key));
  end if;
  if coalesce(p_only_membership, false) then
    delete from core.memberships where app = p_app and user_id = v_key.user_id;
    update core.proposals set status = 'revoked', reason = 'membership removed' where app = p_app and user_id = v_key.user_id and status in ('pending','approved');
    get diagnostics v_revoked = row_count;
    perform core.log_access(p_app, p_actor, v_key.id, 'member_changed', jsonb_build_object('userId', v_key.user_id, 'removed', true, 'proposalsRevoked', v_revoked));
    return jsonb_build_object('keyId', v_key.id, 'revoked', v_key.revoked_at is not null, 'membershipRemoved', true, 'proposalsRevoked', v_revoked);
  end if;
  update core.agent_keys set revoked_at = coalesce(revoked_at, now()) where id = v_key.id;
  update core.proposals set status = 'revoked', reason = 'key revoked' where user_id = v_key.user_id and status in ('pending','approved');
  get diagnostics v_revoked = row_count;
  perform core.log_access(p_app, p_actor, v_key.id, 'key_revoked', jsonb_build_object('userId', v_key.user_id, 'proposalsRevoked', v_revoked));
  return jsonb_build_object('keyId', v_key.id, 'revoked', true, 'membershipRemoved', false, 'proposalsRevoked', v_revoked);
end $$;

create or replace function core.agent_list(p_app text, p_actor uuid)
returns jsonb language plpgsql stable as $$
declare v_role text;
begin
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is distinct from 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only owners list agents')); end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('keyId', k.id, 'userId', k.user_id, 'name', k.name, 'hint', k.hint, 'role', m.role, 'scopes', m.scopes,
            'createdAt', k.created_at, 'expiresAt', k.expires_at, 'lastUsedAt', k.last_used_at, 'revokedAt', k.revoked_at) order by k.created_at), '[]'::jsonb)
          from core.agent_keys k join core.memberships m on m.user_id = k.user_id and m.app = p_app);
end $$;

-- Un agente nunca es owner.
create or replace function core.set_membership(p_app text, p_actor uuid, p_user uuid, p_role text, p_scopes jsonb, p_display_name text)
returns jsonb language plpgsql as $$
declare v_role text;
begin
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is distinct from 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only owners manage memberships')); end if;
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

-- ---------------------------------------------------------------------------
-- Bootstrap: política de agentes (umbral y procedimientos/acciones seguros) para que la Edge calcule el riesgo
-- ---------------------------------------------------------------------------
create or replace function core.bootstrap(p_app text, p_user uuid)
returns jsonb language plpgsql stable as $$
declare v_member core.memberships; v_profile core.profiles; v_cursor bigint; v_tables jsonb; v_threshold int;
begin
  select * into v_member from core.memberships where app = p_app and user_id = p_user;
  if v_member.app is null then perform core.fail('NO_MEMBERSHIP', 403, jsonb_build_object('app', p_app)); end if;
  select * into v_profile from core.profiles where user_id = p_user;
  select cursor into v_cursor from core.app_state where app = p_app;
  select bulk_threshold into v_threshold from core.apps where id = p_app;
  select coalesce(jsonb_agg(jsonb_build_object('table', schema_name || '.' || table_name, 'writableColumns', to_jsonb(writable_columns), 'readable', v_member.role = any(readable_roles), 'writable', v_member.role = any(writable_roles)) order by schema_name, table_name), '[]'::jsonb)
    into v_tables from core.synced_tables where app = p_app;
  return jsonb_build_object(
    'app', p_app, 'cursor', v_cursor, 'serverTime', now(),
    'membership', jsonb_build_object('role', v_member.role, 'scopes', v_member.scopes, 'revision', v_member.revision),
    'profile', jsonb_build_object('userId', p_user, 'displayName', coalesce(v_profile.display_name, ''), 'kind', coalesce(v_profile.kind, 'human')),
    'tables', v_tables,
    'agentPolicy', jsonb_build_object('bulkThreshold', coalesce(v_threshold, 10),
      'safeProcedures', (select coalesce(jsonb_agg(procedure order by procedure), '[]'::jsonb) from core.allowed_procedures where app = p_app and not agent_confirmation),
      'safeActions', (select coalesce(jsonb_agg(name order by name), '[]'::jsonb) from core.allowed_reads where app = p_app and kind = 'action' and not agent_confirmation)));
end $$;

-- ---------------------------------------------------------------------------
-- Aplicación de un lote (compartida por commit y commit_preview)
-- ---------------------------------------------------------------------------
create or replace function core.apply_operations(p_app text, p_actor uuid, p_role text, p_request_id text, p_cursor bigint, p_operations jsonb)
returns jsonb language plpgsql as $$
declare v_op jsonb; v_results jsonb := '[]'::jsonb; v_result jsonb; v_proc text; v_hook text;
begin
  perform set_config('core.actor', p_actor::text, true);
  perform set_config('core.app', p_app, true);
  perform set_config('core.cursor', p_cursor::text, true);
  perform set_config('core.request_id', p_request_id, true);
  perform set_config('core.role', p_role, true);
  for v_op in select * from jsonb_array_elements(p_operations) loop
    if v_op->>'op' = 'call' then
      v_proc := v_op->>'procedure';
      if not exists (select 1 from core.allowed_procedures where app = p_app and procedure = v_proc) then
        perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'procedure not allowed', 'procedure', v_proc));
      end if;
      execute format('select %s($1)', v_proc) into v_result
        using jsonb_build_object('app', p_app, 'actor', p_actor, 'role', p_role, 'requestId', p_request_id, 'cursor', p_cursor, 'args', coalesce(v_op->'args', '{}'::jsonb));
      insert into core.changes (app, cursor, seq, actor_id, request_id, schema_name, table_name, row_id, op, revision, before, after)
      values (p_app, p_cursor, core.next_seq(p_app, p_cursor), p_actor, p_request_id, split_part(v_proc, '.', 1), split_part(v_proc, '.', 2), null, 'call', null, coalesce(v_op->'args', '{}'::jsonb), v_result);
      v_results := v_results || jsonb_build_object('op', 'call', 'procedure', v_proc, 'result', v_result);
    else
      v_result := core.apply_row_op(p_app, p_actor, p_role, p_request_id, p_cursor, v_op);
      v_results := v_results || (v_result - 'after');
    end if;
  end loop;
  for v_hook in select procedure from core.validate_hooks where app = p_app loop
    execute format('select %s($1)', v_hook) using jsonb_build_object('app', p_app, 'actor', p_actor, 'cursor', p_cursor);
  end loop;
  return v_results;
end $$;

-- Ensayo: valida y aplica el lote en una subtransacción que siempre se deshace; devuelve resultados y cambios (antes/después)
-- sin tocar cursor, recibos ni core.changes. Los errores de dominio (PT###) salen tal cual.
create or replace function core.commit_preview(p_app text, p_actor uuid, p_operations jsonb)
returns jsonb language plpgsql as $$
declare v_cursor bigint; v_role text; v_next bigint; v_results jsonb; v_changes jsonb;
begin
  if jsonb_typeof(p_operations) <> 'array' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'operations must be an array')); end if;
  if jsonb_array_length(p_operations) > 500 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'max 500 operations')); end if;
  select cursor into v_cursor from core.app_state where app = p_app;
  if v_cursor is null then perform core.fail('APP_NOT_FOUND', 404, jsonb_build_object('app', p_app)); end if;
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is null then perform core.fail('NO_MEMBERSHIP', 403, jsonb_build_object('app', p_app)); end if;
  if v_role = 'reader' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'readers cannot write')); end if;
  v_next := v_cursor + 1;
  begin
    v_results := core.apply_operations(p_app, p_actor, v_role, 'preview', v_next, p_operations);
    select coalesce(jsonb_agg(jsonb_build_object('seq', c.seq, 'table', c.schema_name || '.' || c.table_name, 'id', c.row_id, 'op', c.op, 'revision', c.revision, 'before', c.before, 'after', c.after) order by c.seq), '[]'::jsonb)
      into v_changes from core.changes c where c.app = p_app and c.cursor = v_next;
    raise exception using errcode = 'PV000', message = 'PREVIEW_ROLLBACK';
  exception when sqlstate 'PV000' then
    -- Las variables conservan su valor; la subtransacción (filas, cambios, secuencias) queda deshecha.
    return jsonb_build_object('cursor', v_cursor, 'results', v_results, 'changes', v_changes);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Commit con confirmación de agente
-- ---------------------------------------------------------------------------
-- p_confirmation = { required: boolean, id: uuid|null, risk: {...} }; lo calcula la Edge (regla del núcleo + hook agentRisk).
-- Para un actor `agent` con required=true debe existir una propuesta aprobada, no caducada, con el mismo requestId y digest;
-- se consume en la misma transacción. Un reintento de un lote ya aplicado devuelve el recibo sin pedir aprobación.
drop function if exists public.core_commit(text, uuid, text, text, bigint, jsonb);
drop function if exists core.commit(text, uuid, text, text, bigint, jsonb);
create or replace function core.commit(p_app text, p_actor uuid, p_request_id text, p_digest text, p_expected_cursor bigint, p_operations jsonb, p_confirmation jsonb default null)
returns jsonb language plpgsql as $$
declare
  v_cursor bigint; v_role text; v_kind text; v_receipt core.receipts; v_results jsonb; v_result jsonb; v_next bigint; v_changes jsonb;
  v_prop core.proposals; v_prop_id uuid;
begin
  if p_request_id is null or p_request_id !~ '^[A-Za-z0-9_.:-]{1,120}$' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid requestId')); end if;
  if jsonb_typeof(p_operations) <> 'array' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'operations must be an array')); end if;
  if jsonb_array_length(p_operations) > 500 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'max 500 operations')); end if;

  select cursor into v_cursor from core.app_state where app = p_app for update;
  if v_cursor is null then perform core.fail('APP_NOT_FOUND', 404, jsonb_build_object('app', p_app)); end if;

  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is null then perform core.fail('NO_MEMBERSHIP', 403, jsonb_build_object('app', p_app)); end if;
  if v_role = 'reader' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'readers cannot write')); end if;

  select * into v_receipt from core.receipts where app = p_app and actor_id = p_actor and request_id = p_request_id;
  if v_receipt.request_id is not null then
    if v_receipt.digest <> p_digest then perform core.fail('IDEMPOTENCY_REUSE', 409, jsonb_build_object('requestId', p_request_id)); end if;
    return v_receipt.result || jsonb_build_object('replayed', true);
  end if;

  if p_expected_cursor is not null and p_expected_cursor <> v_cursor then
    perform core.fail('CURSOR_CONFLICT', 409, jsonb_build_object('expectedCursor', p_expected_cursor, 'currentCursor', v_cursor));
  end if;

  select kind into v_kind from core.profiles where user_id = p_actor;
  if v_kind = 'agent' and coalesce((p_confirmation->>'required')::boolean, false) then
    begin v_prop_id := (p_confirmation->>'id')::uuid; exception when others then v_prop_id := null; end;
    if v_prop_id is not null then select * into v_prop from core.proposals where id = v_prop_id and app = p_app and user_id = p_actor for update; end if;
    if v_prop.id is null or v_prop.status <> 'approved' or v_prop.expires_at < now() or v_prop.request_id <> p_request_id or v_prop.digest <> p_digest then
      perform core.fail('CONFIRMATION_REQUIRED', 428, jsonb_build_object('risk', coalesce(p_confirmation->'risk', '{}'::jsonb), 'proposalId', v_prop.id,
        'proposalStatus', case when v_prop.id is null then null when v_prop.status in ('pending','approved') and v_prop.expires_at < now() then 'expired' else v_prop.status end,
        'mismatch', case when v_prop.id is null then null else jsonb_build_object('requestId', v_prop.request_id <> p_request_id, 'digest', v_prop.digest <> p_digest) end));
    end if;
  end if;

  v_next := v_cursor + 1;
  v_results := core.apply_operations(p_app, p_actor, v_role, p_request_id, v_next, p_operations);

  update core.app_state set cursor = v_next where app = p_app;
  select coalesce(jsonb_agg(jsonb_build_object('cursor', c.cursor, 'seq', c.seq, 'table', c.schema_name || '.' || c.table_name, 'id', c.row_id, 'op', c.op, 'revision', c.revision, 'after', c.after) order by c.seq), '[]'::jsonb)
    into v_changes from core.changes c where c.app = p_app and c.cursor = v_next;
  v_result := jsonb_build_object('cursor', v_next, 'requestId', p_request_id, 'results', v_results, 'changes', v_changes);
  if v_prop.id is not null then
    update core.proposals set status = 'consumed', consumed_cursor = v_next where id = v_prop.id;
    perform core.log_access(p_app, p_actor, v_prop.key_id, 'proposal_consumed', jsonb_build_object('proposalId', v_prop.id, 'cursor', v_next));
    v_result := v_result || jsonb_build_object('proposalId', v_prop.id);
  end if;
  insert into core.receipts (app, actor_id, request_id, digest, cursor, result) values (p_app, p_actor, p_request_id, p_digest, v_next, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Propuestas
-- ---------------------------------------------------------------------------
create or replace function core.proposal_json(p core.proposals)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', p.id, 'app', p.app, 'userId', p.user_id, 'keyId', p.key_id, 'requestId', p.request_id, 'digest', p.digest,
    'operations', p.operations, 'risk', p.risk, 'summary', p.summary,
    'status', case when p.status in ('pending','approved') and p.expires_at < now() then 'expired' else p.status end,
    'reason', p.reason, 'expiresAt', p.expires_at, 'decidedBy', p.decided_by, 'decidedAt', p.decided_at, 'consumedCursor', p.consumed_cursor, 'createdAt', p.created_at);
$$;

-- El agente prepara un lote que exige aprobación: se ensaya (commit_preview) y queda pendiente 24 horas. Idempotente por requestId.
create or replace function core.proposal_prepare(p_app text, p_actor uuid, p_key uuid, p_request_id text, p_digest text, p_operations jsonb, p_risk jsonb)
returns jsonb language plpgsql as $$
declare v_role text; v_prop core.proposals; v_preview jsonb;
begin
  if p_request_id is null or p_request_id !~ '^[A-Za-z0-9_.:-]{1,120}$' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid requestId')); end if;
  if (select kind from core.profiles where user_id = p_actor) is distinct from 'agent' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'proposals are for agents')); end if;
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is null then perform core.fail('NO_MEMBERSHIP', 403, jsonb_build_object('app', p_app)); end if;
  if v_role = 'reader' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'readers cannot write')); end if;
  if exists (select 1 from core.receipts where app = p_app and actor_id = p_actor and request_id = p_request_id) then
    perform core.fail('IDEMPOTENCY_REUSE', 409, jsonb_build_object('requestId', p_request_id, 'reason', 'already committed'));
  end if;
  select * into v_prop from core.proposals where app = p_app and user_id = p_actor and request_id = p_request_id;
  if v_prop.id is not null then
    if v_prop.digest <> p_digest then perform core.fail('IDEMPOTENCY_REUSE', 409, jsonb_build_object('requestId', p_request_id)); end if;
    return core.proposal_json(v_prop);
  end if;
  v_preview := core.commit_preview(p_app, p_actor, p_operations);
  insert into core.proposals (app, user_id, key_id, request_id, digest, operations, risk, summary, status, expires_at)
  values (p_app, p_actor, p_key, p_request_id, p_digest, p_operations, coalesce(p_risk, '{}'::jsonb), coalesce(v_preview->'changes', '[]'::jsonb), 'pending', now() + interval '24 hours')
  returning * into v_prop;
  perform core.log_access(p_app, p_actor, p_key, 'proposal_prepared', jsonb_build_object('proposalId', v_prop.id, 'requestId', p_request_id, 'operations', jsonb_array_length(p_operations), 'risk', coalesce(p_risk, '{}'::jsonb)));
  return core.proposal_json(v_prop);
end $$;

-- Una persona owner aprueba o rechaza. Aprobar vuelve a ensayar el lote: si ya no encaja, la propuesta queda rechazada y se devuelve con `autoRejected`.
create or replace function core.proposal_decide(p_app text, p_actor uuid, p_id uuid, p_decision text)
returns jsonb language plpgsql as $$
declare v_role text; v_prop core.proposals; v_status text; v_error text;
begin
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is distinct from 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only owners decide proposals')); end if;
  if (select kind from core.profiles where user_id = p_actor) = 'agent' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'agents cannot decide proposals')); end if;
  if p_decision not in ('approve','reject') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'decision must be approve or reject')); end if;
  select * into v_prop from core.proposals where id = p_id and app = p_app for update;
  if v_prop.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('proposalId', p_id)); end if;
  v_status := case when v_prop.status in ('pending','approved') and v_prop.expires_at < now() then 'expired' else v_prop.status end;
  if p_decision = 'reject' then
    if v_status not in ('pending','approved') then perform core.fail('PROPOSAL_UNAVAILABLE', 409, jsonb_build_object('proposalId', p_id, 'status', v_status)); end if;
    update core.proposals set status = 'rejected', reason = 'rejected by owner', decided_by = p_actor, decided_at = now() where id = p_id returning * into v_prop;
    perform core.log_access(p_app, p_actor, v_prop.key_id, 'proposal_rejected', jsonb_build_object('proposalId', p_id, 'previous', v_status));
    return core.proposal_json(v_prop);
  end if;
  if v_status <> 'pending' then perform core.fail('PROPOSAL_UNAVAILABLE', 409, jsonb_build_object('proposalId', p_id, 'status', v_status)); end if;
  begin
    perform core.commit_preview(p_app, v_prop.user_id, v_prop.operations);
  exception when others then
    if sqlstate !~ '^PT' then raise; end if;
    v_error := sqlerrm;
    -- Un fallo aquí haría rollback de la función entera, así que el rechazo automático se devuelve en vez de lanzarse;
    -- la Edge responde 409 PROPOSAL_UNAVAILABLE al ver `autoRejected`.
    update core.proposals set status = 'rejected', reason = 'no longer applies: ' || v_error, decided_by = p_actor, decided_at = now() where id = p_id returning * into v_prop;
    perform core.log_access(p_app, p_actor, v_prop.key_id, 'proposal_rejected', jsonb_build_object('proposalId', p_id, 'reason', v_error, 'automatic', true));
    return core.proposal_json(v_prop) || jsonb_build_object('autoRejected', true);
  end;
  update core.proposals set status = 'approved', decided_by = p_actor, decided_at = now() where id = p_id returning * into v_prop;
  perform core.log_access(p_app, p_actor, v_prop.key_id, 'proposal_approved', jsonb_build_object('proposalId', p_id));
  return core.proposal_json(v_prop);
end $$;

create or replace function core.proposal_list(p_app text, p_actor uuid, p_status text, p_limit int)
returns jsonb language plpgsql stable as $$
declare v_role text; v_kind text; v_limit int := greatest(1, least(coalesce(p_limit, 100), 200));
begin
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is null then perform core.fail('NO_MEMBERSHIP', 403, jsonb_build_object('app', p_app)); end if;
  select kind into v_kind from core.profiles where user_id = p_actor;
  if v_role <> 'owner' and v_kind is distinct from 'agent' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only owners and agents list proposals')); end if;
  return (select coalesce(jsonb_agg(core.proposal_json(p) order by p.created_at desc), '[]'::jsonb) from core.proposals p where p.id in (
    select q.id from core.proposals q where q.app = p_app and (v_role = 'owner' or q.user_id = p_actor)
      and (p_status is null or (case when q.status in ('pending','approved') and q.expires_at < now() then 'expired' else q.status end) = p_status)
    order by q.created_at desc limit v_limit));
end $$;

create or replace function core.proposal_get(p_app text, p_actor uuid, p_id uuid)
returns jsonb language plpgsql stable as $$
declare v_role text; v_prop core.proposals;
begin
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is null then perform core.fail('NO_MEMBERSHIP', 403, jsonb_build_object('app', p_app)); end if;
  select * into v_prop from core.proposals where id = p_id and app = p_app;
  if v_prop.id is null or (v_role <> 'owner' and v_prop.user_id <> p_actor) then perform core.fail('NOT_FOUND', 404, jsonb_build_object('proposalId', p_id)); end if;
  return core.proposal_json(v_prop);
end $$;

-- ---------------------------------------------------------------------------
-- invoke: un agente solo ejecuta acciones marcadas seguras (agent_confirmation = false)
-- ---------------------------------------------------------------------------
create or replace function core.invoke(p_app text, p_actor uuid, p_name text, p_args jsonb)
returns jsonb language plpgsql as $$
declare v_role text; v_def core.allowed_reads; v_result jsonb;
begin
  select * into v_def from core.allowed_reads where app = p_app and name = p_name;
  if v_def.app is null or v_def.kind <> 'action' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'action not allowed', 'name', p_name)); end if;
  if p_actor is null then
    v_role := 'system';
  else
    select role into v_role from core.memberships where app = p_app and user_id = p_actor;
    if v_role is null then perform core.fail('NO_MEMBERSHIP', 403, jsonb_build_object('app', p_app)); end if;
    if not (v_role = any(v_def.roles)) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('name', p_name)); end if;
    if v_def.agent_confirmation and (select kind from core.profiles where user_id = p_actor) = 'agent' then
      perform core.fail('CONFIRMATION_REQUIRED', 428, jsonb_build_object('name', p_name, 'reason', 'action requires human approval'));
    end if;
  end if;
  perform set_config('core.actor', coalesce(p_actor::text, ''), true);
  perform set_config('core.app', p_app, true);
  perform set_config('core.role', v_role, true);
  execute format('select %I.%I($1)', split_part(p_name, '.', 1), split_part(p_name, '.', 2)) into v_result
    using jsonb_build_object('app', p_app, 'actor', p_actor, 'role', v_role, 'args', coalesce(p_args, '{}'::jsonb));
  return coalesce(v_result, 'null'::jsonb);
end $$;

-- Helpers para que las apps marquen procedimientos y acciones seguros para agentes (sin aprobación).
create or replace function core.allow_procedure(p_app text, p_procedure text, p_agent_confirmation boolean default true)
returns void language sql as $$
  insert into core.allowed_procedures (app, procedure, agent_confirmation) values (p_app, p_procedure, p_agent_confirmation)
  on conflict (app, procedure) do update set agent_confirmation = excluded.agent_confirmation;
$$;
create or replace function core.allow_read(p_app text, p_name text, p_kind text, p_roles text[] default '{reader,editor,owner}', p_agent_confirmation boolean default true)
returns void language sql as $$
  insert into core.allowed_reads (app, name, kind, roles, agent_confirmation) values (p_app, p_name, p_kind, p_roles, p_agent_confirmation)
  on conflict (app, name) do update set kind = excluded.kind, roles = excluded.roles, agent_confirmation = excluded.agent_confirmation;
$$;
drop function if exists core.allow_procedure(text, text);
drop function if exists core.allow_read(text, text, text, text[]);

-- ---------------------------------------------------------------------------
-- Wrappers public.core_* (solo service_role)
-- ---------------------------------------------------------------------------
create or replace function public.core_commit(p_app text, p_actor uuid, p_request_id text, p_digest text, p_expected_cursor bigint, p_operations jsonb, p_confirmation jsonb default null) returns jsonb
language sql security definer set search_path = '' as $$ select core.commit(p_app, p_actor, p_request_id, p_digest, p_expected_cursor, p_operations, p_confirmation) $$;
create or replace function public.core_commit_preview(p_app text, p_actor uuid, p_operations jsonb) returns jsonb
language sql security definer set search_path = '' as $$ select core.commit_preview(p_app, p_actor, p_operations) $$;
create or replace function public.core_agent_identity(p_digest text) returns jsonb
language sql security definer set search_path = '' as $$ select core.agent_identity(p_digest) $$;
create or replace function public.core_agent_key_issue(p_app text, p_actor uuid, p_user uuid, p_name text, p_role text, p_scopes jsonb, p_digest text, p_hint text, p_expires_at timestamptz) returns jsonb
language sql security definer set search_path = '' as $$ select core.agent_key_issue(p_app, p_actor, p_user, p_name, p_role, p_scopes, p_digest, p_hint, p_expires_at) $$;
create or replace function public.core_agent_key_revoke(p_app text, p_actor uuid, p_key uuid, p_only_membership boolean) returns jsonb
language sql security definer set search_path = '' as $$ select core.agent_key_revoke(p_app, p_actor, p_key, p_only_membership) $$;
create or replace function public.core_agent_list(p_app text, p_actor uuid) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.agent_list(p_app, p_actor) $$;
create or replace function public.core_proposal_prepare(p_app text, p_actor uuid, p_key uuid, p_request_id text, p_digest text, p_operations jsonb, p_risk jsonb) returns jsonb
language sql security definer set search_path = '' as $$ select core.proposal_prepare(p_app, p_actor, p_key, p_request_id, p_digest, p_operations, p_risk) $$;
create or replace function public.core_proposal_decide(p_app text, p_actor uuid, p_id uuid, p_decision text) returns jsonb
language sql security definer set search_path = '' as $$ select core.proposal_decide(p_app, p_actor, p_id, p_decision) $$;
create or replace function public.core_proposal_list(p_app text, p_actor uuid, p_status text, p_limit int) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.proposal_list(p_app, p_actor, p_status, p_limit) $$;
create or replace function public.core_proposal_get(p_app text, p_actor uuid, p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.proposal_get(p_app, p_actor, p_id) $$;
create or replace function public.core_access_log(p_app text, p_actor uuid, p_before bigint, p_limit int) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.access_log(p_app, p_actor, p_before, p_limit) $$;

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
