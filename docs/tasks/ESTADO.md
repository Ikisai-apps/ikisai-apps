# Tasks · estado

Actualizado: 6 de octubre de 2026. **Puerta G2 aprobada por Core de forma provisional; en construcción.**

## Hecho

- `docs/tasks/API.md`: modelo `tasks.*` (diez tablas), operaciones compuestas y único procedimiento, hooks `beforeCommit` y SQL, ámbitos y `visible`, rutas propias, archivos, offline, aceptación con los 72 escenarios clasificados, reparto y adaptador de `sync.js`/`cloud-auth.js` a `sync-client`. Su §16 recoge la resolución de Core.
- Decisiones D1 (catálogo del área en solo lectura para accesos por proyecto), D5 (adjuntos hasta 25 MB, tipos cerrados) y D6 (invitados como cuentas con ámbitos) aprobadas.
- Peticiones C1, C3, C4, C5 y C6 resueltas por Core; C2 y C7 en parte (`docs/tasks/PETICIONES.md`).

## En curso (una PR por punto)

1. `supabase/functions/_domain/tasks` + `packages/domain-tasks`: tipos de fila, ámbitos, validación, grafo y estados, operaciones compuestas, composición con el modelo anidado.
2. Migraciones `*_tasks_*`: tablas, `tasks.validate_batch`, `tasks.import_rows`, lectura `tasks.targets` para Invoices; lint y conformidad.
3. `supabase/functions/tasks-api`: hooks `visible` y `beforeCommit`, rutas de lectura y adjuntos.
4. `apps/tasks`: copia de la interfaz y adaptador sobre `sync-client`.

## Pendiente después

- CSV, copia portable y respaldo; cuentas e invitados con `members/invite`; migración de los 72 escenarios a Playwright; publicación en `tasks.ikisai.com`.

## Bloqueos

- Ninguno para empezar. Abiertos sin bloquear: resto de C2 (fila que sale del ámbito por un movimiento; `undo-plan` sin `visible`), resto de C7 (sesiones, restablecer contraseña) y C8–C11.
