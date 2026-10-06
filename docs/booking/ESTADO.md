# Booking · estado

Actualizado: 6 de octubre de 2026. **Puerta G2 aprobada por Core de forma provisional; en construcción.**

## Hecho

- `docs/booking/API.md` (PR 3): modelo de datos, `booking.confirm_reservation`, validación, visibilidad de huéspedes, rutas, proyección para Food, Calendar con cuenta de servicio, pantallas, offline, aceptación y reparto. Incluye las decisiones del usuario del 6 de octubre (§14).
- `docs/booking/PETICIONES.md`: peticiones a Core con su estado. P1, P2, P4, P10 y P13 resueltas en la ronda G2.

## En curso

- Fase B1 (`API.md` §12): `_domain/booking`, migración `booking_base`, `booking.confirm_reservation`, `booking-api` y conformidad.

## Pendiente

- B2: huéspedes, restricciones, checklist y proyección para Food con su `core.allow_read`.
- B3: Calendar. La cola se programa contra un adaptador falso; la clave JSON de la cuenta de servicio de Google se pide a Víctor al llegar a esa parte.
- `apps/booking` con `@ikisai/ui-kit` (Inicio · Reservas · Calendario · Huéspedes). Core publica `booking.ikisai.com` cuando exista el esqueleto con login.
- Sin verificar: a partir de qué edad firma el huésped (regla por defecto: 14 años).

## Bloqueos

- Ninguno.
