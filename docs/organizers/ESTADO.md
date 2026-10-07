# Organizers · estado

## Hecho

- 2026-10-07 · `docs/organizers/API.md` (puerta G2), aprobado por Core.
- 2026-10-07 · Edge `organizers-api` (`portalIssuer: true`, sin tablas ni rutas propias) y `tests/organizers/api.test.ts` (ámbito, lecturas y acciones de Booking, enlaces de huésped).
- 2026-10-07 · PWA `apps/organizers`: entrada por `/i/<token>` (el token sale de la URL antes de pintar), Mis retiros (un solo retiro abre su ficha), ficha del retiro (Resumen, Asistentes, Cocina), alta con declaración, ficha del asistente según el modo (`ses` / `operativo`), «Rellenado ✓» sin valor para lo que escribió otra persona, alimentación, enlace personal con Web Share / WhatsApp / Copiar y reenvío que anula el anterior, recordatorios (persona y grupo sin nombres), baja, «Ayuda y sugerencias» por pasos, «Guarda tu acceso», caché de lecturas y borradores por persona, textos legales y de contacto desde Central con reserva.
- Pruebas: `tests/organizers/feedback-ids.test.ts` (ids literales y catálogo) y `tests/organizers/portal.spec.ts` (Playwright, 5 recorridos contra las Edge reales sobre PGlite: enlace no válido; recorrido completo; varios retiros y modo operativo; sin red; ayuda).

## Pendiente

- Alta de infraestructura (C5): publicación, Pages y `organizers.ikisai.com` con `organiza.ikisai.com`.
- Textos comunes de Central (C7): la app ya los lee; mientras, usa la reserva.
- Puntos abiertos que decide el usuario: API.md §13.
- Bandeja «Comentarios del retiro» (fase posterior del feedback).

## Bloqueos

- La PR de la PWA depende de la #278 de Core (`loginWithLink`): no compila sin ella.
