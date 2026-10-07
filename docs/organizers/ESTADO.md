# Organizers · estado

## Hecho

- 2026-10-07 · `docs/organizers/API.md` (puerta G2), aprobado por Core.
- 2026-10-07 · Edge `organizers-api` (`portalIssuer: true`, sin tablas ni rutas propias) y `tests/organizers/api.test.ts` (ámbito, lecturas y acciones de Booking, enlaces de huésped).
- 2026-10-07 · PWA `apps/organizers`: entrada por `/i/<token>` (el token sale de la URL antes de pintar), Mis retiros (un solo retiro abre su ficha), ficha del retiro (Resumen, Asistentes, Cocina), alta con declaración, ficha del asistente según el modo (`ses` / `operativo`), «Rellenado ✓» sin valor para lo que escribió otra persona, alimentación, enlace personal con Web Share / WhatsApp / Copiar y reenvío que anula el anterior, recordatorios (persona y grupo sin nombres), baja, «Ayuda y sugerencias» por pasos, «Guarda tu acceso», caché de lecturas y borradores por persona, textos legales y de contacto desde Central con reserva.
- 2026-10-07 · Diseño conjunto PORTALES_V2: mapa de fases en `API.md` §13 (fase 1 detallada; fases 2 a 6 a grandes rasgos; borrador del modelo propio y contrato con Guests) y peticiones de las fases 2 y 3 en `PETICIONES.md`.
- 2026-10-07 · Guardado automático en la ficha del asistente (sin botón «Guardar»): por campo, con estado visible, reintento ante `VERSION_CONFLICT` y envío al recuperar la conexión.
- Pruebas: `tests/organizers/feedback-ids.test.ts` (ids literales y catálogo) y `tests/organizers/portal.spec.ts` (Playwright, 5 recorridos contra las Edge reales sobre PGlite: enlace no válido; recorrido completo; varios retiros y modo operativo; sin red; ayuda).

## Hecho (cierre de la fase 1)

- 2026-10-08 · Publicado en https://organizers.ikisai.com (y `organiza.ikisai.com`).
- 2026-10-08 · Español e inglés con `createI18n` (kit 0.19): clave = texto en español, diccionario `app/i18n-en.ts`, selector ES | EN en la cabecera y en la entrada, repintado al cambiar, fechas y países con `Intl`; textos de Central en el idioma elegido. Prueba de cobertura `tests/organizers/i18n.test.ts`.
- 2026-10-08 · Estado de guardado del kit (`createSaveState`) en la ficha del asistente; «Instala la app» (`createInstallPrompt`): hoja al entrar por enlace y tarjeta en Mis retiros.

## Pendiente

- Fase 1: cerrada salvo el icono propio de la PWA (C8) y la cuenta permanente (Workspace).
- Fase 2 (diseño): cuando Booking construya B6–B10 y B12.

- Alta de infraestructura (C5): publicación, Pages y `organizers.ikisai.com` con `organiza.ikisai.com`.
- Textos comunes de Central (C7): la app ya los lee; mientras, usa la reserva.
- Puntos abiertos que decide el usuario: API.md §13.
- Bandeja «Comentarios del retiro» (fase posterior del feedback).

## Bloqueos

- La PR de la PWA depende de la #278 de Core (`loginWithLink`): no compila sin ella.
