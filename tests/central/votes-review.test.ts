/**
 * Central · tanda 27 (migración 1512): votos de Decisiones (vota todo el equipo, también quien solo lee; decide quien
 * administra) y pantallas de Revisión (los diez pasos del cuadro y el feedback unido a su pantalla). Datos ficticios.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import {
  DECISIONS_TABLE, DECISION_VOTES_TABLE, REVIEW_SCREENS_TABLE, decisionTrail, decisionsToDecide, decisionsToVote, myVote, recentDecisions,
  reviewProgress, screenOfReport, screensToAct, sortScreens, stepCounts, validateOperations, voteTally,
} from '../../supabase/functions/_domain/central/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
const commit = (operations: unknown[], token = app.tokens.owner) => app.call('/api/v1/commands', { token, body: { requestId: `t27-${++seq}`, operations } });
const row = async (table: string, id: string) => (await app.t.db.query<any>(`select * from ${table} where id = $1`, [id])).rows[0];
const code = (res: { status: number; data: any }) => res.data?.error?.code;

test.before(async () => {
  app = await createTestApp({ app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!, createHandler: (c) => createCentralApp({ ...c, origins: [CENTRAL_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });

async function decision(fields: Record<string, unknown> = {}) {
  const id = uuid();
  const res = await commit([{ op: 'insert', table: DECISIONS_TABLE, id, fields: { decided_on: '2026-10-01', name: 'Decisión ficticia', summary: 'Resumen ficticio.', ...fields } }]);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return id;
}

// El lector vota (decisión de VG): la tabla ya lo admite (`writable_roles` con reader), pero el kit y `core.commit` aún no
// dejan escribir a ningún lector. Petición P10 a Core; mientras tanto, esta prueba queda pendiente.
test('votos · el lector vota su propio voto y nada más', { todo: 'P10: el núcleo aún no deja escribir al lector' }, async () => {
  const id = await decision();
  const voteId = uuid();
  const ok = await commit([{ op: 'insert', table: DECISION_VOTES_TABLE, id: voteId, fields: { decision_id: id, vote: 'retirar' } }], app.tokens.reader);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await row('central.decision_votes', voteId)).voter_id, app.users.reader);
  assert.equal((await commit([{ op: 'insert', table: DECISIONS_TABLE, id: uuid(), fields: { decided_on: '2026-10-02', name: 'x', summary: 'x' } }], app.tokens.reader)).status, 403);
});

test('votos · el voto es de quien lo pone, uno por persona, y nadie cambia el de otro', async () => {
  const id = await decision();
  const voteId = uuid();
  const ok = await commit([{ op: 'insert', table: DECISION_VOTES_TABLE, id: voteId, fields: { decision_id: id, vote: 'retirar' } }], app.tokens.editor);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const vote = await row('central.decision_votes', voteId);
  assert.equal(vote.voter_id, app.users.editor);
  // Cambiar de opinión es cambiar el voto.
  const changed = await commit([{ op: 'update', table: DECISION_VOTES_TABLE, id: voteId, expectedRevision: 1, fields: { vote: 'mantener' } }], app.tokens.editor);
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  // No se escribe quién vota: lo pone el servidor.
  const spoof = await commit([{ op: 'insert', table: DECISION_VOTES_TABLE, id: uuid(), fields: { decision_id: id, vote: 'retirar', voter_id: app.users.owner } }], app.tokens.owner);
  assert.notEqual(spoof.status, 200);
  // Un segundo voto vivo de la misma persona: no.
  const twice = await commit([{ op: 'insert', table: DECISION_VOTES_TABLE, id: uuid(), fields: { decision_id: id, vote: 'retirar' } }], app.tokens.editor);
  assert.notEqual(twice.status, 200);
  // Ni el owner cambia ni borra el voto de otra persona.
  const other = await commit([{ op: 'update', table: DECISION_VOTES_TABLE, id: voteId, expectedRevision: 2, fields: { vote: 'retirar' } }], app.tokens.owner);
  assert.equal(other.status, 403, JSON.stringify(other.data));
  const del = await commit([{ op: 'delete', table: DECISION_VOTES_TABLE, id: voteId, expectedRevision: 2 }], app.tokens.owner);
  assert.equal(del.status, 403, JSON.stringify(del.data));
  // Quien votó sí lo retira.
  assert.equal((await commit([{ op: 'delete', table: DECISION_VOTES_TABLE, id: voteId, expectedRevision: 2 }], app.tokens.editor)).status, 200);
  // Todos leen los votos.
  for (const role of ['reader', 'editor', 'owner']) {
    const snap = await app.t.rpc('core_snapshot_table', { p_app: 'central', p_role: role, p_table: DECISION_VOTES_TABLE, p_include_deleted: true, p_limit: 100, p_offset: 0 }) as { rows: any[] };
    assert.ok(snap.rows.some((r) => r.id === voteId), role);
  }
});

test('votos · solo en decisiones vigentes', async () => {
  const id = await decision({ status: 'revocada' });
  const res = await commit([{ op: 'insert', table: DECISION_VOTES_TABLE, id: uuid(), fields: { decision_id: id, vote: 'retirar' } }], app.tokens.editor);
  assert.equal(code(res), 'DECISION_NOT_VOTABLE', JSON.stringify(res.data));
  // Y en la base, aunque la Edge no lo viera (sin espejo).
  await assert.rejects(app.t.db.query(`insert into central.decision_votes (decision_id, voter_id, vote, updated_by) values ($1, $2, 'retirar', $2)`, [id, app.users.editor]), /DECISION_NOT_VOTABLE/);
});

test('decisión final · solo el owner; queda quién, cuándo y con qué votación; «Retirar» la revoca', async () => {
  const id = await decision();
  const second = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('central', $1, 'editor')`, [second]);
  const secondToken = app.supabase.tokenFor(second);
  for (const [token, vote] of [[secondToken, 'retirar'], [app.tokens.editor, 'retirar'], [app.tokens.owner, 'mantener']] as const) {
    assert.equal((await commit([{ op: 'insert', table: DECISION_VOTES_TABLE, id: uuid(), fields: { decision_id: id, vote } }], token)).status, 200);
  }
  // Una decisión nueva no nace decidida.
  const born = await commit([{ op: 'insert', table: DECISIONS_TABLE, id: uuid(), fields: { decided_on: '2026-10-03', name: 'x', summary: 'x', review_outcome: 'mantener' } }]);
  assert.equal(born.status, 422, JSON.stringify(born.data));
  // El editor no decide.
  const editor = await commit([{ op: 'update', table: DECISIONS_TABLE, id, expectedRevision: 1, fields: { review_outcome: 'retirar' } }], app.tokens.editor);
  assert.equal(editor.status, 403, JSON.stringify(editor.data));
  // Aunque el editor se salte la validación de la Edge, la base lo impide.
  await app.t.db.query(`select set_config('core.actor', $1, false)`, [app.users.editor]);
  await assert.rejects(app.t.db.query(`update central.decisions set review_outcome = 'retirar' where id = $1`, [id]), /FORBIDDEN/);
  await app.t.db.query(`select set_config('core.actor', '', false)`);
  // El editor sí edita lo de siempre sin tocar la decisión final.
  assert.equal((await commit([{ op: 'update', table: DECISIONS_TABLE, id, expectedRevision: 1, fields: { name: 'Decisión ficticia editada' } }], app.tokens.editor)).status, 200);

  const keep = await commit([{ op: 'update', table: DECISIONS_TABLE, id, expectedRevision: 2, fields: { review_outcome: 'mantener' } }]);
  assert.equal(keep.status, 200, JSON.stringify(keep.data));
  let d = await row('central.decisions', id);
  assert.equal(d.status, 'vigente');
  assert.equal(d.reviewed_by, app.users.owner);
  assert.ok(d.reviewed_at);
  assert.deepEqual(d.review_tally, { mantener: 1, retirar: 2 });
  const first = new Date(d.reviewed_at).toISOString();

  // Volver a decidir lo mismo más tarde: con `reviewed_at`, la hora la pone el servidor.
  const again = await commit([{ op: 'update', table: DECISIONS_TABLE, id, expectedRevision: 3, fields: { review_outcome: 'mantener', reviewed_at: '2000-01-01T00:00:00Z' } }]);
  assert.equal(again.status, 200, JSON.stringify(again.data));
  d = await row('central.decisions', id);
  assert.ok(new Date(d.reviewed_at).toISOString() >= first);
  assert.notEqual(new Date(d.reviewed_at).getUTCFullYear(), 2000);

  const retire = await commit([{ op: 'update', table: DECISIONS_TABLE, id, expectedRevision: 4, fields: { review_outcome: 'retirar' } }]);
  assert.equal(retire.status, 200, JSON.stringify(retire.data));
  d = await row('central.decisions', id);
  assert.equal(d.status, 'revocada');
  assert.equal(d.review_outcome, 'retirar');
  // Revocada, ya no se vota.
  const late = await commit([{ op: 'insert', table: DECISION_VOTES_TABLE, id: uuid(), fields: { decision_id: id, vote: 'mantener' } }], secondToken);
  assert.equal(code(late), 'DECISION_NOT_VOTABLE', JSON.stringify(late.data));

  // Si alguien la vuelve a poner vigente, deja de constar como retirada; lo último decidido se queda.
  const back = await commit([{ op: 'update', table: DECISIONS_TABLE, id, expectedRevision: 5, fields: { status: 'vigente' } }], app.tokens.editor);
  assert.equal(back.status, 200, JSON.stringify(back.data));
  d = await row('central.decisions', id);
  assert.equal(d.status, 'vigente');
  assert.equal(d.review_outcome, null);
  assert.equal(d.reviewed_by, app.users.owner);
  // Lo que escribe el servidor no lo escribe nadie más.
  assert.notEqual((await commit([{ op: 'update', table: DECISIONS_TABLE, id, expectedRevision: 6, fields: { review_tally: { mantener: 9, retirar: 0 } } }])).status, 200);
});

test('pantallas de Revisión · escribe solo el owner, leen todos; pasos y enlaces validados', async () => {
  const id = uuid();
  const fields = { app: 'central', name: 'Cumplimiento · Vencimientos', step: 'listo', route: '#/cumplimiento', feedback_prefix: 'central.cumplimiento', handoff: 'MUELA-069', url: 'https://example.invalid/demo' };
  assert.equal((await commit([{ op: 'insert', table: REVIEW_SCREENS_TABLE, id, fields }])).status, 200);
  assert.equal((await commit([{ op: 'insert', table: REVIEW_SCREENS_TABLE, id: uuid(), fields: { ...fields, name: 'Otra' } }], app.tokens.editor)).status, 403);
  assert.equal((await commit([{ op: 'insert', table: REVIEW_SCREENS_TABLE, id: uuid(), fields: { ...fields, name: 'Otra' } }], app.tokens.reader)).status, 403);
  for (const [field, value] of [['step', 'listisimo'], ['app', 'marte'], ['route', '/cumplimiento'], ['url', 'http://x'], ['feedback_prefix', 'Central.X']] as const) {
    const res = await commit([{ op: 'insert', table: REVIEW_SCREENS_TABLE, id: uuid(), fields: { ...fields, name: `Mal ${field}`, [field]: value } }]);
    assert.equal(res.status, 422, `${field}: ${JSON.stringify(res.data)}`);
  }
  // El mismo nombre dos veces en la misma app: no.
  assert.notEqual((await commit([{ op: 'insert', table: REVIEW_SCREENS_TABLE, id: uuid(), fields: { ...fields, name: 'cumplimiento · vencimientos' } }])).status, 200);
  for (const role of ['reader', 'editor']) {
    const snap = await app.t.rpc('core_snapshot_table', { p_app: 'central', p_role: role, p_table: REVIEW_SCREENS_TABLE, p_include_deleted: false, p_limit: 100, p_offset: 0 }) as { rows: any[] };
    assert.ok(snap.rows.some((r) => r.id === id), role);
  }
});

test('dominio · votos: recuento, mi voto, lo que toca decidir, por votar, recientes y rastro', () => {
  const D = (id: string, decided_on: string, extra: Record<string, unknown> = {}) => ({ id, code: id, name: id, summary: 's', status: 'vigente', decided_on, ...extra });
  const rows = [
    D('a', '2026-10-01', { reviewed_at: '2026-10-10T10:00:00Z' }), D('b', '2026-10-02'), D('c', '2026-10-03'),
    D('d', '2026-10-04', { status: 'revocada' }), D('e', '2026-10-05', { deleted_at: '2026-10-06T00:00:00Z' }), D('f', '2026-09-01'),
  ];
  const V = (decision_id: string, voter_id: string, vote: string, updated_at = '2026-10-09T00:00:00Z', deleted_at: string | null = null) => ({ decision_id, voter_id, vote, updated_at, deleted_at });
  const votes = [
    V('a', 'u1', 'retirar'), V('a', 'u2', 'retirar'), V('a', 'u3', 'retirar', '2026-10-11T00:00:00Z'),
    V('b', 'u1', 'retirar'), V('b', 'u2', 'mantener'), V('b', 'u3', 'retirar'),
    V('c', 'u1', 'retirar'), V('c', 'u2', 'retirar', '2026-10-09T00:00:00Z', '2026-10-09T01:00:00Z'),
    V('d', 'u1', 'retirar'),
  ];
  assert.deepEqual(voteTally(votes, 'a'), { mantener: 0, retirar: 3 });
  assert.deepEqual(voteTally(votes, 'a', '2026-10-10T10:00:00Z'), { mantener: 0, retirar: 1 });
  assert.deepEqual(voteTally(votes, 'c'), { mantener: 0, retirar: 1 }, 'el voto retirado no cuenta');
  assert.equal(myVote(votes, 'b', 'u2'), 'mantener');
  assert.equal(myVote(votes, 'c', 'u2'), null);
  // b (+1, la más reciente de las de +1), c (+1) y a (+1 tras su decisión final); d está revocada.
  assert.deepEqual(decisionsToDecide(rows, votes).map((d) => d.id), ['c', 'b', 'a']);
  assert.deepEqual(decisionsToDecide(rows, votes.filter((v) => v.updated_at < '2026-10-10')).map((d) => d.id), ['c', 'b'], 'tras «Mantener», a sale del foco');
  assert.deepEqual(decisionsToVote(rows, votes, 'u2').map((d) => d.id), ['c', 'f']);
  assert.deepEqual(recentDecisions(rows).map((d) => d.id), ['c', 'b', 'a']);

  const chain = [
    { ...D('v1', '2026-01-01', { status: 'sustituida', superseded_by: 'v2' }) }, { ...D('v2', '2026-02-01', { status: 'sustituida', superseded_by: 'v3' }) },
    { ...D('v3', '2026-03-01') }, { ...D('x1', '2026-01-01', { status: 'sustituida', superseded_by: 'x2' }) },
    { ...D('x2', '2026-01-02', { status: 'sustituida', superseded_by: 'x1' }) },
  ];
  assert.deepEqual(decisionTrail(chain, 'v2').map((d) => d.id), ['v1', 'v2', 'v3']);
  assert.deepEqual(decisionTrail(chain, 'v3').map((d) => d.id), ['v1', 'v2', 'v3']);
  assert.deepEqual(decisionTrail(chain, 'x1').map((d) => d.id), ['x2', 'x1'], 'a prueba de ciclos');
  assert.deepEqual(decisionTrail(chain, 'nada'), []);
});

test('dominio · decisión final y votos en la validación del cliente', () => {
  const d1 = uuid(), d2 = uuid();
  const current = (table: string, id: string) => (table === DECISIONS_TABLE ? ({ [d1]: { status: 'vigente', review_outcome: null }, [d2]: { status: 'revocada' } } as Record<string, any>)[id] : undefined);
  const decide = (role: string, fields: Record<string, unknown>) => validateOperations([{ op: 'update', table: DECISIONS_TABLE, id: d1, fields }], { role }, current);
  assert.equal(decide('editor', { review_outcome: 'retirar' })?.code, 'FORBIDDEN');
  assert.equal(decide('editor', { review_outcome: null }), null, 'reenviar lo mismo no es decidir');
  assert.equal(decide('owner', { review_outcome: 'retirar' }), null);
  assert.equal(decide('owner', { reviewed_at: 'ayer' })?.details.field, 'reviewed_at');
  assert.equal(validateOperations([{ op: 'insert', table: DECISION_VOTES_TABLE, id: 'v', fields: { decision_id: d2, vote: 'retirar' } }], { role: 'reader' }, current)?.code, 'DECISION_NOT_VOTABLE');
  assert.equal(validateOperations([{ op: 'insert', table: DECISION_VOTES_TABLE, id: 'v', fields: { decision_id: d1, vote: 'quizá' } }], { role: 'reader' }, current)?.details.field, 'vote');
  assert.equal(validateOperations([{ op: 'update', table: DECISION_VOTES_TABLE, id: 'v', fields: { decision_id: d2 } }], { role: 'reader' }, current)?.code, 'IMMUTABLE_FIELD');
  assert.equal(validateOperations([{ op: 'insert', table: REVIEW_SCREENS_TABLE, id: 's', fields: { app: 'central', name: 'x' } }], { role: 'editor' })?.code, 'FORBIDDEN');
});

test('dominio · Revisión: orden, recuento por paso, avance, lo que te toca y el feedback unido a su pantalla', () => {
  const S = (id: string, app: string, step: string, extra: Record<string, unknown> = {}) => ({ id, app, name: id, step, position: 0, ...extra });
  const screens = [
    S('inicio', 'central', 'hecha', { route: '#/', position: 1 }), S('cumpl', 'central', 'listo', { route: '#/cumplimiento', feedback_prefix: 'central.cumplimiento', position: 2 }),
    S('ficha', 'central', 'alt', { route: '#/cumplimiento/ficha', feedback_prefix: 'central.cumplimiento.obligacion', position: 3 }),
    S('menu', 'transversal', 'cons'), S('tareas', 'tasks', 'hecha'), S('vieja', 'central', 'alt', { deleted_at: '2026-10-01T00:00:00Z' }),
  ];
  assert.deepEqual(sortScreens(screens).map((s) => s.id), ['inicio', 'cumpl', 'ficha', 'tareas', 'menu']);
  const counts = stepCounts(screens);
  assert.equal(Object.keys(counts).length, 10);
  assert.deepEqual([counts.hecha, counts.listo, counts.alt, counts.cons, counts.sin], [2, 1, 1, 1, 0]);
  assert.deepEqual(reviewProgress(screens), { done: 2, total: 5 });
  assert.deepEqual(screensToAct(screens).map((s) => s.id), ['cumpl', 'ficha']);
  const of = (originApp: string, node: string | null, sourceRoute: string | null) => screenOfReport({ originApp, node: { id: node }, sourceRoute }, screens)?.id ?? null;
  assert.equal(of('central', 'central.cumplimiento.obligacion.editar', '#/'), 'ficha', 'el prefijo más largo');
  assert.equal(of('central', 'central.cumplimiento.vencimientos', null), 'cumpl');
  assert.equal(of('central', 'central.cumplimientos', '#/cumplimiento/abc'), 'cumpl', 'sin prefijo, por la ruta');
  assert.equal(of('central', null, '#/cumplimiento/ficha/1'), 'ficha');
  assert.equal(of('central', null, '#/cumplimientos'), null);
  assert.equal(of('tasks', 'central.cumplimiento', '#/cumplimiento'), null, 'solo pantallas de su app');
});
