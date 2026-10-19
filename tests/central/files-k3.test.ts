/**
 * Central · K3 para miembros (`uploads.membersK3`, núcleo #585; encargo aprobado por el usuario el 19-10-2026). Conocer el id
 * de un archivo no basta: `GET files/:id` firma un archivo ajeno solo si quien pide ve (hook `visible`) una fila viva que lo
 * referencia. La documentación de personas, solo el owner y el editor con `scopes.people`; la entidad y los documentos
 * clave, todos los miembros, como en la interfaz. Lo propio y el owner, siempre. Datos ficticios.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, CENTRAL_UPLOADS, FILE_FIELDS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import { COMPLIANCE_TABLES, ENTITY_TABLE, TABLES } from '../../supabase/functions/_domain/central/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let scoped: string; // editor con scopes.people
let seq = 0;
const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `k3-${++seq}`, operations } });
const read = async (id: string, token: string) => (await app.call(`/api/v1/files/${id}`, { token })).status;

async function upload(mime: string, text: string, token = app.tokens.owner): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ticket = await app.call('/api/v1/uploads', { token, body: { filename: mime === 'application/pdf' ? 'a.pdf' : 'a.png', mime, size: bytes.byteLength, sha256: sha } });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
  app.supabase.storage.set(ticket.data.path, bytes);
  assert.equal((await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { token, body: {} })).status, 200);
  return ticket.data.id;
}

test.before(async () => {
  app = await createTestApp({ app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!, createHandler: (c) => createCentralApp({ ...c, origins: [CENTRAL_ORIGINS[0]!] }) });
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('central', $1, 'editor', '{"people": true}'::jsonb)`, [user]);
  scoped = app.supabase.tokenFor(user);
});
test.after(async () => { await app.close(); });

test('k3 · Central lo activa, y todas sus columnas de archivo están en core.register_file_field', async () => {
  assert.equal(CENTRAL_UPLOADS.membersK3, true);
  const registered = (await app.t.db.query<{ col: string }>(`select schema_name || '.' || table_name || '.' || column_name as col from core.file_fields where app = 'central' order by 1`)).rows.map((r) => r.col);
  // Las que valida la API al guardar.
  const validated = Object.entries(FILE_FIELDS).flatMap(([table, specs]) => specs.map((s) => `${table}.${s.field}`)).sort();
  assert.deepEqual(validated, registered);
  // Y ninguna columna del schema central que guarde un archivo se ha quedado fuera (ni en JSON ni en texto).
  const columns = (await app.t.db.query<{ col: string }>(`select c.table_schema || '.' || c.table_name || '.' || c.column_name as col
      from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
     where c.table_schema = 'central' and (c.column_name like '%file%' or c.column_name like '%attachment%' or c.column_name like '%photo%' or c.column_name like '%logo%')
     order by 1`)).rows.map((r) => r.col);
  assert.deepEqual(columns, registered);
});

test('k3 · documentación de personas: solo quien ve los datos reservados; entidad y documentos clave, todos los miembros', async () => {
  const personId = uuid();
  assert.equal((await commit([{ op: 'insert', table: TABLES.people, id: personId, fields: { display_name: 'Persona Ficticia', relation: 'equipo' } }])).status, 200);
  const certificate = await upload('application/pdf', '%PDF-1.4 certificado ficticio');
  const recordId = uuid();
  const rec = await commit([{ op: 'insert', table: TABLES.personRecords, id: recordId, fields: { person_id: personId, kind: 'documento', record_type: 'prl_basico', file_id: certificate } }]);
  assert.equal(rec.status, 200, JSON.stringify(rec.data));
  const logo = await upload('image/png', 'PNG ficticio');
  const entity = await commit([{ op: 'insert', table: ENTITY_TABLE, id: uuid(), fields: {
    legal_name: 'Entidad de Prueba S.L.', tax_id: 'B12345674', address_line: 'Calle Falsa 1', postal_code: '28000', city: 'Madrid', logo_file_id: logo } }]);
  assert.equal(entity.status, 200, JSON.stringify(entity.data));
  const policy = await upload('application/pdf', '%PDF-1.4 póliza ficticia');
  const doc = await commit([{ op: 'insert', table: COMPLIANCE_TABLES.keyDocuments, id: uuid(), fields: { document_type: 'poliza', name: 'Póliza ficticia', file_id: policy } }]);
  assert.equal(doc.status, 200, JSON.stringify(doc.data));
  const orphan = await upload('application/pdf', '%PDF-1.4 sin fila');

  // Hoy cualquier miembro con el id lo leía; ahora, el lector y el editor sin `people` no leen la documentación de personas.
  assert.equal(await read(certificate, app.tokens.reader), 404, 'lector: documentación de personas');
  assert.equal(await read(certificate, app.tokens.editor), 404, 'editor sin people: documentación de personas');
  assert.equal(await read(certificate, scoped), 200, 'editor con people');
  assert.equal(await read(certificate, app.tokens.owner), 200, 'owner');
  // La ruta de la ficha sigue igual.
  assert.equal((await app.call(`/api/v1/people/records/${recordId}/file`, { token: scoped })).status, 200);
  // El logotipo y los documentos clave los ve todo miembro en la interfaz: los siguen leyendo.
  for (const token of [app.tokens.reader, app.tokens.editor, scoped]) {
    assert.equal(await read(logo, token), 200, 'logotipo');
    assert.equal(await read(policy, token), 200, 'documento clave');
  }
  // Un archivo ajeno que ninguna fila referencia: solo el owner (y quien lo subió).
  for (const token of [app.tokens.reader, app.tokens.editor, scoped]) assert.equal(await read(orphan, token), 404, 'huérfano ajeno');
  assert.equal(await read(orphan, app.tokens.owner), 200);
  // Lo propio, siempre: lo que sube el editor antes de guardar la fila.
  const mine = await upload('image/png', 'PNG propio', app.tokens.editor);
  assert.equal(await read(mine, app.tokens.editor), 200, 'lo suyo');
});

test('k3 · papelera: el adjunto de una fila borrada solo lo leen quien lo subió y el owner; al restaurarla, como antes', async () => {
  const policy = await upload('application/pdf', '%PDF-1.4 en la papelera');
  const id = uuid();
  const created = await commit([{ op: 'insert', table: COMPLIANCE_TABLES.keyDocuments, id, fields: { document_type: 'acta', name: 'Acta ficticia', file_id: policy } }]);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const del = await commit([{ op: 'delete', table: COMPLIANCE_TABLES.keyDocuments, id, expectedRevision: created.data.changes[0].after.revision }]);
  assert.equal(del.status, 200, JSON.stringify(del.data));
  assert.equal(await read(policy, app.tokens.editor), 404, 'editor: en la papelera');
  assert.equal(await read(policy, app.tokens.owner), 200, 'owner: en la papelera');
  const res = await commit([{ op: 'restore', table: COMPLIANCE_TABLES.keyDocuments, id, expectedRevision: del.data.changes[0].after.revision }]);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(await read(policy, app.tokens.editor), 200, 'editor: restaurado');
});
