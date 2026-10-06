# Tasks · estado

Actualizado: 6 de octubre de 2026. **Puerta G2: `docs/tasks/API.md` escrito, pendiente de revisión de Core.**

## Hecho

- Estudio de `Ikisai-apps/ikisai-tasks` `main` `d02bf44` (migraciones, `domain.mjs`, `service.mjs`, `sync.js`, `cloud-auth.js`, usos en los módulos de UI, 72 escenarios de `tests/integration.cjs`) y del núcleo real (`core_base`, `core_files`, `_kit`, `sync-client`, lint de migraciones).
- `docs/tasks/API.md`: modelo `tasks.*` (diez tablas), operaciones compuestas y único procedimiento, hooks `beforeCommit` y SQL, ámbitos y `visible`, rutas propias, archivos, offline, aceptación con los 72 escenarios clasificados, reparto backend/frontend y adaptador de `sync.js`/`cloud-auth.js` a `sync-client`.
- Revisión pedida a Core en `docs/core/PETICIONES.md` (peticiones C1–C11).

## Pendiente

- Aprobación de Core (G2). Hasta entonces no se crean migraciones, rutas ni código fuera de `docs/tasks/`.
- Confirmación del usuario de las decisiones D1 (catálogo visible para accesos por proyecto), D5 (adjuntos de 25 MB y tipos) y D6 (invitados por cuenta, sin claves).
- Primer paso tras la aprobación: `packages/domain-tasks` (tipos, `scopes`, `validate`, `legacy`).

## Bloqueos

- C1 (payload y helper para hooks SQL): migraciones con `TASK_BLOCKED` y ámbitos de escritura.
- C2, C3 y C7: accesos por proyecto y cuentas (escenarios 27, 28, 30, 34, 36, 37).
- C5: adjuntos (escenario 15).
- C6: lote rechazado conservado (escenario 50).
- C4 afecta a la fiabilidad de la cola en las cuatro apps.

Nada de lo anterior impide empezar por `domain-tasks`, las tablas, `tasks-api` de lectura y el adaptador para un propietario con acceso completo.
