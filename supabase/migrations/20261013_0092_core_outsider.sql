-- Ikisai Core · fase O1 (coordinacion/ampliacion/RECURSOS.md §13.1, §14 y §15.1; aprobado por el usuario el 13-10-2026).
-- Tres piezas, solo en el schema core:
--   1. Rol `outsider` en las membresías. No se da a mano: lo deriva el nivel de casa. Por defecto no lee ni escribe nada;
--      cada app lo abre tabla a tabla (`readable_roles`, `writable_roles`) y procedimiento a procedimiento (AppConfig.outsider).
--   2. Nivel de casa → roles (`house_level_roles`, `house_grants`, `house_levels`, `apply_house_level`). Lo llama el trigger
--      de Central sobre `central.people`. Nunca rebaja un acceso, y al quitarlo devuelve solo lo que dio.
--   3. Sugerencias: propuestas de personas que staff o dirección aprueba o descarta. Al aprobar, el lote se aplica como un
--      `core.commit` de quien aprueba. No confundir con `core.proposals` (lotes de agentes que esperan confirmación).

-- ---------------------------------------------------------------------------
-- 1. Rol `outsider`
-- ---------------------------------------------------------------------------
alter table core.memberships drop constraint if exists memberships_role_check;
alter table core.memberships add constraint memberships_role_check check (role in ('reader', 'outsider', 'editor', 'owner'));

-- Orden para comparar roles al derivar: nunca se rebaja a nadie.
create or replace function core.role_rank(p_role text)
returns int language sql immutable as $$
  select case p_role when 'reader' then 1 when 'outsider' then 2 when 'editor' then 3 when 'owner' then 4 else 0 end
$$;

-- Procedimientos (`call` en un lote): hoy no miran el rol. Un outsider solo llama a los que la app abre a propósito.
alter table core.allowed_procedures add column if not exists outsider boolean not null default false;

create or replace function core.allow_outsider_procedure(p_app text, p_procedure text)
returns void language plpgsql as $$
begin
  update core.allowed_procedures set outsider = true where app = p_app and procedure = p_procedure;
  if not found then perform core.fail('PROCEDURE_NOT_ALLOWED', 422, jsonb_build_object('procedure', p_procedure)); end if;
end $$;

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
      if p_role = 'outsider' and not exists (select 1 from core.allowed_procedures where app = p_app and procedure = v_proc and outsider) then
        perform core.fail('FORBIDDEN', 403, jsonb_build_object('procedure', v_proc));
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

-- ---------------------------------------------------------------------------
-- 2. Nivel de casa → roles
-- ---------------------------------------------------------------------------
-- Qué rol da cada nivel en cada app. Decisión del usuario (13-10-2026): de momento solo el outsider deriva roles;
-- dirección y staff siguen con sus accesos manuales hasta que se rellene esta tabla.
create table core.house_level_roles (
  level text not null check (level in ('direccion', 'staff', 'outsider')),
  app text not null references core.apps(id),
  role text not null check (role in ('reader', 'outsider', 'editor', 'owner')),
  primary key (level, app)
);
-- En Guests el huésped ya es `editor` con `scopes` y todas sus lecturas piden editor: el outsider entra igual, sin `scopes`.
insert into core.house_level_roles (level, app, role) values
  ('outsider', 'tasks', 'outsider'),
  ('outsider', 'guests', 'editor')
on conflict do nothing;

-- Nivel vigente de cada cuenta (lo devuelve bootstrap en `profile.houseLevel`).
create table core.house_levels (
  user_id uuid primary key references auth.users(id) on delete cascade,
  level text not null check (level in ('direccion', 'staff', 'outsider')),
  updated_at timestamptz not null default now()
);

-- Lo que dio el nivel: el rol concedido y el que había antes (null = no tenía acceso).
create table core.house_grants (
  user_id uuid not null references auth.users(id) on delete cascade,
  app text not null references core.apps(id),
  level text not null,
  role text not null,
  previous_role text,
  created_at timestamptz not null default now(),
  primary key (user_id, app)
);

alter table core.house_level_roles enable row level security;
alter table core.house_levels enable row level security;
alter table core.house_grants enable row level security;
revoke all on core.house_level_roles, core.house_levels, core.house_grants from public, anon, authenticated;
grant all on core.house_level_roles, core.house_levels, core.house_grants to service_role;

-- Aplica el nivel de una cuenta (null = sin nivel). Idempotente.
--  · Deshace lo que dio el nivel anterior, solo si el rol sigue siendo el concedido (un cambio a mano posterior se respeta).
--  · Concede lo del nivel nuevo solo si sube: sin acceso → se crea; con un rol menor → se sube; igual o mayor → nada.
--  · Nunca a un agente. Los `scopes` no se tocan.
create or replace function core.apply_house_level(p_user uuid, p_level text, p_actor uuid default null)
returns jsonb language plpgsql as $$
declare g core.house_grants; r core.house_level_roles; v_current text; v_changes jsonb := '[]'::jsonb;
begin
  if p_user is null then return v_changes; end if;
  if p_level is not null and p_level not in ('direccion', 'staff', 'outsider') then perform core.fail('INVALID_HOUSE_LEVEL', 422, jsonb_build_object('level', p_level)); end if;
  if coalesce((select kind from core.profiles where user_id = p_user), 'human') = 'agent' then return v_changes; end if;

  for g in select * from core.house_grants where user_id = p_user for update loop
    -- Mismo nivel y misma concesión: se deja como está.
    if g.level = p_level and exists (select 1 from core.house_level_roles where level = p_level and app = g.app and role = g.role) then continue; end if;
    select role into v_current from core.memberships where app = g.app and user_id = p_user;
    if v_current = g.role then
      if g.previous_role is null then
        delete from core.memberships where app = g.app and user_id = p_user;
      else
        update core.memberships set role = g.previous_role, updated_at = now(), revision = revision + 1 where app = g.app and user_id = p_user;
      end if;
      perform core.log_access(g.app, p_actor, null, 'member_changed', jsonb_build_object('userId', p_user, 'role', g.previous_role, 'removed', g.previous_role is null, 'by', 'house_level'));
      v_changes := v_changes || jsonb_build_object('app', g.app, 'from', g.role, 'to', g.previous_role);
    end if;
    delete from core.house_grants where user_id = p_user and app = g.app;
  end loop;

  if p_level is null then
    delete from core.house_levels where user_id = p_user;
    return v_changes;
  end if;
  insert into core.house_levels (user_id, level) values (p_user, p_level)
  on conflict (user_id) do update set level = excluded.level, updated_at = now() where core.house_levels.level is distinct from excluded.level;

  for r in select * from core.house_level_roles where level = p_level loop
    if exists (select 1 from core.house_grants where user_id = p_user and app = r.app) then continue; end if;
    select role into v_current from core.memberships where app = r.app and user_id = p_user;
    if v_current is null then
      insert into core.profiles (user_id, display_name) values (p_user, '') on conflict (user_id) do nothing;
      insert into core.memberships (app, user_id, role, scopes) values (r.app, p_user, r.role, null);
    elsif core.role_rank(v_current) < core.role_rank(r.role) then
      update core.memberships set role = r.role, updated_at = now(), revision = revision + 1 where app = r.app and user_id = p_user;
    else
      continue;
    end if;
    insert into core.house_grants (user_id, app, level, role, previous_role) values (p_user, r.app, p_level, r.role, v_current);
    perform core.log_access(r.app, p_actor, null, 'member_changed', jsonb_build_object('userId', p_user, 'role', r.role, 'by', 'house_level'));
    v_changes := v_changes || jsonb_build_object('app', r.app, 'from', v_current, 'to', r.role);
  end loop;
  return v_changes;
end $$;

-- Lo que el nivel ha dado a una cuenta (o a todas), para que Central distinga lo derivado de lo manual.
create or replace function core.house_grants_of(p_user uuid default null)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('userId', g.user_id, 'app', g.app, 'level', g.level, 'role', g.role, 'previousRole', g.previous_role)
           order by g.user_id, g.app), '[]'::jsonb)
  from core.house_grants g where p_user is null or g.user_id = p_user;
$$;

-- Bootstrap: además, el nivel de casa de la cuenta (`profile.houseLevel`).
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
    'profile', jsonb_build_object('userId', p_user, 'displayName', coalesce(v_profile.display_name, ''), 'kind', coalesce(v_profile.kind, 'human'),
      'houseLevel', (select level from core.house_levels where user_id = p_user)),
    'tables', v_tables,
    'agentPolicy', jsonb_build_object('bulkThreshold', coalesce(v_threshold, 10),
      'safeProcedures', (select coalesce(jsonb_agg(procedure order by procedure), '[]'::jsonb) from core.allowed_procedures where app = p_app and not agent_confirmation),
      'safeActions', (select coalesce(jsonb_agg(name order by name), '[]'::jsonb) from core.allowed_reads where app = p_app and kind = 'action' and not agent_confirmation)));
end $$;

-- ---------------------------------------------------------------------------
-- 3. Sugerencias (propuestas de personas con aprobación)
-- ---------------------------------------------------------------------------
-- Cada app declara qué se puede sugerir: tablas y operaciones admitidas, o procedimientos (`call`) que se ejecutan al aprobar.
-- `submit_roles`: roles en la propia app que pueden sugerir. `submit_from`: otras apps desde las que se sugiere, con sus roles
-- (p. ej. Food admite platos de los outsiders de Guests: {"guests": ["editor"]} junto con el nivel de casa outsider).
create table core.suggestion_kinds (
  app text not null references core.apps(id),
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text not null check (char_length(label) between 1 and 80),
  tables text[] not null default '{}',
  ops text[] not null default '{insert,update}',
  procedures text[] not null default '{}',
  submit_roles text[] not null default '{outsider}',
  submit_from jsonb,
  house_level text check (house_level is null or house_level in ('direccion', 'staff', 'outsider')),
  primary key (app, kind),
  check (ops <@ array['insert', 'update', 'delete', 'restore']::text[]),
  check (submit_roles <@ array['reader', 'outsider', 'editor', 'owner']::text[])
);

create table core.suggestions (
  id uuid primary key default gen_random_uuid(),
  app text not null,
  kind text not null,
  author_id uuid not null references auth.users(id) on delete cascade,
  request_id text not null,
  summary text not null check (char_length(summary) between 1 and 300),
  detail jsonb,
  operations jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  comment text check (comment is null or char_length(comment) <= 1000),
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  applied_cursor bigint,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (app, author_id, request_id),
  foreign key (app, kind) references core.suggestion_kinds(app, kind)
);
create index suggestions_app_status_idx on core.suggestions (app, status, created_at desc);
create index suggestions_author_idx on core.suggestions (author_id, created_at desc);

alter table core.suggestion_kinds enable row level security;
alter table core.suggestions enable row level security;
revoke all on core.suggestion_kinds, core.suggestions from public, anon, authenticated;
grant all on core.suggestion_kinds, core.suggestions to service_role;

-- Lo llaman las migraciones de cada app.
create or replace function core.register_suggestion_kind(
  p_app text, p_kind text, p_label text,
  p_tables text[] default '{}', p_ops text[] default '{insert,update}', p_procedures text[] default '{}',
  p_submit_roles text[] default '{outsider}', p_submit_from jsonb default null, p_house_level text default null)
returns void language plpgsql as $$
declare v_table text; v_proc text;
begin
  foreach v_table in array p_tables loop
    if not exists (select 1 from core.synced_tables where app = p_app and schema_name || '.' || table_name = v_table) then
      perform core.fail('TABLE_NOT_FOUND', 422, jsonb_build_object('table', v_table));
    end if;
  end loop;
  foreach v_proc in array p_procedures loop
    if not exists (select 1 from core.allowed_procedures where app = p_app and procedure = v_proc) then
      perform core.fail('PROCEDURE_NOT_ALLOWED', 422, jsonb_build_object('procedure', v_proc));
    end if;
  end loop;
  if p_submit_from is not null and jsonb_typeof(p_submit_from) <> 'object' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'submit_from must be an object')); end if;
  insert into core.suggestion_kinds (app, kind, label, tables, ops, procedures, submit_roles, submit_from, house_level)
  values (p_app, p_kind, p_label, p_tables, p_ops, p_procedures, p_submit_roles, p_submit_from, p_house_level)
  on conflict (app, kind) do update set label = excluded.label, tables = excluded.tables, ops = excluded.ops, procedures = excluded.procedures,
    submit_roles = excluded.submit_roles, submit_from = excluded.submit_from, house_level = excluded.house_level;
end $$;

-- ¿Puede esta cuenta sugerir este tipo? Por su rol en la app, o por su rol en una app de `submit_from`;
-- y, si el tipo lo pide, con ese nivel de casa.
create or replace function core.suggestion_can_submit(k core.suggestion_kinds, p_user uuid)
returns boolean language sql stable as $$
  select (k.house_level is null or exists (select 1 from core.house_levels h where h.user_id = p_user and h.level = k.house_level))
     and coalesce((select kind from core.profiles where user_id = p_user), 'human') = 'human'
     and (exists (select 1 from core.memberships m where m.app = k.app and m.user_id = p_user and m.role = any(k.submit_roles))
          or exists (select 1 from core.memberships m, jsonb_each(coalesce(k.submit_from, '{}'::jsonb)) f
                      where m.user_id = p_user and m.app = f.key and jsonb_typeof(f.value) = 'array' and f.value ? m.role));
$$;

-- Valida un lote contra su tipo: operaciones y tablas admitidas, o llamadas a sus procedimientos. Como mucho 50.
create or replace function core.suggestion_check_operations(k core.suggestion_kinds, p_operations jsonb)
returns void language plpgsql as $$
declare v_op jsonb;
begin
  if jsonb_typeof(p_operations) <> 'array' or jsonb_array_length(p_operations) = 0 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'operations must be a non-empty array')); end if;
  if jsonb_array_length(p_operations) > 50 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'max 50 operations')); end if;
  if length(p_operations::text) > 65536 then perform core.fail('PAYLOAD_TOO_LARGE', 413); end if;
  for v_op in select * from jsonb_array_elements(p_operations) loop
    if v_op->>'op' = 'call' then
      if not coalesce(v_op->>'procedure', '') = any(k.procedures) then
        perform core.fail('SUGGESTION_NOT_ALLOWED', 403, jsonb_build_object('procedure', v_op->>'procedure', 'kind', k.kind));
      end if;
    elsif not (coalesce(v_op->>'op', '') = any(k.ops) and coalesce(v_op->>'table', '') = any(k.tables)) then
      perform core.fail('SUGGESTION_NOT_ALLOWED', 403, jsonb_build_object('op', v_op->>'op', 'table', v_op->>'table', 'kind', k.kind));
    end if;
  end loop;
end $$;

create or replace function core.suggestion_json(s core.suggestions)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', s.id, 'app', s.app, 'kind', s.kind,
    'label', (select label from core.suggestion_kinds where app = s.app and kind = s.kind),
    'summary', s.summary, 'detail', s.detail, 'operations', s.operations, 'status', s.status, 'comment', s.comment,
    'author', jsonb_build_object('id', s.author_id, 'name', coalesce((select display_name from core.profiles where user_id = s.author_id), '')),
    'decidedBy', case when s.decided_by is null then null else jsonb_build_object('id', s.decided_by, 'name', coalesce((select display_name from core.profiles where user_id = s.decided_by), '')) end,
    'decidedAt', s.decided_at, 'appliedCursor', s.applied_cursor, 'result', s.result, 'createdAt', s.created_at, 'updatedAt', s.updated_at);
$$;

-- Quien decide: staff o dirección (editor u owner humano de la app).
create or replace function core.suggestion_require_reviewer(p_app text, p_actor uuid)
returns void language plpgsql as $$
begin
  if coalesce((select kind from core.profiles where user_id = p_actor), 'human') = 'agent' then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'agents cannot review suggestions'));
  end if;
  if (select role from core.memberships where app = p_app and user_id = p_actor) is distinct from 'editor'
     and (select role from core.memberships where app = p_app and user_id = p_actor) is distinct from 'owner' then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only editors and owners review suggestions'));
  end if;
end $$;

create or replace function core.suggest(p_app text, p_actor uuid, p_request_id text, p_kind text, p_summary text, p_detail jsonb, p_operations jsonb)
returns jsonb language plpgsql as $$
declare k core.suggestion_kinds; s core.suggestions;
begin
  if p_request_id is null or p_request_id !~ '^[A-Za-z0-9_.:-]{1,120}$' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid requestId')); end if;
  select * into k from core.suggestion_kinds where app = p_app and kind = p_kind;
  if k.app is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('kind', p_kind)); end if;
  if not core.suggestion_can_submit(k, p_actor) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'cannot suggest', 'kind', p_kind)); end if;
  select * into s from core.suggestions where app = p_app and author_id = p_actor and request_id = p_request_id;
  if s.id is not null then
    if s.operations <> p_operations or s.kind <> p_kind then perform core.fail('IDEMPOTENCY_REUSE', 409, jsonb_build_object('requestId', p_request_id)); end if;
    return core.suggestion_json(s) || jsonb_build_object('replayed', true);
  end if;
  if p_summary is null or char_length(btrim(p_summary)) = 0 or char_length(p_summary) > 300 then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'summary')); end if;
  if p_detail is not null and length(p_detail::text) > 8000 then perform core.fail('PAYLOAD_TOO_LARGE', 413, jsonb_build_object('field', 'detail')); end if;
  perform core.suggestion_check_operations(k, p_operations);
  if (select count(*) from core.suggestions where app = p_app and author_id = p_actor and status = 'pending') >= 30 then
    perform core.fail('TOO_MANY_SUGGESTIONS', 429, jsonb_build_object('limit', 30));
  end if;
  insert into core.suggestions (app, kind, author_id, request_id, summary, detail, operations)
  values (p_app, p_kind, p_actor, p_request_id, btrim(p_summary), p_detail, p_operations) returning * into s;
  return core.suggestion_json(s);
end $$;

-- `mine`: las propias (cualquiera que pueda sugerir). `pending` y `all`: las de la app, para quien decide.
create or replace function core.suggestion_list(p_app text, p_actor uuid, p_scope text, p_limit int default 50, p_before timestamptz default null)
returns jsonb language plpgsql stable as $$
declare v_limit int := least(200, greatest(1, coalesce(p_limit, 50)));
begin
  if p_scope not in ('mine', 'pending', 'all') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'scope must be mine, pending or all')); end if;
  if p_scope <> 'mine' then perform core.suggestion_require_reviewer(p_app, p_actor); end if;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(core.suggestion_json(s) order by s.created_at desc)
      from (select * from core.suggestions s
             where s.app = p_app
               and (p_scope <> 'mine' or s.author_id = p_actor)
               and (p_scope <> 'pending' or s.status = 'pending')
               and (p_before is null or s.created_at < p_before)
             order by s.created_at desc limit v_limit) s), '[]'::jsonb),
    'pendingCount', case when p_scope = 'mine' then null else (select count(*) from core.suggestions where app = p_app and status = 'pending') end);
end $$;

-- Antes y después del lote, como lo vería quien aprueba (sin escribir).
create or replace function core.suggestion_preview(p_app text, p_actor uuid, p_id uuid, p_operations jsonb default null)
returns jsonb language plpgsql as $$
declare s core.suggestions; k core.suggestion_kinds; v_ops jsonb;
begin
  perform core.suggestion_require_reviewer(p_app, p_actor);
  select * into s from core.suggestions where id = p_id and app = p_app;
  if s.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('suggestionId', p_id)); end if;
  select * into k from core.suggestion_kinds where app = s.app and kind = s.kind;
  -- Sin lote corregido (null o JSON null), el de la sugerencia.
  if p_operations is null or jsonb_typeof(p_operations) = 'null' then v_ops := s.operations;
  else v_ops := p_operations; perform core.suggestion_check_operations(k, v_ops); end if;
  return core.commit_preview(p_app, p_actor, v_ops);
end $$;

-- Aprobar aplica el lote (o el que corrija quien aprueba, con las mismas reglas del tipo) como su propio commit,
-- con requestId `suggestion:<id>`. Si el lote ya no encaja, falla con el error del núcleo o del hook y la sugerencia
-- sigue pendiente. Descartar admite un comentario.
create or replace function core.suggestion_decide(p_app text, p_actor uuid, p_id uuid, p_decision text, p_comment text default null, p_operations jsonb default null)
returns jsonb language plpgsql as $$
declare s core.suggestions; k core.suggestion_kinds; v_ops jsonb; v_result jsonb;
begin
  perform core.suggestion_require_reviewer(p_app, p_actor);
  if p_decision not in ('approve', 'reject') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'decision must be approve or reject')); end if;
  if p_comment is not null and char_length(p_comment) > 1000 then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'comment')); end if;
  select * into s from core.suggestions where id = p_id and app = p_app for update;
  if s.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('suggestionId', p_id)); end if;
  if s.status <> 'pending' then perform core.fail('SUGGESTION_UNAVAILABLE', 409, jsonb_build_object('suggestionId', p_id, 'status', s.status)); end if;
  if p_decision = 'reject' then
    update core.suggestions set status = 'rejected', comment = nullif(btrim(coalesce(p_comment, '')), ''), decided_by = p_actor, decided_at = now(), updated_at = now()
     where id = p_id returning * into s;
    return core.suggestion_json(s);
  end if;
  select * into k from core.suggestion_kinds where app = s.app and kind = s.kind;
  -- Sin lote corregido (null o JSON null), el de la sugerencia.
  if p_operations is null or jsonb_typeof(p_operations) = 'null' then v_ops := s.operations;
  else v_ops := p_operations; perform core.suggestion_check_operations(k, v_ops); end if;
  v_result := core.commit(p_app, p_actor, 'suggestion:' || p_id::text, encode(sha256(convert_to(v_ops::text, 'UTF8')), 'hex'), null, v_ops, null);
  update core.suggestions set status = 'approved', comment = nullif(btrim(coalesce(p_comment, '')), ''), decided_by = p_actor, decided_at = now(), updated_at = now(),
         applied_cursor = (v_result->>'cursor')::bigint, result = v_result->'results', operations = v_ops
   where id = p_id returning * into s;
  return core.suggestion_json(s);
end $$;

create or replace function core.suggestion_withdraw(p_app text, p_actor uuid, p_id uuid)
returns jsonb language plpgsql as $$
declare s core.suggestions;
begin
  select * into s from core.suggestions where id = p_id and app = p_app for update;
  if s.id is null or s.author_id <> p_actor then perform core.fail('NOT_FOUND', 404, jsonb_build_object('suggestionId', p_id)); end if;
  if s.status <> 'pending' then perform core.fail('SUGGESTION_UNAVAILABLE', 409, jsonb_build_object('suggestionId', p_id, 'status', s.status)); end if;
  update core.suggestions set status = 'withdrawn', updated_at = now() where id = p_id returning * into s;
  return core.suggestion_json(s);
end $$;

-- ---------------------------------------------------------------------------
-- Envoltorios públicos (solo service_role)
-- ---------------------------------------------------------------------------
create or replace function public.core_apply_house_level(p_user uuid, p_level text, p_actor uuid default null) returns jsonb
language sql security definer set search_path = '' as $$ select core.apply_house_level(p_user, p_level, p_actor) $$;
create or replace function public.core_house_grants(p_user uuid default null) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.house_grants_of(p_user) $$;
create or replace function public.core_suggest(p_app text, p_actor uuid, p_request_id text, p_kind text, p_summary text, p_detail jsonb, p_operations jsonb) returns jsonb
language sql security definer set search_path = '' as $$ select core.suggest(p_app, p_actor, p_request_id, p_kind, p_summary, p_detail, p_operations) $$;
create or replace function public.core_suggestion_list(p_app text, p_actor uuid, p_scope text, p_limit int default 50, p_before timestamptz default null) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.suggestion_list(p_app, p_actor, p_scope, p_limit, p_before) $$;
create or replace function public.core_suggestion_preview(p_app text, p_actor uuid, p_id uuid, p_operations jsonb default null) returns jsonb
language sql security definer set search_path = '' as $$ select core.suggestion_preview(p_app, p_actor, p_id, p_operations) $$;
create or replace function public.core_suggestion_decide(p_app text, p_actor uuid, p_id uuid, p_decision text, p_comment text default null, p_operations jsonb default null) returns jsonb
language sql security definer set search_path = '' as $$ select core.suggestion_decide(p_app, p_actor, p_id, p_decision, p_comment, p_operations) $$;
create or replace function public.core_suggestion_withdraw(p_app text, p_actor uuid, p_id uuid) returns jsonb
language sql security definer set search_path = '' as $$ select core.suggestion_withdraw(p_app, p_actor, p_id) $$;

do $$
declare f text;
begin
  for f in select 'public.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname in ('core_apply_house_level', 'core_house_grants', 'core_suggest', 'core_suggestion_list',
                                                       'core_suggestion_preview', 'core_suggestion_decide', 'core_suggestion_withdraw') loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
  for f in select 'core.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'core' and p.proname in ('role_rank', 'allow_outsider_procedure', 'apply_operations', 'apply_house_level', 'house_grants_of', 'bootstrap', 'register_suggestion_kind',
                'suggestion_can_submit', 'suggestion_check_operations', 'suggestion_json', 'suggestion_require_reviewer', 'suggest',
                'suggestion_list', 'suggestion_preview', 'suggestion_decide', 'suggestion_withdraw') loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
