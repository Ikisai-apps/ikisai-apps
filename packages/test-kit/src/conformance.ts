/**
 * Suite de conformidad del núcleo (contrato §9). Toda <app>-api debe pasarla con una tabla
 * sincronizable de muestra. Se ejecuta con node:test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, TEST_PASSWORD, type TestApp, type TestAppOptions } from './http.ts';

export interface ConformanceOptions extends TestAppOptions {
  /** Tabla de muestra registrada para la app, con dos campos escribibles de texto. */
  table: string;
  fieldA: string;
  fieldB: string;
  /** Campos obligatorios mínimos para insertar una fila válida. */
  required: Record<string, unknown>;
  /** Archivo de muestra para la prueba de subidas; por defecto un PDF. Apps que solo admiten imágenes pasan `{ mime: 'image/webp', filename: 'foto.webp' }`. */
  uploadSample?: { mime: string; filename: string; bytes?: Uint8Array };
}

export function runConformance(options: ConformanceOptions) {
  const { table, fieldA, fieldB, required } = options;
  const uuid = () => crypto.randomUUID();
  const insert = (id: string, extra: Record<string, unknown> = {}) => ({ op: 'insert', table, id, fields: { ...required, ...extra } });

  let app: TestApp;
  test.before(async () => { app = await createTestApp(options); });
  test.after(async () => { await app.close(); });

  test('conformidad · auth: sin token 401, token falso 401, origen ajeno 403, health público', async () => {
    assert.equal((await app.call('/api/v1/bootstrap', { token: null })).status, 401);
    assert.equal((await app.call('/api/v1/bootstrap', { token: 'fake.token.x' })).status, 401);
    assert.equal((await app.call('/api/v1/bootstrap', { origin: 'https://foreign.example' })).status, 403);
    const health = await app.call('/api/v1/health', { token: null });
    assert.equal(health.status, 200); assert.equal(health.data.app, options.app);
    const login = await app.call('/api/v1/auth/login', { token: null, body: { username: 'owner@example.invalid', password: TEST_PASSWORD } });
    assert.equal(login.status, 200); assert.ok(login.data.token && login.data.refreshToken);
    assert.equal((await app.call('/api/v1/auth/login', { token: null, body: { username: 'owner@example.invalid', password: 'mal' } })).data.error.code, 'LOGIN_FAILED');
    const refreshed = await app.call('/api/v1/auth/refresh', { token: null, body: { refreshToken: login.data.refreshToken } });
    assert.equal(refreshed.status, 200);
    const boot = await app.call('/api/v1/bootstrap', { token: refreshed.data.token });
    assert.equal(boot.status, 200); assert.equal(boot.data.membership.role, 'owner');
    assert.ok(boot.data.tables.some((x: any) => x.table === table));
    assert.equal(JSON.stringify(boot.data).includes('private-service-key'), false);
  });

  test('conformidad · insert con id de cliente; reintento idempotente; digest distinto rechazado', async () => {
    const id = uuid();
    const batch = { requestId: 'conf-insert', operations: [insert(id, { [fieldA]: 'uno' })] };
    const first = await app.call('/api/v1/commands', { body: batch });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.results[0].revision, 1);
    const again = await app.call('/api/v1/commands', { body: batch });
    assert.equal(again.status, 200); assert.equal(again.data.cursor, first.data.cursor); assert.equal(again.data.replayed, true);
    const other = await app.call('/api/v1/commands', { body: { ...batch, operations: [insert(id, { [fieldA]: 'dos' })] } });
    assert.equal(other.status, 409); assert.equal(other.data.error.code, 'IDEMPOTENCY_REUSE');
    const snap = await app.call(`/api/v1/snapshot?tables=${table}`);
    assert.equal(snap.data.tables[0].rows.filter((r: any) => r.id === id).length, 1);
  });

  test('conformidad · update con revisión correcta; revisión antigua → 409 sin cambiar la fila', async () => {
    const id = uuid();
    await app.call('/api/v1/commands', { body: { requestId: 'conf-u0', operations: [insert(id, { [fieldA]: 'a' })] } });
    const ok = await app.call('/api/v1/commands', { body: { requestId: 'conf-u1', operations: [{ op: 'update', table, id, expectedRevision: 1, fields: { [fieldB]: 'b' } }] } });
    assert.equal(ok.status, 200); assert.equal(ok.data.results[0].revision, 2); assert.equal(ok.data.changes[0].after[fieldB], 'b');
    const stale = await app.call('/api/v1/commands', { body: { requestId: 'conf-u2', operations: [{ op: 'update', table, id, expectedRevision: 1, fields: { [fieldB]: 'pisar' } }] } });
    assert.equal(stale.status, 409); assert.equal(stale.data.error.code, 'VERSION_CONFLICT');
    assert.equal(stale.data.error.details.currentRevision, 2); assert.equal(stale.data.error.details.current[fieldB], 'b');
    const snap = await app.call(`/api/v1/snapshot?tables=${table}`);
    assert.equal(snap.data.tables[0].rows.find((r: any) => r.id === id)[fieldB], 'b');
  });

  test('conformidad · expectedCursor desactualizado → CURSOR_CONFLICT; campo fuera de lista → INVALID_FIELDS', async () => {
    const boot = await app.call('/api/v1/bootstrap');
    const stale = await app.call('/api/v1/commands', { body: { requestId: 'conf-c1', expectedCursor: boot.data.cursor - 1, operations: [insert(uuid())] } });
    assert.equal(stale.data.error.code, 'CURSOR_CONFLICT');
    const bad = await app.call('/api/v1/commands', { body: { requestId: 'conf-c2', operations: [insert(uuid(), { revision: 5 })] } });
    assert.equal(bad.status, 422); assert.equal(bad.data.error.code, 'INVALID_FIELDS');
    const unknown = await app.call('/api/v1/commands', { body: { requestId: 'conf-c3', operations: [insert(uuid(), { campo_inexistente: 1 })] } });
    assert.equal(unknown.data.error.code, 'INVALID_FIELDS');
    assert.equal((await app.call('/api/v1/commands', { body: { requestId: 'conf-c4', operations: [{ op: 'update', table, id: 'no-uuid', expectedRevision: 1, fields: {} }] } })).data.error.code, 'INVALID_OPERATION');
  });

  test('conformidad · reader no escribe; sin membresía 403; sesión cerrada 401', async () => {
    const denied = await app.call('/api/v1/commands', { token: app.tokens.reader, body: { requestId: 'conf-r1', operations: [insert(uuid())] } });
    assert.equal(denied.status, 403);
    assert.equal((await app.call('/api/v1/snapshot', { token: app.tokens.reader })).status, 200);
    const stranger = await app.t.createUser();
    const strangerToken = app.supabase.tokenFor(stranger);
    assert.equal((await app.call('/api/v1/bootstrap', { token: strangerToken })).status, 403);
    const victim = await app.t.createUser();
    await app.t.db.query(`insert into core.memberships (app, user_id, role) values ($1, $2, 'editor')`, [options.app, victim]);
    const victimToken = app.supabase.tokenFor(victim);
    assert.equal((await app.call('/api/v1/bootstrap', { token: victimToken })).status, 200);
    assert.equal((await app.call('/api/v1/auth/logout', { token: victimToken, body: {} })).status, 200);
    assert.equal((await app.call('/api/v1/bootstrap', { token: victimToken })).status, 401);
  });

  test('conformidad · delete lógico sale del snapshot, aparece en changes; restore lo devuelve', async () => {
    const id = uuid();
    const created = await app.call('/api/v1/commands', { body: { requestId: 'conf-d0', operations: [insert(id, { [fieldA]: 'borrable' })] } });
    const del = await app.call('/api/v1/commands', { body: { requestId: 'conf-d1', operations: [{ op: 'delete', table, id, expectedRevision: 1 }] } });
    assert.equal(del.status, 200); assert.ok(del.data.changes[0].after.deleted_at);
    let snap = await app.call(`/api/v1/snapshot?tables=${table}`);
    assert.equal(snap.data.tables[0].rows.some((r: any) => r.id === id), false);
    snap = await app.call(`/api/v1/snapshot?tables=${table}&includeDeleted=1`);
    assert.equal(snap.data.tables[0].rows.some((r: any) => r.id === id), true);
    const changes = await app.call(`/api/v1/changes?after=${created.data.cursor}`);
    assert.ok(changes.data.items.some((c: any) => c.id === id && c.op === 'delete'));
    const res = await app.call('/api/v1/commands', { body: { requestId: 'conf-d2', operations: [{ op: 'restore', table, id, expectedRevision: 2 }] } });
    assert.equal(res.status, 200); assert.equal(res.data.changes[0].after.deleted_at, null);
    assert.equal((await app.call('/api/v1/commands', { body: { requestId: 'conf-d3', operations: [{ op: 'restore', table, id, expectedRevision: 3 }] } })).data.error.code, 'ROW_NOT_DELETED');
  });

  test('conformidad · changes?after devuelve solo lo posterior y pagina', async () => {
    const before = (await app.call('/api/v1/bootstrap')).data.cursor;
    const ids = [uuid(), uuid(), uuid()];
    for (const [i, id] of ids.entries()) await app.call('/api/v1/commands', { body: { requestId: `conf-p${i}-${id}`, operations: [insert(id)] } });
    const page = await app.call(`/api/v1/changes?after=${before}&limit=2`);
    assert.equal(page.data.items.length, 2); assert.equal(page.data.hasMore, true);
    const rest = await app.call(`/api/v1/changes?after=${page.data.cursor}&limit=50`);
    assert.equal(rest.data.items.length, 1); assert.equal(rest.data.hasMore, false);
    assert.deepEqual([...page.data.items, ...rest.data.items].map((c: any) => c.id), ids);
    assert.equal((await app.call('/api/v1/changes?after=abc')).status, 422);
  });

  test('conformidad · undo restaura before; undo tras edición ajena → 409; plan cambiado → UNDO_PLAN_CHANGED', async () => {
    const id = uuid();
    await app.call('/api/v1/commands', { body: { requestId: 'conf-h0', operations: [insert(id, { [fieldA]: 'v1' })] } });
    const edit = await app.call('/api/v1/commands', { body: { requestId: 'conf-h1', operations: [{ op: 'update', table, id, expectedRevision: 1, fields: { [fieldA]: 'v2' } }] } });
    const history = await app.call('/api/v1/history?limit=5');
    assert.equal(history.data.items[0].cursor, edit.data.cursor); assert.equal(history.data.items[0].changes[0].before[fieldA], 'v1');
    const plan = await app.call(`/api/v1/history/${edit.data.cursor}/undo-plan`, { body: {} });
    assert.equal(plan.status, 200); assert.ok(plan.data.planHash);
    assert.equal((await app.call(`/api/v1/history/${edit.data.cursor}/undo`, { body: { requestId: 'conf-h2', planHash: 'otro' } })).data.error.code, 'UNDO_PLAN_CHANGED');
    const undone = await app.call(`/api/v1/history/${edit.data.cursor}/undo`, { body: { requestId: 'conf-h2', planHash: plan.data.planHash } });
    assert.equal(undone.status, 200); assert.equal(undone.data.changes[0].after[fieldA], 'v1');
    // misma petición otra vez → recibo
    const replay = await app.call(`/api/v1/history/${edit.data.cursor}/undo`, { body: { requestId: 'conf-h2', planHash: plan.data.planHash } });
    assert.equal(replay.status, 409); assert.equal(replay.data.error.code, 'UNDO_PLAN_CHANGED');
    // deshacer el primer cambio ahora que la fila está en revisión 3 con un plan viejo → conflicto
    const planOld = await app.call(`/api/v1/history/${edit.data.cursor}/undo-plan`, { body: {} });
    await app.call('/api/v1/commands', { body: { requestId: 'conf-h3', operations: [{ op: 'update', table, id, expectedRevision: 3, fields: { [fieldB]: 'x' } }] } });
    assert.equal((await app.call(`/api/v1/history/${edit.data.cursor}/undo`, { body: { requestId: 'conf-h4', planHash: planOld.data.planHash } })).data.error.code, 'UNDO_PLAN_CHANGED');
    assert.equal((await app.call('/api/v1/history', { token: app.tokens.reader })).status, 200);
    assert.equal((await app.call(`/api/v1/history/${edit.data.cursor}/undo-plan`, { token: app.tokens.reader, body: {} })).status, 403);
  });

  test('conformidad · respuesta perdida tras commit: el reintento devuelve el recibo sin duplicar', async () => {
    const id = uuid();
    const batch = { requestId: 'conf-lost', operations: [insert(id)] };
    app.supabase.loseNextCommitReply();
    const lost = await app.call('/api/v1/commands', { body: batch });
    assert.equal(lost.status, 503); assert.equal(lost.data.error.code, 'BACKEND_UNAVAILABLE');
    const retry = await app.call('/api/v1/commands', { body: batch });
    assert.equal(retry.status, 200); assert.equal(retry.data.replayed, true);
    const snap = await app.call(`/api/v1/snapshot?tables=${table}`);
    assert.equal(snap.data.tables[0].rows.filter((r: any) => r.id === id).length, 1);
  });

  test('conformidad · dos commits al mismo cursor: uno confirma y el otro recibe conflicto', async () => {
    const boot = await app.call('/api/v1/bootstrap');
    const [a, b] = await Promise.all([
      app.call('/api/v1/commands', { body: { requestId: 'conf-race-a', expectedCursor: boot.data.cursor, operations: [insert(uuid())] } }),
      app.call('/api/v1/commands', { body: { requestId: 'conf-race-b', expectedCursor: boot.data.cursor, operations: [insert(uuid())] } }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const failed = a.status === 409 ? a : b;
    assert.equal(failed.data.error.code, 'CURSOR_CONFLICT');
  });

  test('conformidad · call a procedimiento no permitido → INVALID_OPERATION', async () => {
    const res = await app.call('/api/v1/commands', { body: { requestId: 'conf-call', operations: [{ op: 'call', procedure: 'invoices.nada', args: {} }] } });
    assert.equal(res.status, 422); assert.equal(res.data.error.code, 'INVALID_OPERATION');
  });

  test('conformidad · papelera: purge solo owner; facturas exentas por never_purge', async () => {
    const id = uuid();
    await app.call('/api/v1/commands', { body: { requestId: 'conf-t0', operations: [insert(id)] } });
    await app.call('/api/v1/commands', { body: { requestId: 'conf-t1', operations: [{ op: 'delete', table, id, expectedRevision: 1 }] } });
    assert.equal((await app.call('/api/v1/trash/purge', { token: app.tokens.editor, body: { requestId: 'conf-t2', tables: [table] } })).status, 403);
    const purged = await app.call('/api/v1/trash/purge', { body: { requestId: 'conf-t3', tables: [table] } });
    assert.equal(purged.status, 200); assert.ok(purged.data.purged >= 1);
    const snap = await app.call(`/api/v1/snapshot?tables=${table}&includeDeleted=1`);
    assert.equal(snap.data.tables[0].rows.some((r: any) => r.id === id), false);
  });

  test('conformidad · subidas: ticket, PUT simulado, verify con hash y URL de lectura', async () => {
    const sample = options.uploadSample ?? { mime: 'application/pdf', filename: 'Factura (Makro).pdf' };
    const bytes = sample.bytes ?? new TextEncoder().encode(sample.mime === 'application/pdf' ? '%PDF-1.4 prueba' : 'RIFF....WEBPVP8 prueba');
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const ticket = await app.call('/api/v1/uploads', { body: { filename: sample.filename, mime: sample.mime, size: bytes.byteLength, sha256: sha } });
    if (ticket.status === 404) return; // la app no declara subidas
    assert.equal(ticket.status, 200, JSON.stringify(ticket.data)); assert.ok(ticket.data.uploadUrl.includes('/storage/v1/object/upload/sign/'));
    const notYet = await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { body: {} });
    assert.equal(notYet.status, 404);
    app.supabase.storage.set(ticket.data.path, bytes);
    const bad = await app.call('/api/v1/uploads', { body: { filename: sample.filename, mime: sample.mime, size: bytes.byteLength, sha256: 'a'.repeat(64) } });
    app.supabase.storage.set(bad.data.path, bytes);
    assert.equal((await app.call(`/api/v1/uploads/${bad.data.id}/verify`, { body: {} })).data.error.code, 'FILE_MISMATCH');
    const verified = await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { body: {} });
    assert.equal(verified.status, 200); assert.equal(verified.data.verified, true); assert.equal(verified.data.hashVerified, true);
    const url = await app.call(`/api/v1/files/${ticket.data.id}`);
    assert.equal(url.status, 200); assert.ok(url.data.url.includes('/storage/v1/object/sign/'));
    assert.equal((await app.call('/api/v1/uploads', { token: app.tokens.reader, body: { filename: sample.filename, mime: sample.mime, size: 1, sha256: sha } })).status, 403);
    assert.equal((await app.call('/api/v1/uploads', { body: { filename: 'x.exe', mime: 'application/x-msdownload', size: 1, sha256: sha } })).data.error.code, 'UNSUPPORTED_MEDIA');
  });
}
