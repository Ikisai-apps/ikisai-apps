# @ikisai/sync-client

Cliente offline del núcleo de Ikisai (contrato §5 y §6 de `docs/core/CONTRATO_SINCRONIZACION.md`). Mantiene un espejo IndexedDB de las tablas de la app, encola comandos con `requestId` y `expectedRevision`, los envía en orden cuando hay red, rebasa conflictos de campos disjuntos y deja los solapados para decisión humana. Sin dependencias.

El contrato público está en `src/types.ts` (lo fija Core). Este paquete solo lo implementa.

## Uso

```ts
import { createSyncClient } from '@ikisai/sync-client';

const client = createSyncClient({ app: 'invoices', apiBase: '/api/v1' });

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

// Adjuntos (ya recomprimidos por la app)
const sha = await client.stageBlob(webpBlob, { filename: 'foto.webp', mime: 'image/webp' });
await client.commit([{ op: 'insert', table: 'invoices.documents', id: docId, fields: { sha256: sha } }], { blobs: [webpBlob] });

// Rutas propias de la app, con bearer, refresh y errores mapeados a ApiError
const data = await client.api<MiRespuesta>('/invoices/export?year=2026');

client.stop();
```

## Qué hace por dentro

- **Almacenamiento** `ikisai-<app>-v1`: un store por tabla (clave `id`), `meta`, `outbox`, `conflicts`, `blobs`. Los stores de tabla se crean al vuelo subiendo la versión de la base cuando aparece una tabla nueva (bootstrap, `options.tables` o un commit).
- **Sesión**: `Authorization: Bearer`; refresco con `/auth/refresh` cuando quedan menos de 60 s o tras un 401 (una sola vez). Si el refresh devuelve 4xx, la sesión local se borra.
- **Pull**: `/changes?after=cursor` paginado. Una fila con comando pendiente no se sobrescribe: su imagen remota se guarda como base remota del comando.
- **Push**: FIFO, uno en vuelo. Antes de cada lote se suben y verifican sus blobs. Red caída o 503 paran la cola. `VERSION_CONFLICT` con campos disjuntos se rebasa automáticamente (hasta 3 veces por lote, `autoMerged` lo cuenta); solapado, `delete`, `restore` o borrado remoto van a `conflicts`. `IDEMPOTENCY_REUSE` y 422 retiran el lote y lo anotan en `lastError`.
- **Estado**: `network` ∈ `online | offline | syncing | error`; `lastError` se limpia al empezar cada ciclo y refleja lo ocurrido en el último.

## Decisiones de implementación

- `onTable` entrega las filas vivas (igual que `list(table)` sin opciones); para la papelera, llama a `list(table, { includeDeleted: true })` al recibir el aviso.
- Si un comando confirma mientras otros posteriores tocan la misma fila, esos comandos heredan la revisión y la base confirmadas (editar una fila recién creada sin red no cuenta como conflicto).
- Al parquear un conflicto se retira el lote completo; las operaciones sobre otras filas del mismo lote se reenvían con la decisión (también con `theirs`).
- `restore` entra en `conflicts` aunque el tipo `PendingConflict.operation` solo nombre `update | delete`.
- Los blobs ya subidos se conservan en `blobs` con `status: 'uploaded'` (no hay política de limpieza todavía).

## Pruebas

```text
npx tsx --test tests/sync-client/*.test.ts
```

Usan `fake-indexeddb` y un servidor simulado en memoria (`tests/sync-client/fake-server.ts`) que reproduce `core.commit`: revisiones, cursor, recibos por `requestId`, subidas y verificación de adjuntos.
