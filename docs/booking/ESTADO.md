# Booking · estado

Actualizado: 6 de octubre de 2026. **Puerta G2 aprobada por Core de forma provisional; en construcción.**

## Hecho

- `docs/booking/API.md` (PR 3, fusionada): modelo de datos, `booking.confirm_reservation`, validación, visibilidad de huéspedes, rutas, proyección para Food, Calendar con cuenta de servicio, pantallas, offline, aceptación y reparto. Incluye las decisiones del usuario del 6 de octubre (§14).
- `docs/booking/PETICIONES.md`: peticiones a Core con su estado.
- **Fase B1 · reservas base** (rama `booking/base`):
  - Migración `20261006_0005_booking_base.sql`: app `booking`, `booking.reservations`, `booking.reservation_finance` (invisible para `reader`), `booking.events`, códigos `RSV`/`EVT` por trigger, `booking.confirm_reservation` y el hook `booking.check_invariants`.
  - `supabase/functions/_domain/booking/`: catálogos, reglas derivadas (noches, estado de la señal, fase del evento) y validación compartida.
  - `supabase/functions/booking-api/`: app sobre `_kit` con `beforeCommit`.
  - `tests/booking/`: conformidad del núcleo (13 escenarios), API y SQL sobre PGlite (8) y dominio (5). 26 de 26 en verde en local.

## Pendiente

- B2: huéspedes, restricciones, checklist y proyección para Food con su `core.allow_read`.
- B3: Calendar. La cola se programa contra un adaptador falso; la clave JSON de la cuenta de servicio de Google se pide a Víctor al llegar a esa parte. Depende de P15.
- `packages/domain-booking` (reexporta `_domain/booking`) y `apps/booking` con `@ikisai/ui-kit` (Inicio · Reservas · Calendario · Huéspedes). Añadir esos dos workspaces cambia el `package-lock.json` de la raíz, que es de Core: irán en una PR con su visto bueno. Core publica `booking.ikisai.com` cuando exista el esqueleto con login.
- Sin verificar: a partir de qué edad firma el huésped (regla por defecto: 14 años).

## Avisos para otros equipos

- **Food:** `booking.events` ya existe en la migración `20261006_0005`. Vuestra migración de menús debe ordenarse después.
- **Todos:** la CI no ejecuta todavía `tests/booking` (P14); se lanzan en local.

## Bloqueos

- Ninguno para B1 y B2.
