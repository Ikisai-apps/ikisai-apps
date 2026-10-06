# Booking · estado

Actualizado: 6 de octubre de 2026. **Backend completo salvo el cliente real de Google; interfaz con las cuatro pantallas menos Calendario.**

## Hecho

- `docs/booking/API.md` (PR 3): modelo, validación, visibilidad, rutas, proyección, Calendar, pantallas, offline y aceptación; decisiones del usuario en §14.
- **B1 · reservas base** (PR 16): migración `20261006_0005_booking_base.sql`, `booking.confirm_reservation`, `_domain/booking`, `booking-api`.
- **B2 · huéspedes y proyección** (PR 20): migración `20261006_0006_booking_guests.sql`, `booking.food_event_projection` con `core.allow_read` para `food` y `booking`, `booking.guest_summary`.
- **Esqueleto de `apps/booking`** (PR 28): login, shell, Inicio y Reservas sin red, PWA.
- **Tanda 4** (rama `booking/tanda-4`):
  - **Ficha de la reserva** (`#/reservas/<id>`): Resumen, Operación (con cierre), Checklist (base desde la plantilla, marcar, añadir, quitar), Huéspedes (recuentos), Comidas con restricciones y Cobro (solo quien ve importes). Editar, confirmar, archivar y desarchivar.
  - **Papelera**: borrado en cascada de la reserva con su evento, importes, huéspedes, restricciones y checklist en un solo lote; restauración de todo lo que se borró junto. Con evento operativo, solo un propietario.
  - **Huéspedes** (`#/huespedes/<evento>`): alta y edición con los datos del anexo I, aviso de qué falta para SES según documento y edad, firma en pantalla (imagen como adjunto con marcador `$blob`) o en papel con parte imprimible, cola de envío a SES con registro del envío, y recuentos por `booking.guest_summary` para quien no ve huéspedes.
  - `clearOnLogout` para huéspedes e importes, con aviso antes de cerrar sesión si hay cola.
  - **B3 · cola de Calendar con adaptador falso**: migración `20261006_0400_booking_calendar.sql` (enlaces, cola, triggers que encolan en la transacción del guardado, acciones `calendar_claim`, `calendar_report`, `calendar_retry` y lectura `calendar_status`), dominio `calendarProjection` (título `[PRE]`, colores, día completo con el día de salida u horario real, descripción sin datos personales, id determinista, hash), worker y rutas `calendar/tick`, `calendar/status` y `calendar/:id/retry`.
  - Pruebas: `tests/booking/*.test.ts` 48 de 48 (conformidad, API y SQL, dominio, huéspedes, Calendar); humo de Playwright ampliado a ficha, confirmación, checklist, restricciones, cobro, firma con adjunto y papelera.

## Pendiente

- **Cliente real de Google Calendar** (`booking-api/calendar/google.ts` es un esqueleto): JWT de la cuenta de servicio, llamadas a la API v3, reactivar o subir `generation` si alguien borró el evento a mano. Necesita la clave del usuario (P7).
- Disparo del worker tras cada commit y empuje oportunista desde `calendar/status`; planificador de Core (P8, depende de P16).
- **Pantalla Calendario** (vista mensual propia y panel de sincronización con Google).
- Justificante de envío a SES como archivo (hoy solo referencia de texto); restricciones ligadas a un huésped desde su ficha.
- Simplificar `apps/booking/src/ui/reservations.ts`: la hoja de alta conserva una rama de edición que ya no se usa (la edición vive en la ficha).
- Recorrido de aceptación A–E e I completo en PC y Android contra el backend real, cuando Core publique.
- Sin verificar: a partir de qué edad firma el huésped (regla por defecto: 14 años).

## Avisos para otros equipos

- **Food:** `GET /api/v1/read/booking.food_event_projection?where[event_id]=…`. Columnas en `API.md` §7.1.
- **Core:** P16 (rutas `worker` con TypeScript) es lo que falta para que el planificador mueva la cola de Calendar.

## Bloqueos

- Calendar real: clave JSON de la cuenta de servicio de Google (usuario) y P16 (Core). Nada más está bloqueado.
