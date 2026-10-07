# Organizers · peticiones a Core

Detalle en `API.md` §14. Core responde aquí y resume en `docs/core/RESPUESTAS.md`.

| Id | Para | Petición | Estado |
|---|---|---|---|
| B1 | Booking | Detalle de la reserva para la ficha (horas, plazas confirmadas, lo que incluye), sin importes ni notas internas | abierta |
| B2 | Booking | `declared` en `booking.portal_guests` | abierta |
| B3 | Booking | `portal_add_guest` idempotente ante reintento con el mismo `guest_id` | abierta |
| B4 | Booking | (opcional, no V1) restricciones de cocina del grupo sin huésped | abierta |
| C1 | Core | `sync-client`: `loginWithLink(token)` | abierta |
| C2 | Core | `portal-links`: reutilizar la cuenta del huésped y `replace: true` al reenviar | abierta |
| C3 | Core | indicador de la cuenta permanente (`auth/config`) | abierta |
| C4 | UI | entrada «Ayuda y sugerencias» del lanzador en portales y paso `signal` sin interruptor | abierta |
| C5 | Core | alta de infraestructura con la primera PR de `apps/organizers` | abierta |
