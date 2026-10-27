/**
 * Flow · clases de actividad (flow-19, migración 0942), sobre PGlite: objetivo con criterios (solo se cumple con todos
 * verificados, nunca por un toque), resultado verificable con su vínculo, puesto continuo que no se termina. Datos sintéticos.
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
  await app.t.db.query(`update core.memberships set scopes = jsonb_build_object('projects', jsonb_build_array($2::text)) where app = 'flow' and user_id = $1`, [app.users.editor, V1]);
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[], token = app.tokens.editor) => app.call('/api/v1/commands', { token, body: { requestId: `uc-${++seq}-${uuid()}`, operations } });
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
async function ok(operations: unknown[], token = app.tokens.editor) { const r = await commit(operations, token); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.results[0].result; }
const code = async (operations: unknown[], token = app.tokens.editor) => (await commit(operations, token)).data.error?.code;
const unit = async (id: string) => (await app.t.db.query<any>(`select * from flow.units where id = $1`, [id])).rows[0];

test('clases · objetivo: se cumple solo con todos los criterios verificados; desverificar lo reabre', async () => {
  const id = uuid();
  const out = await ok([call(PROCEDURES.addObjective, { unit_id: id, project_id: V1, label: 'Barra lista para el sábado', criteria: ['Hielo en el arcón', 'Carta impresa'] })]);
  assert.equal(out.criteria, 2);
  let u = await unit(id);
  assert.equal(u.class, 'objective'); assert.equal(u.status, 'pending');
  // Ni por un toque directo ni por procedimiento sin criterios.
  await assert.rejects(app.t.db.exec(`begin; select set_config('flow.proc', 'on', true); update flow.units set status = 'done', done_at = now() where id = '${id}'; commit;`), /OBJECTIVE_NOT_MET/);
  await app.t.db.exec('rollback').catch(() => undefined);
  assert.equal((await ok([call(PROCEDURES.verifyCriterion, { unit_id: id, criterion_id: 'c1', evidence: 'Foto del arcón' })])).met, false);
  const met = await ok([call(PROCEDURES.verifyCriterion, { unit_id: id, criterion_id: 'c2' })]);
  assert.equal(met.met, true);
  u = await unit(id);
  assert.equal(u.status, 'done'); assert.ok(u.verified_at); assert.equal(u.verified_by, app.users.editor);
  assert.equal(u.criteria[0].evidence, 'Foto del arcón');
  await ok([call(PROCEDURES.verifyCriterion, { unit_id: id, criterion_id: 'c1', verified: false })]);
  u = await unit(id);
  assert.equal(u.status, 'pending'); assert.equal(u.verified_by, null);
  // Fuera de su ámbito, no; el lector, tampoco.
  assert.equal(await code([call(PROCEDURES.verifyCriterion, { unit_id: id, criterion_id: 'c1' })], app.tokens.reader), 'FORBIDDEN');
});

test('clases · resultado: hecho y verificado por quien lo anota, con su vínculo', async () => {
  const id = uuid();
  await ok([call(PROCEDURES.recordResult, { unit_id: id, project_id: V1, label: 'Compra registrada', link: { app: 'invoices', kind: 'invoice', id: 'F-0001', extra: 'fuera' } })]);
  const u = await unit(id);
  assert.equal(u.class, 'result'); assert.equal(u.status, 'done'); assert.equal(u.verified_by, app.users.editor);
  assert.deepEqual(u.result_link, { app: 'invoices', kind: 'invoice', id: 'F-0001' });
  assert.notEqual(await code([call(PROCEDURES.recordResult, { unit_id: uuid(), project_id: V1, label: 'Sin vínculo', link: { app: 'Mal!', id: '' } })]), undefined);
});

test('clases · un puesto es actividad continua: nunca se termina; la clase no cambia', async () => {
  const id = uuid();
  await app.t.db.exec(`begin; select set_config('flow.proc', 'on', true); insert into flow.units (id, project_id, column_key, kind, label, status) values ('${id}', '${V1}', 'logistics', 'station', 'Pan', 'pending'); commit;`);
  assert.equal((await unit(id)).class, 'station');
  await assert.rejects(app.t.db.exec(`begin; select set_config('flow.proc', 'on', true); update flow.units set status = 'done', done_at = now() where id = '${id}'; commit;`), /STATION_NEVER_DONE/);
  await app.t.db.exec('rollback').catch(() => undefined);
  await assert.rejects(app.t.db.exec(`begin; select set_config('flow.proc', 'on', true); update flow.units set class = 'operation' where id = '${id}'; commit;`), /PROCEDURE_ONLY/);
  await app.t.db.exec('rollback').catch(() => undefined);
});
