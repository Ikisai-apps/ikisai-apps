-- Ikisai Booking · seguridad B2 (auditoría de rutas del 27-10-2026): dos lecturas con datos de huéspedes exigen en el SQL
-- lo mismo que la Edge (`requireGuests`): owner, o editor con `scopes.guests` (`booking.actor_sees_guests`, 0472).
-- Sin esto, un editor sin el ámbito las leía directamente por `read/…` y obtenía documentos, nacimiento, dirección y
-- teléfono (`ses_guest_report_source`) o el archivo de la firma (`guest_signature_file`).
-- - `booking.ses_guest_report_source`: comprueba y llama a la de siempre, que pasa a `_base` (sin registrar). La de sistema
--   (`_system`, tick de SES) llama a `_base`: no hay persona que comprobar.
-- - `booking.guest_signature_file`: comprueba antes de buscar el archivo.
-- Toca solo el schema booking.

alter function booking.ses_guest_report_source(jsonb) rename to ses_guest_report_source_base;

create or replace function booking.ses_guest_report_source(p jsonb)
returns jsonb language plpgsql stable as $$
begin
  if not booking.actor_sees_guests((p->>'actor')::uuid) then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'guests scope required'));
  end if;
  return booking.ses_guest_report_source_base(p);
end $$;

create or replace function booking.ses_guest_report_source_system(p jsonb)
returns jsonb language sql stable as $$ select booking.ses_guest_report_source_base(p) $$;

create or replace function booking.guest_signature_file(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_id uuid; v_out jsonb;
begin
  if not booking.actor_sees_guests((p->>'actor')::uuid) then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'guests scope required'));
  end if;
  begin v_id := (p->'args'->>'guest_id')::uuid; exception when others then v_id := null; end;
  select jsonb_build_object('bucket', f.bucket, 'path', f.path, 'mime', f.mime, 'filename', f.filename, 'storage_provider', f.storage_provider) into v_out
    from booking.guests g join core.files f on f.id = g.signature_file_id and f.status = 'verified' and f.app in ('booking','guests')
   where g.id = v_id and g.deleted_at is null;
  return coalesce(v_out, 'null'::jsonb);
end $$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
