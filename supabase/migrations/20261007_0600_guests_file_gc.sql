-- Ikisai Guests · recogida de huérfanos de sus archivos (contrato §3.9; respuesta C2 de Core del 7-10-2026).
-- Guests no tiene tablas: su único archivo es la imagen de la firma del parte (`core.files` con app = 'guests', bucket
-- `guests-documents`), que referencia `booking.guests.signature_file_id`, campo `legal` que ya declara Booking (0447).
-- Una firma subida que nunca llega a guardarse queda huérfana y se borra a los 30 días; una que fue legal, nunca sola.
select core.enable_file_gc('guests');
