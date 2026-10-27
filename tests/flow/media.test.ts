/**
 * Flow · documentos y portada del flujo subidos desde la app (migración 0907, orden de VG del 27-10), sobre PGlite con el
 * almacenamiento simulado del test-kit: subida por el kit (ticket, PUT, verificación), comprobación del archivo en
 * flow-api, solo el owner gestiona, «Nueva versión» copia documentos y portada, y la lectura de proyectos para Central.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
const V1 = '0f10a000-0000-4000-8000-000000000001';
const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
  await app.t.db.query(`update core.memberships set scopes = $1::jsonb where app = 'flow' and role in ('editor','reader')`, [JSON.stringify({ projects: [V1] })]);
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[], token = app.tokens.owner) => app.call('/api/v1/commands', { token, body: { requestId: `m-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[], token = app.tokens.owner) { const r = await commit(operations, token); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; }
async function rows(table: string): Promise<any[]> { const s = await app.call(`/api/v1/snapshot?tables=${table}`); return s.data.tables[0].rows; }
const row = async (table: string, id: string) => (await rows(table)).find((r) => r.id === id);
const code = (r: { data: any }) => r.data?.error?.code;

/** Sube un archivo como lo hace el sync-client: ticket, PUT al bucket (simulado) y verificación. */
async function upload(mime: string, filename: string, verify = true): Promise<string> {
  const bytes = new TextEncoder().encode(mime === 'application/pdf' ? `%PDF-1.4 ${uuid()}` : `RIFF....WEBPVP8 ${uuid()}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ticket = await app.call('/api/v1/uploads', { body: { filename, mime, size: bytes.byteLength, sha256 } });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
  app.supabase.storage.set(ticket.data.path, bytes);
  if (verify) assert.equal((await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { body: {} })).status, 200);
  return ticket.data.id;
}

test('media · documento PDF e imagen, y portada imagen; el archivo tiene que estar verificado y ser del tipo que toca', async () => {
  const pdf = await upload('application/pdf', 'protocolo.pdf');
  const img = await upload('image/webp', 'mesa.webp');
  const pending = await upload('image/webp', 'a-medias.webp', false);
  await ok([{ op: 'insert', table: TABLES.projectDocuments, id: uuid(), fields: { project_id: V1, file_id: pdf, title: 'Protocolo', mime: 'application/pdf', position: 1 } },
    { op: 'insert', table: TABLES.projectDocuments, id: uuid(), fields: { project_id: V1, file_id: img, title: 'Mesa', mime: 'image/webp', position: 2 } }]);
  assert.equal(code(await commit([{ op: 'insert', table: TABLES.projectDocuments, id: uuid(), fields: { project_id: V1, file_id: pending, title: 'x', position: 3 } }])), 'INVALID_FILE');
  assert.equal(code(await commit([{ op: 'insert', table: TABLES.projectDocuments, id: uuid(), fields: { project_id: V1, file_id: uuid(), title: 'x', position: 3 } }])), 'INVALID_FILE');
  const v1 = await row(TABLES.projects, V1);
  // Portada: un PDF no vale; una imagen, sí (también en la v1 congelada: es dato, no configuración).
  assert.equal(code(await commit([{ op: 'update', table: TABLES.projects, id: V1, expectedRevision: v1.revision, fields: { cover_file_id: pdf } }])), 'INVALID_FILE');
  await ok([{ op: 'update', table: TABLES.projects, id: V1, expectedRevision: v1.revision, fields: { cover_file_id: img } }]);
  // La URL de lectura se pide por el kit.
  const url = await app.call(`/api/v1/files/${img}`);
  assert.equal(url.status, 200); assert.ok(url.data.url);
});

test('media · solo el owner gestiona documentos; el resto los ve', async () => {
  const img = await upload('image/png', 'otra.png');
  assert.equal((await commit([{ op: 'insert', table: TABLES.projectDocuments, id: uuid(), fields: { project_id: V1, file_id: img, title: 'x', position: 9 } }], app.tokens.editor)).status, 403);
  const seen = await app.call(`/api/v1/snapshot?tables=${TABLES.projectDocuments}`, { token: app.tokens.reader });
  assert.equal(seen.data.tables[0].rows.length, 2);
});

test('media · «Nueva versión» copia documentos (los mismos archivos) y portada', async () => {
  const v2 = uuid();
  await ok([{ op: 'call', procedure: PROCEDURES.newVersion, args: { source_project_id: V1, project_id: v2 } }]);
  const p2 = await row(TABLES.projects, v2);
  assert.equal(p2.cover_file_id, (await row(TABLES.projects, V1)).cover_file_id);
  const docs = (await rows(TABLES.projectDocuments)).filter((d) => d.project_id === v2).sort((a, b) => a.position - b.position);
  assert.deepEqual(docs.map((d) => d.title), ['Protocolo', 'Mesa']);
  assert.equal(docs[0].mime, 'application/pdf');
});

test('media · Central lee los proyectos de Flow (solo su owner) para dar accesos por proyecto', async () => {
  const view = await app.t.db.query<{ id: string; name: string }>(`select * from flow.projects_projection order by name`);
  assert.ok(view.rows.some((r) => r.id === V1));
  const reads = await app.t.db.query<{ roles: string[] }>(`select roles from core.allowed_reads where app = 'central' and name = 'flow.projects_projection'`);
  assert.deepEqual(reads.rows[0]!.roles, ['owner']);
});
