/**
 * Flow · recorridos (migración 0919), sobre PGlite: «Registrar compra» sembrado; ejecuciones en aprender (practicado, sin
 * escribir fuera) y en ejecutar (la capacidad del catálogo por el kit, con la API dueña simulada); proyección para Central.
 * Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
const VERSION = '0f10a000-0000-4000-8000-00000000d101';
const CAP = ['invoices', 'register_purchase_quick'].join('.');
const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
const calls: Array<{ url: string; auth: string | null; body: any }> = [];

test.before(async () => {
  const fetchOwner = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body ?? '{}')) });
    return Response.json({ invoice_id: uuid(), status: 'pendiente_revision', nature: 'fiscal', replayed: false, summary: 'FVR_TEST · Proveedor de prueba · 12,10 €' });
  }) as typeof fetch;
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN,
    createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN], capabilities: { fetch: fetchOwner, apiBaseOf: () => 'https://invoices.example.invalid' } }) });
  // La capacidad en el catálogo (la registra Finance en su PR; aquí, sintética) y el owner como editor de Finance.
  await app.t.db.query(`select core.register_capability($1::jsonb)`, [JSON.stringify({ id: CAP, app: 'invoices', title: 'Registrar compra rápida', route: 'POST purchases/quick',
    roles: ['editor', 'owner'], idempotent: true, input: { type: 'object', properties: { total: { type: 'number' }, vat_rate: { type: 'number' }, date: { type: 'string' } } } })]);
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('invoices', $1, 'editor') on conflict do nothing`, [app.users.owner]);
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[], token = app.tokens.owner) => app.call('/api/v1/commands', { token, body: { requestId: `j-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[], token = app.tokens.owner) { const r = await commit(operations, token); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.results[0].result; }
async function rows(table: string): Promise<any[]> { const s = await app.call(`/api/v1/snapshot?tables=${table}`); return s.data.tables[0].rows; }
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
const code = async (operations: unknown[], token = app.tokens.owner) => (await commit(operations, token)).data.error?.code;

test('recorridos · «Registrar compra» sembrado: una versión publicada con la capacidad de Finance y sus pasos', async () => {
  const v = (await rows(TABLES.definitionVersions)).find((x) => x.id === VERSION);
  assert.equal(v.status, 'published'); assert.equal(v.capability, CAP);
  const steps = (await rows(TABLES.definitionSteps)).filter((s) => s.version_id === VERSION);
  assert.equal(steps.length, 8);
  assert.deepEqual(steps.filter((s) => s.essential).map((s) => s.key).sort(), ['date', 'description', 'supplier.name', 'target', 'total']);
});

test('recorridos · aprender: borrador, revisión y «practicado» (nada fuera); solo quien la hace la toca', async () => {
  const id = uuid();
  await ok([call(PROCEDURES.startExecution, { execution_id: id, version_id: VERSION, mode: 'learn' })], app.tokens.editor);
  await ok([call(PROCEDURES.saveExecutionValues, { execution_id: id, values: { 'supplier.name': 'Proveedor de prueba', total: '12.10' } })], app.tokens.editor);
  assert.equal(await code([call(PROCEDURES.saveExecutionValues, { execution_id: id, values: { total: '1' } })]), 'NOT_FOUND'); // otra persona
  assert.equal(await code([call(PROCEDURES.finishExecution, { execution_id: id, status: 'done' })], app.tokens.editor), 'INVALID_OPERATION');
  const before = calls.length;
  await ok([call(PROCEDURES.finishExecution, { execution_id: id, status: 'practiced' })], app.tokens.editor);
  assert.equal(calls.length, before);
  const e = (await rows(TABLES.executions)).find((x) => x.id === id); // el owner las lee
  assert.equal(e.status, 'practiced'); assert.equal(e.values.total, '12.10');
  assert.equal(await code([call(PROCEDURES.saveExecutionValues, { execution_id: id, values: { total: '2' } })], app.tokens.editor), 'EXECUTION_FINISHED');
  assert.equal(await code([{ op: 'insert', table: TABLES.executions, id: uuid(), fields: { version_id: VERSION, mode: 'run' } }]), 'PROCEDURE_ONLY');
});

test('recorridos · ejecutar: la capacidad del catálogo con el token de la persona y su resultado anotado', async () => {
  const caps = await app.call('/api/v1/capabilities');
  assert.equal(caps.status, 200, JSON.stringify(caps.data));
  assert.equal(caps.data.items.find((c: any) => c.id === CAP)?.allowed, true);
  const id = uuid();
  await ok([call(PROCEDURES.startExecution, { execution_id: id, version_id: VERSION, mode: 'run' })]);
  const body = { requestId: `flow-${id}`, supplier: { name: 'Proveedor de prueba' }, date: '2026-10-31', total: 12.1, description: 'Hielo', target: { app: 'general', kind: 'unassigned' } };
  const res = await app.call(`/api/v1/capabilities/${CAP}/invoke`, { body });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const last = calls.at(-1)!;
  assert.equal(last.url, 'https://invoices.example.invalid/api/v1/purchases/quick');
  assert.equal(last.auth, `Bearer ${app.tokens.owner}`); assert.deepEqual(last.body, body);
  await ok([call(PROCEDURES.finishExecution, { execution_id: id, status: 'done', result: { invoice_id: res.data.result.invoice_id, summary: res.data.result.summary } })]);
  assert.equal((await rows(TABLES.executions)).find((x) => x.id === id).status, 'done');
});

test('recorridos · Central lee en qué recorridos participa cada función (solo owner de Central)', async () => {
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('central', $1, 'owner') on conflict do nothing`, [app.users.owner]);
  const out = (await app.t.db.query<{ out: any }>(`select core.read('central', $1, 'flow.journey_steps_projection', '{"limit": 100}'::jsonb) as out`, [app.users.owner])).rows[0]!.out;
  const mine = out.rows.filter((r: any) => r.flow_name === 'Registrar compra');
  assert.equal(mine.length, 8); assert.ok(mine.every((r: any) => r.app === 'invoices' && r.feature_id === CAP && r.version === 1));
});
