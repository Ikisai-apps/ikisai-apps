# Central · peticiones a Core

Peticiones del equipo Central sobre lo compartido (`core`, `_kit`, `sync-client`, `test-kit`, raíz, CI) y, a través de Core, a otros equipos. El detalle de cada una está en `API.md` §14. Core responde aquí y resume en `docs/core/RESPUESTAS.md`.

| Nº | Fecha | Petición | Estado | Respuesta |
|---|---|---|---|---|
| P1 | 2026-10-07 | Visibilidad de archivos en `files/:id` (hook `fileVisible` o comprobación de la fila que referencia el archivo). Coincide con la P5 de Booking | Pendiente | |
| P2 | 2026-10-07 | `admin`: restablecer la contraseña temporal de una cuenta existente y desactivar o reactivar una cuenta (Auth, pases y sesiones) | Pendiente | |
| P3 | 2026-10-07 | Lint: que las migraciones de `central` lean `core.profiles` y comprueben `auth.users.id` (validar `people.user_id`) | Pendiente | |
| P4 | 2026-10-07 | `admin/accounts`: estado de la cuenta (con P2) y `memberships[].updatedAt` | Pendiente | |
| P5 | 2026-10-07 | A Tasks: ruta para que otra app pida una tarea con el token del usuario, idempotente por `requestId`; `tasks.targets` con lista de ids | Pendiente | |
| P6 | 2026-10-07 | A Booking: `person_ref_app = 'central'` (no `'encarna'`) y si quiere ya `central.booking_person_projection` | Pendiente | |
| P7 | 2026-10-07 | Repartir a los equipos el contrato de KPIs (`<schema>.central_kpi_projection`, `API.md` §7.2) cuando se apruebe | Pendiente | |
| P8 | 2026-10-07 | Lanzador del kit y publicación de `apps/central` (Pages `ikisai-central`, dominio atado explícitamente, alias `encarna`) | Pendiente | |
