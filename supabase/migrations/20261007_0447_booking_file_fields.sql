-- Ikisai Booking · columnas que guardan un archivo de core.files, para la recogida de huérfanos del núcleo (contrato §3.9,
-- #243). Firma del parte y justificante de SES son registro de viajeros: legales, nunca se borran solos.
select core.register_file_field('booking', 'booking', 'guests', 'signature_file_id', 'legal');
select core.register_file_field('booking', 'booking', 'guests', 'ses_receipt_file_id', 'legal');
select core.enable_file_gc('booking');
