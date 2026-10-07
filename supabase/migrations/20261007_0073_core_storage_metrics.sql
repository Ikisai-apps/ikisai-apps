-- Ikisai Core · medición del almacenamiento (ALMACENAMIENTO.md fase 0, aprobada el 7-10-2026).
-- Instantánea semanal de tamaños (base, esquemas, historial y objetos por bucket lógico y proveedor) para el panel de Central y
-- los avisos antes de llegar a los límites del plan gratuito. Los umbrales viven en una tabla, no en el código.

create table core.storage_snapshots (
  taken_at timestamptz primary key default now(),
  metrics jsonb not null
);

create table core.storage_thresholds (
  metric text primary key check (metric in ('database','supabase_storage','r2_storage')),
  limit_bytes bigint not null, warn_bytes bigint not null, critical_bytes bigint not null,
  updated_at timestamptz not null default now()
);
insert into core.storage_thresholds (metric, limit_bytes, warn_bytes, critical_bytes) values
  ('database', 500 * 1024 * 1024::bigint, 350 * 1024 * 1024::bigint, 425 * 1024 * 1024::bigint),
  ('supabase_storage', 1024 * 1024 * 1024::bigint, 700 * 1024 * 1024::bigint, 850 * 1024 * 1024::bigint),
  ('r2_storage', 10 * 1024 * 1024 * 1024::bigint, 7 * 1024 * 1024 * 1024::bigint, 8704 * 1024 * 1024::bigint)
on conflict (metric) do nothing;

do $$
declare t text;
begin
  foreach t in array array['storage_snapshots','storage_thresholds'] loop
    execute format('alter table core.%I enable row level security', t);
    execute format('revoke all on core.%I from public, anon, authenticated', t);
    execute format('grant all on core.%I to service_role', t);
  end loop;
end $$;

-- Tamaños actuales. Los objetos se miden por core.files (fuente de verdad de lo que referencian las apps), por bucket lógico
-- y proveedor; los huérfanos del Storage los medirá la recogida de huérfanos (fase 2).
create or replace function core.storage_metrics()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'takenAt', now(),
    'databaseBytes', pg_database_size(current_database()),
    'bySchema', (select coalesce(jsonb_object_agg(schema, bytes), '{}'::jsonb) from (
        select n.nspname schema, sum(pg_total_relation_size(c.oid))::bigint bytes from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind in ('r','m') and n.nspname not in ('pg_catalog','information_schema','pg_toast') group by n.nspname) s),
    'largestTables', (select coalesce(jsonb_agg(jsonb_build_object('table', t, 'bytes', b) order by b desc), '[]'::jsonb) from (
        select n.nspname || '.' || c.relname t, pg_total_relation_size(c.oid)::bigint b from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind = 'r' and n.nspname not in ('pg_catalog','information_schema','pg_toast') order by 2 desc limit 10) l),
    'changesRows', (select count(*) from core.changes),
    'changesBytes', pg_total_relation_size('core.changes'),
    'files', (select jsonb_build_object('rows', count(*), 'bytes', coalesce(sum(size), 0)) from core.files where status = 'verified'),
    'objectsByProvider', (select coalesce(jsonb_object_agg(storage_provider, bytes), '{}'::jsonb) from (
        select storage_provider, sum(size)::bigint bytes from core.files where status = 'verified' group by 1) p),
    'objectsByBucket', (select coalesce(jsonb_agg(jsonb_build_object('bucket', bucket, 'provider', storage_provider, 'rows', n, 'bytes', bytes) order by bytes desc), '[]'::jsonb) from (
        select bucket, storage_provider, count(*) n, sum(size)::bigint bytes from core.files where status = 'verified' group by 1, 2) b),
    'thresholds', (select coalesce(jsonb_object_agg(metric, jsonb_build_object('limit', limit_bytes, 'warn', warn_bytes, 'critical', critical_bytes)), '{}'::jsonb) from core.storage_thresholds))
$$;

create or replace function core.storage_snapshot()
returns void language sql security definer set search_path = '' as $$
  insert into core.storage_snapshots (metrics) values (core.storage_metrics());
  delete from core.storage_snapshots where taken_at < now() - interval '2 years';
$$;

-- Para Central (owner): estado actual, nivel de cada límite y las últimas 26 instantáneas (medio año) para ver el crecimiento.
create or replace function core.admin_storage(p_actor uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := core.storage_metrics(); v_db bigint; v_sb bigint; v_r2 bigint;
begin
  perform core.require_admin(p_actor);
  v_db := (v->>'databaseBytes')::bigint;
  v_sb := coalesce((v->'objectsByProvider'->>'supabase')::bigint, 0);
  v_r2 := coalesce((v->'objectsByProvider'->>'r2')::bigint, 0);
  return v || jsonb_build_object(
    'levels', (select jsonb_object_agg(metric, case when used >= critical_bytes then 'critical' when used >= warn_bytes then 'warn' else 'ok' end)
                 from (select metric, warn_bytes, critical_bytes, case metric when 'database' then v_db when 'supabase_storage' then v_sb else v_r2 end used
                         from core.storage_thresholds) t),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('takenAt', taken_at, 'databaseBytes', metrics->'databaseBytes', 'files', metrics->'files',
                   'objectsByProvider', metrics->'objectsByProvider', 'changesRows', metrics->'changesRows') order by taken_at), '[]'::jsonb)
                  from (select * from core.storage_snapshots order by taken_at desc limit 26) s));
end $$;

create or replace function public.core_admin_storage(p_actor uuid) returns jsonb
language sql security definer set search_path = '' as $$ select core.admin_storage(p_actor) $$;

do $$
declare f text;
begin
  foreach f in array array['core.storage_metrics()', 'core.storage_snapshot()', 'core.admin_storage(uuid)', 'public.core_admin_storage(uuid)'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;

select core.storage_snapshot();

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select cron.schedule('ikisai-storage-snapshot', '7 5 * * 1', $c$select core.storage_snapshot()$c$)$q$;
  end if;
end $$;
