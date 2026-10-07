/** Central · personas (datos reservados por ámbito), enlace de cuenta, catálogo de apps y archivo de un registro. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/central/mod.ts';

const { people: PEOPLE, personPrivate: PRIVATE, personRecords: RECORDS } = TABLES;
const uuid = () => crypto.randomUUID();

let app: TestApp;
let scoped: string; // token de un editor con scopes.people
let seq = 0;
const rid = () => `central-${++seq}`;

test.before(async () => {
  app = await createTestApp({
    app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!,
    createHandler: (config) => createCentralApp({ ...config, origins: [CENTRAL_ORIGINS[0]!] }),
  });
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('central', $1, 'editor', '{"people": true}'::jsonb)`, [user]);
  scoped = app.supabase.tokenFor(user);
});
test.after(async () => { await app.close(); });

async function commit(operations: unknown[], token?: string) {
  return app.call('/api/v1/commands', { token, body: { requestId: rid(), operations } });
}

async function newPerson(fields: Record<string, unknown> = {}) {
  const id = uuid();
  const res = await commit([{ op: 'insert', table: PEOPLE, id, fields: { display_name: 'Marga', relation: 'equipo', base_role: 'cocina', ...fields } }]);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return { id, row: res.data.changes[0].after };
}

test('personas · alta con código PER y validación de dominio', async () => {
  const { row } = await newPerson();
  assert.match(row.code, /^PER_\d{4}_\d{3}$/);
  const bad = await commit([{ op: 'insert', table: PEOPLE, id: uuid(), fields: { display_name: 'X', relation: 'jefa' } }]);
  assert.equal(bad.status, 422); assert.equal(bad.data.error.code, 'INVALID_FIELDS'); assert.equal(bad.data.error.details.field, 'relation');
  const missing = await commit([{ op: 'insert', table: PEOPLE, id: uuid(), fields: { display_name: 'X' } }]);
  assert.equal(missing.data.error.details.field, 'relation');
});

test('personas · datos reservados: owner y editor con ámbito; editor sin ámbito y lector no los ven ni escriben', async () => {
  const { id: personId } = await newPerson({ display_name: 'Reservada' });
  const privId = uuid();
  const ok = await commit([{ op: 'insert', table: PRIVATE, id: privId, fields: { person_id: personId, phone: '600000000', email: 'marga@example.invalid', engagement: 'autonomo' } }], scoped);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const before = (await app.call('/api/v1/bootstrap')).data.cursor - 1;

  const forbidden = await commit([{ op: 'update', table: PRIVATE, id: privId, expectedRevision: 1, fields: { phone: '611111111' } }], app.tokens.editor);
  assert.equal(forbidden.status, 403); assert.equal(forbidden.data.error.code, 'FORBIDDEN');

  // Lector: el núcleo no le entrega la tabla. Editor sin ámbito: el hook visible filtra las filas.
  assert.equal((await app.call(`/api/v1/snapshot?tables=${PRIVATE}`, { token: app.tokens.reader })).status, 403);
  const editorSnap = await app.call(`/api/v1/snapshot?tables=${PRIVATE}`, { token: app.tokens.editor });
  assert.equal(editorSnap.status, 200); assert.equal(editorSnap.data.tables[0].rows.length, 0);
  for (const token of [app.tokens.reader, app.tokens.editor]) {
    const changes = await app.call(`/api/v1/changes?after=${before}`, { token });
    assert.equal(JSON.stringify(changes.data).includes('600000000'), false);
    const history = await app.call('/api/v1/history?limit=20', { token });
    assert.equal(JSON.stringify(history.data).includes('600000000'), false);
  }
  const scopedSnap = await app.call(`/api/v1/snapshot?tables=${PRIVATE}`, { token: scoped });
  assert.equal(scopedSnap.data.tables[0].rows.find((r: any) => r.id === privId).phone, '600000000');
  // La ficha básica sí la ve el lector.
  const basic = await app.call(`/api/v1/snapshot?tables=${PEOPLE}`, { token: app.tokens.reader });
  assert.ok(basic.data.tables[0].rows.some((r: any) => r.id === personId));
});

test('personas · un solo bloque reservado por persona y nada vivo colgando de una persona borrada', async () => {
  const { id: personId, row } = await newPerson({ display_name: 'Única' });
  await commit([{ op: 'insert', table: PRIVATE, id: uuid(), fields: { person_id: personId } }]);
  const dup = await commit([{ op: 'insert', table: PRIVATE, id: uuid(), fields: { person_id: personId } }]);
  assert.equal(dup.status, 422); assert.equal(dup.data.error.code, 'CONSTRAINT_VIOLATION');
  const orphan = await commit([{ op: 'delete', table: PEOPLE, id: personId, expectedRevision: row.revision }]);
  assert.equal(orphan.status, 422); assert.equal(orphan.data.error.code, 'ORPHAN_CHILD');
});

test('personas · documentación: tipo según la clase, título con «otro», fechas coherentes', async () => {
  const { id: personId } = await newPerson({ display_name: 'Docs' });
  const wrongType = await commit([{ op: 'insert', table: RECORDS, id: uuid(), fields: { person_id: personId, kind: 'documento', record_type: 'socorrismo' } }]);
  assert.equal(wrongType.data.error.details.field, 'record_type');
  const noTitle = await commit([{ op: 'insert', table: RECORDS, id: uuid(), fields: { person_id: personId, kind: 'formacion', record_type: 'otra_formacion' } }]);
  assert.equal(noTitle.data.error.details.field, 'title');
  const dates = await commit([{ op: 'insert', table: RECORDS, id: uuid(), fields: { person_id: personId, kind: 'formacion', record_type: 'manipulador_alimentos', issued_on: '2026-05-01', expires_on: '2026-01-01' } }]);
  assert.equal(dates.data.error.details.field, 'expires_on');
  const ok = await commit([{ op: 'insert', table: RECORDS, id: uuid(), fields: { person_id: personId, kind: 'formacion', record_type: 'manipulador_alimentos', status: 'ok', issued_on: '2026-01-01', expires_on: '2030-01-01' } }]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const reparent = await commit([{ op: 'update', table: RECORDS, id: ok.data.changes[0].after.id, expectedRevision: 1, fields: { person_id: personId } }]);
  assert.equal(reparent.data.error.code, 'IMMUTABLE_FIELD');
});

test('personas · enlazar una cuenta: solo el owner, cuenta única y nunca un agente', async () => {
  const { id: personId } = await newPerson({ display_name: 'Con cuenta' });
  const byEditor = await commit([{ op: 'update', table: PEOPLE, id: personId, expectedRevision: 1, fields: { user_id: app.users.editor } }], scoped);
  assert.equal(byEditor.status, 403);
  const linked = await commit([{ op: 'update', table: PEOPLE, id: personId, expectedRevision: 1, fields: { user_id: app.users.editor } }]);
  assert.equal(linked.status, 200, JSON.stringify(linked.data));
  const twice = await commit([{ op: 'insert', table: PEOPLE, id: uuid(), fields: { display_name: 'Otra', relation: 'otro', user_id: app.users.editor } }]);
  assert.equal(twice.data.error.code, 'CONSTRAINT_VIOLATION');
  const agent = await app.t.createUser();
  await app.t.db.query(`insert into core.profiles (user_id, display_name, kind) values ($1, 'Bot', 'agent')`, [agent]);
  const asAgent = await commit([{ op: 'insert', table: PEOPLE, id: uuid(), fields: { display_name: 'Bot', relation: 'otro', user_id: agent } }]);
  assert.equal(asAgent.status, 422); assert.equal(asAgent.data.error.code, 'INVALID_ACCOUNT');
});

test('archivos · un registro con archivo verificado; la URL solo para quien ve los datos reservados', async () => {
  const { id: personId } = await newPerson({ display_name: 'Con archivo' });
  const bytes = new TextEncoder().encode('%PDF-1.4 certificado');
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ticket = await app.call('/api/v1/uploads', { body: { filename: 'certificado.pdf', mime: 'application/pdf', size: bytes.byteLength, sha256: sha } });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
  const recordId = uuid();
  const early = await commit([{ op: 'insert', table: RECORDS, id: recordId, fields: { person_id: personId, kind: 'documento', record_type: 'prl_basico', file_id: ticket.data.id } }]);
  assert.equal(early.data.error.code, 'INVALID_FILE');
  app.supabase.storage.set(ticket.data.path, bytes);
  assert.equal((await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { body: {} })).status, 200);
  const ok = await commit([{ op: 'insert', table: RECORDS, id: recordId, fields: { person_id: personId, kind: 'documento', record_type: 'prl_basico', file_id: ticket.data.id } }]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));

  const url = await app.call(`/api/v1/people/records/${recordId}/file`, { token: scoped });
  assert.equal(url.status, 200, JSON.stringify(url.data)); assert.ok(url.data.url.includes('/storage/v1/object/sign/'));
  assert.equal((await app.call(`/api/v1/people/records/${recordId}/file`, { token: app.tokens.editor })).status, 404);
  assert.equal((await app.call(`/api/v1/people/records/${recordId}/file`, { token: app.tokens.reader })).status, 403);
  assert.equal((await app.call(`/api/v1/people/records/${uuid()}/file`)).status, 404);
});

test('accesos · catálogo completo de apps solo para el owner; admin/* montado', async () => {
  const catalog = await app.call('/api/v1/catalog/apps');
  assert.equal(catalog.status, 200, JSON.stringify(catalog.data));
  const ids = catalog.data.items.map((a: any) => a.id);
  for (const id of ['tasks', 'invoices', 'booking', 'food', 'central']) assert.ok(ids.includes(id), id);
  assert.equal((await app.call('/api/v1/catalog/apps', { token: app.tokens.editor })).status, 403);
  assert.equal((await app.call('/api/v1/admin/accounts')).status, 200);
  assert.equal((await app.call('/api/v1/admin/accounts', { token: scoped })).status, 403);
});
