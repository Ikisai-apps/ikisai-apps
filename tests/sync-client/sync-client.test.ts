import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createSyncClient, type SyncClient, type SyncStatus, type SyncedRow, type TableName } from '../../packages/sync-client/src/index.ts';
import { FakeServer, type FakeServerOptions } from './fake-server.ts';

const TABLE: TableName = 'invoices.suppliers';

interface Harness {
  server: FakeServer;
  idb: IDBFactory;
  client: SyncClient;
  /** Crea otro cliente sobre la misma IndexedDB (simula recargar la página). */
  reopen(): SyncClient;
}

function harness(options: FakeServerOptions = {}, clientExtra: { now?: () => number } = {}): Harness {
  const server = new FakeServer({ tables: [TABLE], ...options });
  const idb = new IDBFactory();
  const make = () =>
    createSyncClient({ app: server.app, apiBase: server.apiBase, fetch: server.fetch, indexedDB: idb, pullIntervalMs: 0, ...clientExtra });
  return { server, idb, client: make(), reopen: make };
}

/** Cliente con sesión iniciada, bootstrap hecho y snapshot inicial sincronizado. */
async function ready(options: FakeServerOptions = {}): Promise<Harness> {
  const h = harness(options);
  await h.client.login('user@example.com', 'secret');
  await h.client.start();
  await h.client.sync();
  return h;
}

function pendingRows(rows: SyncedRow[]): SyncedRow[] {
  return rows.filter((r) => (r as SyncedRow & { _pending?: boolean })._pending === true);
}

// ---------------------------------------------------------------------------

test('login guarda la sesión y un 401 se resuelve refrescando una sola vez', async () => {
  const { server, client } = harness();
  const session = await client.login('user@example.com', 'secret');
  assert.equal(session.token, 'token-1');
  assert.equal(client.session()?.refreshToken, 'refresh-1');

  server.expireTokens();
  const boot = await client.api<{ app: string }>('/bootstrap');
  assert.equal(boot.app, 'invoices');
  assert.equal(server.refreshCount, 1);
  assert.equal(client.session()?.token, 'token-2');
  const authCalls = server.calls.filter((c) => c.path === '/bootstrap').length;
  assert.equal(authCalls, 2, 'la petición original y el reintento tras refrescar');

  await assert.rejects(client.login('user@example.com', 'mal'), (e: unknown) => {
    const err = e as { status: number; code: string };
    return err.status === 401 && err.code === 'INVALID_CREDENTIALS';
  });
});

test('la sesión se refresca de forma proactiva cuando quedan menos de 60 s', async () => {
  const { server, client } = harness({ loginExpiresIn: 30 });
  await client.login('user@example.com', 'secret');
  await client.api('/bootstrap');
  assert.equal(server.refreshCount, 1, 'refresco antes de la primera llamada');
  assert.equal(server.calls.filter((c) => c.path === '/bootstrap').length, 1, 'sin reintento: la llamada ya salió con el token nuevo');
});

test('snapshot inicial y pull incremental con notificación por tabla', async () => {
  const { server, client } = harness();
  const a = server.seed(TABLE, { name: 'Makro', notes: null });
  server.seed(TABLE, { name: 'Mercadona', notes: null });

  await client.login('user@example.com', 'secret');
  const boot = await client.start();
  assert.equal(boot?.cursor, 2);
  await client.sync();

  const rows = await client.list(TABLE);
  assert.equal(rows.length, 2);
  assert.equal(client.status().cursor, server.cursor);
  assert.equal(client.status().network, 'online');
  assert.ok(client.status().lastPullAt);

  const seen: SyncedRow[][] = [];
  const off = client.onTable(TABLE, (r) => seen.push(r));
  server.update(TABLE, a.id, { notes: 'cambiado fuera' });
  const deleted = server.seed(TABLE, { name: 'Borrado', notes: null });
  server.delete(TABLE, deleted.id);
  await client.sync();

  const afterPull = await client.list(TABLE);
  assert.equal(afterPull.length, 2, 'la fila borrada no aparece en list() por defecto');
  assert.equal((await client.list(TABLE, { includeDeleted: true })).length, 3);
  assert.equal((await client.get(TABLE, a.id))?.notes, 'cambiado fuera');
  assert.equal((await client.get(TABLE, a.id))?.revision, 2);
  assert.equal(client.status().cursor, server.cursor);
  assert.ok(seen.length >= 1, 'onTable notificó');
  off();
});

test('commit optimista: fila provisional, push y sustitución por la confirmada', async () => {
  const { server, client } = await ready();
  const statuses: SyncStatus[] = [];
  client.onStatus((s) => statuses.push(s));
  const id = crypto.randomUUID();

  server.unavailable = true; // para observar el estado provisional sin carrera
  const { requestId } = await client.commit([{ op: 'insert', table: TABLE, id, fields: { name: 'Nuevo', notes: null } }]);
  assert.ok(requestId);
  const provisional = (await client.get(TABLE, id)) as SyncedRow & { _pending?: boolean };
  assert.equal(provisional.revision, 0);
  assert.equal(provisional._pending, true);
  assert.equal(provisional.name, 'Nuevo');
  await client.sync();
  assert.equal(client.status().pendingCommands, 1);
  assert.equal(client.status().network, 'error');
  assert.equal(client.status().lastError?.code, 'BACKEND_UNAVAILABLE');

  server.unavailable = false;
  await client.sync();
  const confirmed = (await client.get(TABLE, id)) as SyncedRow & { _pending?: boolean };
  assert.equal(confirmed.revision, 1);
  assert.equal(confirmed._pending, undefined, 'ya no está marcada como pendiente');
  assert.equal(confirmed.updated_by, server.userId);
  assert.equal(client.status().pendingCommands, 0);
  assert.equal(client.status().network, 'online');
  assert.equal(client.status().lastError, null);
  assert.equal(client.status().cursor, server.cursor);
  assert.ok(statuses.some((s) => s.pendingCommands === 1), 'onStatus vio la cola con un comando');

  // una edición posterior con la revisión confirmada
  await client.commit([{ op: 'update', table: TABLE, id, expectedRevision: 1, fields: { notes: 'hola' } }]);
  await client.sync();
  assert.equal(server.row(TABLE, id)?.notes, 'hola');
  assert.equal((await client.get(TABLE, id))?.revision, 2);
});

test('reintento tras respuesta perdida: el recibo devuelve el mismo resultado y no duplica', async () => {
  const { server, client } = await ready();
  const id = crypto.randomUUID();
  server.dropNextCommandResponse = true;
  await client.commit([{ op: 'insert', table: TABLE, id, fields: { name: 'Una vez', notes: null } }]);
  await client.sync();
  assert.equal(server.commandCount, 1, 'el servidor sí procesó el lote');
  assert.equal(client.status().pendingCommands, 1, 'el cliente no sabe que llegó');
  assert.equal(client.status().network, 'offline');
  const changesBefore = server.changes.length;

  await client.sync();
  assert.equal(server.commandCount, 1, 'no se aplicó dos veces');
  assert.equal(server.changes.length, changesBefore);
  assert.equal(server.rowsOf(TABLE).length, 1);
  assert.equal(client.status().pendingCommands, 0);
  assert.equal((await client.get(TABLE, id))?.revision, 1);
});

test('red caída: la cola espera y se vacía en orden al reconectar', async () => {
  const { server, client } = await ready();
  const id1 = crypto.randomUUID();
  const id2 = crypto.randomUUID();
  server.down = true;
  await client.commit([{ op: 'insert', table: TABLE, id: id1, fields: { name: 'Primero', notes: null } }]);
  await client.commit([{ op: 'insert', table: TABLE, id: id2, fields: { name: 'Segundo', notes: null } }]);
  await client.sync();
  assert.equal(client.status().network, 'offline');
  assert.equal(client.status().pendingCommands, 2);
  assert.equal(pendingRows(await client.list(TABLE)).length, 2);
  assert.equal(server.commandCount, 0);

  server.down = false;
  await client.sync();
  assert.equal(client.status().network, 'online');
  assert.equal(client.status().pendingCommands, 0);
  assert.equal(pendingRows(await client.list(TABLE)).length, 0);
  const order = server.changes.filter((c) => c.actorId === server.userId).map((c) => c.id);
  assert.deepEqual(order, [id1, id2], 'FIFO');
});

test('inserción y edición encadenadas sin red: la segunda hereda la revisión confirmada', async () => {
  const { server, client } = await ready();
  const id = crypto.randomUUID();
  server.down = true;
  await client.commit([{ op: 'insert', table: TABLE, id, fields: { name: 'Borrador', notes: null } }]);
  const local = (await client.get(TABLE, id))!;
  await client.commit([{ op: 'update', table: TABLE, id, expectedRevision: local.revision, fields: { notes: 'más tarde' } }]);
  await client.sync();
  server.down = false;
  await client.sync();
  assert.equal(client.status().pendingCommands, 0);
  assert.equal(client.status().autoMerged, 0, 'no fue un conflicto, solo encadenado');
  assert.equal(server.row(TABLE, id)?.revision, 2);
  assert.equal(server.row(TABLE, id)?.notes, 'más tarde');
  assert.equal((await client.get(TABLE, id))?.revision, 2);
});

test('conflicto disjunto: se rebasa solo, autoMerged = 1 y nada se pierde', async () => {
  const { server, client } = await ready();
  const row = server.seed(TABLE, { name: 'Proveedor', notes: 'original', tax_id: null });
  await client.sync();

  server.unavailable = true;
  await client.commit([{ op: 'update', table: TABLE, id: row.id, expectedRevision: 1, fields: { notes: 'mis notas' } }]);
  await client.sync();
  server.update(TABLE, row.id, { name: 'Renombrado por otro' });
  server.unavailable = false;

  await client.sync();
  assert.equal(client.status().autoMerged, 1);
  assert.equal(client.status().pendingCommands, 0);
  assert.equal(client.status().conflicts, 0);
  const final = server.row(TABLE, row.id)!;
  assert.equal(final.name, 'Renombrado por otro');
  assert.equal(final.notes, 'mis notas');
  assert.equal(final.revision, 3);
  const mirror = await client.get(TABLE, row.id);
  assert.deepEqual({ name: mirror?.name, notes: mirror?.notes, revision: mirror?.revision }, { name: final.name, notes: final.notes, revision: 3 });
});

test('pull con edición pendiente no pisa el espejo y guarda la base remota', async () => {
  const { server, client } = await ready();
  const row = server.seed(TABLE, { name: 'Proveedor', notes: 'original' });
  await client.sync();
  server.down = true;
  await client.commit([{ op: 'update', table: TABLE, id: row.id, expectedRevision: 1, fields: { notes: 'mías' } }]);
  await client.sync();
  server.down = false;
  server.update(TABLE, row.id, { name: 'Otro nombre' });
  // Forzamos un pull sin push: solo la ruta commands falla por red.
  server.commandsDown = true;
  await client.sync();
  const mirror = await client.get(TABLE, row.id);
  assert.equal(mirror?.notes, 'mías', 'el espejo conserva mi edición pendiente');
  assert.equal(mirror?.name, 'Proveedor', 'el cambio remoto espera al rebase');
  assert.equal(client.status().cursor, server.cursor, 'pero el cursor avanzó');
  server.commandsDown = false;
  await client.sync();
  assert.equal(client.status().autoMerged, 1);
  assert.equal((await client.get(TABLE, row.id))?.name, 'Otro nombre');
  assert.equal((await client.get(TABLE, row.id))?.notes, 'mías');
});

async function overlappingConflict() {
  const h = await ready();
  const row = h.server.seed(TABLE, { name: 'Proveedor', notes: 'original' });
  await h.client.sync();
  h.server.unavailable = true;
  const { requestId } = await h.client.commit([{ op: 'update', table: TABLE, id: row.id, expectedRevision: 1, fields: { name: 'Mi nombre' } }]);
  await h.client.sync();
  h.server.update(TABLE, row.id, { name: 'Su nombre' });
  h.server.unavailable = false;
  await h.client.sync();
  return { ...h, row, requestId };
}

test('conflicto solapado: va a conflicts y el espejo muestra la versión del servidor', async () => {
  const { client, server, row, requestId } = await overlappingConflict();
  assert.equal(client.status().autoMerged, 0);
  assert.equal(client.status().pendingCommands, 0);
  assert.equal(client.status().conflicts, 1);
  const [conflict] = await client.conflicts();
  assert.ok(conflict);
  assert.equal(conflict.requestId, requestId);
  assert.deepEqual(conflict.overlapping, ['name']);
  assert.equal(conflict.base?.name, 'Proveedor');
  assert.equal(conflict.current.name, 'Su nombre');
  assert.equal(conflict.current.revision, 2);
  assert.equal(conflict.operation.op, 'update');
  const mirror = await client.get(TABLE, row.id);
  assert.equal(mirror?.name, 'Su nombre');
  assert.equal(mirror?.revision, 2);
  assert.equal(server.row(TABLE, row.id)?.name, 'Su nombre', 'nada se escribió a ciegas');
});

test("resolveConflict('mine') reaplica mis campos sobre la revisión actual", async () => {
  const { client, server, row, requestId } = await overlappingConflict();
  await client.resolveConflict(requestId, { choice: 'mine' });
  await client.sync();
  assert.equal(client.status().conflicts, 0);
  assert.equal(client.status().pendingCommands, 0);
  assert.equal(server.row(TABLE, row.id)?.name, 'Mi nombre');
  assert.equal(server.row(TABLE, row.id)?.revision, 3);
  assert.equal((await client.get(TABLE, row.id))?.name, 'Mi nombre');
});

test("resolveConflict('theirs') descarta mi comando y deja la fila del servidor", async () => {
  const { client, server, row, requestId } = await overlappingConflict();
  const commandsBefore = server.commandCount;
  await client.resolveConflict(requestId, { choice: 'theirs' });
  await client.sync();
  assert.equal(client.status().conflicts, 0);
  assert.equal(server.commandCount, commandsBefore, 'no se envió nada');
  assert.equal(server.row(TABLE, row.id)?.name, 'Su nombre');
  assert.equal((await client.get(TABLE, row.id))?.name, 'Su nombre');
  await assert.rejects(client.resolveConflict(requestId, { choice: 'theirs' }), /No hay conflicto/);
});

test("resolveConflict('merge') envía los campos combinados", async () => {
  const { client, server, row, requestId } = await overlappingConflict();
  await client.resolveConflict(requestId, { choice: 'merge', fields: { name: 'Nombre pactado', notes: 'tras hablar' } });
  await client.sync();
  assert.equal(client.status().conflicts, 0);
  const final = server.row(TABLE, row.id)!;
  assert.equal(final.name, 'Nombre pactado');
  assert.equal(final.notes, 'tras hablar');
  assert.equal(final.revision, 3);
});

test('delete contra una fila modificada remotamente siempre pide confirmación', async () => {
  const { server, client } = await ready();
  const row = server.seed(TABLE, { name: 'Proveedor', notes: null });
  await client.sync();
  server.unavailable = true;
  const { requestId } = await client.commit([{ op: 'delete', table: TABLE, id: row.id, expectedRevision: 1 }]);
  assert.ok((await client.get(TABLE, row.id))?.deleted_at, 'borrado optimista en local');
  await client.sync();
  server.update(TABLE, row.id, { notes: 'cambiado por otro' });
  server.unavailable = false;
  await client.sync();
  assert.equal(client.status().conflicts, 1);
  const [conflict] = await client.conflicts();
  assert.equal(conflict?.operation.op, 'delete');
  assert.equal((await client.get(TABLE, row.id))?.deleted_at, null, 'el espejo vuelve a mostrar la fila viva');
  await client.resolveConflict(requestId, { choice: 'mine' });
  await client.sync();
  assert.ok(server.row(TABLE, row.id)?.deleted_at, 'tras confirmar, se borra con la revisión actual');
});

test('ROW_DELETED (editar una fila que otro borró) queda en conflicts', async () => {
  const { server, client } = await ready();
  const row = server.seed(TABLE, { name: 'Proveedor', notes: null });
  await client.sync();
  server.unavailable = true;
  await client.commit([{ op: 'update', table: TABLE, id: row.id, expectedRevision: 1, fields: { notes: 'mías' } }]);
  await client.sync();
  // El servidor devuelve ROW_DELETED solo si la revisión coincide; simulamos borrado sin subir revisión.
  const current = server.row(TABLE, row.id)!;
  server.rows.set(`${TABLE}|${row.id}`, { ...current, deleted_at: '2026-10-05T11:00:00Z' });
  server.unavailable = false;
  await client.sync();
  assert.equal(client.status().conflicts, 1);
  const [conflict] = await client.conflicts();
  assert.deepEqual(conflict?.overlapping, ['deleted_at']);
  assert.ok(conflict?.current.deleted_at);
  assert.equal((await client.get(TABLE, row.id))?.deleted_at, '2026-10-05T11:00:00Z');
});

test('blob staged: se sube y verifica antes de enviar el lote que lo referencia', async () => {
  const { server, client } = await ready();
  const blob = new Blob(['contenido del adjunto'], { type: 'text/plain' });
  const sha = await client.stageBlob(blob, { filename: 'nota.txt', mime: 'text/plain' });
  assert.match(sha, /^[0-9a-f]{64}$/);
  assert.equal(client.status().pendingBlobs, 1);

  const id = crypto.randomUUID();
  server.down = true;
  await client.commit([{ op: 'insert', table: TABLE, id, fields: { name: 'Con adjunto', attachment_sha: sha } }], { blobs: [blob] });
  await client.sync();
  server.down = false;
  server.calls.length = 0;
  await client.sync();

  const order = server.calls.map((c) => `${c.method} ${c.path}`).filter((p) => !p.includes('/changes'));
  assert.deepEqual(order, ['POST /uploads', 'PUT storage:/upl-1', 'POST /uploads/upl-1/verify', 'POST /commands']);
  assert.equal(server.uploads.get('upl-1')?.verified, true);
  assert.equal(client.status().pendingBlobs, 0);
  assert.equal(client.status().pendingCommands, 0);
  assert.equal(server.row(TABLE, id)?.attachment_sha, sha);
  assert.match(await client.fileUrl('upl-1'), /^https:\/\/storage\.test\/upl-1/);
});

test('si la verificación del adjunto falla, el lote no se envía y lastError lo dice', async () => {
  const { server, client } = await ready();
  const blob = new Blob(['pdf falso'], { type: 'application/pdf' });
  const sha = await client.stageBlob(blob, { filename: 'factura.pdf', mime: 'application/pdf' });
  server.failVerify = true;
  await client.commit([{ op: 'insert', table: TABLE, id: crypto.randomUUID(), fields: { name: 'X', attachment_sha: sha } }], { blobs: [blob] });
  await client.sync();
  assert.equal(server.commandCount, 0);
  assert.equal(client.status().pendingCommands, 1);
  assert.equal(client.status().pendingBlobs, 1);
  assert.equal(client.status().lastError?.code, 'UPLOAD_MISMATCH');
  server.failVerify = false;
  await client.sync();
  assert.equal(server.commandCount, 1);
  assert.equal(client.status().pendingBlobs, 0);
});

test('logout borra la sesión pero conserva el espejo; la cola sobrevive a una recarga', async () => {
  const h = await ready();
  const { server, client } = h;
  server.seed(TABLE, { name: 'Persistente', notes: null });
  await client.sync();
  server.down = true;
  const id = crypto.randomUUID();
  await client.commit([{ op: 'insert', table: TABLE, id, fields: { name: 'Pendiente', notes: null } }]);
  await client.sync();
  server.down = false;

  await client.logout();
  assert.equal(client.session(), null);
  assert.equal(server.logoutCount, 1);
  assert.equal((await client.list(TABLE)).length, 2, 'el espejo sigue ahí');
  assert.equal(client.status().pendingCommands, 1);
  client.stop();

  // «Recarga»: otro cliente sobre la misma IndexedDB, sin red.
  server.down = true;
  const again = h.reopen();
  const boot = await again.start();
  assert.equal(boot?.app, 'invoices', 'devuelve el bootstrap guardado');
  assert.equal(again.session(), null);
  assert.equal((await again.list(TABLE)).length, 2);
  assert.equal(again.status().pendingCommands, 1);
  assert.equal(again.status().cursor, server.cursor);

  server.down = false;
  await again.login('user@example.com', 'secret');
  await again.sync();
  assert.equal(again.status().pendingCommands, 0);
  assert.equal(server.row(TABLE, id)?.name, 'Pendiente');
  again.stop();
});

test('sync() nunca corre dos veces a la vez y devuelve la promesa en curso', async () => {
  const { client } = await ready();
  const p1 = client.sync();
  const p2 = client.sync();
  assert.equal(p1, p2);
  await p1;
});

test('IDEMPOTENCY_REUSE: el comando se retira y queda registrado en lastError', async () => {
  const { server, client } = await ready();
  const requestId = crypto.randomUUID();
  const id = crypto.randomUUID();
  server.receipts.set(requestId, { digest: 'otro', result: { cursor: 0, requestId, results: [], changes: [] } });
  await client.commit([{ op: 'insert', table: TABLE, id, fields: { name: 'Reusado', notes: null } }], { requestId });
  await client.sync();
  assert.equal(client.status().pendingCommands, 0);
  assert.equal(client.status().lastError?.code, 'IDEMPOTENCY_REUSE');
  assert.equal(await client.get(TABLE, id), null, 'la fila provisional se retira');
});

test('las operaciones se validan antes de encolar', async () => {
  const { client } = await ready();
  await assert.rejects(client.commit([]), /al menos una operación/);
  await assert.rejects(client.commit([{ op: 'update', table: TABLE, id: 'x', expectedRevision: -1, fields: {} }]), /expectedRevision/);
  await assert.rejects(client.commit([{ op: 'insert', table: 'sin_schema' as TableName, id: 'x', fields: {} }]), /schema\.tabla/);
  assert.equal(client.status().pendingCommands, 0);
});

test('sin IndexedDB disponible el error es claro', () => {
  const saved = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  try {
    assert.throws(() => createSyncClient({ app: 'invoices', fetch: async () => new Response() }), /IndexedDB no está disponible/);
  } finally {
    if (saved) (globalThis as { indexedDB?: IDBFactory }).indexedDB = saved;
  }
});
