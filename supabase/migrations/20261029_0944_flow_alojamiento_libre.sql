-- Ikisai Flow · recorrido «Alojamiento libre · recepción» (flow-19; traspaso V0.3 §4, decisión D3 del roadmap de Core).
-- Booking es la autoridad (plaza, cobro, datos, llegada) y ya tiene la Recepción con sus carriles (Booking §39 y §43): Flow no
-- la duplica, solo guía. Cuatro tramos «ir a Booking», cada uno a su control real de `#/recepcion`, que se cierran cuando
-- Booking confirma la acción (Guiado, 0940) o, si no hay confirmación, con «Hecho»:
-- 1. buscar el número de la solicitud; 2. revisar la ficha y los datos; 3. cobrar y alojar; 4. marcar la llegada.
-- Sin datos de huéspedes en Flow: ni nombres ni documentos (eso queda en Booking).
-- Los anclajes («booking» || «.recepcion.…») son ids de pantalla de la app, no objetos de base de datos.

insert into flow.definitions (id, key, name, description) values
  ('0f10a000-0000-4000-8000-00000000d003', 'alojamiento_recepcion', 'Alojamiento libre · recepción', 'Alojar a quien llega con su número de «Alójate aquí»: buscar, revisar, cobrar y marcar la llegada, en Booking.');
insert into flow.definition_versions (id, definition_id, version, status) values
  ('0f10a000-0000-4000-8000-00000000d301', '0f10a000-0000-4000-8000-00000000d003', 1, 'draft');
insert into flow.definition_stages (id, version_id, position, kind, title, explain, target_app, target_anchor) values
  ('0f10a000-0000-4000-8000-00000000d311', '0f10a000-0000-4000-8000-00000000d301', 1, 'handoff', 'Busca su número', 'En Recepción de Booking, escribe el número que le dio «Alójate aquí» (o su nombre).', 'booking', 'booking' || '.recepcion.buscar'),
  ('0f10a000-0000-4000-8000-00000000d312', '0f10a000-0000-4000-8000-00000000d301', 2, 'handoff', 'Revisa su ficha', 'Mira qué falta por persona: datos para el registro, firma y cama. Complétalo en la ficha.', 'booking', 'booking' || '.recepcion.ficha'),
  ('0f10a000-0000-4000-8000-00000000d313', '0f10a000-0000-4000-8000-00000000d301', 3, 'handoff', 'Cobra y aloja', 'Elige cómo paga (Bizum, efectivo, Bitcoin o tarjeta) y pulsa «Cobrar y alojar». Si ya pagó en línea, «Alojar (pagado en línea)».', 'booking', 'booking' || '.recepcion.cobrar'),
  ('0f10a000-0000-4000-8000-00000000d314', '0f10a000-0000-4000-8000-00000000d301', 4, 'handoff', 'Marca la llegada', 'Cuando esté aquí, «Llega». Si aún no ha llegado, vuelve a este paso más tarde.', 'booking', 'booking' || '.recepcion.llega');
-- Un paso por tramo con el anclaje: la confirmación de Booking (Guiado) cierra el tramo.
insert into flow.definition_steps (version_id, stage_id, position, key, title, essential, mode, anchor) values
  ('0f10a000-0000-4000-8000-00000000d301', '0f10a000-0000-4000-8000-00000000d311', 1, 'confirmacion', 'Número encontrado', true, 'ask', 'booking' || '.recepcion.buscar'),
  ('0f10a000-0000-4000-8000-00000000d301', '0f10a000-0000-4000-8000-00000000d312', 1, 'confirmacion', 'Ficha revisada', true, 'ask', 'booking' || '.recepcion.ficha'),
  ('0f10a000-0000-4000-8000-00000000d301', '0f10a000-0000-4000-8000-00000000d313', 1, 'confirmacion', 'Cobrado y alojado', true, 'ask', 'booking' || '.recepcion.cobrar'),
  ('0f10a000-0000-4000-8000-00000000d301', '0f10a000-0000-4000-8000-00000000d314', 1, 'confirmacion', 'Ha llegado', true, 'ask', 'booking' || '.recepcion.llega');
update flow.definition_versions set status = 'published' where id = '0f10a000-0000-4000-8000-00000000d301';
