# Booking · estado

Actualizado: 6 de octubre de 2026. **Las cuatro pantallas construidas, Calendar real probado contra Google por Core y escenarios sin red automatizados; falta el recorrido de aceptación del usuario en producción.**

## Hecho

- `docs/booking/API.md` (PR 3): modelo, validación, visibilidad, rutas, proyección, Calendar, pantallas, offline y aceptación; decisiones del usuario en §14.
- **B1 · reservas base** (PR 16): migración `20261006_0005_booking_base.sql`, `booking.confirm_reservation`, `_domain/booking`, `booking-api`.
- **B2 · huéspedes y proyección** (PR 20): migración `20261006_0006_booking_guests.sql`, `booking.food_event_projection` con `core.allow_read` para `food` y `booking`, `booking.guest_summary`.
- **Esqueleto de `apps/booking`** (PR 28): login, shell, Inicio y Reservas sin red, PWA.
- **Tanda 4** (PR 40): ficha de la reserva, papelera en cascada con restauración, Huéspedes (datos del anexo I, firma en pantalla o en papel, cola de SES), checklist, y cola de Calendar con adaptador falso (migración `20261006_0400_booking_calendar.sql`).
- **Tanda 5** (PR 52):
  - **Calendar real**: `booking-api/calendar/google.ts` con cuenta de servicio (JWT RS256 con WebCrypto, token en memoria, API v3). Se activa solo con los secretos `GOOGLE_SERVICE_ACCOUNT_JSON` y `BOOKING_CALENDAR_ID`.
  - **Bloqueo por acceso** (migración `20261006_0401_booking_calendar_blocked.sql`): con credenciales rechazadas o el calendario sin compartir, el trabajo sigue `pending` sin gastar intentos, con código legible, y el tick hace un solo intento por vuelta. `calendar/status` lo expone como `health`.
  - **Cómo avanza la cola**: `afterCommit` tras cada guardado, el planificador de Core cada 5 minutos en `POST /api/v1/worker/calendar/tick`, y `POST calendar/tick` a mano.
  - Si Google ya no acepta el id de un evento (borrado a mano), el worker sube la generación y lo crea de nuevo.
  - **Pantalla Calendario**: vista mensual con `createCalendar` del kit, sin franjas horarias, tramos de día completo que incluyen el día de salida y colores por estado; panel «Google Calendar» con el estado, pendientes, errores y «Reintentar».
  - **Ficha**: en móvil quedan visibles «Editar» y «Confirmar» y el resto pasa a un menú «Más»; icono de la app `bed`.
  - **Huéspedes**: justificante de envío a SES como archivo (PDF o imagen recomprimida) con marcador `$blob`; restricciones alimentarias desde la ficha del huésped.
  - Limpieza de `reservations.ts` (la hoja de alta ya no arrastra la edición).
  - Pruebas: `tests/booking/*.test.ts` 57 de 57; humo de Playwright ampliado a Calendario, justificante, restricción del huésped y menú «Más».

- **Tanda 6** (PR 77):
  - Pastilla de Calendar en la cabecera de la ficha (misma caché que la pantalla Calendario).
  - Confirmar sin red: marca «Confirmación pendiente de enviar», aviso con el motivo si el servidor la rechaza, y retirada de marcas huérfanas.
  - Huéspedes: hoja «Datos para SES» con un botón Copiar por dato (viajero y transacción); aviso en Inicio de huéspedes sin comunicar a SES cuando el evento empieza en menos de 24 horas.
  - Escenarios sin red en Playwright (`tests/booking/offline.spec.ts`): O1 crear sin red y recargar, O3 confirmar sin red (y rechazo), O4 conflicto disjunto, O5 conflicto solapado, O6 firma diferida, O7 borrado local al cerrar sesión, más el aviso de Inicio. O2 (editar sin red) ya estaba en el humo.
  - `docs/booking/ACEPTACION.md`: recorrido paso a paso para hacerlo con la cuenta del usuario en producción.
  - Prueba real de Calendar contra Google: hecha por Core, 12 de 12 (ronda 5).

- **Tanda 7** (PR 84): botón «Vaciar papelera» para el propietario en Reservas → Papelera, con recuento y confirmación; llama a `POST trash/purge` con las tablas de hijos a padres y explica los dos motivos por los que puede negarse (evento aún vivo en Google Calendar, menú de Food ligado al evento). Probado en el humo y, sobre PGlite, con una reserva completa (evento, huésped, restricción, checklist).
- **Invoices lee `booking.food_event_projection`** (PR 80): migración `20261006_0402_booking_invoices_read.sql`, fusionada junto con el ajuste de la prueba de Invoices.
- **Tanda 8** (PR 94):
  - **Checklist reordenable** con `createSortableList` del kit: al mover una tarea solo viaja ese ítem (`position` entre sus vecinos); se renumera la lista entera solo si no hay hueco.
  - **Bloque «Coste real»** en Cobro (solo quien ve importes): total asignado en Invoices a la reserva y a su evento, desglose por categoría y asignaciones con su código de factura, leído de `invoices.booking_cost_projection`. Última respuesta guardada en el dispositivo y borrada al cerrar sesión.
  - Retirado el parche `[hidden]` (lo trae el kit 0.8.0).
- **Tanda 9** (PR 102): las listas reordenables del checklist se conservan entre repintados y se actualizan con `setItems`; el foco del asa se recupera tras cada guardado. El humo prueba el reorden con teclado (foco conservado) y con arrastre de ratón.
- **Tanda 10** (PR 109):
  - «Coste real» con `renderMoneyBreakdown` del kit 0.9.0: total frente a lo presupuestado (marca «excede»), una línea por categoría con su número de facturas y enlace a las compras de la reserva en Invoices; cada asignación enlaza a su factura (`#/facturas/<código>`).
  - Agentes de IA: hook `agentRisk` (cancelar o dar por perdida una reserva, archivarla, tocar huéspedes o importes exigen aprobación humana) y `booking.calendar_retry` marcada segura (migración `20261006_0403_booking_agent_safe.sql`).
  - O1 baja a 15 s de margen con `sync-client` 0.2.3.
  - El arnés de Playwright pide un puerto libre al sistema: un puerto al azar caía a veces en los rangos que Windows reserva (`EACCES`) y era la intermitencia que se veía de vez en cuando.

- **Tanda 11** (PR 116): prueba de agentes de extremo a extremo (`tests/booking/agents.test.ts`): alta del agente por el owner, política con `booking.calendar_retry` segura, lo cotidiano sin aprobación, 428 con el motivo al confirmar, cancelar o tocar importes, y confirmación aplicada con propuesta aprobada.

- **Tanda 12** (rama `booking/tanda-12`, incidencia del usuario en Android, V1): al confirmar, el registro del procedimiento (`call`, sin id) que devuelve el servidor no se podía guardar en IndexedDB y el lote se atascaba con «2 pendientes». La causa está en `sync-client` y la corrige Core (0.2.5, PR #133). Por parte de Booking: los fallos del dispositivo se avisan con «No se pudo guardar en este dispositivo. Reintenta; si sigue, cierra y abre la app» y el texto técnico plegado; la API falsa de las pruebas devuelve ese registro como el servidor real (por eso el humo no lo había visto), y el humo confirma y recarga. Con el `sync-client` de `main` el humo falla igual que el móvil; con la PR #133 pasa.

- **Ampliación V2 · bloque 1: espacios y alojamiento** (rama `booking/espacios`; diseño en `API.md` §15, que vive en la PR 142): migración `20261006_0410_booking_spaces.sql` con `booking.spaces` (código `ESP_…`), `booking.beds` y `booking.room_assignments`; hook SQL `booking.check_space_invariants` (huérfanos, cama de otro espacio, huésped de otro evento y la regla dura `BED_OVERBOOKED`: una cama, una ocupación por noche entre reservas vivas; la salida de uno puede ser la entrada del siguiente); vista `booking.tasks_space_projection` para Tasks (sin ocupación ni huéspedes). Interfaz: pantalla «Espacios y camas» (inventario por zonas, reordenable, camas por habitación) y bloque «Alojamiento» en la ficha (asignar huésped o grupo, aviso de sobreocupación que no bloquea, aviso previo de cama ocupada también sin red). Pruebas: `tests/booking/spaces.test.ts` y pasos nuevos en smoke y offline.

- **Ampliación V2 · bloque 2: personal en eventos** (rama `booking/personal`, sobre la de espacios; diseño en `API.md` §15.3): migración `20261006_0430_booking_staff.sql` con `booking.staff_assignments` (solo el nombre de la persona; función de C05; día opcional; horas previstas y reales no negativas y como máximo 24 en un turno de un día; enlace tipado futuro a Central (`person_ref_app = 'central'`, migración 0431)) y `booking.staff_needs` (refuerzos que se cubren a mano); hook `booking.check_staff_invariants` (sin huérfanos); vista `booking.invoices_staff_hours_projection` para Invoices **sin nombres** (`staff_ref` estable). Interfaz: bloque «Personal» en la ficha (turnos por día reordenables, totales, refuerzos con cambio rápido a cubierto), fila «Personal» en Operación, aviso de turnos sin horas reales al anotar el cierre y aviso en Inicio de refuerzos sin cubrir en 7 días. Horas reales las apunta el responsable al cerrar (propuesta (a), a la espera del usuario). Pruebas: `tests/booking/staff.test.ts` y pasos en smoke y offline.

- **Ampliación V2 · bloque 3: tarifas y propuestas** (rama `booking/tarifas`, sobre la de personal; diseño en `API.md` §15.2 y decisiones en §15.6): migración `20261006_0420_booking_rates.sql` con `booking.rates` (código `TAR_…`, cuatro capas de C03 más `extra`; solo el owner escribe), `booking.conditions` (señal, plazos, IVA incluido 10 % por defecto, una por defecto) y `booking.cancellation_tiers` (inmutables si una propuesta enviada usa las condiciones: `CONDITIONS_IN_USE`), `booking.proposals` versionadas y `booking.proposal_lines` (descuento en % por línea). Una propuesta enviada es inmutable (`PROPOSAL_LOCKED`); `booking.new_proposal_version`, `booking.send_proposal` (fija totales y señal en SQL, igual que `proposalTotals` del dominio) y `booking.accept_proposal` (único punto que escribe `final_amount`, `deposit_required` y, si faltaba, `budget_amount`). Interfaz: `#/tarifas` (tarifas por capa, extras, condiciones y tramos), bloque «Propuesta» en la ficha, editor con «Sugerir desde el tarifario» y «Añadir extra» (las supletorias activadas se sugieren solas), y documento A4 para el organizador con «Imprimir / Guardar PDF». Las cinco tablas se borran del dispositivo al cerrar sesión. Pruebas: `tests/booking/rates.test.ts` y pasos en smoke y offline.
- **Espacios, ajustes de la ronda 18:** `spaces.bookable` («No reservable»), supletorias fuera de la capacidad base, alta de una habitación con N camas y M supletorias en un lote, «Duplicar» y «Crear distribución inicial» (6 habitaciones, 58 camas, con confirmación).

- **Portales, parte 1 (#191):** caducidad de los enlaces ligada a la reserva (`booking.portal_link_valid_until`, migración 0432), `portalIssuer` en `booking-api` y bloque «Portal del organizador» en la ficha. Parte 2 (datos de huéspedes) en propuesta: `API.md` §16 (PR #188).
- **Entidad en la propuesta:** `GET /api/v1/entity` lee `central.common_entity_projection` y firma el logotipo (bucket privado de Central, 10 min, sin guardarlo); el documento para el organizador lleva cabecera con logotipo, razón social, NIF/CIF y domicilio, o el aviso «Faltan los datos de la entidad en Central».

- **Portales, parte 2 · datos de huéspedes (§16, migración 0433):** procedencia por campo, consentimiento, aviso legal y firma solo del huésped, declaración del organizador, lecturas y acciones para Organizers y Guests (con `core.apply_portal_operations` y `core.portal_revoke_scope`), baja por el organizador en cualquier momento salvo entrada o SES, y `GET /api/v1/guest-signature/:guestId`. Interfaz del personal en Huéspedes: completitud según el modo de la reserva, origen de cada dato (huésped, organizador, personal), consentimiento y aviso legal, «Copiar recordatorio» al huésped y al organizador, «Ver firma» de Guests y papelera de huéspedes con «Dado de baja por el organizador».

- **SES.HOSPEDAJES, paso 1 (§17):** interruptores por reserva (migración 0440; bloque «Registro de viajeros» en la ficha, modos `ses`/`operativo`/`ninguno` en huéspedes y portales), ajuste global PRE/PROD y «Pausar envíos» (`#/ses`, solo owner), y cliente SES-1 (`_domain/booking/ses/`, validado contra los XSD oficiales; transporte con el intermedio de la FNMT; `POST /api/v1/worker/ses/ping` para comprobar TLS en la Edge). **SES-2 (migración 0441):** «Comunicar reserva a SES» con botón cuando hay pago registrado (`payment_registered_at` = momento legal), estados (preparada, en proceso, aceptada con código, rechazada con el texto de SES, anulada, error con reintento), pausa, anulación, aviso de cambio de fechas o personas, avisos de 12/18/24 h en la ficha y en Inicio, y aviso a Tasks (`booking.ses_deadline`, prioridad `critical`) a las 12 h; `POST /api/v1/worker/ses/tick` para el planificador. Pendiente: crear la cuenta de servicio con `ensureServiceActor` cuando esté en el kit; SES-3 (llegada y parte de viajeros).

## Pendiente

- **Recorrido de aceptación en producción** por el usuario, en PC y Android (`docs/booking/ACEPTACION.md`).
- La reactivación de un evento borrado a mano en Google solo está probada en simulación.
- En el calendario mensual en móvil los tramos no llevan título (mejora menor pedida a UI por Core).
- Sin verificar: a partir de qué edad firma el huésped (regla por defecto: 14 años).
- Las restricciones alimentarias no son reordenables: no tienen columna de orden y son pocas por evento.
- Peticiones a Core abiertas, sin bloquear: P3, P5, P6 y P9.

## Avisos para otros equipos

- **Food:** `GET /api/v1/read/booking.food_event_projection?where[event_id]=…`. Columnas en `API.md` §7.1.

## Bloqueos

- Ninguno.
