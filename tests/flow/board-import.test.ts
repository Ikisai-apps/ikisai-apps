/**
 * Flow · «Avance» para la mudanza (migración 0947), sobre PGlite: importación idempotente del tablero (hitos, tarjetas con su
 * paso, historial) por el registro del núcleo; hito cumplido cuando sus hijas que no son backlog están hechas (y reabierto si
 * no); fotos del historial al escribir tarjetas. Datos sintéticos.
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
const BOARD = uuid(), H1 = uuid(), H2 = uuid(), C1 = uuid(), C2 = uuid(), C3 = uuid(), C4 = uuid();

const payload = {
  hitos: [{ hito_id: H1, title: 'Sábado listo', orden: 1 }, { hito_id: H2, title: 'Avance en Flow', orden: 2, done_at: '2026-10-27T18:00:00Z' }],
  cards: [
    { card_id: C1, lane_key: 'flow', title: 'Carta pública', status: 'done', hito_id: H1, paso: 1, tipo: 'arreglo', ref: '#910' },
    { card_id: C2, lane_key: 'booking', title: 'Recepción', status: 'pending', hito_id: H1, paso: 2, prio: 'urgente', steps: ['Abrir', 'Cobrar'] },
    { card_id: C3, lane_key: 'core', title: 'Exportar', status: 'done', hito_id: H2, paso: 1 },
    { card_id: C4, lane_key: 'victor', title: 'Más adelante', status: 'pending', flag: 'backlog', hito_id: H2, paso: 2 },
  ],
  history: [{ t: '2026-10-26T10:00:00Z', hecho: 1, pr: 0, curso: 0, pend: 3, backlog: 0, total: 4 },
    { t: '2026-10-27T10:00:00Z', hecho: 2, pr: 0, curso: 0, pend: 1, backlog: 1, total: 4 }],
};

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
  const r = await commit([{ op: 'call', procedure: PROCEDURES.createFlow, args: { template_key: 'avance', project_id: BOARD, name: 'Avance por aplicaciones' } }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
});
test.after(async () => { await app.close(); });

function commit(operations: unknown[], token = app.tokens.owner) { return app.call('/api/v1/commands', { token, body: { requestId: `bi-${++seq}-${uuid()}`, operations } }); }
const unit = async (id: string) => (await app.t.db.query<any>(`select * from flow.units where id = $1`, [id])).rows[0];
const importBoard = async () => (await app.t.db.query<{ out: any }>(`select flow.import_board($1, $2::jsonb) as out`, [BOARD, JSON.stringify(payload)])).rows[0]!.out;
const history = async () => (await app.t.db.query<any>(`select * from flow.board_history where project_id = $1 order by taken_at`, [BOARD])).rows;

test('avance · importar: hitos, tarjetas con paso e historial; un hito con todo hecho (sin contar backlog) queda cumplido', async () => {
  const out = await importBoard();
  assert.deepEqual(out, { project_id: BOARD, hitos: 2, cards: 4, changed: 4, history: 2 });
  const h1 = await unit(H1); const h2 = await unit(H2);
  assert.equal(h1.class, 'objective'); assert.equal(h1.status, 'pending'); assert.equal(h1.payload.orden, 1);
  assert.equal(h2.status, 'done'); assert.equal(new Date(h2.done_at).toISOString(), '2026-10-27T18:00:00.000Z');
  const c2 = await unit(C2);
  assert.equal(c2.parent_id, H1); assert.equal(c2.payload.paso, 2); assert.equal(c2.prio, 'urgente'); assert.deepEqual(c2.payload.steps, ['Abrir', 'Cobrar']);
  assert.equal((await history()).length, 2);
  // Cada hito es una ejecución de su cadena: un tramo por tarjeta, en orden de paso, con su carril; estado según las tarjetas.
  const exec = async (h: string) => (await app.t.db.query<any>(`select e.* from flow.executions e join flow.units u on u.execution_id = e.id where u.id = $1`, [h])).rows[0];
  const e1 = await exec(H1); const e2 = await exec(H2);
  assert.equal(e1.status, 'draft'); assert.deepEqual(e1.stages.map((x: any) => x.status), ['done', 'draft']);
  assert.equal(e2.status, 'done'); assert.deepEqual(e2.stages.map((x: any) => x.status), ['done', 'skipped']);
  const st = (await app.t.db.query<any>(`select position, kind, lane_key from flow.definition_stages where version_id = $1 order by position`, [e1.version_id])).rows;
  assert.deepEqual(st, [{ position: 1, kind: 'handoff', lane_key: 'flow' }, { position: 2, kind: 'handoff', lane_key: 'booking' }]);
  assert.equal(c2.execution_id, e1.id); assert.equal(c2.stage_position, 2);
  // Por el registro del núcleo: los móviles lo reciben al sincronizar.
  const logged = await app.t.db.query(`select 1 from core.changes where app = 'flow' and row_id = $1`, [C2]);
  assert.ok(logged.rows.length >= 1);
});

test('avance · importar otra vez no duplica nada', async () => {
  const before = (await app.t.db.query<{ n: number }>(`select count(*)::int n from flow.units where project_id = $1`, [BOARD])).rows[0]!.n;
  const revs = async () => (await app.t.db.query<{ id: string; revision: number }>(`select id, revision from flow.units where project_id = $1 order by id`, [BOARD])).rows;
  const r0 = await revs();
  // Sin cambios en la carga, no se escribe nada (0960): ni revisiones nuevas ni cambios que bajarse.
  assert.deepEqual(await importBoard(), { project_id: BOARD, hitos: 2, cards: 4, changed: 0, history: 0 });
  assert.deepEqual(await revs(), r0);
  assert.equal((await app.t.db.query<{ n: number }>(`select count(*)::int n from flow.units where project_id = $1`, [BOARD])).rows[0]!.n, before);
  assert.equal((await history()).length, 2);
});

test('avance · al hacer el último paso el hito se cumple; al reabrirlo, vuelve; y queda foto en el historial', async () => {
  const before = (await history()).length;
  let r = await commit([{ op: 'call', procedure: PROCEDURES.boardCard, args: { project_id: BOARD, card_id: C2, lane_key: 'booking', status: 'done' } }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let h1 = await unit(H1);
  assert.equal(h1.status, 'done'); assert.ok(h1.done_at);
  const e1 = (await app.t.db.query<any>(`select * from flow.executions where id = $1`, [h1.execution_id])).rows[0];
  assert.equal(e1.status, 'done'); assert.deepEqual(e1.stages.map((x: any) => x.status), ['done', 'done']);
  assert.equal((await history()).length, before + 1);
  // El snapshot del núcleo las entrega como filas con id (con una columna `t`, salían como fechas sueltas y el espejo local fallaba).
  const snap = await app.call('/api/v1/snapshot?tables=flow.board_history');
  const rows = snap.data.tables[0].rows as any[];
  assert.ok(rows.length > 0 && rows.every((r) => typeof r === 'object' && typeof r.id === 'string' && typeof r.taken_at === 'string'), JSON.stringify(rows).slice(0, 200));
  r = await commit([{ op: 'call', procedure: PROCEDURES.boardCard, args: { project_id: BOARD, card_id: C2, lane_key: 'booking', status: 'pending' } }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  h1 = await unit(H1);
  assert.equal(h1.status, 'pending'); assert.equal(h1.done_at, null);
  // Colgar una tarjeta nueva de un hito con paso, por board_card.
  const n = await commit([{ op: 'call', procedure: PROCEDURES.boardCard, args: { project_id: BOARD, lane_key: 'flow', title: 'Paso 3', hito_id: H1, paso: 3 } }]);
  assert.equal(n.status, 200, JSON.stringify(n.data));
  const id = n.data.results[0].result.card_id;
  const c = await unit(id);
  assert.equal(c.parent_id, H1); assert.equal(c.payload.paso, 3);
  // La tarjeta nueva es un tramo más de la cadena del hito.
  assert.equal(c.stage_position, 3); assert.equal(c.execution_id, (await unit(H1)).execution_id);
  // Nadie importa desde el navegador.
  const bad = await commit([{ op: 'call', procedure: 'flow.import_board', args: {} }]);
  assert.notEqual(bad.status, 200);
});

test('avance · sin proyecto, la importación crea el flujo «avance» (para hacerlo todo por SQL) y devuelve su id', async () => {
  const out = (await app.t.db.query<{ out: any }>(`select flow.import_board(null, $1::jsonb) as out`, [JSON.stringify({ name: 'Avance por aplicaciones', cards: [
    { card_id: uuid(), lane_key: 'victor', title: 'Probar la mudanza', status: 'pending' }] })])).rows[0]!.out;
  assert.match(out.project_id, /^[0-9a-f-]{36}$/); assert.equal(out.cards, 1);
  const p = (await app.t.db.query<any>(`select name, template_key from flow.projects where id = $1`, [out.project_id])).rows[0];
  assert.deepEqual(p, { name: 'Avance por aplicaciones', template_key: 'avance' });
  const cols = (await app.t.db.query<any>(`select key from flow.columns where project_id = $1 and deleted_at is null`, [out.project_id])).rows;
  assert.deepEqual(cols.map((c: any) => c.key), ['avance']);
});

test('avance · las aplicaciones de una tarjeta (0959): board_card las pone, una recarga del tablero las conserva y null las quita', async () => {
  let r = await commit([{ op: 'call', procedure: PROCEDURES.boardCard, args: { project_id: BOARD, card_id: C4, lane_key: 'victor', apps: ['flow', 'finance'] } }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual((await unit(C4)).payload.apps, ['flow', 'finance']);
  await importBoard();
  assert.deepEqual((await unit(C4)).payload.apps, ['flow', 'finance']);
  const bad = await commit([{ op: 'call', procedure: PROCEDURES.boardCard, args: { project_id: BOARD, card_id: C4, apps: ['Flow!'] } }]);
  assert.equal(bad.status, 422, JSON.stringify(bad.data));
  r = await commit([{ op: 'call', procedure: PROCEDURES.boardCard, args: { project_id: BOARD, card_id: C4, apps: null } }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await unit(C4)).payload.apps, undefined);
});
