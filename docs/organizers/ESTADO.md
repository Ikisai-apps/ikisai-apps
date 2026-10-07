# Organizers · estado

## Hecho

- 2026-10-07 · `docs/organizers/API.md` (puerta G2), aprobado por Core: entrada por enlace, mis retiros, ficha, asistentes, cocina, ayuda y sugerencias, hueco de «Guarda tu acceso».
- 2026-10-07 · Edge `organizers-api` (`createOrganizersApp`, `portalIssuer: true`, sin tablas ni rutas propias) y `tests/organizers/api.test.ts`: canje del enlace emitido por Booking, ámbito por reserva en `bootstrap`, `members` solo propio, lecturas y acciones de Booking dentro y fuera de ámbito, enlaces de huésped (emitir, listar, revocar; no ampliar ni emitir de organizador).

## Pendiente

- PWA `apps/organizers`: cuando entren C1–C3 de Core (`loginWithLink`, reutilizar cuenta del huésped al reenviar, `permanentAccount` en `auth/config`). Con su PR, alta de infraestructura (C5).
- Puntos abiertos que decide el usuario: API.md §13.

## Bloqueos

- Ninguno. La ficha completa necesita B1 de Booking (API.md §14).
