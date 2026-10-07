-- Ikisai Booking · la firma del huésped trae dónde vive su archivo (`core.files.storage_provider`, contrato §3.9), para que la
-- Edge la firme con createStorage y no llame a Supabase Storage directamente. Toca solo el schema booking.
create or replace function booking.guest_signature_file(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_id uuid; v_out jsonb;
begin
  begin v_id := (p->'args'->>'guest_id')::uuid; exception when others then v_id := null; end;
  select jsonb_build_object('bucket', f.bucket, 'path', f.path, 'mime', f.mime, 'filename', f.filename, 'storage_provider', f.storage_provider) into v_out
    from booking.guests g join core.files f on f.id = g.signature_file_id and f.status = 'verified' and f.app in ('booking','guests')
   where g.id = v_id and g.deleted_at is null;
  return coalesce(v_out, 'null'::jsonb);
end $$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
