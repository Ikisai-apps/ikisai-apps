# Cambios de @ikisai/sync-client

## 0.2.0 · 6 de octubre de 2026

Peticiones de los equipos de app. El contrato `src/types.ts` solo gana miembros; nada de lo existente cambia.

- **Marcadores de blob.** `{ "$blob": "<sha256>" }` en `operations[*].fields` y `operations[*].args` (a cualquier profundidad) se sustituye por el `fileId` del blob subido y verificado antes de enviar el lote. Los blobs referenciados así se suben aunque no vayan en `blobs`. Si el hash no existe en local, el lote se rechaza con `BLOB_MISSING`.
- **Cierre de sesión y cambio de persona.** Nueva opción `clearOnLogout?: boolean | TableName[]` (por defecto `false`). Si el `profile.userId` del bootstrap difiere del guardado, se vacía todo lo local y `status().lastError` avisa con `USER_CHANGED` durante un ciclo.
- **Cambio de ámbitos.** Si cambia `membership.revision` o una tabla del espejo deja de ser legible, se rehace el snapshot completo (sin tocar la outbox) y se eliminan las tablas no legibles.
- **Lotes rechazados visibles.** Todo 4xx definitivo (incluidos 403 y 404, que antes paraban la cola, e `IDEMPOTENCY_REUSE`/422, que solo dejaban `lastError`) mueve el lote al nuevo store `rejected` y la cola continúa. Nuevo en el tipo público: `RejectedBatch`, `rejected()`, `retryRejected(requestId, operations?)`, `discardRejected(requestId)` y `SyncStatus.rejected`. 401 sigue refrescando una vez y, si falla, conserva la cola; 5xx y red siguen siendo reintentables.
- Servidor falso de pruebas: `rejectValue` (422 `CONSTRAINT_VIOLATION`), `forbidden` (403), detección de marcadores sin resolver (422 `INVALID_VALUE`), `membershipRevision`, `tables` y `userId` mutables. 11 pruebas nuevas en `tests/sync-client/sync-client-0.2.test.ts`.

## 0.1.0 · 5 de octubre de 2026

Primera entrega: espejo IndexedDB, cola FIFO con `requestId` y `expectedRevision`, rebase de conflictos disjuntos, conflictos solapados para decisión humana, subida y verificación de adjuntos, sesión con refresco.
