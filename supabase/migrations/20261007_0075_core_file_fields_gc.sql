-- Ikisai Core · registro de campos de archivo y recogida de huérfanos (ALMACENAMIENTO.md fase 2, aprobada el 7-10-2026).
-- Cada app declara en su migración qué columnas guardan un file_id y con qué retención (core.register_file_field). De ahí salen
-- las referencias, la retención y la recogida de huérfanos, sin tocar subidas ni clientes.
-- Seguro: la recogida solo actúa en las apps que han declarado su registro completo (core.enable_file_gc), un archivo legal
-- nunca se borra solo, y un huérfano espera 30 días antes de borrarse (y se vuelve a comprobar justo antes).

create table core.file_fields (
  app text references core.apps(id),                 -- null: tablas del núcleo (core.feedback_attachments…)
  schema_name text not null, table_name text not null, column_name text not null,
  retention text not null check (retention in ('operational','legal','permanent','temporary')),
  created_at timestamptz not null default now(),
  primary key (schema_name, table_name, column_name)
);

create table core.file_gc_apps (
  app text primary key references core.apps(id),
  enabled_at timestamptz not null default now()
);

alter table core.files
  add column if not exists retention_class text check (retention_class in ('operational','legal','permanent','temporary')),
  add column if not exists orphaned_at timestamptz,
  add column if not exists last_referenced_at timestamptz;
create index if not exists files_orphaned_idx on core.files (orphaned_at) where orphaned_at is not null;

do $$
declare t text;
begin
  foreach t in array array['file_fields','file_gc_apps'] loop
    execute format('alter table core.%I enable row level security', t);
    execute format('revoke all on core.%I from public, anon, authenticated', t);
    execute format('grant all on core.%I to service_role', t);
  end loop;
end $$;

-- Helper de migración de app: declara una columna que guarda file_id.
create or replace function core.register_file_field(p_app text, p_schema text, p_table text, p_column text, p_retention text)
returns void language plpgsql as $$
begin
  if p_app is not null and not exists (select 1 from core.apps where id = p_app) then perform core.fail('APP_NOT_FOUND', 404, jsonb_build_object('app', p_app)); end if;
  if not exists (select 1 from information_schema.columns where table_schema = p_schema and table_name = p_table and column_name = p_column and data_type = 'uuid') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'column must exist and be uuid', 'column', p_schema || '.' || p_table || '.' || p_column));
  end if;
  insert into core.file_fields (app, schema_name, table_name, column_name, retention) values (p_app, p_schema, p_table, p_column, p_retention)
  on conflict (schema_name, table_name, column_name) do update set retention = excluded.retention, app = excluded.app;
end $$;

-- Helper de migración de app: «ya he registrado todos mis campos de archivo»; desde aquí la recogida actúa en esa app.
create or replace function core.enable_file_gc(p_app text)
returns void language plpgsql as $$
begin
  insert into core.file_gc_apps (app) values (p_app) on conflict (app) do nothing;
end $$;

-- Retención más fuerte de los campos que hoy referencian el archivo (null si nadie lo referencia).
create or replace function core.file_reference_retention(p_file uuid)
returns text language plpgsql stable as $$
declare f core.file_fields; v_found boolean; v_best text; v_rank int := 0;
begin
  for f in select * from core.file_fields loop
    execute format('select exists (select 1 from %I.%I where %I = $1)', f.schema_name, f.table_name, f.column_name) into v_found using p_file;
    if v_found then
      if (case f.retention when 'legal' then 4 when 'permanent' then 3 when 'operational' then 2 else 1 end) > v_rank then
        v_rank := case f.retention when 'legal' then 4 when 'permanent' then 3 when 'operational' then 2 else 1 end;
        v_best := f.retention;
      end if;
    end if;
  end loop;
  return v_best;
end $$;

-- Paso 1 (diario): marca y desmarca huérfanos. Solo archivos de apps con la recogida activada y de más de 2 días.
create or replace function core.file_gc_mark(p_limit int default 2000)
returns jsonb language plpgsql as $$
declare v core.files; v_ret text; v_marked int := 0; v_cleared int := 0;
begin
  for v in select f.* from core.files f join core.file_gc_apps g on g.app = f.app
            where f.created_at < now() - interval '2 days' order by coalesce(f.last_referenced_at, f.created_at) limit greatest(1, least(p_limit, 10000)) loop
    v_ret := core.file_reference_retention(v.id);
    if v_ret is not null then
      update core.files set orphaned_at = null, last_referenced_at = now(),
        retention_class = case when retention_class = 'legal' or v_ret = 'legal' then 'legal' else v_ret end where id = v.id;
      if v.orphaned_at is not null then v_cleared := v_cleared + 1; end if;
    elsif v.orphaned_at is null then
      update core.files set orphaned_at = now() where id = v.id;
      v_marked := v_marked + 1;
    end if;
  end loop;
  return jsonb_build_object('marked', v_marked, 'cleared', v_cleared);
end $$;

-- Paso 2: huérfanos de más de 30 días que siguen sin referencia y no son legales ni permanentes → a borrar (lo hace la Edge).
create or replace function core.file_gc_claim(p_limit int default 100)
returns jsonb language plpgsql as $$
declare v core.files; v_out jsonb := '[]'::jsonb;
begin
  for v in select f.* from core.files f join core.file_gc_apps g on g.app = f.app
            where f.orphaned_at < now() - interval '30 days' and coalesce(f.retention_class, 'operational') not in ('legal','permanent')
            order by f.orphaned_at limit greatest(1, least(p_limit, 500)) for update of f skip locked loop
    if core.file_reference_retention(v.id) is null then
      v_out := v_out || jsonb_build_object('id', v.id, 'bucket', v.bucket, 'path', v.path, 'storage_provider', v.storage_provider, 'size', v.size);
    else
      update core.files set orphaned_at = null, last_referenced_at = now() where id = v.id;
    end if;
  end loop;
  return v_out;
end $$;

create or replace function core.file_gc_done(p_id uuid)
returns void language plpgsql as $$
begin
  if core.file_reference_retention(p_id) is not null then perform core.fail('INVALID_OPERATION', 409, jsonb_build_object('reason', 'file referenced again')); end if;
  delete from core.files where id = p_id and orphaned_at is not null;
end $$;

-- Lo que referencia el propio núcleo.
select core.register_file_field(null, 'core', 'feedback_attachments', 'file_id', 'temporary');

create or replace function public.core_file_gc_mark(p_limit int) returns jsonb
language sql security definer set search_path = '' as $$ select core.file_gc_mark(p_limit) $$;
create or replace function public.core_file_gc_claim(p_limit int) returns jsonb
language sql security definer set search_path = '' as $$ select core.file_gc_claim(p_limit) $$;
create or replace function public.core_file_gc_done(p_id uuid) returns void
language sql security definer set search_path = '' as $$ select core.file_gc_done(p_id) $$;

do $$
declare f text;
begin
  for f in select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where (n.nspname = 'core' and p.proname in ('register_file_field','enable_file_gc','file_reference_retention','file_gc_mark','file_gc_claim','file_gc_done'))
             or (n.nspname = 'public' and p.proname like 'core\_file\_gc\_%') loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;

-- Recogida diaria por el worker de central-api (marca, y borra lo que ya cumplió los 30 días).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select cron.schedule('ikisai-files-gc', '45 4 * * *', $c$select core.worker_tick('central', 'files/gc') where exists (select 1 from core.file_gc_apps)$c$)$q$;
  end if;
end $$;
