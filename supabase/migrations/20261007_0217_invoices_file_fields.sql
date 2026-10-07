-- Invoices · campos de archivo y recogida de huérfanos (contrato §3.9, ALMACENAMIENTO.md fase 2, #243). Toca solo el schema invoices.
--
-- Cada columna que guarda un `file_id` con su retención:
-- - `legal`: los documentos de las facturas recibidas y emitidas (obligación de conservación). Nunca se borran solos.
-- - `operational`: extracciones y texto leído. Apuntan al mismo documento que la factura, que ya es `legal`; un archivo
--   que alguna vez fue `legal` nunca se borra solo, así que esta clase no pone en riesgo el original.
-- - `temporary`: el ZIP de la gestoría, que se regenera desde el manifest.
-- Después se activa la recogida para la app: un huérfano espera 30 días.

select core.register_file_field('invoices', 'invoices', 'invoice_files', 'file_id', 'legal');
select core.register_file_field('invoices', 'invoices', 'issued_invoice_files', 'file_id', 'legal');
select core.register_file_field('invoices', 'invoices', 'extractions', 'file_id', 'operational');
select core.register_file_field('invoices', 'invoices', 'document_texts', 'file_id', 'operational');
select core.register_file_field('invoices', 'invoices', 'exports', 'zip_file_id', 'temporary');

select core.enable_file_gc('invoices');
