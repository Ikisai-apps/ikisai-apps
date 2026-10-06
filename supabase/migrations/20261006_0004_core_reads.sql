-- Ikisai Core · lecturas registradas: funciones y vistas que una app puede ejecutar o consultar desde su Edge
-- (procedimientos de lectura de su propio schema y proyecciones publicadas por otras apps).
create table core.allowed_reads (
  app text not null references core.apps(id),
  name text not null check (name ~ '^[a-z_]+\.[a-z0-9_]+$'),
  kind text not null check (kind in ('function','view')),
  roles text[] not null default '{reader,editor,owner}',
  primary key (app, name)
);
alter table core.allowed_reads enable row level security;
revoke all on core.allowed_reads from public, anon, authenticated;
grant all on core.allowed_reads to service_role;

-- La app dueña del objeto (o Core) registra qué app puede leerlo. Una vista de proyección de booking la registra booking para food.
create or replace function core.allow_read(p_app text, p_name text, p_kind text, p_roles text[] default '{reader,editor,owner}')
returns void language sql as $$
  insert into core.allowed_reads (app, name, kind, roles) values (p_app, p_name, p_kind, p_roles)
  on conflict (app, name) do update set kind = excluded.kind, roles = excluded.roles;
$$;

-- Ejecuta una lectura registrada. Funciones: name(p_ctx jsonb) returns jsonb. Vistas: filtros de igualdad, límite y desplazamiento.
create or replace function core.read(p_app text, p_actor uuid, p_name text, p_args jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_role text; v_def core.allowed_reads; v_args jsonb := coalesce(p_args, '{}'::jsonb); v_result jsonb;
  v_schema text; v_object text; v_where jsonb; v_key text; v_cols text[]; v_conds text[] := '{}'; v_params jsonb := '[]'::jsonb;
  v_limit int; v_offset int; v_rows jsonb; v_total bigint; v_sql text; v_i int := 0;
begin
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is null then perform core.fail('NO_MEMBERSHIP', 403, jsonb_build_object('app', p_app)); end if;
  select * into v_def from core.allowed_reads where app = p_app and name = p_name;
  if v_def.app is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'read not allowed', 'name', p_name)); end if;
  if not (v_role = any(v_def.roles)) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('name', p_name)); end if;
  v_schema := split_part(p_name, '.', 1); v_object := split_part(p_name, '.', 2);

  if v_def.kind = 'function' then
    execute format('select %I.%I($1)', v_schema, v_object) into v_result
      using jsonb_build_object('app', p_app, 'actor', p_actor, 'role', v_role, 'args', v_args);
    return coalesce(v_result, 'null'::jsonb);
  end if;

  select array_agg(column_name::text) into v_cols from information_schema.columns where table_schema = v_schema and table_name = v_object;
  if v_cols is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'view not found', 'name', p_name)); end if;
  v_where := coalesce(v_args->'where', '{}'::jsonb);
  if jsonb_typeof(v_where) <> 'object' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'where must be an object')); end if;
  for v_key in select jsonb_object_keys(v_where) loop
    if not (v_key = any(v_cols)) then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'unknown column', 'column', v_key)); end if;
    v_i := v_i + 1;
    -- comparación textual: suficiente para ids, códigos y estados
    v_conds := v_conds || format('%I::text = ($1->>%s)', v_key, v_i - 1);
    v_params := v_params || to_jsonb(v_where->>v_key);
  end loop;
  v_limit := greatest(1, least(coalesce((v_args->>'limit')::int, 500), 2000));
  v_offset := greatest(0, coalesce((v_args->>'offset')::int, 0));
  v_sql := format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from (select * from %I.%I %s limit %s offset %s) t',
    v_schema, v_object, case when array_length(v_conds, 1) is null then '' else 'where ' || array_to_string(v_conds, ' and ') end, v_limit, v_offset);
  execute v_sql into v_rows using v_params;
  execute format('select count(*) from %I.%I %s', v_schema, v_object, case when array_length(v_conds, 1) is null then '' else 'where ' || array_to_string(v_conds, ' and ') end) into v_total using v_params;
  return jsonb_build_object('name', p_name, 'rows', v_rows, 'total', v_total, 'limit', v_limit, 'offset', v_offset);
end $$;

create or replace function public.core_read(p_app text, p_actor uuid, p_name text, p_args jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.read(p_app, p_actor, p_name, p_args) $$;

do $$
declare f text;
begin
  for f in select 'public.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'core_read' loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
  for f in select 'core.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'core' and p.proname in ('read','allow_read') loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
