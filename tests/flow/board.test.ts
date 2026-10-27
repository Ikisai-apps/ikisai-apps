/**
 * Flow · «Avance por aplicaciones» (migración 0937), sobre PGlite: plantilla `avance`, tarjetas como unidades con carril,
 * urgencia y marca; solo por procedimiento; cada agente solo en sus carriles (`scopes.lanes`), el owner en todos.
 * Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
let app: TestApp;
let board = '';
let seq = 0;

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[], token = app.tokens.owner) => app.call('/api/v1/commands', { token, body: { requestId: `b-${++seq}-${crypto.randomUUID()}`, operations } });
/** Escribe una tarjeta como lo hará el procedimiento del paso 2: dentro de un procedimiento y con el actor del núcleo. */
async function asProc(actor: string, sql: string): Promise<string> {
  try {
    await app.t.db.exec(`begin; select set_config('flow.proc', 'on', true); select set_config('core.actor', '${actor}', true); ${sql}; commit;`);
    return 'ok';
  } catch (error) {
    await app.t.db.exec('rollback').catch(() => undefined);
    return String((error as Error).message).match(/[A-Z_]{6,}/)?.[0] ?? String(error);
  }
}
const card = (id: string, lane: string, extra = '') =>
  `insert into flow.units (id, project_id, column_key, kind, label, lane_key, prio, status${extra ? ', board_flag' : ''}) values ('${id}', '${board}', 'avance', 'card', 'Tarjeta de prueba', '${lane}', 'importante', 'pending'${extra ? `, '${extra}'` : ''})`;

test('avance · la plantilla crea el flujo con su columna «Avance»', async () => {
  board = crypto.randomUUID();
  const r = await commit([{ op: 'call', procedure: PROCEDURES.createFlow, args: { template_key: 'avance', project_id: board, name: 'Avance por aplicaciones' } }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const cols = (await app.call(`/api/v1/snapshot?tables=${TABLES.columns}`)).data.tables[0].rows.filter((c: any) => c.project_id === board);
  assert.deepEqual(cols.map((c: any) => c.key), ['avance']);
});

test('avance · las tarjetas no se escriben directamente, ni siquiera el owner', async () => {
  const r = await commit([{ op: 'insert', table: TABLES.units, id: crypto.randomUUID(), fields: { project_id: board, column_key: 'avance', kind: 'card', label: 'Directa', lane_key: 'flow', status: 'pending' } }]);
  assert.notEqual(r.status, 200);
  assert.match(JSON.stringify(r.data), /PROCEDURE_ONLY|FORBIDDEN|INVALID/);
});

test('avance · cada agente en sus carriles; el owner en todos', async () => {
  const mine = crypto.randomUUID();
  // Sin carriles en su membresía, el editor no escribe.
  await app.t.db.query(`update core.memberships set scopes = jsonb_build_object('projects', jsonb_build_array($2::text)) where app = 'flow' and user_id = $1`, [app.users.editor, board]);
  assert.equal(await asProc(app.users.editor, card(mine, 'flow')), 'LANE_FORBIDDEN');
  // Con el carril «flow», sí en el suyo y no en otro.
  await app.t.db.query(`update core.memberships set scopes = jsonb_build_object('projects', jsonb_build_array($2::text), 'lanes', jsonb_build_array('flow')) where app = 'flow' and user_id = $1`, [app.users.editor, board]);
  assert.equal(await asProc(app.users.editor, card(mine, 'flow')), 'ok');
  assert.equal(await asProc(app.users.editor, card(crypto.randomUUID(), 'food')), 'LANE_FORBIDDEN');
  // Tampoco se lleva una tarjeta suya a otro carril, ni toca una ajena.
  assert.equal(await asProc(app.users.editor, `update flow.units set lane_key = 'food' where id = '${mine}'`), 'LANE_FORBIDDEN');
  const foreign = crypto.randomUUID();
  assert.equal(await asProc(app.users.owner, card(foreign, 'food', 'pr')), 'ok');
  assert.equal(await asProc(app.users.editor, `update flow.units set status = 'done', done_at = now() where id = '${foreign}'`), 'LANE_FORBIDDEN');
  const row = (await app.t.db.query<any>(`select lane_key, prio, board_flag from flow.units where id = $1`, [foreign])).rows[0];
  assert.deepEqual(row, { lane_key: 'food', prio: 'importante', board_flag: 'pr' });
});

test('avance · formas: recurrente sin urgencia, sin «cancelled», marca pr o backlog', async () => {
  const sql = (fields: string) => `insert into flow.units (id, project_id, column_key, kind, label, lane_key, status, prio, board_flag) values ('${crypto.randomUUID()}', '${board}', 'avance', ${fields})`;
  assert.notEqual(await asProc(app.users.owner, sql(`'recurring', 'Revisar CI', 'core', 'pending', 'urgente', null`)), 'ok');
  assert.equal(await asProc(app.users.owner, sql(`'recurring', 'Revisar CI', 'core', 'pending', null, null`)), 'ok');
  assert.notEqual(await asProc(app.users.owner, sql(`'card', 'Anulada', 'core', 'cancelled', null, null`)), 'ok');
  assert.notEqual(await asProc(app.users.owner, sql(`'card', 'Otra marca', 'core', 'pending', null, 'aplazada'`)), 'ok');
  assert.equal(await asProc(app.users.owner, sql(`'card', '${'T'.repeat(250)}', 'core', 'pending', 'opcional', 'backlog'`)), 'ok');
});
