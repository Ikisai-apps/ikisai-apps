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
| O1 | Organizers | URL firmadas de los materiales publicados para el huésped | hecha (#333), en uso |
| U1 | UI | capa de traducción y catálogos del feedback por idioma | hecha (#285), en uso |
| U2 | UI | recuadro de firma en el kit | opcional: Guests tiene el suyo en `ui/sign.ts` |
| U3 | UI | estado de guardado por campo y global | opcional: Guests tiene el suyo (`writer.ts`) |
| U4 | UI | icono de Guests y `nav: []` sin barra | hecha |
| BG9 | Booking | programa del retiro: `program_items`, acciones para el organizador y `portal_program` | hecha (#328), en uso |
| BG10 | Booking | alojamiento: `portal_lodging`, `portal_choose_bed` atómica, `portal_release_bed`, `portal_room_preference` y columnas nuevas | hecha (#328), en uso |
| BG11 | Booking | huésped de muestra para la vista previa (`preview`, `PREVIEW_READ_ONLY`) | hecha (#328 y #325), en uso |
| BG12 | Booking | `reservation_id` en `food_event_projection` | hecha (ya estaba) |
| FD1 | Food | `food.portal_menu` para `guests` y `organizers` | hecha (#327), en uso |
| O1 | Organizers | resolutor `guest_material_file` y lectura `guest_materials` | hecha (#333), en uso |
| O2 | Organizers | forma de `guest_experience_for`, `guest_questions` y `guest_answer` | hecha (#333): la forma de §13; en uso |
| O3 | Organizers | configuración del alojamiento y aprobación de peticiones | hecha (#333 y Booking #328), en uso |
| O5 | Organizers | quitar `guest_offers` del contrato | abierta |
| O6 | Organizers | vista previa: huésped de muestra en Guests o pintada en Organizers | decidida: huésped de muestra en Guests |
| O7 | Organizers | preguntas sin salud, alergias ni documentos | abierta |
| CE3 | Central | `info.map_link`, `guests.menu_notice` y plano del centro | hecha (#326), en uso |
| C8 | Core | archivos publicados a un portal: `core.allow_portal_file` y `GET portal-files/:fileId` | hecha (#325) |
| C9 | Core | enlace de Guests al huésped de muestra para el organizador | hecha (#325, `preview: true`) |
| U5 | UI | barra inferior con «Más» y lista de días para el programa | hecha (kit 0.21), en uso |
| K6 | Core | que una acción de Organizers invocada desde Guests escriba en `organizers.*` (`apply_portal_operations` rechaza hoy un destino portal); sin ello no se guardan las respuestas | hecha (#334), en uso |
| BG13 | Booking | supletorias activadas en `portal_lodging` (con `kind: 'supletoria'`, `extra_total` y `extra_free`) y en `portal_choose_bed` | hecha (#491), en uso |
| C10 | Core | `POST auth/link` y `loginWithLink` devuelven la entrada del enlace (`grant: {reservation_id, guest_id}`), para abrir ese retiro cuando la cuenta tiene varios (regla de entrada de O4a) | hecha (#508, `sync-client` 0.7.1), en uso |
| U6 | UI | textos del calendario en el idioma del kit: «Hoy», «Anterior», «Siguiente» y «Vista» salen siempre en español | abierta |
| FD2 | Food | lectura de portal del menú de casa para el outsider: `food.portal_house_menu({from?, to?})` → `{services: [{date, type, time, dishes: [{name, quick, allergens_checked}]}]}` (preparación de O4 §3) | abierta |
| TK1 | Tasks | resumen de tareas del outsider para Guests: `tasks.portal_my_summary` → `{assigned}` (preparación de O4 §3), cuando Tasks tenga el rol outsider | abierta |
| BG14 | Booking | `portal_role` en el primer nivel de `portal_my_guest` y en cada item de `portal_my_retreats` (API.md §9.17 d) | hecha (#725), en uso |
| BG15 | Booking | accesos de su §29: `validUntil = 'infinity'`, `portal_open_retreats` con `direction`, `status` y `joinable`, `portal_join_direction` y `portal_lodging.team` (API.md §9.17) | hecha (#725), en uso |
| Gu1 | Organizers → Guests | ruta para abrir un retiro concreto | respondida: `#/r/<reservation_id>`, ya en `main`; con dirección sin ficha, la vista de dirección (§9.17) |
| FD3 | Food | `food.portal_offers` para Guests y Organizers, con las internas (`audience`) solo para Guests (API.md §9.18) | acordada; PR de Food pendiente |
| BG16 | Booking | `meal_group` en el primer nivel de `portal_my_guest` (§9.18) | hecha en #748 (0485), sin fusionar |
| FL1 | Flow | `flow.portal_customer({reservation_id, guest_id})` → `{number, carta_url}` con enlace de un solo uso, para la carta «a cuenta» (§9.18) | acordada; en el paso 3 de Flow |
| C11 | Core | visitantes: `core.visitors`, `POST public/visitor`, `X-Visitor`, `resolveVisitor` y `publicReadWithVisitor`; recuperación y transferencia en v2 (API.md §9.19) | contrato fijado; en #775 |
| BG17 | Booking | `booking.events.public_code` para el QR (`/e/<código>`) (§9.19) | en #767 (0488) |
| BG18 | Booking | `POST public/join` en booking-api (`booking.visitor_requests`) con {event_code, kind, name?, contact?, note?}, la lectura `booking_visitor_requests` y `join_from_visitor`; ficha ligada al visitante al aceptarla (§9.19) | en #770, sale con el kit (#775) |
| BG19 | Booking | `booking.public_event({code})`, lectura pública que Guests sirve en `GET public/event` (§9.19) | en #767 (0488); la sirve el kit (`GET public/booking_event`) |
| FD5 | Food | `food.visitor_offers({event_code})`: solo las ofertas con `public` (indicador de `food.event_offers`, «Visible para visitantes (QR)») (§9.19) | acordada; en la #758 de Food |
| FL2 | Flow | `flow.visitor_join({event_code})` (acción) y `flow.visitor_customer` → `{number, carta_url, account_open, orders}` (§9.19) | acordada; tras C11 |
