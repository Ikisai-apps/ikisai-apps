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
| B11 | Booking | Coorganizadores: lectura `booking.portal_organizers({reservation_id})` con los nombres para mostrar de quienes organizan el retiro, sin correo ni teléfono | abierta |
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
| B6 | Booking | **Disponibilidad segura:** `booking.portal_availability({from, to})` → por día `libre`, `en_opcion` u `ocupado`, sin decir quién. Propuesta: `ocupado` = reserva con evento (confirmada o en ejecución) o bloqueo manual del personal; `en_opcion` = prerreserva o negociación con fechas; el resto, `libre`. Ventana máxima de 18 meses | alta |
| B7 | Booking | **Borrador desde el portal.** Acción `booking.portal_update_draft({reservation_id, expectedRevision, fields})`, solo con la reserva en `en_estudio` o `negociacion` y solo con campos de diseño: personas previstas, menores, régimen y estilo de menú pedidos, alojamiento, servicios (centro, exterior, piscina, montaje, apoyo técnico), notas del organizador. Además, la tabla `booking.reservation_date_options` (reserva, inicio, fin, hora aproximada de llegada y de salida, posición, estado `propuesta`, `pedida`, `confirmada` o `descartada`) con sus acciones `portal_set_date_options` y `portal_remove_date_option` | alta |
| B8 | Booking | **«Pedir esta fecha»:** acción `booking.portal_request_date({option_id})` → la opción pasa a `pedida` y el personal recibe el aviso (Inicio de Booking y petición a Tasks). Confirmar sigue siendo cosa del personal desde Booking | alta |
| B9 | Booking | **Calculadora:** lectura `booking.portal_quote({reservation_id, option_id?})` que aplica `suggestLines` y `proposalTotals` con las tarifas activas, en solo lectura. Devuelve líneas y totales con el IVA incluido y su desglose (base y cuota), las noches, las comidas incluidas, el mínimo comercial aplicado y si se ha aplicado. Mínimo en un ajuste de Booking (`rate_settings.minimum_total`, lo cambia el owner). Sin tarifas cargadas: `{available: false}` | alta |
| B10 | Booking | **Catálogo de extras para el portal:** marca `portal_visible` y nombre y descripción públicos en `booking.rates` (capa `servicio`), con las habitaciones de 2–4 plazas con baño como extra; y que `portal_update_draft` admita los extras elegidos (líneas pedidas, no la propuesta) | media |
| T3 | Tasks | Petición de sistema «Fecha pedida por un organizador» (la lanza Booking con B8), con regla de enrutado al área comercial | media |
| Fd1 | Food | Para el diseño basta con la orientación del menú de Booking (`menu_style`). Opcional: `food.portal_sample_menu({style})`, un menú de ejemplo público por orientación (platos con su nombre y descripción públicos, sin cantidades) para enseñarlo al interesado | baja |
| X2 | Central | Textos `organizers.availability_note` («El bloqueo lo hace efectivo el equipo de Ikisai al confirmarla.») y `organizers.quote_note` (IVA incluido, mínimo, precio orientativo), en los dos idiomas | media |
| K1 | Core | Comprobación de ámbito de portal reutilizable por cualquier app (`core.portal_in_scope(portal, actor, reservation_id, guest_id)`), para que Finance y Food filtren sus lecturas de portal sin depender de una función de Booking | alta |

## Fase 3 · Formalización

| Id | Para | Petición | Prioridad |
|---|---|---|---|
| B12 | Booking | **Propuesta en el portal:** lectura `booking.portal_proposals({reservation_id})` (propuestas `enviada` y `aceptada` con líneas, condiciones, tramos de cancelación y validez) y acción `booking.portal_accept_proposal({proposal_id, expectedRevision})` con el mismo efecto que `accept_proposal`, registrada como aceptación del organizador. Antes, decisión del usuario (pregunta en la salida) | alta |
| B13 | Booking | Al confirmar: pedir a Tasks el proyecto `AAAAMMDD-<título>` y, por cada extra contratado, su tarea (B13 depende de T1 y T2) | alta |
| F1 | Finance | **Dinero del retiro para el portal:** lectura `invoices.portal_reservation_money({reservation_id})` filtrada por ámbito (K1). Devuelve total contratado, señal requerida y pagada, saldo, vencimientos, cobros (fecha, importe, forma) y facturas emitidas (número, fecha, importe, estado), sin datos internos | alta |
| F2 | Finance | Descarga del PDF de una factura desde el portal (URL firmada de corta duración), solo dentro del ámbito | alta |
| F3 | Finance | Instrucciones de pago a Ikisai (IBAN, concepto y Bizum) como textos de Central o ajuste de Finance, en los dos idiomas | media |
| T1 | Tasks | **Proyecto por retiro por petición de sistema:** crear de forma idempotente (por `external_ref` = reserva) el proyecto `AAAAMMDD-<título>` en el área que fija la regla del owner, y renombrarlo si cambian la fecha o el título | alta |
| T2 | Tasks | Tareas de los extras contratados dentro de ese proyecto, idempotentes por línea (`external_ref` = línea de la propuesta) | media |
