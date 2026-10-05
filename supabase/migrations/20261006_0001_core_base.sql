-- Ikisai Core · base del núcleo de sincronización (contrato v0.1, docs/core/CONTRATO_SINCRONIZACION.md)
-- Esta migración toca únicamente el schema core y los wrappers public.core_* para PostgREST.

create schema if not exists core;
revoke all on schema core from public;
revoke all on schema core from anon, authenticated;
grant usage on schema core to service_role;

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------
create table core.apps (
  id text primary key check (id ~ '^[a-z][a-z0-9_]{1,30}$'),
  name text not null,
  domain text,
  created_at timestamptz not null default now()
);

create table core.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  kind text not null default 'human' check (kind in ('human','agent')),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table core.memberships (
  app text not null references core.apps(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('reader','editor','owner')),
  scopes jsonb,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (app, user_id)
);

create table core.app_state (
  app text primary key references core.apps(id),
  cursor bigint not null default 0
);

create table core.synced_tables (
  app text not null references core.apps(id),
  schema_name text not null,
  table_name text not null,
  writable_columns text[] not null,
  readable_roles text[] not null default '{reader,editor,owner}',
  writable_roles text[] not null default '{editor,owner}',
  never_purge boolean not null default false,
  primary key (app, schema_name, table_name)
);

create table core.allowed_procedures (
  app text not null references core.apps(id),
  procedure text not null check (procedure ~ '^[a-z_]+\.[a-z0-9_]+$'),
  primary key (app, procedure)
);

create table core.validate_hooks (
  app text not null references core.apps(id),
  procedure text not null check (procedure ~ '^[a-z_]+\.[a-z0-9_]+$'),
  primary key (app, procedure)
);

create table core.code_sequences (
  prefix text not null check (prefix ~ '^[A-Z]{2,6}$'),
  year int not null,
  last int not null default 0,
  primary key (prefix, year)
);

create table core.changes (
  app text not null,
  cursor bigint not null,
  seq int not null,
  committed_at timestamptz not null default now(),
  actor_id uuid,
  request_id text,
  schema_name text not null,
  table_name text not null,
  row_id uuid,
  op text not null check (op in ('insert','update','delete','restore','call','purge')),
  revision bigint,
  before jsonb,
  after jsonb,
  primary key (app, cursor, seq)
);
create index changes_row_idx on core.changes (app, schema_name, table_name, row_id);
create index changes_actor_idx on core.changes (app, actor_id, cursor);

create table core.receipts (
  app text not null,
  actor_id uuid not null,
  request_id text not null,
  digest text not null,
  cursor bigint,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (app, actor_id, request_id)
);

alter table core.apps enable row level security;
alter table core.profiles enable row level security;
alter table core.memberships enable row level security;
alter table core.app_state enable row level security;
alter table core.synced_tables enable row level security;
alter table core.allowed_procedures enable row level security;
alter table core.validate_hooks enable row level security;
alter table core.code_sequences enable row level security;
alter table core.changes enable row level security;
alter table core.receipts enable row level security;
revoke all on all tables in schema core from public, anon, authenticated;
grant all on all tables in schema core to service_role;

-- ---------------------------------------------------------------------------
-- Errores
-- ---------------------------------------------------------------------------
-- PostgREST traduce SQLSTATE PTxxx al estado HTTP xxx. message = código de dominio, detail = JSON.
create or replace function core.fail(p_code text, p_http int, p_details jsonb default null)
returns void language plpgsql as $$
begin
  raise exception using errcode = 'PT' || p_http::text, message = p_code, detail = coalesce(p_details, '{}'::jsonb)::text;
end $$;

-- ---------------------------------------------------------------------------
-- Trigger de revisión
-- ---------------------------------------------------------------------------
create or replace function core.touch_revision()
returns trigger language plpgsql as $$
declare v_actor text := current_setting('core.actor', true);
begin
  new.revision := old.revision + 1;
  new.updated_at := now();
  new.created_at := old.created_at;
  if v_actor is not null and v_actor <> '' then new.updated_by := v_actor::uuid; end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Registro de apps y tablas (helpers que las migraciones de app pueden llamar)
-- ---------------------------------------------------------------------------
create or replace function core.ensure_app(p_app text, p_name text, p_domain text default null)
returns void language plpgsql as $$
begin
  insert into core.apps (id, name, domain) values (p_app, p_name, p_domain)
  on conflict (id) do update set name = excluded.name, domain = coalesce(excluded.domain, core.apps.domain);
  insert into core.app_state (app) values (p_app) on conflict do nothing;
end $$;

-- Registra una tabla sincronizable: comprueba columnas obligatorias, crea el trigger, activa RLS y revoca accesos.
create or replace function core.register_table(
  p_app text, p_schema text, p_table text, p_writable_columns text[],
  p_readable_roles text[] default '{reader,editor,owner}',
  p_writable_roles text[] default '{editor,owner}',
  p_never_purge boolean default false)
returns void language plpgsql as $$
declare v_missing text[]; v_col text; v_cols text[];
begin
  if p_schema !~ '^[a-z_]+$' or p_table !~ '^[a-z0-9_]+$' then perform core.fail('INVALID_TABLE', 422); end if;
  if to_regclass(format('%I.%I', p_schema, p_table)) is null then perform core.fail('TABLE_NOT_FOUND', 422, jsonb_build_object('table', p_schema || '.' || p_table)); end if;
  select array_agg(column_name::text) into v_cols from information_schema.columns where table_schema = p_schema and table_name = p_table;
  select array_agg(c) into v_missing from unnest(array['id','revision','created_at','updated_at','updated_by','deleted_at']) c where not (c = any(v_cols));
  if v_missing is not null then perform core.fail('TABLE_NOT_SYNCABLE', 422, jsonb_build_object('missing', to_jsonb(v_missing))); end if;
  foreach v_col in array p_writable_columns loop
    if not (v_col = any(v_cols)) then perform core.fail('INVALID_WRITABLE_COLUMN', 422, jsonb_build_object('column', v_col)); end if;
    if v_col in ('id','revision','created_at','updated_at','updated_by','deleted_at') then perform core.fail('INVALID_WRITABLE_COLUMN', 422, jsonb_build_object('column', v_col)); end if;
  end loop;
  execute format('drop trigger if exists core_touch_revision on %I.%I', p_schema, p_table);
  execute format('create trigger core_touch_revision before update on %I.%I for each row execute function core.touch_revision()', p_schema, p_table);
  execute format('alter table %I.%I enable row level security', p_schema, p_table);
  execute format('revoke all on %I.%I from public, anon, authenticated', p_schema, p_table);
  execute format('grant all on %I.%I to service_role', p_schema, p_table);
  insert into core.synced_tables (app, schema_name, table_name, writable_columns, readable_roles, writable_roles, never_purge)
  values (p_app, p_schema, p_table, p_writable_columns, p_readable_roles, p_writable_roles, p_never_purge)
  on conflict (app, schema_name, table_name) do update
    set writable_columns = excluded.writable_columns, readable_roles = excluded.readable_roles,
        writable_roles = excluded.writable_roles, never_purge = excluded.never_purge;
end $$;

create or replace function core.allow_procedure(p_app text, p_procedure text)
returns void language sql as $$
  insert into core.allowed_procedures (app, procedure) values (p_app, p_procedure) on conflict do nothing;
$$;

create or replace function core.add_validate_hook(p_app text, p_procedure text)
returns void language sql as $$
  insert into core.validate_hooks (app, procedure) values (p_app, p_procedure) on conflict do nothing;
$$;

-- ---------------------------------------------------------------------------
-- Códigos humanos
-- ---------------------------------------------------------------------------
create or replace function core.next_code(p_prefix text, p_year int default null)
returns text language plpgsql as $$
declare v_year int := coalesce(p_year, extract(year from now())::int); v_last int;
begin
  insert into core.code_sequences (prefix, year, last) values (p_prefix, v_year, 1)
  on conflict (prefix, year) do update set last = core.code_sequences.last + 1
  returning last into v_last;
  return format('%s_%s_%s', p_prefix, v_year, lpad(v_last::text, 3, '0'));
end $$;

-- ---------------------------------------------------------------------------
-- Sesiones
-- ---------------------------------------------------------------------------
create or replace function core.session_active(p_user uuid, p_session uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.sessions s
    where s.id = p_session and s.user_id = p_user and (s.not_after is null or s.not_after > now()));
$$;

-- ---------------------------------------------------------------------------
-- Operaciones fila a fila
-- ---------------------------------------------------------------------------
create or replace function core.table_def(p_app text, p_table text)
returns core.synced_tables language plpgsql as $$
declare v_def core.synced_tables; v_parts text[];
begin
  v_parts := string_to_array(p_table, '.');
  if array_length(v_parts, 1) <> 2 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'table must be schema.table', 'table', p_table)); end if;
  select * into v_def from core.synced_tables where app = p_app and schema_name = v_parts[1] and table_name = v_parts[2];
  if v_def.app is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'table not registered', 'table', p_table)); end if;
  return v_def;
end $$;

create or replace function core.next_seq(p_app text, p_cursor bigint)
returns int language sql as $$
  select coalesce(max(seq), 0) + 1 from core.changes where app = p_app and cursor = p_cursor;
$$;

-- Aplica una operación de fila. p_cursor es el cursor que recibirá el lote (actual + 1).
create or replace function core.apply_row_op(p_app text, p_actor uuid, p_role text, p_request_id text, p_cursor bigint, p_op jsonb)
returns jsonb language plpgsql as $$
declare
  v_def core.synced_tables; v_op text := p_op->>'op'; v_id uuid; v_fields jsonb := coalesce(p_op->'fields', '{}'::jsonb);
  v_before jsonb; v_after jsonb; v_key text; v_cols text[] := '{}'; v_expected bigint; v_qualified text; v_sql text;
begin
  if v_op not in ('insert','update','delete','restore') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'unknown op', 'op', v_op)); end if;
  v_def := core.table_def(p_app, p_op->>'table');
  v_qualified := format('%I.%I', v_def.schema_name, v_def.table_name);
  if not (p_role = any(v_def.writable_roles)) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', p_op->>'table')); end if;
  begin v_id := (p_op->>'id')::uuid; exception when others then v_id := null; end;
  if v_id is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'id must be a uuid')); end if;
  if jsonb_typeof(v_fields) <> 'object' then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('reason', 'fields must be an object')); end if;
  for v_key in select jsonb_object_keys(v_fields) loop
    if not (v_key = any(v_def.writable_columns)) then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', v_key, 'table', p_op->>'table')); end if;
    v_cols := v_cols || v_key;
  end loop;
  if v_op in ('delete','restore') and array_length(v_cols, 1) is not null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('reason', 'delete/restore take no fields')); end if;

  if v_op = 'insert' then
    execute format('select to_jsonb(t) from %s t where id = $1', v_qualified) into v_before using v_id;
    if v_before is not null then perform core.fail('ROW_EXISTS', 409, jsonb_build_object('table', p_op->>'table', 'id', v_id)); end if;
    v_fields := v_fields || jsonb_build_object('id', v_id, 'updated_by', p_actor);
    v_cols := v_cols || array['id','updated_by'];
    v_sql := format('insert into %s (%s) select %s from jsonb_populate_record(null::%s, $1) returning to_jsonb(%I.*)',
      v_qualified, (select string_agg(format('%I', c), ',') from unnest(v_cols) c), (select string_agg(format('%I', c), ',') from unnest(v_cols) c), v_qualified, v_def.table_name);
    execute v_sql into v_after using v_fields;
  else
    execute format('select to_jsonb(t) from %s t where id = $1 for update', v_qualified) into v_before using v_id;
    if v_before is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', p_op->>'table', 'id', v_id)); end if;
    if p_op->>'expectedRevision' is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'expectedRevision required', 'id', v_id)); end if;
    v_expected := (p_op->>'expectedRevision')::bigint;
    if (v_before->>'revision')::bigint <> v_expected then
      perform core.fail('VERSION_CONFLICT', 409, jsonb_build_object('table', p_op->>'table', 'id', v_id, 'expectedRevision', v_expected, 'currentRevision', (v_before->>'revision')::bigint, 'current', v_before));
    end if;
    if v_op = 'update' then
      if v_before->>'deleted_at' is not null then perform core.fail('ROW_DELETED', 409, jsonb_build_object('table', p_op->>'table', 'id', v_id, 'current', v_before)); end if;
      if array_length(v_cols, 1) is null then
        v_after := v_before;
      else
        v_sql := format('update %s set (%s) = (select %s from jsonb_populate_record(null::%s, $1)) where id = $2 returning to_jsonb(%I.*)',
          v_qualified, (select string_agg(format('%I', c), ',') from unnest(v_cols) c), (select string_agg(format('%I', c), ',') from unnest(v_cols) c), v_qualified, v_def.table_name);
        if array_length(v_cols, 1) = 1 then
          v_sql := format('update %s set %I = (select %I from jsonb_populate_record(null::%s, $1)) where id = $2 returning to_jsonb(%I.*)', v_qualified, v_cols[1], v_cols[1], v_qualified, v_def.table_name);
        end if;
        execute v_sql into v_after using v_fields, v_id;
      end if;
    elsif v_op = 'delete' then
      if v_before->>'deleted_at' is not null then perform core.fail('ROW_DELETED', 409, jsonb_build_object('table', p_op->>'table', 'id', v_id, 'current', v_before)); end if;
      execute format('update %s set deleted_at = now() where id = $1 returning to_jsonb(%I.*)', v_qualified, v_def.table_name) into v_after using v_id;
    else
      if v_before->>'deleted_at' is null then perform core.fail('ROW_NOT_DELETED', 409, jsonb_build_object('table', p_op->>'table', 'id', v_id, 'current', v_before)); end if;
      execute format('update %s set deleted_at = null where id = $1 returning to_jsonb(%I.*)', v_qualified, v_def.table_name) into v_after using v_id;
    end if;
  end if;

  insert into core.changes (app, cursor, seq, actor_id, request_id, schema_name, table_name, row_id, op, revision, before, after)
  values (p_app, p_cursor, core.next_seq(p_app, p_cursor), p_actor, p_request_id, v_def.schema_name, v_def.table_name, v_id, v_op, (v_after->>'revision')::bigint, v_before, v_after);
  return jsonb_build_object('op', v_op, 'table', p_op->>'table', 'id', v_id, 'revision', (v_after->>'revision')::bigint, 'after', v_after);
end $$;

-- ---------------------------------------------------------------------------
-- Commit
-- ---------------------------------------------------------------------------
create or replace function core.commit(p_app text, p_actor uuid, p_request_id text, p_digest text, p_expected_cursor bigint, p_operations jsonb)
returns jsonb language plpgsql as $$
declare
  v_cursor bigint; v_role text; v_receipt core.receipts; v_op jsonb; v_results jsonb := '[]'::jsonb; v_result jsonb;
  v_proc text; v_hook text; v_next bigint; v_changes jsonb; v_count int := 0;
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

  v_next := v_cursor + 1;
  perform set_config('core.actor', p_actor::text, true);
  perform set_config('core.app', p_app, true);
  perform set_config('core.cursor', v_next::text, true);
  perform set_config('core.request_id', p_request_id, true);
  perform set_config('core.role', v_role, true);

  for v_op in select * from jsonb_array_elements(p_operations) loop
    v_count := v_count + 1;
    if v_op->>'op' = 'call' then
      v_proc := v_op->>'procedure';
      if not exists (select 1 from core.allowed_procedures where app = p_app and procedure = v_proc) then
        perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'procedure not allowed', 'procedure', v_proc));
      end if;
      execute format('select %s($1)', v_proc) into v_result
        using jsonb_build_object('app', p_app, 'actor', p_actor, 'role', v_role, 'requestId', p_request_id, 'cursor', v_next, 'args', coalesce(v_op->'args', '{}'::jsonb));
      insert into core.changes (app, cursor, seq, actor_id, request_id, schema_name, table_name, row_id, op, revision, before, after)
      values (p_app, v_next, core.next_seq(p_app, v_next), p_actor, p_request_id, split_part(v_proc, '.', 1), split_part(v_proc, '.', 2), null, 'call', null, coalesce(v_op->'args', '{}'::jsonb), v_result);
      v_results := v_results || jsonb_build_object('op', 'call', 'procedure', v_proc, 'result', v_result);
    else
      v_result := core.apply_row_op(p_app, p_actor, v_role, p_request_id, v_next, v_op);
      v_results := v_results || (v_result - 'after');
    end if;
  end loop;

  for v_hook in select procedure from core.validate_hooks where app = p_app loop
    execute format('select %s($1)', v_hook) using jsonb_build_object('app', p_app, 'actor', p_actor, 'cursor', v_next);
  end loop;

  update core.app_state set cursor = v_next where app = p_app;
  select coalesce(jsonb_agg(jsonb_build_object('cursor', c.cursor, 'seq', c.seq, 'table', c.schema_name || '.' || c.table_name, 'id', c.row_id, 'op', c.op, 'revision', c.revision, 'after', c.after) order by c.seq), '[]'::jsonb)
    into v_changes from core.changes c where c.app = p_app and c.cursor = v_next;
  v_result := jsonb_build_object('cursor', v_next, 'requestId', p_request_id, 'results', v_results, 'changes', v_changes);
  insert into core.receipts (app, actor_id, request_id, digest, cursor, result) values (p_app, p_actor, p_request_id, p_digest, v_next, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Lectura
-- ---------------------------------------------------------------------------
create or replace function core.bootstrap(p_app text, p_user uuid)
returns jsonb language plpgsql stable as $$
declare v_member core.memberships; v_profile core.profiles; v_cursor bigint; v_tables jsonb;
begin
  select * into v_member from core.memberships where app = p_app and user_id = p_user;
  if v_member.app is null then perform core.fail('NO_MEMBERSHIP', 403, jsonb_build_object('app', p_app)); end if;
  select * into v_profile from core.profiles where user_id = p_user;
  select cursor into v_cursor from core.app_state where app = p_app;
  select coalesce(jsonb_agg(jsonb_build_object('table', schema_name || '.' || table_name, 'writableColumns', to_jsonb(writable_columns), 'readable', v_member.role = any(readable_roles), 'writable', v_member.role = any(writable_roles)) order by schema_name, table_name), '[]'::jsonb)
    into v_tables from core.synced_tables where app = p_app;
  return jsonb_build_object(
    'app', p_app, 'cursor', v_cursor, 'serverTime', now(),
    'membership', jsonb_build_object('role', v_member.role, 'scopes', v_member.scopes, 'revision', v_member.revision),
    'profile', jsonb_build_object('userId', p_user, 'displayName', coalesce(v_profile.display_name, ''), 'kind', coalesce(v_profile.kind, 'human')),
    'tables', v_tables);
end $$;

-- Filas de una tabla para el espejo local. Sin visibilidad por ámbitos: eso lo aplica la Edge de cada app.
create or replace function core.snapshot_table(p_app text, p_role text, p_table text, p_include_deleted boolean, p_limit int, p_offset int)
returns jsonb language plpgsql stable as $$
declare v_def core.synced_tables; v_rows jsonb; v_total bigint;
begin
  v_def := core.table_def(p_app, p_table);
  if not (p_role = any(v_def.readable_roles)) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', p_table)); end if;
  execute format('select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.id), ''[]''::jsonb) from (select * from %I.%I where ($1 or deleted_at is null) order by created_at, id limit $2 offset $3) t', v_def.schema_name, v_def.table_name)
    into v_rows using p_include_deleted, greatest(1, least(coalesce(p_limit, 500), 2000)), greatest(0, coalesce(p_offset, 0));
  execute format('select count(*) from %I.%I where ($1 or deleted_at is null)', v_def.schema_name, v_def.table_name) into v_total using p_include_deleted;
  return jsonb_build_object('table', p_table, 'rows', v_rows, 'total', v_total);
end $$;

create or replace function core.changes_since(p_app text, p_role text, p_after bigint, p_limit int)
returns jsonb language plpgsql stable as $$
declare v_items jsonb; v_cursor bigint; v_last bigint;
begin
  select cursor into v_cursor from core.app_state where app = p_app;
  select coalesce(jsonb_agg(jsonb_build_object('cursor', c.cursor, 'seq', c.seq, 'at', c.committed_at, 'actorId', c.actor_id, 'requestId', c.request_id, 'table', c.schema_name || '.' || c.table_name, 'id', c.row_id, 'op', c.op, 'revision', c.revision, 'after', c.after) order by c.cursor, c.seq), '[]'::jsonb), max(c.cursor)
    into v_items, v_last
    from (select * from core.changes where app = p_app and cursor > coalesce(p_after, 0) and op <> 'call'
            and exists (select 1 from core.synced_tables s where s.app = p_app and s.schema_name = core.changes.schema_name and s.table_name = core.changes.table_name and p_role = any(s.readable_roles))
          order by cursor, seq limit greatest(1, least(coalesce(p_limit, 500), 2000))) c;
  return jsonb_build_object('items', v_items, 'cursor', coalesce(v_last, coalesce(p_after, 0)), 'latest', v_cursor, 'hasMore', coalesce(v_last, 0) < v_cursor and v_items <> '[]'::jsonb);
end $$;

create or replace function core.history(p_app text, p_role text, p_before bigint, p_limit int)
returns jsonb language plpgsql stable as $$
declare v_items jsonb; v_first bigint;
begin
  select coalesce(jsonb_agg(b order by (b->>'cursor')::bigint desc), '[]'::jsonb), min((b->>'cursor')::bigint) into v_items, v_first from (
    select jsonb_build_object('cursor', g.cursor, 'at', g.at, 'actorId', g.actor_id, 'requestId', g.request_id, 'changes', g.changes) b
    from (
      select c.cursor, min(c.committed_at) at, min(c.actor_id::text)::uuid actor_id, min(c.request_id) request_id,
             jsonb_agg(jsonb_build_object('seq', c.seq, 'table', c.schema_name || '.' || c.table_name, 'id', c.row_id, 'op', c.op, 'revision', c.revision, 'before', c.before, 'after', c.after) order by c.seq) changes
      from core.changes c
      where c.app = p_app and c.cursor < coalesce(p_before, 9223372036854775807)
        and (c.op = 'call' or exists (select 1 from core.synced_tables s where s.app = p_app and s.schema_name = c.schema_name and s.table_name = c.table_name and p_role = any(s.readable_roles)))
      group by c.cursor order by c.cursor desc limit greatest(1, least(coalesce(p_limit, 50), 200)) ) g ) x;
  return jsonb_build_object('items', v_items, 'nextBefore', v_first, 'hasMore', coalesce(v_first, 1) > 1);
end $$;

-- Plan de deshacer: operaciones inversas con la revisión actual de cada fila.
create or replace function core.undo_plan(p_app text, p_cursor bigint)
returns jsonb language plpgsql stable as $$
declare c record; v_ops jsonb := '[]'::jsonb; v_current jsonb; v_def core.synced_tables; v_fields jsonb; v_col text;
begin
  if not exists (select 1 from core.changes where app = p_app and cursor = p_cursor) then perform core.fail('NOT_FOUND', 404, jsonb_build_object('cursor', p_cursor)); end if;
  for c in select * from core.changes where app = p_app and cursor = p_cursor order by seq desc loop
    if c.op = 'call' then perform core.fail('UNDO_UNAVAILABLE', 409, jsonb_build_object('reason', 'batch contains a procedure call', 'cursor', p_cursor)); end if;
    if c.op = 'purge' then perform core.fail('UNDO_UNAVAILABLE', 409, jsonb_build_object('reason', 'purged rows cannot be restored', 'cursor', p_cursor)); end if;
    execute format('select to_jsonb(t) from %I.%I t where id = $1', c.schema_name, c.table_name) into v_current using c.row_id;
    if v_current is null then perform core.fail('UNDO_UNAVAILABLE', 409, jsonb_build_object('reason', 'row no longer exists', 'id', c.row_id)); end if;
    if c.op = 'insert' then
      v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', c.schema_name || '.' || c.table_name, 'id', c.row_id, 'expectedRevision', (v_current->>'revision')::bigint);
    elsif c.op = 'delete' then
      v_ops := v_ops || jsonb_build_object('op', 'restore', 'table', c.schema_name || '.' || c.table_name, 'id', c.row_id, 'expectedRevision', (v_current->>'revision')::bigint);
    elsif c.op = 'restore' then
      v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', c.schema_name || '.' || c.table_name, 'id', c.row_id, 'expectedRevision', (v_current->>'revision')::bigint);
    else
      select * into v_def from core.synced_tables where app = p_app and schema_name = c.schema_name and table_name = c.table_name;
      v_fields := '{}'::jsonb;
      foreach v_col in array v_def.writable_columns loop
        if c.before->v_col is distinct from c.after->v_col then v_fields := v_fields || jsonb_build_object(v_col, c.before->v_col); end if;
      end loop;
      v_ops := v_ops || jsonb_build_object('op', 'update', 'table', c.schema_name || '.' || c.table_name, 'id', c.row_id, 'expectedRevision', (v_current->>'revision')::bigint, 'fields', v_fields);
    end if;
  end loop;
  return jsonb_build_object('cursor', p_cursor, 'operations', v_ops);
end $$;

-- ---------------------------------------------------------------------------
-- Papelera
-- ---------------------------------------------------------------------------
create or replace function core.purge_deleted(p_app text, p_actor uuid, p_request_id text, p_tables text[])
returns jsonb language plpgsql as $$
declare v_role text; v_cursor bigint; v_next bigint; v_table text; v_def core.synced_tables; v_count int; v_total int := 0; v_row record;
begin
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is distinct from 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only owners can purge')); end if;
  select cursor into v_cursor from core.app_state where app = p_app for update;
  v_next := v_cursor + 1;
  foreach v_table in array p_tables loop
    v_def := core.table_def(p_app, v_table);
    if v_def.never_purge then continue; end if;
    for v_row in execute format('select id, to_jsonb(t) row from %I.%I t where deleted_at is not null', v_def.schema_name, v_def.table_name) loop
      insert into core.changes (app, cursor, seq, actor_id, request_id, schema_name, table_name, row_id, op, revision, before, after)
      values (p_app, v_next, core.next_seq(p_app, v_next), p_actor, p_request_id, v_def.schema_name, v_def.table_name, v_row.id, 'purge', (v_row.row->>'revision')::bigint, v_row.row, null);
    end loop;
    execute format('delete from %I.%I where deleted_at is not null', v_def.schema_name, v_def.table_name);
    get diagnostics v_count = row_count; v_total := v_total + v_count;
  end loop;
  if v_total > 0 then update core.app_state set cursor = v_next where app = p_app; end if;
  return jsonb_build_object('purged', v_total, 'cursor', case when v_total > 0 then v_next else v_cursor end);
end $$;

-- Borrado real de una fila y de su historial (protección de datos). Solo Core, a petición.
create or replace function core.purge_row_history(p_app text, p_table text, p_id uuid)
returns jsonb language plpgsql as $$
declare v_def core.synced_tables; v_rows int; v_changes int;
begin
  v_def := core.table_def(p_app, p_table);
  execute format('delete from %I.%I where id = $1', v_def.schema_name, v_def.table_name) using p_id;
  get diagnostics v_rows = row_count;
  delete from core.changes where app = p_app and schema_name = v_def.schema_name and table_name = v_def.table_name and row_id = p_id;
  get diagnostics v_changes = row_count;
  return jsonb_build_object('rowsDeleted', v_rows, 'changesDeleted', v_changes);
end $$;

-- ---------------------------------------------------------------------------
-- Pertenencia (administración por owner)
-- ---------------------------------------------------------------------------
create or replace function core.set_membership(p_app text, p_actor uuid, p_user uuid, p_role text, p_scopes jsonb, p_display_name text)
returns jsonb language plpgsql as $$
declare v_role text;
begin
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is distinct from 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only owners manage memberships')); end if;
  if p_role not in ('reader','editor','owner') then perform core.fail('INVALID_ROLE', 422); end if;
  if p_actor = p_user and p_role <> 'owner' then perform core.fail('CURRENT_ACCOUNT', 422, jsonb_build_object('reason', 'an owner cannot demote themselves')); end if;
  insert into core.profiles (user_id, display_name) values (p_user, coalesce(p_display_name, ''))
  on conflict (user_id) do update set display_name = coalesce(p_display_name, core.profiles.display_name), updated_at = now(), revision = core.profiles.revision + 1;
  insert into core.memberships (app, user_id, role, scopes) values (p_app, p_user, p_role, p_scopes)
  on conflict (app, user_id) do update set role = excluded.role, scopes = excluded.scopes, updated_at = now(), revision = core.memberships.revision + 1;
  return (select to_jsonb(m) from core.memberships m where app = p_app and user_id = p_user);
end $$;

create or replace function core.list_memberships(p_app text, p_actor uuid)
returns jsonb language plpgsql stable as $$
declare v_role text;
begin
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is null then perform core.fail('NO_MEMBERSHIP', 403); end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('userId', m.user_id, 'role', m.role, 'scopes', m.scopes, 'displayName', coalesce(p.display_name, ''), 'kind', coalesce(p.kind, 'human')) order by m.created_at), '[]'::jsonb)
          from core.memberships m left join core.profiles p on p.user_id = m.user_id where m.app = p_app);
end $$;

-- ---------------------------------------------------------------------------
-- Wrappers public.core_* para PostgREST (solo service_role)
-- ---------------------------------------------------------------------------
create or replace function public.core_session_active(p_user uuid, p_session uuid) returns boolean
language sql stable security definer set search_path = '' as $$ select core.session_active(p_user, p_session) $$;

create or replace function public.core_bootstrap(p_app text, p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.bootstrap(p_app, p_user) $$;

create or replace function public.core_commit(p_app text, p_actor uuid, p_request_id text, p_digest text, p_expected_cursor bigint, p_operations jsonb) returns jsonb
language sql security definer set search_path = '' as $$ select core.commit(p_app, p_actor, p_request_id, p_digest, p_expected_cursor, p_operations) $$;

create or replace function public.core_snapshot_table(p_app text, p_role text, p_table text, p_include_deleted boolean, p_limit int, p_offset int) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.snapshot_table(p_app, p_role, p_table, p_include_deleted, p_limit, p_offset) $$;

create or replace function public.core_changes_since(p_app text, p_role text, p_after bigint, p_limit int) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.changes_since(p_app, p_role, p_after, p_limit) $$;

create or replace function public.core_history(p_app text, p_role text, p_before bigint, p_limit int) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.history(p_app, p_role, p_before, p_limit) $$;

create or replace function public.core_undo_plan(p_app text, p_cursor bigint) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.undo_plan(p_app, p_cursor) $$;

create or replace function public.core_purge_deleted(p_app text, p_actor uuid, p_request_id text, p_tables text[]) returns jsonb
language sql security definer set search_path = '' as $$ select core.purge_deleted(p_app, p_actor, p_request_id, p_tables) $$;

create or replace function public.core_set_membership(p_app text, p_actor uuid, p_user uuid, p_role text, p_scopes jsonb, p_display_name text) returns jsonb
language sql security definer set search_path = '' as $$ select core.set_membership(p_app, p_actor, p_user, p_role, p_scopes, p_display_name) $$;

create or replace function public.core_list_memberships(p_app text, p_actor uuid) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.list_memberships(p_app, p_actor) $$;

create or replace function public.core_next_code(p_prefix text, p_year int) returns text
language sql security definer set search_path = '' as $$ select core.next_code(p_prefix, p_year) $$;

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
