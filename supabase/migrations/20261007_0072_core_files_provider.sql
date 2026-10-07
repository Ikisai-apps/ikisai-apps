-- Ikisai Core · almacenamiento con varios proveedores (coordinacion/ampliacion/ALMACENAMIENTO.md, fase 1, aprobado el 7-10-2026).
-- `core.files.bucket` pasa a ser lógico y `storage_provider` dice dónde vive el objeto (Supabase Storage o Cloudflare R2).
-- Las apps no cambian: siguen guardando `file_id`. Los archivos nuevos van al proveedor por defecto de la Edge.

alter table core.files add column if not exists storage_provider text not null default 'supabase' check (storage_provider in ('supabase','r2'));
create index if not exists files_provider_idx on core.files (storage_provider);

drop function if exists public.core_file_create(text, uuid, text, text, text, bigint, text);
drop function if exists core.file_create(text, uuid, text, text, text, bigint, text);

create or replace function core.file_create(p_app text, p_actor uuid, p_bucket text, p_filename text, p_mime text, p_size bigint, p_sha256 text, p_provider text default 'supabase')
returns jsonb language plpgsql as $$
declare v_role text; v_id uuid := gen_random_uuid(); v_ext text; v_path text; v_safe text;
begin
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is null then perform core.fail('NO_MEMBERSHIP', 403); end if;
  if v_role = 'reader' and p_bucket <> 'feedback-media' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'readers cannot upload')); end if;
  if p_filename is null or length(p_filename) = 0 or length(p_filename) > 255 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid filename')); end if;
  if p_sha256 !~ '^[0-9a-f]{64}$' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid sha256')); end if;
  v_ext := lower(coalesce(nullif(regexp_replace(p_filename, '^.*\.', ''), p_filename), ''));
  if v_ext !~ '^[a-z0-9]{1,8}$' then v_ext := 'bin'; end if;
  v_safe := regexp_replace(regexp_replace(lower(p_filename), '[^a-z0-9._()-]+', '_', 'g'), '_+', '_', 'g');
  v_path := format('%s/%s/%s/%s', p_app, to_char(now(), 'YYYY'), v_id, v_safe);
  if coalesce(p_provider, 'supabase') not in ('supabase','r2') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'unknown storage provider')); end if;
  insert into core.files (id, app, bucket, path, filename, mime, size, sha256, created_by, storage_provider)
  values (v_id, p_app, p_bucket, v_path, p_filename, p_mime, p_size, p_sha256, p_actor, coalesce(p_provider, 'supabase'));
  return jsonb_build_object('id', v_id, 'storageProvider', coalesce(p_provider, 'supabase'), 'bucket', p_bucket, 'path', v_path, 'sha256', p_sha256, 'size', p_size, 'mime', p_mime, 'filename', p_filename,
    'duplicateOf', (select f.id from core.files f where f.app = p_app and f.sha256 = p_sha256 and f.status = 'verified' and f.id <> v_id order by f.created_at limit 1));
end $$;

create or replace function public.core_file_create(p_app text, p_actor uuid, p_bucket text, p_filename text, p_mime text, p_size bigint, p_sha256 text, p_provider text default 'supabase') returns jsonb
language sql security definer set search_path = '' as $$ select core.file_create(p_app, p_actor, p_bucket, p_filename, p_mime, p_size, p_sha256, p_provider) $$;

revoke all on function core.file_create(text, uuid, text, text, text, bigint, text, text) from public, anon, authenticated;
revoke all on function public.core_file_create(text, uuid, text, text, text, bigint, text, text) from public, anon, authenticated;
grant execute on function core.file_create(text, uuid, text, text, text, bigint, text, text) to service_role;
grant execute on function public.core_file_create(text, uuid, text, text, text, bigint, text, text) to service_role;

-- El detalle del feedback devuelve el proveedor de cada imagen.
create or replace function core.feedback_get(p_actor uuid, p_id uuid)
returns jsonb language plpgsql stable as $$
declare v core.feedback_reports;
begin
  select * into v from core.feedback_reports where id = p_id or code = p_id::text;
  if v.id is null or not core.feedback_can_see(v, p_actor) then perform core.fail('OUT_OF_SCOPE', 404); end if;
  return jsonb_build_object('report', core.feedback_json(v, p_actor), 'context', v.context, 'sourceRoute', v.source_route, 'reporterUserId', v.reporter_user_id,
    'attachments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'fileId', a.file_id, 'bucket', f.bucket, 'path', f.path, 'mime', f.mime, 'provider', f.storage_provider) order by a.created_at)
                             from core.feedback_attachments a join core.files f on f.id = a.file_id where a.report_id = v.id), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('sequence', l.sequence, 'externalRef', l.external_ref, 'taskId', l.task_id, 'status', l.task_status) order by l.sequence)
                       from core.feedback_task_links l where l.report_id = v.id), '[]'::jsonb));
end $$;
