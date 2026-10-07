# Organizers · peticiones a Core y a otras apps

Detalle en `API.md` §13 y §14. Core responde aquí y resume en `docs/core/RESPUESTAS.md`.

## Fase 1 · Preparación

| Id | Para | Petición | Estado |
|---|---|---|---|
| B1 | Booking | Detalle de la reserva para la ficha (horas, plazas confirmadas, lo que incluye), sin importes ni notas internas | hecha (#277, `booking.portal_reservation_detail`) |
| B2 | Booking | `declared` en `booking.portal_guests` | hecha (#277) |
| B3 | Booking | `portal_add_guest` idempotente ante un reintento con el mismo `guest_id` | hecha (#277) |
| B4 | Booking | (opcional) restricciones de cocina del grupo sin huésped, para el modo `ninguno` | aplazada |
| B5 | Booking | Campos booleanos en `portal_guests` (`is_minor`). Hoy `true` significa a la vez «rellenado por otro» y «vale `true`», y el `false` por defecto sale como rellenado. Propuesta: en los booleanos, el valor si lo escribió el organizador y `null` si nunca se escribió | abierta |
| B11 | Booking | Coorganizadores: lectura `booking.portal_organizers({reservation_id})` con los nombres para mostrar de quienes organizan el retiro, sin correo ni teléfono | hecha (#284; en la ficha del retiro) |
| C1 | Core | `sync-client`: `loginWithLink(token)` | en #278 |
| C2 | Core | `portal-links`: reutilizar la cuenta del huésped y `replace: true` al reenviar | en #278 |
| C3 | Core | `permanentAccount` en `GET auth/config` | en #278 |
| C4 | UI | Entrada «Ayuda y sugerencias» del lanzador en portales y paso `signal` sin el interruptor | hecha (kit 0.18.5, #279) |
| C5 | Core | Alta de infraestructura con la primera PR de `apps/organizers` | abierta (#282) |
| C6 | UI | `createAppShell({ nav: [] })` pinta la barra inferior vacía (`.nonav .nav`), que en móvil tapa los botones del pie. Organizers la oculta en su CSS | abierta |
| C7 | Central | `central.common_texts_projection` legible desde `organizers` (`organizers.declaration`, `portal.privacy`, `contact.email`, `contact.phone`) | en curso |
| C8 | UI | Icono propio de Organizers para la PWA (hoy usa el de Central) | abierta |
| U1 | UI | Capa de traducción del kit (español e inglés) con claves por app y textos del kit traducidos | abierta |
| U2 | UI | Indicador de guardado automático del kit: «Guardando…», «Guardado» y «No se ha guardado · Reintentar», por campo o por formulario | abierta |
| U3 | UI | Hoja «Instala la app»: `beforeinstallprompt` e instrucciones de iOS, con recuerdo de «ahora no» | abierta |
| X1 | Central | Textos comunes por idioma (columna `lang` o claves `.es` y `.en`), con el español como reserva | abierta |

## Fase 2 · Diseño desde el interesado

| Id | Para | Petición | Prioridad |
|---|---|---|---|
| B6 | Booking | **Disponibilidad:** `booking.portal_availability({from, to})` → por fin de semana (de viernes a domingo) y por día en las opciones entre semana: `libre`, `en_opcion` u `ocupado`, sin decir quién ni por qué. `ocupado` incluye los bloqueos manuales internos; la propia reserva no cuenta contra sí misma. Ventana de 18 meses | alta · aprobada |
| B7 | Booking | **Fechas definitivas y posibles.** (a) En `booking.reservations`, la fecha definitiva como dato explícito (`dates_definitive boolean`, o equivalente que marque el comercial; con ella, `start_date` y `end_date` son la fecha fija). (b) Tabla `booking.reservation_date_options`: reserva, inicio, fin, horas aproximadas, `proposed_by` (`ikisai` u `organizer`), `organizer_ok` (el organizador la marca como posible) y posición. La escribe el personal en Booking (propuestas de Ikisai) y el portal con B8. (c) Lectura `booking.portal_dates({reservation_id})` → `{definitive: {start, end, arrival_time, departure_time} | null, options: [{id, start, end, proposed_by, organizer_ok, availability}], mode: 'fixed' | 'ikisai_options' | 'calendar'}`. (d) Acción `booking.portal_update_draft({reservation_id, expectedRevision, fields})` solo con la reserva en `en_estudio` o `negociacion` y solo con campos de diseño: personas previstas, menores, régimen y estilo de menú pedidos, alojamiento, servicios (centro, exterior, piscina, montaje, apoyo técnico), extras pedidos y notas del organizador | alta |
| B8 | Booking | **Fechas posibles del organizador:** acción `booking.portal_set_date_preferences({reservation_id, options})`, que sustituye lo que marcó el organizador. Con propuestas de Ikisai, `options = [{option_id, ok}]` y solo marca `organizer_ok`. Sin propuestas, `options = [{start, end}]` y crea filas `proposed_by: organizer`. Errores: `DATES_FIXED` si ya hay fecha definitiva, `DATE_UNAVAILABLE` si está ocupada, `DATE_NOT_OFFERED` si Ikisai propuso fechas y se marca otra. Avisa al comercial por la cola y el tick de Booking (Inicio de Booking y petición a Tasks, T3), no al instante. Nunca fija la fecha | alta · aprobada |
| B9 | Booking | **Tarifas para la calculadora** (cambia, aprobado): no hay cálculo en SQL. `booking.portal_rates({reservation_id})` publica las tarifas visibles, las condiciones (IVA incluido) y `minimum_total`; Organizers calcula en el dispositivo con `@ikisai/domain-booking` (`suggestLines`, `proposalTotals`). Sin tarifas: lista vacía y la calculadora dice «Ikisai te enviará el precio» | alta · aprobada |
| B10 | Booking | **Extras para el portal:** `public_name` y `public_description` en los extras visibles (incluidas las habitaciones de 2–4 plazas con baño); los pedidos del organizador van en `booking.reservation_extra_requests` | media · aprobada |
| T3 | Tasks | Peticiones de sistema «Fechas posibles marcadas por un organizador» (B8) y «Quiere confirmar» o «Comentario sobre la propuesta» (B12), que lanza Booking, con regla de enrutado al área comercial | media |
| Fd1 | Food | Para el diseño basta con la orientación del menú de Booking (`menu_style`). Opcional: `food.portal_sample_menu({style})`, un menú de ejemplo público por orientación (platos con su nombre y descripción públicos, sin cantidades) para enseñarlo al interesado | baja |
| X2 | Central | Textos `organizers.dates_note` («Ikisai confirmará la fecha definitiva; lo que marques son posibilidades.»), `organizers.quote_note` (IVA incluido, mínimo, precio orientativo) y `organizers.proposal_note` («Para confirmar, pulsa «Quiero confirmar» y el equipo de Ikisai te contactará»), en los dos idiomas | media |
| K1 | Core | Comprobación de ámbito de portal reutilizable por cualquier app (`core.portal_in_scope(portal, actor, reservation_id, guest_id)`), para que Finance y Food filtren sus lecturas de portal sin depender de una función de Booking | alta |

## Fase 3 · Formalización

| Id | Para | Petición | Prioridad |
|---|---|---|---|
| B12 | Booking | **Propuesta en el portal, sin aceptar** (decisión del usuario): lectura `booking.portal_proposals({reservation_id})` (propuestas `enviada` y `aceptada`, con líneas, condiciones, tramos de cancelación y validez). Acción `booking.portal_request({reservation_id, kind: 'quiere_confirmar' \| 'comentario', proposal_id?, message?})`, que deja la petición en una tabla de Booking (`booking.portal_requests`: reserva, tipo, propuesta, mensaje, quién, cuándo y estado `enviada`, `vista` o `respondida`, que cambia el personal) y avisa al comercial por la cola de Booking. Lectura de las propias peticiones con su estado. La aceptación sigue siendo de Booking (`accept_proposal`) | alta · aprobada |
| B13 | Booking | Al confirmar: pedir a Tasks el proyecto `AAAAMMDD-<título>` y, por cada extra contratado, su tarea (B13 depende de T1 y T2) | alta |
| F1 | Finance | **Dinero del retiro para el portal:** lectura `invoices.portal_reservation_money({reservation_id})` filtrada por ámbito (K1). Devuelve total contratado, señal requerida y pagada, saldo, vencimientos, cobros (fecha, importe, forma) y facturas emitidas (número, fecha, importe, estado), sin datos internos | alta |
| F2 | Finance | Descarga del PDF de una factura desde el portal (URL firmada de corta duración), solo dentro del ámbito | alta |
| F3 | Finance | Instrucciones de pago a Ikisai (IBAN, concepto y Bizum) como textos de Central o ajuste de Finance, en los dos idiomas | media |
| T1 | Tasks | **Proyecto por retiro por petición de sistema:** crear de forma idempotente (por `external_ref` = reserva) el proyecto `AAAAMMDD-<título>` en el área que fija la regla del owner, y renombrarlo si cambian la fecha o el título | alta |
| T2 | Tasks | Tareas de los extras contratados dentro de ese proyecto, idempotentes por línea (`external_ref` = línea de la propuesta) | media |
