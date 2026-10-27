/**
 * Flow · editor de flujos (migración 0914), sobre PGlite: piezas con su comportamiento y opciones, create_flow desde
 * plantilla o desde columnas, la plantilla `barra` v1 sembrada desde «Barra · v1», save_template y edición de columnas
 * de un flujo no congelado. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { PIECES, PROCEDURES, TABLES } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
const V1 = '0f10a000-0000-4000-8000-000000000001';
const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
let custom = '';

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[], token = app.tokens.owner) => app.call('/api/v1/commands', { token, body: { requestId: `e-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[], token = app.tokens.owner) { const r = await commit(operations, token); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.results[0].result; }
async function rows(table: string): Promise<any[]> { const s = await app.call(`/api/v1/snapshot?tables=${table}`); return s.data.tables[0].rows; }
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
const code = async (operations: unknown[], token = app.tokens.owner) => (await commit(operations, token)).data.error?.code;
const colsOf = async (project: string) => (await rows(TABLES.columns)).filter((c) => c.project_id === project && !c.deleted_at).sort((a, b) => a.position - b.position);

test('editor · las piezas del dominio coinciden con las de la base (comportamiento y opciones)', async () => {
  for (const p of PIECES) {
    const r = await app.t.db.query<{ b: string }>(`select flow.piece_behavior($1) as b`, [p.key]);
    assert.equal(r.rows[0]!.b, p.behavior, p.key);
    for (const o of p.options ?? []) {
      const c = await app.t.db.query<{ c: any }>(`select flow.piece_config($1, $2::jsonb) as c`, [p.key, JSON.stringify({ [o.key]: true })]);
      assert.equal(c.rows[0]!.c[o.key], true, `${p.key}.${o.key}`);
    }
  }
});

test('editor · la plantilla barra v1 tiene las columnas de «Barra · v1»', async () => {
  const t = (await rows(TABLES.templateColumns)).filter((x) => x.template_key === 'barra' && x.version === 1).sort((a, b) => a.position - b.position);
  assert.deepEqual(t.map((x) => x.key), (await colsOf(V1)).map((c) => c.key));
});

test('editor · nuevo flujo con columnas elegidas: piezas conocidas, una vez cada una, opciones válidas; solo owner', async () => {
  const columns = [{ key: 'order', label: 'Caja', options: { accounts: true } }, { key: 'prep', label: 'Cocina' }, { key: 'service', label: 'Entrega', options: { complete_on_delivery: true } }];
  assert.equal((await commit([call(PROCEDURES.createFlow, { project_id: uuid(), columns })], app.tokens.editor)).status, 403);
  assert.equal(await code([call(PROCEDURES.createFlow, { project_id: uuid(), columns: [{ key: 'bar' }] })]), 'INVALID_OPERATION');
  assert.equal(await code([call(PROCEDURES.createFlow, { project_id: uuid(), columns: [{ key: 'prep' }, { key: 'prep' }] })]), 'INVALID_OPERATION');
  assert.equal(await code([call(PROCEDURES.createFlow, { project_id: uuid(), columns: [{ key: 'prep', options: { accounts: true } }] })]), 'INVALID_OPERATION');
  assert.equal(await code([call(PROCEDURES.createFlow, { project_id: uuid() })]), 'INVALID_OPERATION');
  custom = uuid();
  const out = await ok([call(PROCEDURES.createFlow, { project_id: custom, name: 'Terraza', columns })]);
  assert.equal(out.name, 'Terraza'); assert.equal(out.template_key, null);
  const cols = await colsOf(custom);
  assert.deepEqual(cols.map((c) => [c.key, c.label, c.behavior, c.position]), [['order', 'Caja', 'inspect_confirm', 1], ['prep', 'Cocina', 'quick_steps', 2], ['service', 'Entrega', 'inspect_confirm', 3]]);
  assert.equal(cols[0].config.accounts, true); assert.equal(cols[2].config.complete_on_delivery, true);
});

test('editor · guardar como plantilla y reconstruir el flujo desde ella', async () => {
  assert.equal((await commit([call(PROCEDURES.saveTemplate, { project_id: custom, template_key: 'terraza', label_base: 'Terraza' })], app.tokens.editor)).status, 403);
  const saved = await ok([call(PROCEDURES.saveTemplate, { project_id: custom, template_key: 'terraza', label_base: 'Terraza' })]);
  assert.equal(saved.version, 1); assert.equal(saved.columns, 3);
  const again = uuid();
  const out = await ok([call(PROCEDURES.createFlow, { project_id: again, template_key: 'terraza' })]);
  assert.equal(out.name, 'Terraza · v1'); assert.equal(out.template_version, 1);
  const strip = (cs: any[]) => cs.map((c) => [c.key, c.label, c.behavior, c.position, c.config]);
  assert.deepEqual(strip(await colsOf(again)), strip(await colsOf(custom)));
  // Otra vez la misma plantilla sin evento: la versión siguiente.
  assert.equal((await ok([call(PROCEDURES.createFlow, { project_id: uuid(), template_key: 'terraza' })])).template_version, 2);
});

test('editor · las columnas de un flujo no congelado se editan; las de la v1 congelada, no', async () => {
  const [first] = await colsOf(custom);
  await ok([{ op: 'update', table: TABLES.columns, id: first.id, expectedRevision: first.revision, fields: { label: 'Caja y cuentas', position: 4 } }]);
  assert.equal((await colsOf(custom)).find((c) => c.id === first.id).label, 'Caja y cuentas');
  const [v1col] = await colsOf(V1);
  assert.equal(await code([{ op: 'update', table: TABLES.columns, id: v1col.id, expectedRevision: v1col.revision, fields: { label: 'Otro' } }]), 'FLOW_FROZEN');
});
