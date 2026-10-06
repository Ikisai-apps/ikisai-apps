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

- **Tanda 7** (rama `booking/tanda-7`): botón «Vaciar papelera» para el propietario en Reservas → Papelera, con recuento y confirmación; llama a `POST trash/purge` con las tablas de hijos a padres y explica los dos motivos por los que puede negarse (evento aún vivo en Google Calendar, menú de Food ligado al evento). Probado en el humo y, sobre PGlite, con una reserva completa (evento, huésped, restricción, checklist).
- **Invoices lee `booking.food_event_projection`** (PR 80): migración `20261006_0402_booking_invoices_read.sql`, fusionada junto con el ajuste de la prueba de Invoices.

## Pendiente

- **Recorrido de aceptación en producción** por el usuario, en PC y Android (`docs/booking/ACEPTACION.md`).
- La reactivación de un evento borrado a mano en Google solo está probada en simulación.
- En el calendario mensual en móvil los tramos no llevan título (mejora menor pedida a UI por Core).
- Sin verificar: a partir de qué edad firma el huésped (regla por defecto: 14 años).
- Peticiones a Core abiertas, sin bloquear: P3, P5, P6, P9, P18 (retraso de la cola tras recargar sin red) y P19 (UI).

## Avisos para otros equipos

- **Food:** `GET /api/v1/read/booking.food_event_projection?where[event_id]=…`. Columnas en `API.md` §7.1.

## Bloqueos

- Ninguno.
