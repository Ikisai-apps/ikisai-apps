-- Ikisai Core · acciones invocables desde la Edge fuera de core.commit (workers, colas internas),
-- y baja de tablas y lecturas registradas.

-- 1) Tipo 'action': procedimiento volátil que la app ejecuta con `POST /api/v1/invoke/:name` (editor/owner)
--    o desde un worker con la clave de sistema (`POST /api/v1/worker/:name`, actor null).
alter table core.allowed_reads drop constraint if exists allowed_reads_kind_check;
alter table core.allowed_reads add constraint allowed_reads_kind_check check (kind in ('function','view','action'));

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
  end if;
  perform set_config('core.actor', coalesce(p_actor::text, ''), true);
  perform set_config('core.app', p_app, true);
  perform set_config('core.role', v_role, true);
  execute format('select %I.%I($1)', split_part(p_name, '.', 1), split_part(p_name, '.', 2)) into v_result
    using jsonb_build_object('app', p_app, 'actor', p_actor, 'role', v_role, 'args', coalesce(p_args, '{}'::jsonb));
  return coalesce(v_result, 'null'::jsonb);
end $$;

-- 2) Bajas. La app sigue siendo responsable de borrar la tabla o la vista en su propia migración.
create or replace function core.unregister_table(p_app text, p_schema text, p_table text)
returns void language plpgsql as $$
begin
  if to_regclass(format('%I.%I', p_schema, p_table)) is not null then
    execute format('drop trigger if exists core_touch_revision on %I.%I', p_schema, p_table);
  end if;
  delete from core.synced_tables where app = p_app and schema_name = p_schema and table_name = p_table;
end $$;

create or replace function core.disallow_read(p_app text, p_name text)
returns void language sql as $$
  delete from core.allowed_reads where app = p_app and name = p_name;
$$;

create or replace function public.core_invoke(p_app text, p_actor uuid, p_name text, p_args jsonb) returns jsonb
language sql security definer set search_path = '' as $$ select core.invoke(p_app, p_actor, p_name, p_args) $$;

do $$
declare f text;
begin
  for f in select 'public.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'core_invoke' loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
  for f in select 'core.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'core' and p.proname in ('invoke','unregister_table','disallow_read') loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
