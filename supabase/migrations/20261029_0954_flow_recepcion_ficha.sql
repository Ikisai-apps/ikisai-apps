-- Ikisai Flow · «Alojamiento libre · recepción», versión 2 (acordado con Booking, #1130, 27-10). En Recepción, el botón «Ficha»
-- abre la hoja de esa persona (`#/huespedes/<evento>/<huésped>`); el campo del documento solo existe con la hoja abierta. Así que
-- el tramo 2 lleva dos pasos: «Abre su ficha» en `booking.recepcion.ficha` (se confirma a mano) y «Completa el documento» en
-- `booking.huespedes.ficha.document_number`, sin ruta propia, que Booking confirma al guardar (`event`) y cierra el tramo.
-- El tramo 3 sigue en `booking.recepcion.cobrar` (también lo confirma lo pagado en línea). La versión 1 queda para las
-- ejecuciones que ya la usan. Los anclajes («booking» || «.…») son ids de pantalla, no objetos de base de datos.

insert into flow.definition_versions (id, definition_id, version, status) values
  ('0f10a000-0000-4000-8000-00000000d302', '0f10a000-0000-4000-8000-00000000d003', 2, 'draft');
insert into flow.definition_stages (id, version_id, position, kind, title, explain, target_app, target_anchor) values
  ('0f10a000-0000-4000-8000-00000000d321', '0f10a000-0000-4000-8000-00000000d302', 1, 'handoff', 'Busca su número', 'En Recepción de Booking, escribe el número que le dio «Alójate aquí» (o su nombre).', 'booking', 'booking' || '.recepcion.buscar'),
  ('0f10a000-0000-4000-8000-00000000d322', '0f10a000-0000-4000-8000-00000000d302', 2, 'handoff', 'Revisa su ficha', 'Pulsa «Ficha» en su tarjeta: se abre su hoja. Mira qué falta (datos para el registro, firma y cama) y complétalo; el documento, en su campo.', 'booking', 'booking' || '.recepcion.ficha'),
  ('0f10a000-0000-4000-8000-00000000d323', '0f10a000-0000-4000-8000-00000000d302', 3, 'handoff', 'Cobra y aloja', 'Elige cómo paga (Bizum, efectivo, Bitcoin o tarjeta) y pulsa «Cobrar y alojar». Si ya pagó en línea, «Alojar (pagado en línea)».', 'booking', 'booking' || '.recepcion.cobrar'),
  ('0f10a000-0000-4000-8000-00000000d324', '0f10a000-0000-4000-8000-00000000d302', 4, 'handoff', 'Marca la llegada', 'Cuando esté aquí, «Llega». Si aún no ha llegado, vuelve a este paso más tarde.', 'booking', 'booking' || '.recepcion.llega');
insert into flow.definition_steps (version_id, stage_id, position, key, title, essential, mode, anchor) values
  ('0f10a000-0000-4000-8000-00000000d302', '0f10a000-0000-4000-8000-00000000d321', 1, 'confirmacion', 'Número encontrado', true, 'ask', 'booking' || '.recepcion.buscar'),
  ('0f10a000-0000-4000-8000-00000000d302', '0f10a000-0000-4000-8000-00000000d322', 1, 'ficha', 'Abre su ficha', true, 'ask', 'booking' || '.recepcion.ficha'),
  ('0f10a000-0000-4000-8000-00000000d302', '0f10a000-0000-4000-8000-00000000d322', 2, 'confirmacion', 'Completa el documento', true, 'ask', 'booking' || '.huespedes.ficha.document_number'),
  ('0f10a000-0000-4000-8000-00000000d302', '0f10a000-0000-4000-8000-00000000d323', 1, 'confirmacion', 'Cobrado y alojado', true, 'ask', 'booking' || '.recepcion.cobrar'),
  ('0f10a000-0000-4000-8000-00000000d302', '0f10a000-0000-4000-8000-00000000d324', 1, 'confirmacion', 'Ha llegado', true, 'ask', 'booking' || '.recepcion.llega');
update flow.definition_versions set status = 'published' where id = '0f10a000-0000-4000-8000-00000000d302';
