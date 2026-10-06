# Booking · estado

Actualizado: 6 de octubre de 2026. **Puerta G2 aprobada por Core de forma provisional; en construcción.**

## Hecho

- `docs/booking/API.md` (PR 3, fusionada): modelo de datos, `booking.confirm_reservation`, validación, visibilidad de huéspedes, rutas, proyección para Food, Calendar con cuenta de servicio, pantallas, offline, aceptación y reparto. Incluye las decisiones del usuario del 6 de octubre (§14).
- `docs/booking/PETICIONES.md`: peticiones a Core con su estado.
- **Fase B1 · reservas base** (PR 16, fusionada): migración `20261006_0005_booking_base.sql` (app `booking`, `reservations`, `reservation_finance` invisible para `reader`, `events`, códigos `RSV`/`EVT`, `booking.confirm_reservation`, hook `booking.check_invariants`), `_domain/booking`, `booking-api` y `tests/booking`.
- **Fase B2 · huéspedes y proyección** (PR 20, fusionada): migración `20261006_0006_booking_guests.sql` (`guests`, `dietary_restrictions`, `checklist_items`, contador `event_food_state`, vista `booking.food_event_projection` con `core.allow_read` para `food` y `booking`, lectura `booking.guest_summary`, invariantes `ORPHAN_CHILD` y `GUEST_MISMATCH`), reglas de dominio de huéspedes y checklist, hook `visible`.
- **Esqueleto de `apps/booking`** (rama `booking/app`, PR pendiente del visto bueno de Core porque toca `package-lock.json`):
  - PWA con `@ikisai/ui-kit` y `sync-client` 0.2: login, shell con Inicio · Reservas · Calendario · Huéspedes, service worker y actualización coordinada.
  - **Inicio**: próximas reservas y avisos calculados con el espejo local.
  - **Reservas**: lista con filtros y búsqueda, alta y edición de los datos principales sin red (solo viaja el campo cambiado), «Confirmar reserva» (`call`), y pantalla «Por resolver» con conflictos y lotes rechazados.
  - Calendario y Huéspedes: marcadas como próximas.
  - `clearOnLogout` para huéspedes e importes, con aviso si hay cambios sin enviar.
  - `packages/domain-booking` reexporta `_domain/booking`.
  - `tests/booking/smoke.spec.ts` (Playwright, corre en la CI): login, reservas sin red, sincronización y PWA. 2 de 2 en verde.

## Pendiente

- Ficha completa de la reserva (bloques Resumen, Operación, Comidas, Cobro), papelera y archivado.
- Pantalla Huéspedes (alta con los datos del anexo I, firma en pantalla o en papel, cola de envío a SES) y restricciones y checklist en la ficha.
- B3: Calendar. La cola se programa contra un adaptador falso; la clave JSON de la cuenta de servicio de Google se pide a Víctor al llegar a esa parte. Depende de P15.
- Recorrido de aceptación A–E e I completo en PC y Android.
- Sin verificar: a partir de qué edad firma el huésped (regla por defecto: 14 años).

## Avisos para otros equipos

- **Food:** `booking.events` existe desde la migración `20261006_0005` y `booking.food_event_projection` desde la `20261006_0006`, ya registrada para vosotros: `GET /api/v1/read/booking.food_event_projection?where[event_id]=…` desde `food-api`. Columnas en `API.md` §7.1 (las del contrato más `reservation_status`, `guest_count_is_final`, `requires_meals` y `meal_notes`).
- **Todos:** la CI no ejecuta todavía las pruebas `*.test.ts` de `tests/booking` (P14); se lanzan en local. El humo de Playwright sí corre en la CI.
- **Core:** al fusionar el esqueleto, `booking` pasa a ser publicable para `release.yml` (existen `booking-api/index.ts` y `apps/booking/package.json`). Falta la primera puesta en marcha: dominio `booking.ikisai.com` y alta del propietario.
- **UI:** la marca de la cabecera del shell es el icono de documento; si el kit admite un icono por app, Booking usaría `calendar`.

## Bloqueos

- Ninguno. B3 (Calendar) necesitará P15 y la clave de la cuenta de servicio.
