# @ikisai/sync-client

Cliente offline del núcleo de Ikisai (contrato §5 y §6 de `docs/core/CONTRATO_SINCRONIZACION.md`). Mantiene un espejo IndexedDB de las tablas de la app, encola comandos con `requestId` y `expectedRevision`, los envía en orden cuando hay red, rebasa conflictos de campos disjuntos y deja los solapados para decisión humana. Sin dependencias.

El contrato público está en `src/types.ts` (lo fija Core). Este paquete solo lo implementa.

## Uso

```ts
import { createSyncClient } from '@ikisai/sync-client';

const client = createSyncClient({
  app: 'invoices',
  apiBase: '/api/v1',
  // Qué borrar al cerrar sesión: false (por defecto), true (todo) o una lista de tablas sensibles
  clearOnLogout: ['booking.guests'],
});

// Sesión (proxy de Supabase Auth)
await client.login('persona@ejemplo.com', '…');

// Arranque: carga el espejo local al instante, bootstrap y snapshot si hay red, y lanza el primer sync
const boot = await client.start();

// Lectura y suscripción al espejo
const suppliers = await client.list('invoices.suppliers');
const off = client.onTable('invoices.suppliers', (rows) => render(rows));

// Edición optimista: la fila aparece al momento marcada con `_pending: true`
const row = await client.get('invoices.suppliers', id);
await client.commit([
  { op: 'update', table: 'invoices.suppliers', id, expectedRevision: row!.revision, fields: { name: 'Nuevo nombre' } },
]);

// Estado para la barra de la UI (§6.4)
client.onStatus(({ network, pendingCommands, conflicts, autoMerged, lastError }) => { /* … */ });

// Conflictos solapados
for (const c of await client.conflicts()) {
  // c.base (lo que vi), c.current (lo del servidor), c.overlapping (campos en disputa)
  await client.resolveConflict(c.requestId, { choice: 'mine' }); // | 'theirs' | { choice: 'merge', fields }
}

// Adjuntos (ya recomprimidos por la app): el marcador { "$blob": sha } se sustituye por el fileId
// que devuelve el servidor al subir y verificar el blob, justo antes de enviar el lote.
const sha = await client.stageBlob(webpBlob, { filename: 'foto.webp', mime: 'image/webp' });
await client.commit([{ op: 'insert', table: 'food.recipes', id, fields: { photo_file_id: { $blob: sha } } }]);

// Lotes rechazados por el servidor con un error definitivo (422, 403, 404…): no bloquean la cola
for (const r of await client.rejected()) {
  // r.error (código y detalles del servidor), r.operations, r.baseRows, r.rejectedAt
  await client.retryRejected(r.requestId, operacionesCorregidas); // o client.discardRejected(r.requestId)
}

// Rutas propias de la app, con bearer, refresh y errores mapeados a ApiError
const data = await client.api<MiRespuesta>('/invoices/export?year=2026');

client.stop();
```

## Qué hace por dentro

- **Almacenamiento** `ikisai-<app>-v1`: un store por tabla (clave `id`), `meta`, `outbox`, `conflicts`, `blobs` y `rejected`. Los stores de tabla se crean al vuelo subiendo la versión de la base cuando aparece una tabla nueva (bootstrap, `options.tables` o un commit); los fijos que falten (p. ej. `rejected` en una base creada con 0.1) se añaden al abrir.
- **Sesión**: `Authorization: Bearer`; refresco con `/auth/refresh` cuando quedan menos de 60 s o tras un 401 (una sola vez). Si el refresh devuelve 4xx, la sesión local se borra.
- **Cierre de sesión**: `logout()` borra la sesión y, según `clearOnLogout`, nada más (por defecto), todo lo local (`true`: espejo, outbox, conflictos, rechazados y blobs) o solo las tablas indicadas junto con los comandos, conflictos y rechazados que las tocan (contienen sus datos). En ambos casos el cursor vuelve a cero para que el siguiente arranque haga un snapshot nuevo.
- **Cambio de persona**: si el `profile.userId` del bootstrap no coincide con el guardado en `meta`, se vacía todo lo local antes de continuar (otra persona ha entrado en este dispositivo) y `status().lastError` lleva el código `USER_CHANGED` durante el ciclo que lanza `start()`; se limpia en el siguiente.
- **Cambio de ámbitos**: si en el bootstrap cambia `membership.revision`, o `tables` deja de incluir una tabla que el espejo tiene, se rehace el snapshot completo de las tablas legibles (las filas sin comando pendiente se sustituyen; la outbox no se toca) y las tablas que ya no son legibles se eliminan del espejo. Es la forma V1 de que una fila que sale del ámbito del usuario desaparezca de su dispositivo.
- **Pull**: `/changes?after=cursor` paginado. Una fila con comando pendiente no se sobrescribe: su imagen remota se guarda como base remota del comando.
- **Adjuntos**: antes de enviar un lote se suben y verifican los blobs declarados en `blobs` y los referenciados con marcadores `{ "$blob": "<sha256>" }` en `operations[*].fields` y `operations[*].args` (a cualquier profundidad en objetos y arrays, hasta 16 niveles). Cada marcador se sustituye por el `fileId` que devolvió `POST /uploads` + `verify`; el espejo local conserva el marcador hasta que el servidor confirma con `changes`. Si el blob aún no está subido, el lote espera; si no existe ningún blob con ese hash, el lote pasa a `rejected` con código `BLOB_MISSING`. Un objeto con más claves que `$blob` no es un marcador.
- **Push**: FIFO, uno en vuelo. Red caída, 5xx (incluido 503) y 401 sin refresco posible paran la cola conservándola. `VERSION_CONFLICT` con campos disjuntos se rebasa automáticamente (hasta 3 veces por lote, `autoMerged` lo cuenta); solapado, `delete`, `restore` o borrado remoto van a `conflicts`. Cualquier otro 4xx definitivo (`INVALID_FIELDS`, `INVALID_OPERATION`, `CONSTRAINT_VIOLATION`, `INVALID_VALUE`, `DOMAIN_ERROR`, `SQL_ERROR`, `FORBIDDEN`, `NOT_FOUND`, `ROW_EXISTS`, `IDEMPOTENCY_REUSE`, `CURSOR_CONFLICT` tras un pull, `BLOB_MISSING`) mueve el lote a `rejected` con el error completo, las operaciones, `baseRows` y la fecha; el espejo vuelve a la base, `lastError` lo anota y la cola **continúa con el siguiente lote**.
- **Rechazados**: `rejected()` los lista en orden de rechazo; `retryRejected(requestId, operations?)` reencola el lote con un `requestId` nuevo (y las operaciones corregidas, si se pasan; conserva los `blobs`); `discardRejected(requestId)` lo olvida. `SyncStatus.rejected` los cuenta.
- **Estado**: `network` ∈ `online | offline | syncing | error`; `lastError` se limpia al empezar cada ciclo y refleja lo ocurrido en el último.

## Decisiones de implementación

- `onTable` entrega las filas vivas (igual que `list(table)` sin opciones); para la papelera, llama a `list(table, { includeDeleted: true })` al recibir el aviso.
- Si un comando confirma mientras otros posteriores tocan la misma fila, esos comandos heredan la revisión y la base confirmadas (editar una fila recién creada sin red no cuenta como conflicto).
- Al parquear un conflicto se retira el lote completo; las operaciones sobre otras filas del mismo lote se reenvían con la decisión (también con `theirs`).
- `restore` entra en `conflicts` aunque el tipo `PendingConflict.operation` solo nombre `update | delete`.
- Los blobs ya subidos se conservan en `blobs` con `status: 'uploaded'` y su `fileId` (no hay política de limpieza todavía); un marcador que apunte a uno de ellos se resuelve sin volver a subirlo.
- Los marcadores se sustituyen en una copia del lote al enviarlo; la outbox guarda las operaciones originales, así un reintento o un rechazo las conserva tal y como las escribió la app.
- Un lote rechazado se retira entero: las operaciones sobre otras filas del mismo lote también vuelven a la base (y viajan en `operations` del rechazado para poder reintentarlas juntas).
- Con `clearOnLogout` en lista, los comandos pendientes sobre esas tablas se eliminan sin enviar: es la opción para datos sensibles, y la app debe avisar antes de cerrar sesión si hay cambios pendientes.
- Si `options.tables` incluye una tabla que el bootstrap no marca como legible, el espejo no la mantiene.

## Pruebas

```text
npx tsx --test tests/sync-client/*.test.ts
```

Usan `fake-indexeddb` y un servidor simulado en memoria (`tests/sync-client/fake-server.ts`) que reproduce `core.commit`: revisiones, cursor, recibos por `requestId`, subidas y verificación de adjuntos, rechazo de marcadores sin resolver, y modos de fallo (`rejectValue` → 422 `CONSTRAINT_VIOLATION`, `forbidden` → 403, `membershipRevision`, `tables` y `userId` mutables).
