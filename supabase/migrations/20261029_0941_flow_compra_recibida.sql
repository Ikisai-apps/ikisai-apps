-- Ikisai Flow · primer recorrido de dos tramos (flow-14, paso 4): «Compra recibida».
-- 1. Registrar la compra en Finance (capacidad `register_purchase_quick`, como «Registrar compra»).
-- 2. Pedir la reposición a Tasks (capacidad `request_task`): el título y la referencia salen del tramo 1 (lo comprado y el id
--    de la factura que devuelve Finance), sin volver a preguntarlos; `source` fijo (no `flow`, que Tasks reserva a la Edge de Flow).
-- Ids de capacidad compuestos («app» || «.operación»): son ids del catálogo, no objetos de base de datos.

insert into flow.definitions (id, key, name, description) values
  ('0f10a000-0000-4000-8000-00000000d002', 'compra_recibida', 'Compra recibida', 'Registra la compra en Finance y pide su reposición a Tasks, sin repetir datos.');
insert into flow.definition_versions (id, definition_id, version, status) values
  ('0f10a000-0000-4000-8000-00000000d201', '0f10a000-0000-4000-8000-00000000d002', 1, 'draft');
insert into flow.definition_stages (id, version_id, position, kind, capability, title, explain) values
  ('0f10a000-0000-4000-8000-00000000d211', '0f10a000-0000-4000-8000-00000000d201', 1, 'capability', 'invoices' || '.register_purchase_quick', 'Registrar la compra', 'Queda en Finance pendiente de revisión.'),
  ('0f10a000-0000-4000-8000-00000000d212', '0f10a000-0000-4000-8000-00000000d201', 2, 'capability', 'tasks' || '.request_task', 'Pedir la reposición', 'Una tarea en Tasks para reponer lo que se ha gastado.');
insert into flow.definition_steps (version_id, stage_id, position, key, title, explain, essential, mode, fixed_value, default_from) values
  ('0f10a000-0000-4000-8000-00000000d201', '0f10a000-0000-4000-8000-00000000d211', 1, 'supplier.name', '¿A quién le has comprado?', 'El proveedor, como sale en el ticket. Si Finance no lo conoce, lo crea.', true, 'ask', null, null),
  ('0f10a000-0000-4000-8000-00000000d201', '0f10a000-0000-4000-8000-00000000d211', 2, 'date', '¿Qué día fue la compra?', 'La fecha del ticket o de la factura, no la de hoy si es distinta.', true, 'ask', null, null),
  ('0f10a000-0000-4000-8000-00000000d201', '0f10a000-0000-4000-8000-00000000d211', 3, 'total', '¿Cuánto pagaste, con IVA?', 'El total del ticket, en euros, con dos decimales.', true, 'ask', null, null),
  ('0f10a000-0000-4000-8000-00000000d201', '0f10a000-0000-4000-8000-00000000d211', 4, 'description', '¿Qué compraste?', 'Una frase corta: «Hielo para la barra». Servirá también para la reposición.', true, 'ask', null, null),
  ('0f10a000-0000-4000-8000-00000000d201', '0f10a000-0000-4000-8000-00000000d211', 5, 'target', '¿Para qué es?', 'Para un evento de Booking o gasto general. Así la oficina lo imputa bien.', true, 'ask', null, null),
  ('0f10a000-0000-4000-8000-00000000d201', '0f10a000-0000-4000-8000-00000000d211', 6, 'invoice_number', '¿Número del ticket o de la factura?', 'Si lo lleva. Ayuda a no registrarla dos veces.', false, 'ask', null, null),
  ('0f10a000-0000-4000-8000-00000000d201', '0f10a000-0000-4000-8000-00000000d212', 1, 'title', 'Qué reponer', 'Sale de lo que has comprado en el tramo anterior.', true, 'from', null, 'stages[1].values.description'),
  ('0f10a000-0000-4000-8000-00000000d201', '0f10a000-0000-4000-8000-00000000d212', 2, 'external_ref', 'Referencia', 'La factura registrada en Finance.', true, 'from', null, 'stages[1].result.invoice_id'),
  ('0f10a000-0000-4000-8000-00000000d201', '0f10a000-0000-4000-8000-00000000d212', 3, 'source', 'Origen', null, true, 'fixed', '"recorridos"'::jsonb, null),
  ('0f10a000-0000-4000-8000-00000000d201', '0f10a000-0000-4000-8000-00000000d212', 4, 'note', '¿Algo que deba saber quien repone?', 'Cantidad, dónde se guarda, para cuándo…', false, 'ask', null, null),
  ('0f10a000-0000-4000-8000-00000000d201', '0f10a000-0000-4000-8000-00000000d212', 5, 'priority', '¿Es urgente?', 'Normal si no corre prisa.', false, 'ask', null, null);
-- Publicada (sin procedimiento: es una migración; las reglas de publish_version se cumplen).
update flow.definition_versions set status = 'published', capability = 'invoices' || '.register_purchase_quick' where id = '0f10a000-0000-4000-8000-00000000d201';
