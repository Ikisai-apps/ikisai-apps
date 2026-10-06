# Booking · estado

Actualizado: 6 de octubre de 2026. **Puerta G2 aprobada por Core de forma provisional; en construcción.**

## Hecho

- `docs/booking/API.md` (PR 3, fusionada): modelo de datos, `booking.confirm_reservation`, validación, visibilidad de huéspedes, rutas, proyección para Food, Calendar con cuenta de servicio, pantallas, offline, aceptación y reparto. Incluye las decisiones del usuario del 6 de octubre (§14).
- `docs/booking/PETICIONES.md`: peticiones a Core con su estado.
- **Fase B1 · reservas base** (PR 16, fusionada): migración `20261006_0005_booking_base.sql` (app `booking`, `reservations`, `reservation_finance` invisible para `reader`, `events`, códigos `RSV`/`EVT`, `booking.confirm_reservation`, hook `booking.check_invariants`), `_domain/booking`, `booking-api` y `tests/booking`.
- **Fase B2 · huéspedes y proyección** (rama `booking/guests`):
  - Migración `20261006_0006_booking_guests.sql`: `booking.guests` (datos del anexo I del RD 933/2021, firma, estados SES), `booking.dietary_restrictions`, `booking.checklist_items`, contador `booking.event_food_state` con sus triggers, vista `booking.food_event_projection` registrada con `core.allow_read` para `food` y para `booking`, lectura `booking.guest_summary` e invariantes ampliadas (`ORPHAN_CHILD`, `GUEST_MISMATCH`).
  - Dominio: ámbito `scopes.guests`, datos que faltan para SES según la especificación v3.1.2, regla de firma, plantilla del checklist y validación de las tres tablas.
  - `booking-api`: hook `visible` para huéspedes.
  - `tests/booking`: 34 de 34 en verde en local (13 de conformidad, 16 de API y SQL, 5 de dominio).

## Pendiente

- B3: Calendar. La cola se programa contra un adaptador falso; la clave JSON de la cuenta de servicio de Google se pide a Víctor al llegar a esa parte. Depende de P15.
- `packages/domain-booking` (reexporta `_domain/booking`) y `apps/booking` con `@ikisai/ui-kit` (Inicio · Reservas · Calendario · Huéspedes). Añadir esos dos workspaces cambia el `package-lock.json` de la raíz, que es de Core: irán en una PR con su visto bueno. Core publica `booking.ikisai.com` cuando exista el esqueleto con login.
- Sin verificar: a partir de qué edad firma el huésped (regla por defecto: 14 años).

## Avisos para otros equipos

- **Food:** `booking.events` existe desde la migración `20261006_0005` y `booking.food_event_projection` desde la `20261006_0006`, ya registrada para vosotros: `GET /api/v1/read/booking.food_event_projection?where[event_id]=…` desde `food-api`. Columnas en `API.md` §7.1 (las del contrato más `reservation_status`, `guest_count_is_final`, `requires_meals` y `meal_notes`).
- **Todos:** la CI no ejecuta todavía `tests/booking` (P14); se lanzan en local.

## Bloqueos

- Ninguno. B3 (Calendar) necesitará P15 y la clave de la cuenta de servicio.
