# Tasks · peticiones a Core

Peticiones del equipo Tasks sobre los directorios compartidos. El razonamiento de cada una está en `docs/tasks/API.md` §14 y su resolución en §16. Core responde en la última columna y resume en `docs/core/RESPUESTAS.md`.

| Fecha | # | Petición | Estado | Respuesta |
|---|---|---|---|---|
| 2026-10-06 | G2 | Revisión de `docs/tasks/API.md`, con las decisiones D1–D8 de su §15 | Aprobada (provisional) | G2 aprobada de forma provisional; D1, D5 y D6 aprobadas. Los comentarios irán en la PR |
| 2026-10-06 | C1 | Hooks SQL: acceso al lote (`before`/`after`) y a los ámbitos del actor desde las migraciones de Tasks | Hecho | El lint permite leer `core.memberships`, `core.changes`, `core.files` y `core.synced_tables` y llamar a `core.allow_read` (PR #10) |
| 2026-10-06 | C2 | `changes` retira del espejo las filas que salen del ámbito; `undo-plan`/`undo` aplican `visible` | Parcial | `sync-client` 0.2 rehace el snapshot al cambiar `membership.revision` (PR #12). **Sigue abierto:** fila que sale del ámbito por un movimiento, y `undo-plan` sin `visible` |
| 2026-10-06 | C3 | `sync-client`: limpiar el espejo al cerrar sesión y al cambiar de persona | Hecho | `clearOnLogout` y vaciado con `USER_CHANGED` (PR #12) |
| 2026-10-06 | C4 | Errores SQL definitivos como 422, no 503 | Hecho | `CONSTRAINT_VIOLATION`, `INVALID_VALUE`, `DOMAIN_ERROR`, `SQL_ERROR` con `details.sqlstate` (PR #10) |
| 2026-10-06 | C5 | Enlace comando ↔ archivo | Hecho | Marcador `{"$blob": "<sha256>"}` sustituido por el `file_id` (PR #12). Sin hook de visibilidad en `files/{id}`; Tasks no lo necesita |
| 2026-10-06 | C6 | `sync-client`: conservar los lotes rechazados | Hecho | `rejected()`, `retryRejected()`, `discardRejected()` (PR #12) |
| 2026-10-06 | C7 | Cuentas en `_kit` | Parcial | `POST members/invite` (PR #10). **Pendiente, no bloquea:** lista y cierre de sesiones, restablecer contraseña, desactivación, `validateScopes` |
| 2026-10-06 | C8 | `history` con filtros `table`, `id`, `match=<columna>:<valor>`, `actorId` | Pendiente | |
| 2026-10-06 | C9 | `client.fetch(path, init)` crudo con `Bearer` y refresco, para descargas binarias | Pendiente | |
| 2026-10-06 | C10 | Purga por app: orden de tablas o hook `beforePurge` | Pendiente | |
| 2026-10-06 | C11 | Deshacer lotes con `call` cuyas escrituras pasaron por `core.apply_row_op` | Pendiente | |
| 2026-10-06 | C12 | `npm test` (raíz) solo ejecuta `tests/core/*.test.ts`: añadir `tests/tasks/*.test.ts` (o un patrón `tests/*/*.test.ts` que excluya los e2e) para que la CI corra las pruebas de dominio, SQL y API de Tasks. Hoy se lanzan a mano con `npx tsx --test tests/tasks/*.test.ts` | Pendiente | |
| 2026-10-06 | C13 | `packages/domain-tasks` todavía no tiene `package.json`: declararlo como workspace cambia `package-lock.json` (raíz). Lo añadiré junto con `apps/tasks` en una PR que pedirá tu visto bueno solo por el lockfile | Aviso | |
