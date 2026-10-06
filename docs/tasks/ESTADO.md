# Tasks · estado

Actualizado: 6 de octubre de 2026. **Puerta G2 aprobada por Core de forma provisional; en construcción.**

## Hecho

- `docs/tasks/API.md`: modelo `tasks.*` (diez tablas), operaciones compuestas y único procedimiento, hooks `beforeCommit` y SQL, ámbitos y `visible`, rutas propias, archivos, offline, aceptación con los 72 escenarios clasificados, reparto y adaptador de `sync.js`/`cloud-auth.js` a `sync-client`. Su §16 recoge la resolución de Core.
- Decisiones D1 (catálogo del área en solo lectura para accesos por proyecto), D5 (adjuntos hasta 25 MB, tipos cerrados) y D6 (invitados como cuentas con ámbitos) aprobadas.
- Peticiones C1, C3, C4, C5 y C6 resueltas por Core; C2 y C7 en parte (`docs/tasks/PETICIONES.md`).
- `supabase/functions/_domain/tasks` (reexportado por `packages/domain-tasks`): tipos de fila y metadatos de tablas, ámbitos y `visible`, validación de lotes (`beforeCommit`), estados y ciclos, operaciones compuestas. 15 pruebas en `tests/tasks/domain.test.ts` (`npx tsx --test tests/tasks/*.test.ts`; la CI aún no las ejecuta, C12).
- Migraciones `20261006_0300_tasks_schema.sql` y `20261006_0301_tasks_rules.sql`: diez tablas registradas, triggers de inmutables y `done_at`, hook `tasks.validate_batch` (ámbitos de escritura, Entrada, jerarquía, claves, catálogo, vistas, dependencias y ciclos, `TASK_BLOCKED`, adjuntos), procedimiento `tasks.import_rows` y lectura registrada **`tasks.targets`** para Invoices (`GET /api/v1/read/tasks.targets` en cuanto exista `tasks-api`). 14 pruebas en `tests/tasks/sql.test.ts` sobre PGlite.
- `supabase/functions/tasks-api`: app sobre `_kit` con hooks `visible` y `beforeCommit`, subidas a `ikisai-files`, y rutas `GET blockers` (bloqueos privados) y `GET attachments/:id` (descarga con comprobación de ámbito). La lectura `tasks.targets` responde en `GET/POST /api/v1/read/tasks.targets`. Conformidad del núcleo 13/13 (`tests/tasks/conformance.test.ts`) y 6 pruebas HTTP (`tests/tasks/api.test.ts`). Total de Tasks en local: 48 pruebas.
- `supabase/functions/_domain/tasks/legacy.ts`: puente con el modelo anidado de la interfaz heredada. `compose` (filas → `state.tabs`, con `done` calculado, bloqueos y `restricted`), `decompose` (modelo editado → lotes de operaciones de fila, con las cascadas que hacía el servidor antiguo) y `adoptLegacyIds` (familias con id fijo → uuid). 7 pruebas contra PGlite en `tests/tasks/legacy.test.ts`.
- Migración `20261006_0302_tasks_rules_live_keys.sql`: el hook exige la coherencia de claves y el «mismo proyecto que el padre» solo a filas vivas (defecto encontrado al probar el movimiento con puentes en papelera). Total de Tasks en local: 56 pruebas.

## En curso (una PR por punto)

4. `apps/tasks`: copia de la interfaz y adaptador sobre `sync-client` (incluye la composición fila ↔ modelo anidado, `legacy.ts`).

## Pendiente después

- Rutas `tree`, `tabs/:tabId/tasks`, `trash/empty`, CSV, copia portable y respaldo; cuentas e invitados con `members/invite`; migración de los 72 escenarios a Playwright; publicación en `tasks.ikisai.com`.

## Bloqueos

- Ninguno para empezar. Abiertos sin bloquear: resto de C2 (fila que sale del ámbito por un movimiento; `undo-plan` sin `visible`), resto de C7 (sesiones, restablecer contraseña) y C8–C11.
