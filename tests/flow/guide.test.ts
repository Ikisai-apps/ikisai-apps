/**
 * Flow · Guiado (flow-23, migración 0940), sobre PGlite: `guide-read` da los pasos de una app y los propios de Flow, solo a
 * quien hace la ejecución; `guide-confirm` deja recibo sin valores, idempotente; `done` sale de la confirmación de la app o
 * del valor en el tramo (pasos propios). Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
const DEF = uuid(), VER = uuid(), S1 = uuid(), S2 = uuid(), STEP_BOOKING = uuid(), STEP_FLOW = uuid(), STEP_FOOD = uuid();
let execution = '';

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
  const r = await commit([
    ins(TABLES.definitions, DEF, { key: 'alojar_a_alguien', name: 'Alojar a alguien' }),
    ins(TABLES.definitionVersions, VER, { definition_id: DEF, version: 1, status: 'draft' }),
    ins(TABLES.definitionStages, S1, { version_id: VER, position: 1, kind: 'record', title: 'En la ficha' }),
    ins(TABLES.definitionStages, S2, { version_id: VER, position: 2, kind: 'record', title: 'Nota para la barra' }),
    ins(TABLES.definitionSteps, STEP_BOOKING, { version_id: VER, stage_id: S1, position: 1, key: 'llegada', title: 'Pon la hora de llegada', anchor: 'booking.ficha.check_in', input_type: 'text', essential: true }),
    ins(TABLES.definitionSteps, STEP_FOOD, { version_id: VER, stage_id: S1, position: 2, key: 'dieta', title: 'Revisa la dieta', anchor: 'food.alergias.lista', input_type: 'text', essential: false }),
    ins(TABLES.definitionSteps, STEP_FLOW, { version_id: VER, stage_id: S2, position: 1, key: 'nota', title: '¿Algo para la barra?', input_type: 'text', essential: false }),
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await commit([call(PROCEDURES.publishVersion, { version_id: VER })])).status, 200);
  execution = uuid();
  assert.equal((await commit([call(PROCEDURES.startExecution, { execution_id: execution, version_id: VER, mode: 'run' })], app.tokens.editor)).status, 200);
});
test.after(async () => { await app.close(); });

function commit(operations: unknown[], token = app.tokens.owner) { return app.call('/api/v1/commands', { token, body: { requestId: `g-${++seq}-${uuid()}`, operations } }); }
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
const ins = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const read = (body: Record<string, unknown>, token = app.tokens.editor) => app.call('/api/v1/guide-read', { token, body });
const confirm = (body: Record<string, unknown>, token = app.tokens.editor) => app.call('/api/v1/guide-confirm', { token, body });

test('guiado · guide-read: los pasos de esa app y los propios de Flow; no los de otras apps; solo quien la hace', async () => {
  const r = await read({ execution_id: execution, app: 'booking' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.title, 'Alojar a alguien'); assert.equal(r.data.mode, 'run');
  assert.deepEqual(r.data.steps.map((s: any) => s.id).sort(), [STEP_BOOKING, STEP_FLOW].sort());
  const b = r.data.steps.find((s: any) => s.id === STEP_BOOKING);
  assert.equal(b.anchor, 'booking.ficha.check_in'); assert.equal(b.done, false); assert.equal(b.essential, true);
  assert.ok(['save', 'event', 'manual', 'none'].includes(b.confirm));
  assert.equal(r.data.steps.find((s: any) => s.id === STEP_FLOW).confirm, 'manual');
  assert.equal((await read({ execution_id: execution, app: 'booking' }, app.tokens.owner)).status, 404); // otra persona
  assert.equal((await read({ execution_id: execution, app: 'Booking!' })).status, 422);
});

test('guiado · guide-confirm deja recibo (sin valores), idempotente; con él el paso queda hecho', async () => {
  const body = { requestId: `guia-${execution}-1`, execution_id: execution, step_id: STEP_BOOKING, how: 'save', pending: false };
  const first = await confirm(body);
  assert.equal(first.status, 200, JSON.stringify(first.data)); assert.equal(first.data.ok, true);
  const again = await confirm(body);
  assert.equal(again.data.replayed, true);
  const rows = (await app.t.db.query<any>(`select * from flow.guide_receipts where execution_id = $1`, [execution])).rows;
  assert.equal(rows.length, 1); assert.deepEqual(Object.keys(rows[0]).filter((k) => /value/.test(k)), []);
  assert.equal((await read({ execution_id: execution, app: 'booking' })).data.steps.find((s: any) => s.id === STEP_BOOKING).done, true);
  // «Pendiente» no cuenta como hecho; ni otra persona confirma; ni un «cómo» inventado.
  await confirm({ ...body, requestId: `guia-${execution}-food`, step_id: STEP_FOOD, pending: true });
  assert.equal((await read({ execution_id: execution, app: 'food' })).data.steps.find((s: any) => s.id === STEP_FOOD).done, false);
  assert.notEqual((await confirm({ ...body, requestId: 'ajena' }, app.tokens.owner)).status, 200);
  assert.notEqual((await confirm({ ...body, requestId: 'como', how: 'magia' })).status, 200);
});

test('guiado · un paso propio de Flow queda hecho con su valor en el tramo; un ensayo no confirma nada', async () => {
  await commit([call(PROCEDURES.startStage, { execution_id: execution, position: 1 })], app.tokens.editor);
  await commit([call(PROCEDURES.finishStage, { execution_id: execution, position: 1, status: 'done' })], app.tokens.editor);
  await commit([call(PROCEDURES.startStage, { execution_id: execution, position: 2 })], app.tokens.editor);
  await commit([call(PROCEDURES.saveStageValues, { execution_id: execution, position: 2, values: { nota: 'Sin gluten' } })], app.tokens.editor);
  assert.equal((await read({ execution_id: execution, app: 'booking' })).data.steps.find((s: any) => s.id === STEP_FLOW).done, true);
  const learn = uuid();
  await commit([call(PROCEDURES.startExecution, { execution_id: learn, version_id: VER, mode: 'learn' })], app.tokens.editor);
  assert.notEqual((await confirm({ requestId: 'ensayo', execution_id: learn, step_id: STEP_BOOKING, how: 'save' })).status, 200);
});

test('guiado · un tramo «ir a otra app» se cierra cuando la app destino lo confirma, no al abrir el enlace', async () => {
  const D = uuid(), V = uuid(), H = uuid(), STEP = uuid();
  assert.equal((await commit([
    ins(TABLES.definitions, D, { key: 'pedir_en_tasks', name: 'Pedir en Tasks' }),
    ins(TABLES.definitionVersions, V, { definition_id: D, version: 1, status: 'draft' }),
    ins(TABLES.definitionStages, H, { version_id: V, position: 1, kind: 'handoff', title: 'Crea la compra en Tasks', target_app: 'tasks', target_anchor: 'tasks.compras.nueva' }),
    ins(TABLES.definitionSteps, STEP, { version_id: V, stage_id: H, position: 1, key: 'compra', title: 'Crea la compra', anchor: 'tasks.compras.nueva', essential: true }),
  ])).status, 200);
  assert.equal((await commit([call(PROCEDURES.publishVersion, { version_id: V })])).status, 200);
  const ex = uuid();
  await commit([call(PROCEDURES.startExecution, { execution_id: ex, version_id: V, mode: 'run' })], app.tokens.editor);
  await commit([call(PROCEDURES.startStage, { execution_id: ex, position: 1 })], app.tokens.editor);
  await confirm({ requestId: `h-${ex}-p`, execution_id: ex, step_id: STEP, how: 'save', pending: true });
  let e = (await app.t.db.query<any>(`select status, stages from flow.executions where id = $1`, [ex])).rows[0];
  assert.equal(e.stages[0].status, 'draft'); // pendiente: aún no
  await confirm({ requestId: `h-${ex}-ok`, execution_id: ex, step_id: STEP, how: 'event' });
  e = (await app.t.db.query<any>(`select status, stages from flow.executions where id = $1`, [ex])).rows[0];
  assert.equal(e.stages[0].status, 'done'); assert.equal(e.status, 'done');
});

test('guiado · «Hecho» o «Saltar» (manual/none) deja el paso hecho al releer, pero no cierra el tramo «ir a otra app» (0949)', async () => {
  const D = uuid(), V = uuid(), H = uuid(), STEP = uuid();
  assert.equal((await commit([
    ins(TABLES.definitions, D, { key: 'pedir_a_mano', name: 'Pedir a mano' }),
    ins(TABLES.definitionVersions, V, { definition_id: D, version: 1, status: 'draft' }),
    ins(TABLES.definitionStages, H, { version_id: V, position: 1, kind: 'handoff', title: 'Crea la compra en Tasks', target_app: 'tasks', target_anchor: 'tasks.compras.nueva' }),
    ins(TABLES.definitionSteps, STEP, { version_id: V, stage_id: H, position: 1, key: 'compra', title: 'Crea la compra', anchor: 'tasks.compras.nueva', essential: true }),
  ])).status, 200);
  assert.equal((await commit([call(PROCEDURES.publishVersion, { version_id: V })])).status, 200);
  const ex = uuid();
  await commit([call(PROCEDURES.startExecution, { execution_id: ex, version_id: V, mode: 'run' })], app.tokens.editor);
  await commit([call(PROCEDURES.startStage, { execution_id: ex, position: 1 })], app.tokens.editor);
  const done = async () => (await read({ execution_id: ex, app: 'tasks' })).data.steps.find((s: any) => s.id === STEP).done;
  await confirm({ requestId: `m-${ex}-p`, execution_id: ex, step_id: STEP, how: 'none', pending: true });
  assert.equal(await done(), false); // pendiente: aún no
  await confirm({ requestId: `m-${ex}-ok`, execution_id: ex, step_id: STEP, how: 'manual' });
  assert.equal(await done(), true);
  const e = (await app.t.db.query<any>(`select status, stages from flow.executions where id = $1`, [ex])).rows[0];
  assert.equal(e.stages[0].status, 'draft');
});
