-- Ikisai Core · registro de archivos subidos a Storage (tickets de subida, verificación, resolución de id → ruta).
create table core.files (
  id uuid primary key default gen_random_uuid(),
  app text not null references core.apps(id),
  bucket text not null,
  path text not null unique,
  filename text not null,
  mime text not null,
  size bigint not null check (size >= 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending','verified','missing')),
  hash_verified boolean not null default false,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  verified_at timestamptz
);
create index files_app_sha_idx on core.files (app, sha256);
alter table core.files enable row level security;
revoke all on core.files from public, anon, authenticated;
grant all on core.files to service_role;

create or replace function core.file_create(p_app text, p_actor uuid, p_bucket text, p_filename text, p_mime text, p_size bigint, p_sha256 text)
returns jsonb language plpgsql as $$
declare v_role text; v_id uuid := gen_random_uuid(); v_ext text; v_path text; v_safe text;
begin
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is null then perform core.fail('NO_MEMBERSHIP', 403); end if;
  if v_role = 'reader' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'readers cannot upload')); end if;
  if p_filename is null or length(p_filename) = 0 or length(p_filename) > 255 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid filename')); end if;
  if p_sha256 !~ '^[0-9a-f]{64}$' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid sha256')); end if;
  v_ext := lower(coalesce(nullif(regexp_replace(p_filename, '^.*\.', ''), p_filename), ''));
  if v_ext !~ '^[a-z0-9]{1,8}$' then v_ext := 'bin'; end if;
  v_safe := regexp_replace(regexp_replace(lower(p_filename), '[^a-z0-9._()-]+', '_', 'g'), '_+', '_', 'g');
  v_path := format('%s/%s/%s/%s', p_app, to_char(now(), 'YYYY'), v_id, v_safe);
  insert into core.files (id, app, bucket, path, filename, mime, size, sha256, created_by)
  values (v_id, p_app, p_bucket, v_path, p_filename, p_mime, p_size, p_sha256, p_actor);
  return jsonb_build_object('id', v_id, 'bucket', p_bucket, 'path', v_path, 'sha256', p_sha256, 'size', p_size, 'mime', p_mime, 'filename', p_filename,
    'duplicateOf', (select f.id from core.files f where f.app = p_app and f.sha256 = p_sha256 and f.status = 'verified' and f.id <> v_id order by f.created_at limit 1));
end $$;

create or replace function core.file_mark(p_id uuid, p_status text, p_size bigint, p_hash_verified boolean)
returns jsonb language plpgsql as $$
declare v_row core.files;
begin
  update core.files set status = p_status, size = coalesce(p_size, size), hash_verified = coalesce(p_hash_verified, hash_verified),
    verified_at = case when p_status = 'verified' then now() else verified_at end
  where id = p_id returning * into v_row;
  if v_row.id is null then perform core.fail('FILE_NOT_FOUND', 404); end if;
  return to_jsonb(v_row);
end $$;

create or replace function core.file_get(p_app text, p_actor uuid, p_id uuid)
returns jsonb language plpgsql stable as $$
declare v_role text; v_row core.files;
begin
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is null then perform core.fail('NO_MEMBERSHIP', 403); end if;
  select * into v_row from core.files where id = p_id and app = p_app;
  if v_row.id is null then perform core.fail('FILE_NOT_FOUND', 404, jsonb_build_object('id', p_id)); end if;
  return to_jsonb(v_row);
end $$;

create or replace function public.core_file_create(p_app text, p_actor uuid, p_bucket text, p_filename text, p_mime text, p_size bigint, p_sha256 text) returns jsonb
language sql security definer set search_path = '' as $$ select core.file_create(p_app, p_actor, p_bucket, p_filename, p_mime, p_size, p_sha256) $$;
create or replace function public.core_file_mark(p_id uuid, p_status text, p_size bigint, p_hash_verified boolean) returns jsonb
language sql security definer set search_path = '' as $$ select core.file_mark(p_id, p_status, p_size, p_hash_verified) $$;
create or replace function public.core_file_get(p_app text, p_actor uuid, p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.file_get(p_app, p_actor, p_id) $$;

do $$
declare f text;
begin
  for f in select 'public.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'core\_file\_%' loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
  for f in select 'core.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'core' and p.proname like 'file\_%' loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
