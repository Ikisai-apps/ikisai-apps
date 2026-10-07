# Central · peticiones a Core

Peticiones del equipo Central sobre lo compartido (`core`, `_kit`, `sync-client`, `test-kit`, raíz, CI) y, a través de Core, a otros equipos. El detalle de cada una está en `API.md` §14. Core responde aquí y resume en `docs/core/RESPUESTAS.md`.

| Nº | Fecha | Petición | Estado | Respuesta |
|---|---|---|---|---|
| P1 | 2026-10-07 | Visibilidad de archivos en `files/:id` (hook `fileVisible` o comprobación de la fila que referencia el archivo). Coincide con la P5 de Booking | Pendiente | Pendiente de Core. Mientras tanto vale la ruta propia `people/records/:id/file`. |
| P2 | 2026-10-07 | `admin`: restablecer la contraseña temporal de una cuenta existente y desactivar o reactivar una cuenta (Auth, pases y sesiones) | Hecho | PR #181: `POST admin/accounts/:userId/password` y `POST admin/accounts/:userId/disable` y `…/enable` (no a uno mismo; revoca pases). |
| P3 | 2026-10-07 | Lint: que las migraciones de `central` lean `core.profiles` y comprueben `auth.users.id` (validar `people.user_id`) | Hecho | PR #181: el lint permite leer `core.profiles` y `core.apps` desde migraciones de `central`; las FK a `auth.users` ya estaban permitidas. |
| P4 | 2026-10-07 | `admin/accounts`: estado de la cuenta (con P2) y `memberships[].updatedAt` | Hecho | PR #181: `admin/accounts` con `disabled`, `bannedUntil` y `memberships[].updatedAt`. |
| P5 | 2026-10-07 | A Tasks: ruta para que otra app pida una tarea con el token del usuario, idempotente por `requestId`; `tasks.targets` con lista de ids | Pasada a Tasks | |
| P6 | 2026-10-07 | A Booking: `person_ref_app = 'central'` (no `'encarna'`) y si quiere ya `central.booking_person_projection` | Pasada a Booking | `central.booking_person_projection` cuando la pida Booking. |
| P7 | 2026-10-07 | Repartir a los equipos el contrato de KPIs (`<schema>.central_kpi_projection`, `API.md` §7.2) cuando se apruebe | Aprobado | Core lo reparte a los equipos cuando Central empiece V2. |
| P8 | 2026-10-07 | Lanzador del kit y publicación de `apps/central` (Pages `ikisai-central`, dominio atado explícitamente, alias `encarna`) | Hecho en parte | Lanzador en el kit 0.14.0 (`createAppLauncher`). Pages se crea con la primera release de `apps/central`; Core ata `central.ikisai.com` y `encarna.ikisai.com` después. |
