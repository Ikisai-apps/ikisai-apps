# Organizers · peticiones a Core

Detalle en `API.md` §14. Core responde aquí y resume en `docs/core/RESPUESTAS.md`.

| Id | Para | Petición | Estado |
|---|---|---|---|
| B1 | Booking | Detalle de la reserva para la ficha (horas, plazas confirmadas, lo que incluye), sin importes ni notas internas | hecha (#277, `booking.portal_reservation_detail`) |
| B2 | Booking | `declared` en `booking.portal_guests` | hecha (#277) |
| B3 | Booking | `portal_add_guest` idempotente ante reintento con el mismo `guest_id` | hecha (#277) |
| B4 | Booking | (opcional, no V1) restricciones de cocina del grupo sin huésped | aplazada |
| B5 | Booking | Campos booleanos en `portal_guests` (`is_minor`): hoy `true` significa a la vez «rellenado por otro» y «vale `true`», y el `false` por defecto sale como rellenado. Propuesta: para booleanos, devolver el valor si es del organizador y `null` si nunca se escribió | abierta |
| C1 | Core | `sync-client`: `loginWithLink(token)` | en #278 |
| C2 | Core | `portal-links`: reutilizar la cuenta del huésped y `replace: true` al reenviar | en #278 |
| C3 | Core | `permanentAccount` en `GET auth/config` | en #278 |
| C4 | UI | entrada «Ayuda y sugerencias» del lanzador en portales y paso `signal` sin interruptor | hecha (kit 0.18.5, #279) |
| C5 | Core | alta de infraestructura con la primera PR de `apps/organizers` | abierta (PR de la PWA) |
| C6 | UI | `createAppShell({ nav: [] })` pinta la barra inferior vacía (`.nonav .nav`), que en móvil tapa los botones del pie. Organizers la oculta en su CSS | abierta |
| C7 | Central | `central.common_texts_projection` legible desde `organizers` con `organizers.declaration`, `portal.privacy`, `contact.email`, `contact.phone` | en curso (Central) |
| C8 | UI | Icono propio de Organizers para la PWA (hoy usa el de Central) | abierta |
