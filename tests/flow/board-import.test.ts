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
const history = async () => (await app.t.db.query<any>(`select * from flow.board_history where project_id = $1 order by t`, [BOARD])).rows;

test('avance · importar: hitos, tarjetas con paso e historial; un hito con todo hecho (sin contar backlog) queda cumplido', async () => {
  const out = await importBoard();
  assert.deepEqual(out, { hitos: 2, cards: 4, history: 2 });
  const h1 = await unit(H1); const h2 = await unit(H2);
  assert.equal(h1.class, 'objective'); assert.equal(h1.status, 'pending'); assert.equal(h1.payload.orden, 1);
  assert.equal(h2.status, 'done'); assert.equal(new Date(h2.done_at).toISOString(), '2026-10-27T18:00:00.000Z');
  const c2 = await unit(C2);
  assert.equal(c2.parent_id, H1); assert.equal(c2.payload.paso, 2); assert.equal(c2.prio, 'urgente'); assert.deepEqual(c2.payload.steps, ['Abrir', 'Cobrar']);
  assert.equal((await history()).length, 2);
  // Por el registro del núcleo: los móviles lo reciben al sincronizar.
  const logged = await app.t.db.query(`select 1 from core.changes where app = 'flow' and row_id = $1`, [C2]);
  assert.ok(logged.rows.length >= 1);
});

test('avance · importar otra vez no duplica nada', async () => {
  const before = (await app.t.db.query<{ n: number }>(`select count(*)::int n from flow.units where project_id = $1`, [BOARD])).rows[0]!.n;
  assert.deepEqual(await importBoard(), { hitos: 2, cards: 4, history: 0 });
  assert.equal((await app.t.db.query<{ n: number }>(`select count(*)::int n from flow.units where project_id = $1`, [BOARD])).rows[0]!.n, before);
  assert.equal((await history()).length, 2);
});

test('avance · al hacer el último paso el hito se cumple; al reabrirlo, vuelve; y queda foto en el historial', async () => {
  const before = (await history()).length;
  let r = await commit([{ op: 'call', procedure: PROCEDURES.boardCard, args: { project_id: BOARD, card_id: C2, lane_key: 'booking', status: 'done' } }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let h1 = await unit(H1);
  assert.equal(h1.status, 'done'); assert.ok(h1.done_at);
  assert.equal((await history()).length, before + 1);
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
  // Nadie importa desde el navegador.
  const bad = await commit([{ op: 'call', procedure: 'flow.import_board', args: {} }]);
  assert.notEqual(bad.status, 200);
});
