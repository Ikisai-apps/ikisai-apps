-- Ikisai Central · campos que guardan un archivo de `core.files` y activación de la recogida de huérfanos
-- (contrato §3.9, ALMACENAMIENTO.md fase 2; retenciones indicadas por Core). Toca solo el schema central.
-- Un archivo que alguna vez fue `legal` o `permanent` nunca se borra solo; un huérfano espera 30 días.

-- Logotipo de la entidad: lo usan las propuestas de Booking y las facturas de Finance.
select core.register_file_field('central', 'central', 'entity', 'logo_file_id', 'permanent');
-- Documentación de personas (contratos, certificados, formación) y documentos clave de cumplimiento.
select core.register_file_field('central', 'central', 'person_records', 'file_id', 'legal');
select core.register_file_field('central', 'central', 'key_documents', 'file_id', 'legal');

select core.enable_file_gc('central');
