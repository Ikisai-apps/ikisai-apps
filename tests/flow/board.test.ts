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

// ---------------------------------------------------------------------------------------------------------------------
// Paso 2 (0938): flow.board_card y la capacidad del catálogo
// ---------------------------------------------------------------------------------------------------------------------
const boardCard = (args: Record<string, unknown>, token = app.tokens.owner) => commit([{ op: 'call', procedure: PROCEDURES.boardCard, args: { project_id: board, ...args } }], token);
const unit = async (id: string) => (await app.t.db.query<any>(`select * from flow.units where id = $1`, [id])).rows[0];

test('avance · board_card crea y cambia solo lo que se da; done pone la hora; null quita la urgencia', async () => {
  const r = await boardCard({ lane_key: 'victor', title: 'Probar el alojamiento', prio: 'urgente', tipo: 'prueba', order: 3, ref: '#943', url: 'https://example.invalid/pr/943', steps: ['Abrir la carta', 'Tocar «Alójate aquí»'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = r.data.results[0].result.card_id as string;
  let u = await unit(id);
  assert.equal(u.kind, 'card'); assert.equal(u.status, 'pending'); assert.equal(u.prio, 'urgente');
  assert.deepEqual(u.payload.steps, ['Abrir la carta', 'Tocar «Alójate aquí»']); assert.equal(u.payload.ref, '#943');
  assert.equal(u.payload.tipo, 'prueba'); assert.equal(u.idx, 3);
  assert.notEqual((await boardCard({ lane_key: 'victor', title: 'Oficio raro', tipo: 'magia' })).status, 200);
  assert.equal((await boardCard({ card_id: id, status: 'done', flag: 'pr' })).status, 200);
  u = await unit(id);
  assert.equal(u.status, 'done'); assert.ok(u.done_at); assert.equal(u.board_flag, 'pr'); assert.equal(u.prio, 'urgente'); assert.equal(u.label, 'Probar el alojamiento');
  assert.equal((await boardCard({ card_id: id, status: 'in_progress', prio: null, flag: null, url: null })).status, 200);
  u = await unit(id);
  assert.equal(u.done_at, null); assert.equal(u.prio, null); assert.equal(u.board_flag, null); assert.equal(u.payload.url, undefined);
  assert.notEqual((await boardCard({ lane_key: 'victor', title: 'Mal enlace', url: 'javascript:alert(1)' })).status, 200);
  // Una recurrente no lleva urgencia: se crea sin ella aunque se pida.
  const rec = await boardCard({ lane_key: 'victor', title: 'Recurrente', kind: 'recurring', prio: 'urgente' });
  assert.equal(rec.status, 200, JSON.stringify(rec.data));
  assert.equal((await unit(rec.data.results[0].result.card_id)).prio, null);
});

test('avance · capacidad board-card: el agente en su carril, idempotente por requestId; otro carril, LANE_FORBIDDEN', async () => {
  const caps = (await app.call('/api/v1/capabilities', { token: app.tokens.editor })).data.items as Array<{ id: string; allowed: boolean }>;
  assert.ok(caps.some((c) => c.id === 'flow.board_card' && c.allowed), JSON.stringify(caps.map((c) => c.id)));
  const body = { requestId: 'flow-pr-943', project_id: board, lane_key: 'flow', title: '«Alójate aquí» en la carta', status: 'in_progress', flag: 'pr', ref: '#943' };
  const first = await app.call('/api/v1/board-card', { token: app.tokens.editor, body });
  assert.equal(first.status, 200, JSON.stringify(first.data)); assert.equal(first.data.created, true);
  const again = await app.call('/api/v1/board-card', { token: app.tokens.editor, body });
  assert.equal(again.data.card_id, first.data.card_id); assert.equal(again.data.replayed, true);
  const done = await app.call('/api/v1/board-card', { token: app.tokens.editor, body: { requestId: 'flow-pr-943-done', project_id: board, card_id: first.data.card_id, lane_key: 'flow', status: 'done', flag: null } });
  assert.equal(done.status, 200, JSON.stringify(done.data)); assert.equal((await unit(first.data.card_id)).status, 'done');
  const other = await app.call('/api/v1/board-card', { token: app.tokens.editor, body: { requestId: 'flow-en-food', project_id: board, lane_key: 'food', title: 'No es mío' } });
  assert.equal(other.status, 403, JSON.stringify(other.data)); assert.equal(other.data.error.code, 'LANE_FORBIDDEN');
  assert.equal((await app.call('/api/v1/board-card', { token: app.tokens.reader, body: { ...body, requestId: 'lector' } })).status, 403);
});
