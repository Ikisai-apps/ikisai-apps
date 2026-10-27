/**
 * Flow · versiones de flujo (migración 0906, decisión de VG del 27-10). La barra actual es «Barra · v1», congelada: el
 * resto de tests/flow es su regresión fija. Aquí: lo congelado no cambia de configuración, «Nueva versión» copia la
 * configuración y nada del servicio, y la carta pública sigue en quien la atiende.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
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

const commit = (operations: unknown[], token = app.tokens.owner) => app.call('/api/v1/commands', { token, body: { requestId: `v-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[], token = app.tokens.owner) { const r = await commit(operations, token); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; }
async function rows(table: string): Promise<any[]> { const s = await app.call(`/api/v1/snapshot?tables=${table}`); return s.data.tables[0].rows; }
const row = async (table: string, id: string) => (await rows(table)).find((r) => r.id === id);
const code = (r: { data: any }) => r.data?.error?.code;
let v2 = '';

test('versiones · la barra es «Barra · v1», congelada y atendiendo la carta pública', async () => {
  const v1 = await row(TABLES.projects, V1);
  assert.equal(v1.name, 'Barra · v1'); assert.equal(v1.template_key, 'barra'); assert.equal(v1.template_version, 1);
  assert.equal(v1.frozen, true); assert.equal(v1.serves_public, true);
});

test('versiones · congelada: ni columnas ni plantilla cambian, ni siquiera el owner; los datos (nombre, modo pruebas) sí', async () => {
  const col = (await rows(TABLES.columns)).find((c) => c.project_id === V1 && c.key === 'prep');
  assert.equal(code(await commit([{ op: 'update', table: TABLES.columns, id: col.id, expectedRevision: col.revision, fields: { label: 'Cocina' } }])), 'FLOW_FROZEN');
  assert.equal(code(await commit([{ op: 'insert', table: TABLES.columns, id: uuid(), fields: { project_id: V1, key: 'extra', label: 'Extra', behavior: 'free_task', position: 9 } }])), 'FLOW_FROZEN');
  const v1 = await row(TABLES.projects, V1);
  assert.equal(code(await commit([{ op: 'update', table: TABLES.projects, id: V1, expectedRevision: v1.revision, fields: { frozen: false } }])), 'FLOW_FROZEN');
  await ok([{ op: 'update', table: TABLES.projects, id: V1, expectedRevision: v1.revision, fields: { notes: 'congelada para el sábado' } }]);
});

test('versiones · «Nueva versión» (solo owner) copia la configuración y nada del servicio; nace en pruebas y sin carta pública', async () => {
  // Algo de servicio en la v1, que no debe copiarse.
  const order = uuid();
  await ok([{ op: 'insert', table: TABLES.orders, id: order, fields: { project_id: V1, origin: 'counter' } },
    { op: 'insert', table: TABLES.orderLines, id: uuid(), fields: { order_id: order, product_id: '0f10a000-0000-4000-8000-000000000101', quantity: 1 } }]);
  assert.equal((await commit([{ op: 'call', procedure: PROCEDURES.newVersion, args: { source_project_id: V1, project_id: uuid() } }], app.tokens.editor)).status, 403);
  v2 = uuid();
  const out = (await ok([{ op: 'call', procedure: PROCEDURES.newVersion, args: { source_project_id: V1, project_id: v2 } }])).results[0].result;
  assert.equal(out.name, 'Barra · v2'); assert.equal(out.template_version, 2);
  const p2 = await row(TABLES.projects, v2);
  assert.equal(p2.frozen, false); assert.equal(p2.test_mode, true); assert.equal(p2.serves_public, false); assert.equal(p2.template_key, 'barra');
  const cols1 = (await rows(TABLES.columns)).filter((c) => c.project_id === V1).sort((a, b) => a.position - b.position);
  const cols2 = (await rows(TABLES.columns)).filter((c) => c.project_id === v2).sort((a, b) => a.position - b.position);
  assert.deepEqual(cols2.map((c) => [c.key, c.label, c.behavior]), cols1.map((c) => [c.key, c.label, c.behavior]));
  // La config se copia; los ajustes de plantilla de la v2 (0909: fresh_stock en Ingredientes) se suman encima.
  for (const c of cols2) {
    const base = cols1.find((x) => x.key === c.key).config;
    assert.deepEqual(c.config, c.key === 'ingredients' ? { ...base, fresh_stock: true } : base);
  }
  const prods2 = (await rows(TABLES.products)).filter((p) => p.project_id === v2);
  assert.equal(prods2.length, (await rows(TABLES.products)).filter((p) => p.project_id === V1).length);
  assert.ok(prods2.some((p) => p.image_key === 'montaditos/serrano'));
  assert.ok((await rows(TABLES.productComponents)).some((c) => c.project_id === v2));
  assert.equal((await rows(TABLES.orders)).filter((o) => o.project_id === v2).length, 0);
  // La v2 sí se configura.
  const c2 = cols2.find((c) => c.key === 'prep');
  await ok([{ op: 'update', table: TABLES.columns, id: c2.id, expectedRevision: c2.revision, fields: { label: 'Cocina' } }]);
  // La siguiente es la v3.
  const v3 = (await ok([{ op: 'call', procedure: PROCEDURES.newVersion, args: { source_project_id: v2, project_id: uuid() } }])).results[0].result;
  assert.equal(v3.name, 'Barra · v3');
});

test('versiones · la carta pública sigue en la v1 hasta que el owner la pase a otra (una sola la atiende)', async () => {
  let menu = await app.call('/api/v1/public/menu', { token: null });
  assert.equal(menu.data.project, 'Barra · v1');
  const v1 = await row(TABLES.projects, V1);
  const p2 = await row(TABLES.projects, v2);
  // Dos a la vez no: el índice lo impide.
  assert.equal(code(await commit([{ op: 'update', table: TABLES.projects, id: v2, expectedRevision: p2.revision, fields: { serves_public: true } }])), 'CONSTRAINT_VIOLATION');
  await ok([{ op: 'update', table: TABLES.projects, id: V1, expectedRevision: v1.revision, fields: { serves_public: false } },
    { op: 'update', table: TABLES.projects, id: v2, expectedRevision: p2.revision, fields: { serves_public: true } }]);
  menu = await app.call('/api/v1/public/menu', { token: null });
  assert.equal(menu.data.project, 'Barra · v2');
  assert.ok(menu.data.products.every((p: any) => p.id !== '0f10a000-0000-4000-8000-000000000101'));
});
