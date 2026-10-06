/**
 * Pruebas de las peticiones de los equipos de app atendidas en 0.2.0:
 * marcadores de blob, cierre de sesión y cambio de persona, cambio de ámbitos y lotes rechazados visibles.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import {
  createSyncClient,
  type SyncClient,
  type SyncClientOptions,
  type SyncStatus,
  type SyncedRow,
  type TableName,
} from '../../packages/sync-client/src/index.ts';
import { FakeServer, type FakeServerOptions } from './fake-server.ts';

const TABLE: TableName = 'invoices.suppliers';
const GUESTS: TableName = 'booking.guests';

interface Harness {
  server: FakeServer;
  idb: IDBFactory;
  client: SyncClient;
  /** Crea otro cliente sobre la misma IndexedDB (simula recargar la página). */
  reopen(): SyncClient;
}

function harness(options: FakeServerOptions = {}, clientExtra: Partial<SyncClientOptions> = {}): Harness {
  const server = new FakeServer({ tables: [TABLE], ...options });
  const idb = new IDBFactory();
  const make = () =>
    createSyncClient({ app: server.app, apiBase: server.apiBase, fetch: server.fetch, indexedDB: idb, pullIntervalMs: 0, ...clientExtra });
  return { server, idb, client: make(), reopen: make };
}

/** Cliente con sesión iniciada, bootstrap hecho y snapshot inicial sincronizado. */
async function ready(options: FakeServerOptions = {}, clientExtra: Partial<SyncClientOptions> = {}): Promise<Harness> {
  const h = harness(options, clientExtra);
  await h.client.login('user@example.com', 'secret');
  await h.client.start();
  await h.client.sync();
  return h;
}

function pendingRows(rows: SyncedRow[]): SyncedRow[] {
  return rows.filter((r) => (r as SyncedRow & { _pending?: boolean })._pending === true);
}

// ---------------------------------------------------------------------------
// 1. Marcadores de blob
// ---------------------------------------------------------------------------

test('marcador {"$blob"}: se sustituye por el fileId tras subir y verificar, a cualquier profundidad', async () => {
  const { server, client } = await ready();
  const photo = new Blob(['foto webp'], { type: 'image/webp' });
  const pdf = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
  const shaPhoto = await client.stageBlob(photo, { filename: 'foto.webp', mime: 'image/webp' });
  const shaPdf = await client.stageBlob(pdf, { filename: 'factura.pdf', mime: 'application/pdf' });
  assert.equal(client.status().pendingBlobs, 2);

  const id = crypto.randomUUID();
  server.down = true;
  await client.commit([
    {
      op: 'insert',
      table: TABLE,
      id,
      fields: {
        name: 'Con marcadores',
        photo_file_id: { $blob: shaPhoto },
        documents: [{ kind: 'invoice', file: { $blob: shaPdf } }, { kind: 'again', file: { $blob: shaPhoto } }],
        plain: { $blob: 'x', other: 1 }, // no es un marcador: tiene más claves
      },
    },
  ]);
  const provisional = (await client.get(TABLE, id))!;
  assert.deepEqual(provisional.photo_file_id, { $blob: shaPhoto }, 'en local el marcador se conserva hasta que el servidor confirma');
  await client.sync();
  assert.equal(client.status().pendingCommands, 1, 'sin red, el lote espera');
  server.down = false;
  server.calls.length = 0;
  await client.sync();

  const order = server.calls.map((c) => `${c.method} ${c.path}`).filter((p) => !p.includes('/changes'));
  assert.deepEqual(order, [
    'POST /uploads',
    'PUT storage:/upl-1',
    'POST /uploads/upl-1/verify',
    'POST /uploads',
    'PUT storage:/upl-2',
    'POST /uploads/upl-2/verify',
    'POST /commands',
  ]);
  const row = server.row(TABLE, id)!;
  assert.equal(row.photo_file_id, 'upl-1');
  assert.deepEqual(row.documents, [
    { kind: 'invoice', file: 'upl-2' },
    { kind: 'again', file: 'upl-1' },
  ]);
  assert.deepEqual(row.plain, { $blob: 'x', other: 1 });
  const mirror = (await client.get(TABLE, id))!;
  assert.equal(mirror.photo_file_id, 'upl-1', 'el espejo refleja la sustitución al confirmar');
  assert.equal(client.status().pendingBlobs, 0);
  assert.equal(client.status().pendingCommands, 0);
  assert.equal(client.status().rejected, 0);

  // Reutilizar un blob ya subido no vuelve a subirlo.
  server.calls.length = 0;
  await client.commit([{ op: 'update', table: TABLE, id, expectedRevision: 1, fields: { photo_file_id: { $blob: shaPdf } } }]);
  await client.sync();
  assert.equal(server.calls.filter((c) => c.path === '/uploads').length, 0);
  assert.equal(server.row(TABLE, id)?.photo_file_id, 'upl-2');
});

test('marcador de un blob inexistente: el lote va a rejected con BLOB_MISSING y la cola sigue', async () => {
  const { server, client } = await ready();
  const bad = crypto.randomUUID();
  const good = crypto.randomUUID();
  server.down = true;
  const { requestId } = await client.commit([{ op: 'insert', table: TABLE, id: bad, fields: { name: 'Sin blob', photo_file_id: { $blob: 'f'.repeat(64) } } }]);
  await client.commit([{ op: 'insert', table: TABLE, id: good, fields: { name: 'Normal', notes: null } }]);
  await client.sync();
  server.down = false;
  await client.sync();

  assert.equal(client.status().pendingCommands, 0);
  assert.equal(client.status().rejected, 1);
  assert.equal(client.status().lastError?.code, 'BLOB_MISSING');
  assert.equal(client.status().network, 'online');
  const [rejected] = await client.rejected();
  assert.equal(rejected?.requestId, requestId);
  assert.equal(rejected?.error.code, 'BLOB_MISSING');
  assert.equal(rejected?.operations[0]?.op, 'insert');
  assert.equal(await client.get(TABLE, bad), null, 'la fila provisional se retira');
  assert.equal(server.row(TABLE, good)?.name, 'Normal', 'el siguiente lote se envió');
  assert.equal(server.commandCount, 1);
});

// ---------------------------------------------------------------------------
// 2. Cierre de sesión y cambio de persona
// ---------------------------------------------------------------------------

test('clearOnLogout: true borra espejo, outbox, conflictos y blobs; el siguiente arranque rehace el snapshot', async () => {
  const h = await ready({}, { clearOnLogout: true });
  const { server, client } = h;
  server.seed(TABLE, { name: 'Persistente', notes: null });
  await client.sync();
  await client.stageBlob(new Blob(['x']), { filename: 'x.bin', mime: 'application/octet-stream' });
  server.down = true;
  await client.commit([{ op: 'insert', table: TABLE, id: crypto.randomUUID(), fields: { name: 'Pendiente', notes: null } }]);
  await client.sync();
  server.down = false;
  assert.equal((await client.list(TABLE)).length, 2);

  await client.logout();
  assert.equal(client.session(), null);
  assert.equal(server.logoutCount, 1);
  assert.deepEqual(await client.list(TABLE), []);
  const status = client.status();
  assert.equal(status.pendingCommands, 0);
  assert.equal(status.pendingBlobs, 0);
  assert.equal(status.conflicts, 0);
  assert.equal(status.cursor, 0);
  assert.equal(status.lastPullAt, null);
  client.stop();

  const again = h.reopen();
  await again.login('user@example.com', 'secret');
  await again.start();
  await again.sync();
  assert.equal((await again.list(TABLE)).length, 1, 'snapshot nuevo: solo lo que hay en el servidor');
  assert.equal(again.status().cursor, server.cursor);
  again.stop();
});

test('clearOnLogout con lista: solo se vacían esas tablas y lo que las referencia', async () => {
  const h = await ready({ tables: [TABLE, GUESTS] }, { clearOnLogout: [GUESTS] });
  const { server, client } = h;
  server.seed(TABLE, { name: 'Proveedor', notes: null });
  server.seed(GUESTS, { name: 'Huésped', notes: null });
  await client.sync();
  server.down = true;
  await client.commit([{ op: 'insert', table: GUESTS, id: crypto.randomUUID(), fields: { name: 'Huésped pendiente', notes: null } }]);
  await client.commit([{ op: 'insert', table: TABLE, id: crypto.randomUUID(), fields: { name: 'Proveedor pendiente', notes: null } }]);
  await client.sync();
  server.down = false;
  assert.equal(client.status().pendingCommands, 2);

  await client.logout();
  assert.deepEqual(await client.list(GUESTS), [], 'los huéspedes desaparecen del dispositivo');
  assert.equal((await client.list(TABLE)).length, 2, 'los proveedores siguen (incluido el pendiente)');
  assert.equal(client.status().pendingCommands, 1, 'el comando sobre huéspedes se elimina; el otro sigue');
  assert.equal(client.status().cursor, 0, 'el próximo arranque hace snapshot');

  await client.login('user@example.com', 'secret');
  await client.start();
  await client.sync();
  assert.equal((await client.list(GUESTS)).length, 1, 'tras volver a entrar, el snapshot los trae de nuevo');
  assert.equal(client.status().pendingCommands, 0);
  assert.equal(server.rowsOf(TABLE).length, 2);
});

test('otra persona entra en el dispositivo: se vacía todo, se avisa con USER_CHANGED y el aviso dura un ciclo', async () => {
  const { server, client } = await ready();
  const shared = server.seed(TABLE, { name: 'Compartido', notes: null });
  await client.sync();
  await client.stageBlob(new Blob(['y']), { filename: 'y.bin', mime: 'application/octet-stream' });
  server.commandsDown = true;
  const mine = crypto.randomUUID();
  await client.commit([{ op: 'insert', table: TABLE, id: mine, fields: { name: 'Mi borrador', notes: null } }]);
  await client.sync();
  server.commandsDown = false;
  assert.equal(client.status().pendingCommands, 1);

  const seen: SyncStatus[] = [];
  const off = client.onStatus((s) => seen.push(s));
  server.userId = '00000000-0000-4000-8000-000000000002';
  await client.start();
  assert.equal(client.status().lastError?.code, 'USER_CHANGED');
  assert.equal(client.status().pendingCommands, 0, 'la cola de la otra persona no se envía');
  assert.equal(client.status().pendingBlobs, 0);
  assert.equal(await client.get(TABLE, mine), null, 'su borrador no está');
  assert.equal(server.row(TABLE, mine), undefined, 'y nunca llegó al servidor');
  assert.equal((await client.get(TABLE, shared.id))?.name, 'Compartido', 'el snapshot nuevo trae lo legible para la nueva persona');
  assert.equal(client.bootstrap()?.profile.userId, server.userId);

  await client.sync(); // ciclo lanzado por start(): conserva el aviso
  assert.equal(client.status().lastError?.code, 'USER_CHANGED');
  await client.sync(); // siguiente ciclo: se limpia
  assert.equal(client.status().lastError, null);
  assert.ok(seen.some((s) => s.lastError?.code === 'USER_CHANGED'), 'onStatus vio el aviso');
  off();
});

// ---------------------------------------------------------------------------
// 3. Cambio de ámbitos
// ---------------------------------------------------------------------------

test('membership.revision distinta: snapshot completo sustituye el espejo sin tocar la outbox', async () => {
  const { server, client } = await ready();
  const stays = server.seed(TABLE, { name: 'Sigue en ámbito', notes: null });
  const leaves = server.seed(TABLE, { name: 'Sale del ámbito', notes: null });
  await client.sync();
  assert.equal((await client.list(TABLE)).length, 2);

  // La fila deja de ser visible para esta persona sin que haya un cambio en el log (es un cambio de ámbito).
  server.rows.delete(`${TABLE}|${leaves.id}`);
  server.membershipRevision = 2;
  server.commandsDown = true;
  const draft = crypto.randomUUID();
  await client.commit([{ op: 'insert', table: TABLE, id: draft, fields: { name: 'Borrador', notes: null } }]);
  await client.sync();
  server.commandsDown = false;

  await client.start();
  await client.sync();
  const rows = await client.list(TABLE, { includeDeleted: true });
  assert.deepEqual(
    rows.map((r) => r.id).sort(),
    [stays.id, draft].sort(),
    'la fila fuera de ámbito desaparece; la que sigue y el borrador pendiente se conservan',
  );
  assert.equal(pendingRows(rows).length, 0, 'el borrador se envió al recuperar la red');
  assert.equal(server.row(TABLE, draft)?.name, 'Borrador');
  assert.equal(client.status().cursor, server.cursor);
  assert.equal(client.bootstrap()?.membership.revision, 2);
});

test('una tabla que deja de ser legible desaparece del espejo', async () => {
  const { server, client } = await ready({ tables: [TABLE, GUESTS] });
  server.seed(TABLE, { name: 'Proveedor', notes: null });
  server.seed(GUESTS, { name: 'Huésped', notes: null });
  await client.sync();
  assert.equal((await client.list(GUESTS)).length, 1);

  server.tables = [TABLE];
  await client.start();
  await client.sync();
  assert.deepEqual(await client.list(GUESTS), []);
  assert.equal((await client.list(TABLE)).length, 1);
  assert.equal(client.status().cursor, server.cursor);
  assert.equal(client.status().lastError, null);
});

// ---------------------------------------------------------------------------
// 4. Lotes rechazados visibles
// ---------------------------------------------------------------------------

test('422 CONSTRAINT_VIOLATION: el lote va a rejected, el espejo vuelve a la base y la cola continúa', async () => {
  const { server, client } = await ready();
  const existing = server.seed(TABLE, { name: 'Proveedor', notes: 'original' });
  await client.sync();
  server.rejectValue = 'DUPLICADO';
  server.down = true;
  const badId = crypto.randomUUID();
  const goodId = crypto.randomUUID();
  const { requestId: badRequest } = await client.commit([
    { op: 'update', table: TABLE, id: existing.id, expectedRevision: 1, fields: { notes: 'mis notas' } },
    { op: 'insert', table: TABLE, id: badId, fields: { name: 'DUPLICADO', notes: null } },
  ]);
  await client.commit([{ op: 'insert', table: TABLE, id: goodId, fields: { name: 'Correcto', notes: null } }]);
  await client.sync();
  server.down = false;
  await client.sync();

  const status = client.status();
  assert.equal(status.pendingCommands, 0);
  assert.equal(status.rejected, 1);
  assert.equal(status.lastError?.code, 'CONSTRAINT_VIOLATION');
  assert.equal(status.network, 'online', 'la cola no se bloquea');
  assert.equal(server.row(TABLE, goodId)?.name, 'Correcto', 'el siguiente lote se envió');
  assert.equal(await client.get(TABLE, badId), null);
  assert.equal((await client.get(TABLE, existing.id))?.notes, 'original', 'la otra fila del lote vuelve a la base');

  const [rejected] = await client.rejected();
  assert.ok(rejected);
  assert.equal(rejected.requestId, badRequest);
  assert.equal(rejected.error.status, 422);
  assert.equal(rejected.error.code, 'CONSTRAINT_VIOLATION');
  assert.deepEqual(rejected.error.details, { value: 'DUPLICADO' });
  assert.equal(rejected.operations.length, 2);
  assert.equal(rejected.baseRows[`${TABLE}|${existing.id}`]?.notes, 'original');
  assert.equal(rejected.baseRows[`${TABLE}|${badId}`], null);
  assert.ok(rejected.rejectedAt);

  // Reintento con las operaciones corregidas: requestId nuevo, el lote prospera y sale de rejected.
  const corrected = rejected.operations.map((op) => (op.op === 'insert' ? { ...op, fields: { ...op.fields, name: 'Único' } } : op));
  const { requestId: retried } = await client.retryRejected(badRequest, corrected);
  assert.notEqual(retried, badRequest);
  assert.equal(client.status().rejected, 0);
  assert.equal(client.status().pendingCommands, 1);
  await client.sync();
  assert.equal(client.status().pendingCommands, 0);
  assert.equal(server.row(TABLE, badId)?.name, 'Único');
  assert.equal(server.row(TABLE, existing.id)?.notes, 'mis notas');
  await assert.rejects(client.retryRejected(badRequest), /No hay lote rechazado/);
});

test('403 FORBIDDEN ya no detiene la cola: cada lote se rechaza y puede descartarse o reintentarse', async () => {
  const { server, client } = await ready();
  server.commandsDown = true;
  const first = await client.commit([{ op: 'insert', table: TABLE, id: crypto.randomUUID(), fields: { name: 'Uno', notes: null } }]);
  const second = await client.commit([{ op: 'insert', table: TABLE, id: crypto.randomUUID(), fields: { name: 'Dos', notes: null } }]);
  await client.sync();
  assert.equal(client.status().pendingCommands, 2);
  server.commandsDown = false;
  server.forbidden = true; // el ámbito se retiró mientras la cola esperaba
  await client.sync();
  assert.equal(server.commandCount, 0);
  assert.equal(client.status().pendingCommands, 0);
  assert.equal(client.status().rejected, 2);
  assert.equal(client.status().lastError?.code, 'FORBIDDEN');
  assert.deepEqual(
    (await client.rejected()).map((r) => r.requestId),
    [first.requestId, second.requestId],
    'en orden de rechazo',
  );
  assert.equal(pendingRows(await client.list(TABLE)).length, 0, 'las filas provisionales se retiran');

  await client.discardRejected(first.requestId);
  assert.equal(client.status().rejected, 1);
  await assert.rejects(client.discardRejected(first.requestId), /No hay lote rechazado/);

  server.forbidden = false;
  await client.retryRejected(second.requestId);
  await client.sync();
  assert.equal(client.status().rejected, 0);
  assert.equal(server.rowsOf(TABLE).map((r) => r.name).join(), 'Dos');
});

test('401 sin refresco posible y 5xx conservan la cola; un 404 la rechaza sin bloquearla', async () => {
  const { server, client } = await ready();
  server.commandsDown = true;
  await client.commit([{ op: 'insert', table: TABLE, id: crypto.randomUUID(), fields: { name: 'Espera', notes: null } }]);
  await client.sync();
  server.commandsDown = false;

  // 401 irrecuperable: la sesión se borra, la cola se conserva.
  server.expireTokens();
  server.refreshTokens.clear();
  await client.sync();
  assert.equal(client.status().pendingCommands, 1);
  assert.equal(client.status().rejected, 0);
  assert.equal(client.session(), null);
  assert.equal(client.status().lastError?.code, 'UNAUTHENTICATED');

  // 5xx: reintentable.
  await client.login('user@example.com', 'secret');
  server.unavailable = true;
  await client.sync();
  assert.equal(client.status().pendingCommands, 1);
  assert.equal(client.status().network, 'error');
  server.unavailable = false;

  // 404 (editar una fila que el servidor no conoce): definitivo, va a rejected.
  await client.commit([{ op: 'update', table: TABLE, id: crypto.randomUUID(), expectedRevision: 1, fields: { notes: 'x' } }]);
  await client.sync();
  assert.equal(client.status().pendingCommands, 0);
  assert.equal(client.status().rejected, 1);
  assert.equal((await client.rejected())[0]?.error.code, 'NOT_FOUND');
  assert.equal(server.rowsOf(TABLE).length, 1, 'el primer lote sí llegó');
});

test('los rechazados sobreviven a una recarga y la base creada en 0.1 gana el store rejected', async () => {
  const h = await ready();
  const { server, client } = h;
  server.forbidden = true;
  const { requestId } = await client.commit([{ op: 'insert', table: TABLE, id: crypto.randomUUID(), fields: { name: 'Uno', notes: null } }]);
  await client.sync();
  assert.equal(client.status().rejected, 1);
  client.stop();

  server.down = true;
  const again = h.reopen();
  await again.start();
  assert.equal(again.status().rejected, 1);
  assert.equal((await again.rejected())[0]?.requestId, requestId);
  again.stop();
});
