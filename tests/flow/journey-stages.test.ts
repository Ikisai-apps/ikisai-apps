/**
 * Flow · recorridos por tramos (flow-14, migración 0939), sobre PGlite: «Registrar compra» migrado a un tramo; publicar
 * valida; lo publicado no se toca; ejecución tramo a tramo con lo fijo y lo heredado puesto por el servidor, error y
 * reintento de un tramo, `handoff` y proyección para Central. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
const COMPRA = '0f10a000-0000-4000-8000-00000000d101';
const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
const DEF = uuid(), VER = uuid(), S1 = uuid(), S2 = uuid(), S3 = uuid();

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[], token = app.tokens.owner) => app.call('/api/v1/commands', { token, body: { requestId: `js-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[], token = app.tokens.owner) { const r = await commit(operations, token); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.results[0].result; }
const code = async (operations: unknown[], token = app.tokens.owner) => (await commit(operations, token)).data.error?.code;
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
const ins = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
async function rows(table: string): Promise<any[]> { return (await app.call(`/api/v1/snapshot?tables=${table}`)).data.tables[0].rows; }

test('tramos · «Registrar compra» pasa a un tramo de capacidad con sus 8 pasos', async () => {
  const stages = (await rows(TABLES.definitionStages)).filter((s) => s.version_id === COMPRA);
  assert.equal(stages.length, 1); assert.equal(stages[0].kind, 'capability'); assert.equal(stages[0].capability, ['invoices', 'register_purchase_quick'].join('.'));
  const steps = (await rows(TABLES.definitionSteps)).filter((s) => s.version_id === COMPRA);
  assert.equal(steps.length, 8); assert.ok(steps.every((s) => s.stage_id === stages[0].id && s.mode === 'ask'));
});

test('tramos · borrador de tres tramos; publicar valida; lo publicado no se toca', async () => {
  // 1 · capacidad (total preguntado, moneda fija) → 2 · registro (referencia heredada del resultado del 1, nota) → 3 · ir a Tasks.
  await ok([
    ins(TABLES.definitions, DEF, { key: 'compra_y_reposicion', name: 'Compra y reposición' }),
    ins(TABLES.definitionVersions, VER, { definition_id: DEF, version: 1, status: 'draft' }),
    ins(TABLES.definitionStages, S1, { version_id: VER, position: 1, kind: 'capability', capability: 'invoices.prueba', title: 'Registrar la compra' }),
    ins(TABLES.definitionStages, S2, { version_id: VER, position: 2, kind: 'record', title: 'Anotar en la barra' }),
    ins(TABLES.definitionStages, S3, { version_id: VER, position: 3, kind: 'handoff', title: 'Pedir reposición', target_app: 'tasks', target_anchor: 'tasks.compras.nueva' }),
    ins(TABLES.definitionSteps, uuid(), { version_id: VER, stage_id: S1, position: 1, key: 'total', title: '¿Cuánto?', essential: true }),
    ins(TABLES.definitionSteps, uuid(), { version_id: VER, stage_id: S1, position: 2, key: 'currency', title: 'Moneda', mode: 'fixed', fixed_value: 'EUR', essential: true }),
    ins(TABLES.definitionSteps, uuid(), { version_id: VER, stage_id: S2, position: 1, key: 'ref', title: 'Factura', mode: 'from', default_from: 'stages[1].result.invoice_id', input_type: 'text', essential: true }),
    ins(TABLES.definitionSteps, uuid(), { version_id: VER, stage_id: S2, position: 2, key: 'nota', title: '¿Algo más?', input_type: 'text', essential: false }),
  ]);
  // Un paso que hereda de un tramo posterior no se publica.
  const bad = uuid();
  await ok([ins(TABLES.definitionSteps, bad, { version_id: VER, stage_id: S1, position: 3, key: 'luego', title: 'Del futuro', mode: 'from', default_from: 'stages[2].values.nota', essential: false })]);
  assert.equal(await code([call(PROCEDURES.publishVersion, { version_id: VER })]), 'JOURNEY_INVALID');
  const b = (await rows(TABLES.definitionSteps)).find((s) => s.id === bad);
  await ok([{ op: 'update', table: TABLES.definitionSteps, id: bad, expectedRevision: b.revision, fields: { mode: 'ask', default_from: null } }]);
  // Solo el owner publica.
  assert.equal(await code([call(PROCEDURES.publishVersion, { version_id: VER })], app.tokens.editor), 'FORBIDDEN');
  const out = await ok([call(PROCEDURES.publishVersion, { version_id: VER })]);
  assert.equal(out.stages, 3);
  const v = (await rows(TABLES.definitionVersions)).find((x) => x.id === VER);
  assert.equal(v.status, 'published'); assert.equal(v.capability, 'invoices.prueba');
  const step = (await rows(TABLES.definitionSteps)).find((s) => s.id === bad);
  assert.equal(await code([{ op: 'update', table: TABLES.definitionSteps, id: bad, expectedRevision: step.revision, fields: { title: 'Cambiado' } }]), 'VERSION_PUBLISHED');
  // Tampoco la versión publicada (y un borrador sí se puede renombrar: la guarda no falla en `definition_versions`).
  const pv = (await rows(TABLES.definitionVersions)).find((x) => x.id === VER);
  assert.equal(await code([{ op: 'update', table: TABLES.definitionVersions, id: VER, expectedRevision: pv.revision, fields: { capability: 'otra.cosa' } }]), 'VERSION_PUBLISHED');
});

test('tramos · ejecutar: fijo y heredado los pone el servidor; error y reintento del tramo; handoff; termina hecha', async () => {
  const ex = uuid();
  await ok([call(PROCEDURES.startExecution, { execution_id: ex, version_id: VER, mode: 'run' })], app.tokens.editor);
  assert.equal(await code([call(PROCEDURES.startStage, { execution_id: ex, position: 2 })], app.tokens.editor), 'STAGE_NOT_READY');
  const s1 = await ok([call(PROCEDURES.startStage, { execution_id: ex, position: 1 })], app.tokens.editor);
  assert.deepEqual(s1.values, { currency: 'EUR' });
  assert.equal(await code([call(PROCEDURES.saveStageValues, { execution_id: ex, position: 1, values: { currency: 'USD' } })], app.tokens.editor), 'INVALID_OPERATION');
  assert.equal(await code([call(PROCEDURES.saveStageValues, { execution_id: ex, position: 1, values: { 'currency.code': 'USD' } })], app.tokens.editor), 'INVALID_OPERATION');
  await ok([call(PROCEDURES.saveStageValues, { execution_id: ex, position: 1, values: { total: 12.1, 'supplier.name': 'Proveedor de prueba' } })], app.tokens.editor);
  // La capacidad falla: el tramo queda en error y se reintenta con lo ya respondido.
  await ok([call(PROCEDURES.finishStage, { execution_id: ex, position: 1, status: 'error', error: { code: 'APP_UNAVAILABLE' } })], app.tokens.editor);
  const retry = await ok([call(PROCEDURES.startStage, { execution_id: ex, position: 1 })], app.tokens.editor);
  assert.deepEqual(retry.values, { currency: 'EUR', total: 12.1, supplier: { name: 'Proveedor de prueba' } });
  await ok([call(PROCEDURES.finishStage, { execution_id: ex, position: 1, status: 'done', result: { invoice_id: 'F-0001' } })], app.tokens.editor);
  assert.equal(await code([call(PROCEDURES.startStage, { execution_id: ex, position: 1 })], app.tokens.editor), 'STAGE_FINISHED');
  // El tramo 2 hereda la factura del resultado del 1.
  const s2 = await ok([call(PROCEDURES.startStage, { execution_id: ex, position: 2 })], app.tokens.editor);
  assert.deepEqual(s2.values, { ref: 'F-0001' });
  await ok([call(PROCEDURES.finishStage, { execution_id: ex, position: 2, status: 'done' })], app.tokens.editor);
  // Ir a Tasks: se cierra al marcar «hecho».
  const s3 = await ok([call(PROCEDURES.startStage, { execution_id: ex, position: 3 })], app.tokens.editor);
  assert.equal(s3.kind, 'handoff');
  const last = await ok([call(PROCEDURES.finishStage, { execution_id: ex, position: 3, status: 'done' })], app.tokens.editor);
  assert.equal(last.execution_status, 'done');
  const e = (await rows(TABLES.executions)).find((x) => x.id === ex);
  assert.equal(e.status, 'done'); assert.equal(e.stages.length, 3);
  // Otra persona no toca esta ejecución.
  assert.equal(await code([call(PROCEDURES.saveStageValues, { execution_id: ex, position: 2, values: { nota: 'x' } })]), 'NOT_FOUND');
});

test('tramos · aprender: el tramo de capacidad no se da por hecho, se practica', async () => {
  const ex = uuid();
  await ok([call(PROCEDURES.startExecution, { execution_id: ex, version_id: VER, mode: 'learn' })], app.tokens.editor);
  await ok([call(PROCEDURES.startStage, { execution_id: ex, position: 1 })], app.tokens.editor);
  assert.equal(await code([call(PROCEDURES.finishStage, { execution_id: ex, position: 1, status: 'done' })], app.tokens.editor), 'INVALID_OPERATION');
  await ok([call(PROCEDURES.finishStage, { execution_id: ex, position: 1, status: 'practiced' })], app.tokens.editor);
});

test('tramos · Central ve cada paso con su tramo y su tipo', async () => {
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('central', $1, 'owner') on conflict do nothing`, [app.users.owner]);
  const out = (await app.t.db.query<{ out: any }>(`select core.read('central', $1, 'flow.journey_steps_projection', '{"limit": 200}'::jsonb) as out`, [app.users.owner])).rows[0]!.out;
  const mine = out.rows.filter((r: any) => r.flow_name === 'Compra y reposición');
  assert.deepEqual([...new Set(mine.map((r: any) => `${r.stage}:${r.stage_kind}:${r.app}`))].sort(), ['1:capability:invoices', '2:record:flow']);
  assert.equal(out.rows.filter((r: any) => r.flow_name === 'Registrar compra').length, 8);
});

test('tramos · «Compra recibida»: el título y la referencia de Tasks salen de Finance sin preguntar', async () => {
  const VERSION = '0f10a000-0000-4000-8000-00000000d201';
  const v = (await rows(TABLES.definitionVersions)).find((x) => x.id === VERSION);
  assert.equal(v.status, 'published');
  const ex = uuid();
  await ok([call(PROCEDURES.startExecution, { execution_id: ex, version_id: VERSION, mode: 'run' })], app.tokens.editor);
  await ok([call(PROCEDURES.startStage, { execution_id: ex, position: 1 })], app.tokens.editor);
  await ok([call(PROCEDURES.saveStageValues, { execution_id: ex, position: 1, values: { description: 'Hielo para la barra', total: 12.1 } })], app.tokens.editor);
  await ok([call(PROCEDURES.finishStage, { execution_id: ex, position: 1, status: 'done', result: { invoice_id: '0f10a000-0000-4000-8000-0000000000f1' } })], app.tokens.editor);
  const s2 = await ok([call(PROCEDURES.startStage, { execution_id: ex, position: 2 })], app.tokens.editor);
  assert.deepEqual(s2.values, { title: 'Hielo para la barra', external_ref: '0f10a000-0000-4000-8000-0000000000f1', source: 'recorridos' });
});

test('tramos · «Alojamiento libre · recepción»: cuatro tramos «ir a Booking», cada uno a su control de Recepción', async () => {
  const VERSION = '0f10a000-0000-4000-8000-00000000d301';
  assert.equal((await rows(TABLES.definitionVersions)).find((x) => x.id === VERSION).status, 'published');
  const stages = (await rows(TABLES.definitionStages)).filter((s) => s.version_id === VERSION).sort((a, b) => a.position - b.position);
  assert.deepEqual(stages.map((s) => `${s.kind}:${s.target_app}:${s.target_anchor}`), [
    'handoff:booking:booking.recepcion.buscar', 'handoff:booking:booking.recepcion.ficha', 'handoff:booking:booking.recepcion.cobrar', 'handoff:booking:booking.recepcion.llega']);
  const steps = (await rows(TABLES.definitionSteps)).filter((s) => s.version_id === VERSION);
  assert.equal(steps.length, 4); assert.ok(steps.every((s) => s.anchor === stages.find((st) => st.id === s.stage_id).target_anchor));
  // Se recorre con «Hecho» aunque Booking aún no confirme por el Guiado.
  const ex = uuid();
  await ok([call(PROCEDURES.startExecution, { execution_id: ex, version_id: VERSION, mode: 'run' })], app.tokens.editor);
  for (const p of [1, 2, 3, 4]) {
    await ok([call(PROCEDURES.startStage, { execution_id: ex, position: p })], app.tokens.editor);
    await ok([call(PROCEDURES.finishStage, { execution_id: ex, position: p, status: 'done' })], app.tokens.editor);
  }
  assert.equal((await rows(TABLES.executions)).find((x) => x.id === ex).status, 'done');
});

test('tramos · recepción v2 (0954): en «Revisa su ficha», abrirla no cierra el tramo; el documento guardado en Booking, sí', async () => {
  const VERSION = '0f10a000-0000-4000-8000-00000000d302';
  assert.equal((await rows(TABLES.definitionVersions)).find((x) => x.id === VERSION).status, 'published');
  const steps = (await rows(TABLES.definitionSteps)).filter((s) => s.version_id === VERSION && s.stage_id === '0f10a000-0000-4000-8000-00000000d322')
    .sort((a, b) => a.position - b.position);
  assert.deepEqual(steps.map((s) => s.anchor), ['booking.recepcion.ficha', 'booking.huespedes.ficha.document_number']);
  const ex = uuid();
  await ok([call(PROCEDURES.startExecution, { execution_id: ex, version_id: VERSION, mode: 'run' })], app.tokens.editor);
  await ok([call(PROCEDURES.startStage, { execution_id: ex, position: 1 })], app.tokens.editor);
  await ok([call(PROCEDURES.finishStage, { execution_id: ex, position: 1, status: 'done' })], app.tokens.editor);
  await ok([call(PROCEDURES.startStage, { execution_id: ex, position: 2 })], app.tokens.editor);
  const confirm = (step: string, how: string) => app.call('/api/v1/guide-confirm', { token: app.tokens.editor, body: { requestId: `r2-${ex}-${how}`, execution_id: ex, step_id: step, how } });
  const stage2 = async () => (await rows(TABLES.executions)).find((x) => x.id === ex).stages.find((s: any) => s.position === 2).status;
  assert.equal((await confirm(steps[0].id, 'manual')).status, 200);
  assert.equal(await stage2(), 'draft');
  assert.equal((await confirm(steps[1].id, 'event')).status, 200);
  assert.equal(await stage2(), 'done');
});
