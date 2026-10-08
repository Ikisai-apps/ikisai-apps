/** Central · datos de la entidad: fila única, solo owner, NIF/CIF válido, logotipo y proyección para Booking y Finance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import { ENTITY_PROJECTION, ENTITY_TABLE, normalizeTaxId, taxIdProblem, validateOperations } from '../../supabase/functions/_domain/central/mod.ts';

const uuid = () => crypto.randomUUID();
// Datos ficticios: el repositorio es público y los reales los escribe el owner en la app.
const ENTITY = { legal_name: 'Entidad de Prueba S.L.', tax_id: 'B12345674', address_line: 'Calle Falsa 1', postal_code: '28000', city: 'Madrid' };

let app: TestApp;
let seq = 0;
const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `entity-${++seq}`, operations } });

async function upload(mime: string, text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ticket = await app.call('/api/v1/uploads', { body: { filename: mime === 'application/pdf' ? 'a.pdf' : 'logo.png', mime, size: bytes.byteLength, sha256: sha } });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
  app.supabase.storage.set(ticket.data.path, bytes);
  assert.equal((await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { body: {} })).status, 200);
  return ticket.data.id;
}

test.before(async () => {
  app = await createTestApp({
    app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!,
    createHandler: (config) => createCentralApp({ ...config, origins: [CENTRAL_ORIGINS[0]!] }),
  });
});
test.after(async () => { await app.close(); });

test('entidad · dominio: NIF, NIE y CIF con su control', () => {
  assert.equal(taxIdProblem('12345678Z'), null);
  assert.equal(taxIdProblem('12345678-z'), null);
  assert.match(taxIdProblem('12345678A') ?? '', /letra del NIF/);
  assert.equal(taxIdProblem('X1234567L'), null);
  assert.equal(taxIdProblem('B12345674'), null);
  assert.match(taxIdProblem('B12345675') ?? '', /control del CIF/);
  assert.equal(taxIdProblem('P1234567D'), null); // tipo P: control con letra
  assert.match(taxIdProblem('HOLA') ?? '', /forma/);
  assert.equal(normalizeTaxId(' b-12.345.674 '), 'B12345674');
  assert.equal(validateOperations([{ op: 'insert', table: ENTITY_TABLE, id: 'x', fields: { ...ENTITY, logo_file_id: { $blob: 'a'.repeat(64) } } }], { role: 'owner' }), null);
  assert.equal(validateOperations([{ op: 'insert', table: ENTITY_TABLE, id: 'x', fields: ENTITY }], { role: 'editor' })?.code, 'FORBIDDEN');
  assert.equal(validateOperations([{ op: 'insert', table: ENTITY_TABLE, id: 'x', fields: { ...ENTITY, website: 'http://x' } }], { role: 'owner' })?.details.field, 'website');
});

test('entidad · solo el owner la escribe; una sola viva; NIF/CIF comprobado', async () => {
  assert.equal((await commit([{ op: 'insert', table: ENTITY_TABLE, id: uuid(), fields: ENTITY }], app.tokens.editor)).status, 403);
  const bad = await commit([{ op: 'insert', table: ENTITY_TABLE, id: uuid(), fields: { ...ENTITY, tax_id: 'B12345675' } }]);
  assert.equal(bad.status, 422); assert.equal(bad.data.error.details.field, 'tax_id');
  const id = uuid();
  const ok = await commit([{ op: 'insert', table: ENTITY_TABLE, id, fields: ENTITY }]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data.changes[0].after.country, 'ES');
  const second = await commit([{ op: 'insert', table: ENTITY_TABLE, id: uuid(), fields: ENTITY }]);
  assert.equal(second.status, 422); assert.equal(second.data.error.code, 'CONSTRAINT_VIOLATION');
  const snap = await app.call(`/api/v1/snapshot?tables=${ENTITY_TABLE}`, { token: app.tokens.reader });
  assert.equal(snap.data.tables[0].rows[0].legal_name, ENTITY.legal_name);
});

test('entidad · logotipo: imagen verificada; un PDF no vale', async () => {
  const [row] = (await app.call(`/api/v1/snapshot?tables=${ENTITY_TABLE}`)).data.tables[0].rows;
  const pdf = await upload('application/pdf', '%PDF-1.4 no es un logo');
  const rejected = await commit([{ op: 'update', table: ENTITY_TABLE, id: row.id, expectedRevision: row.revision, fields: { logo_file_id: pdf } }]);
  assert.equal(rejected.status, 422); assert.equal(rejected.data.error.code, 'INVALID_FILE');
  const logo = await upload('image/png', 'PNG de prueba');
  const ok = await commit([{ op: 'update', table: ENTITY_TABLE, id: row.id, expectedRevision: row.revision, fields: { logo_file_id: logo } }]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
});

test('entidad · proyección de solo lectura para Booking y Finance, con el logotipo para firmar', async () => {
  for (const reader of ['booking', 'invoices']) {
    const user = await app.t.createUser();
    await app.t.db.query(`insert into core.memberships (app, user_id, role) values ($1, $2, 'reader')`, [reader, user]);
    const out = await app.t.rpc('core_read', { p_app: reader, p_actor: user, p_name: ENTITY_PROJECTION, p_args: {} }) as { rows: any[] };
    assert.equal(out.rows.length, 1, reader);
    const e = out.rows[0];
    assert.equal(e.legal_name, ENTITY.legal_name); assert.equal(e.tax_id, ENTITY.tax_id);
    assert.equal(e.logo_bucket, 'central-documents'); assert.equal(e.logo_mime, 'image/png'); assert.ok(e.logo_path);
    assert.equal(e.logo_provider, 'supabase');
    assert.ok(e.entity_revision >= 2);
  }
  // Una app sin permiso registrado no la lee.
  const foodUser = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('food', $1, 'reader')`, [foodUser]);
  await assert.rejects(app.t.rpc('core_read', { p_app: 'food', p_actor: foodUser, p_name: ENTITY_PROJECTION, p_args: {} }));
});

test('archivos · Central declara sus campos de archivo con su retención y activa la recogida de huérfanos', async () => {
  const fields = (await app.t.db.query<{ col: string; retention: string }>(
    `select table_name || '.' || column_name as col, retention from core.file_fields where app = 'central' order by 1`)).rows;
  assert.deepEqual(fields.map((f) => [f.col, f.retention]), [
    ['entity.logo_file_id', 'permanent'], ['key_documents.file_id', 'legal'], ['person_records.file_id', 'legal'],
  ]);
  const gc = await app.t.db.query(`select 1 from core.file_gc_apps where app = 'central'`);
  assert.equal(gc.rows.length, 1);
});

test('entidad · IBAN y Bizum (F3): dígito de control, formato, proyección y las instrucciones de pago', async () => {
  const { ibanProblem, formatIban, renderMarkers } = await import('../../supabase/functions/_domain/central/mod.ts');
  const IBAN = 'ES9121000418450200051332'; // IBAN de ejemplo con el control correcto, no una cuenta real de Ikisai
  assert.equal(ibanProblem(IBAN), null);
  assert.equal(ibanProblem('es91 2100 0418 4502 0005 1332'), null);
  assert.match(ibanProblem('ES9121000418450200051333') ?? '', /control/);
  assert.match(ibanProblem('ES912100041845') ?? '', /24 caracteres|forma/);
  assert.equal(formatIban(IBAN), 'ES91 2100 0418 4502 0005 1332');
  assert.equal(renderMarkers('{{entidad.iban}} · {{entidad.bizum}}', { entity: { iban: IBAN, bizum: '600 000 000' } }), 'ES91 2100 0418 4502 0005 1332 · 600 000 000');
  assert.equal(renderMarkers('{{entidad.iban}}', {}), '—');

  const [row] = (await app.call(`/api/v1/snapshot?tables=${ENTITY_TABLE}`)).data.tables[0].rows;
  const bad = await commit([{ op: 'update', table: ENTITY_TABLE, id: row.id, expectedRevision: row.revision, fields: { iban: 'ES9121000418450200051333' } }]);
  assert.equal(bad.status, 422); assert.equal(bad.data.error.details.field, 'iban');
  const spaced = await commit([{ op: 'update', table: ENTITY_TABLE, id: row.id, expectedRevision: row.revision, fields: { iban: 'ES91 2100 0418 4502 0005 1332' } }]);
  assert.equal(spaced.data.error.details.field, 'iban'); // se guarda sin espacios: la app lo normaliza antes
  const ok = await commit([{ op: 'update', table: ENTITY_TABLE, id: row.id, expectedRevision: row.revision, fields: { iban: IBAN, bizum: '600 000 000' } }]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await commit([{ op: 'update', table: ENTITY_TABLE, id: row.id, expectedRevision: row.revision + 1, fields: { bizum: 'abc' } }])).data.error.details.field, 'bizum');

  const projection = (await app.t.db.query<{ iban: string; bizum: string }>(`select iban, bizum from central.common_entity_projection`)).rows[0]!;
  assert.deepEqual(projection, { iban: IBAN, bizum: '600 000 000' });

  // El texto de pago, en los dos idiomas, con la cuenta en grupos de cuatro.
  assert.equal((await app.t.db.query<{ n: number }>(`select central.seed_texts_payment() as n`)).rows[0]!.n, 2);
  assert.equal((await app.t.db.query<{ n: number }>(`select central.seed_texts_payment() as n`)).rows[0]!.n, 0);
  const texts = (await app.t.db.query<{ lang: string; body: string; kind: string }>(`select lang, body, kind from central.common_texts_projection where key = 'payment.instructions' order by lang desc`)).rows;
  assert.deepEqual(texts.map((t) => [t.lang, t.kind]), [['es', 'mensaje'], ['en', 'mensaje']]);
  assert.match(texts[0]!.body, /cuenta ES91 2100 0418 4502 0005 1332, a nombre de Entidad de Prueba S\.L\./);
  assert.match(texts[0]!.body, /Bizum\*\* al 600 000 000/);
  assert.match(texts[1]!.body, /account ES91 2100 0418 4502 0005 1332/);
});
