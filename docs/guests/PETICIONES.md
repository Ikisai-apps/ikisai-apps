# Guests · peticiones a Core

Detalle en `API.md` §14. Core responde aquí y resume en `docs/core/RESPUESTAS.md`.

| Id | Para | Petición | Estado |
|---|---|---|---|
| BG1 | Booking | `sources` por campo y `source` por restricción en `portal_my_guest` | hecha (#284) |
| BG2 | Booking | `revision` nueva en la respuesta de las acciones del huésped | hecha (#284) |
| BG3 | Booking | `diet_reviewed_at`: alimentación revisada, también con la lista vacía | hecha (#284) |
| BG4 | Booking | `status`, `arrival_time` y `departure_time` en `portal_my_guest.reservation` | hecha (#284) |
| BG5 | Booking | la firma deja de valer si cambia un dato del registro después de firmar; versión del texto firmado | hecha (#284) |
| BG6 | Booking | parentesco: ¿códigos del catálogo de SES en el dominio? | hecha (#284) |
| CE1 | Central | textos por idioma (`es`, `en`) con alternativa en español | hecha (#281) |
| CE2 | Central | claves `guests.data_why`, `guests.signature_statement`, `guests.allergies_notice` e `info.*` | hecha (#281) |
| C1 | Core | lectura pública del contacto para las pantallas sin sesión | en el kit (#297); falta la #289 de Central. Guests ya la lee |
| C2 | Core | firma (`app = 'guests'`, columna de Booking) y recogida de huérfanos | respondida: migración 0600 |
| C3 | Core | alta de infraestructura con la primera PR de `apps/guests` | hecha (#290): en producción |
| C4 | Core | varias entradas de ámbito por cuenta con la #278 | confirmada |
| C5 | Core | comentarios «Mi retiro» antes de la bandeja de Organizers | respondida: los ve Booking |
| C6 | Core | cuentas internas de huésped al vencer la conservación | la hace Core con Booking |
| C7 | Core | `uploads`: lectura y verificación solo del autor | hecha (#288) |
| O1 | Organizers | URL firmadas de los materiales publicados para el huésped | abierta |
| U1 | UI | capa de traducción y catálogos del feedback por idioma | hecha (#285), en uso |
| U2 | UI | recuadro de firma en el kit | opcional: Guests tiene el suyo en `ui/sign.ts` |
| U3 | UI | estado de guardado por campo y global | opcional: Guests tiene el suyo (`writer.ts`) |
| U4 | UI | icono de Guests y `nav: []` sin barra | hecha |
| BG9 | Booking | programa del retiro: `program_items`, acciones para el organizador y `portal_program` | hecha (#328), en uso |
| BG10 | Booking | alojamiento: `portal_lodging`, `portal_choose_bed` atómica, `portal_release_bed`, `portal_room_preference` y columnas nuevas | hecha (#328), en uso |
| BG11 | Booking | huésped de muestra para la vista previa (`preview`, `PREVIEW_READ_ONLY`) | hecha (#328 y #325), en uso |
| BG12 | Booking | `reservation_id` en `food_event_projection` | hecha (ya estaba) |
| FD1 | Food | `food.portal_menu` para `guests` y `organizers` | hecha (#327), en uso |
| O1 | Organizers | resolutor `guest_material_file` y lectura `guest_materials` | abierta (fase 4) |
| O2 | Organizers | forma de `guest_experience_for`, `guest_questions` y `guest_answer` | abierta: confirmar la salida exacta; Guests acepta la forma de Organizers §15 (`app/normalize.ts`) |
| O3 | Organizers | configuración del alojamiento y aprobación de peticiones | abierta (fase 5) |
| O5 | Organizers | quitar `guest_offers` del contrato | abierta |
| O6 | Organizers | vista previa: huésped de muestra en Guests o pintada en Organizers | decidida: huésped de muestra en Guests |
| O7 | Organizers | preguntas sin salud, alergias ni documentos | abierta |
| CE3 | Central | `info.map_link`, `guests.menu_notice` y plano del centro | hecha (#326), en uso |
| C8 | Core | archivos publicados a un portal: `core.allow_portal_file` y `GET portal-files/:fileId` | hecha (#325) |
| C9 | Core | enlace de Guests al huésped de muestra para el organizador | hecha (#325, `preview: true`) |
| U5 | UI | barra inferior con «Más» y lista de días para el programa | abierta (opcional) |
