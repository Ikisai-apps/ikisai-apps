-- Organizers · logotipo del retiro para Booking (tanda 27, portadas de Inicio, Reservas y la ficha). Solo el logotipo
-- (`materials.is_logo`, uno por reserva: `materials_one_logo`), nada más de los materiales. Como el logotipo de Central
-- (0550): la proyección dice dónde vive el archivo y Booking lo firma con `createStorage` del kit. El campo
-- `materials.file_id` ya está registrado (0700). Toca solo el schema organizers.

create or replace view organizers.booking_logo_projection as
select m.reservation_id, m.id as material_id, m.updated_at,
       f.id as logo_file_id, f.bucket as logo_bucket, f.path as logo_path, f.mime as logo_mime, f.sha256 as logo_sha256,
       f.storage_provider as logo_provider
  from organizers.materials m
  join core.files f on f.id = m.file_id and f.app = 'organizers' and f.status = 'verified' and f.mime like 'image/%'
 where m.is_logo and m.kind = 'file' and m.deleted_at is null;

revoke all on organizers.booking_logo_projection from public, anon, authenticated;
grant select on organizers.booking_logo_projection to service_role;
select core.allow_read('booking', 'organizers.booking_logo_projection', 'view');
