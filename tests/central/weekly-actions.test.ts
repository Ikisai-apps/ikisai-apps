/**
 * Central · acciones de la revisión semanal (1523; VG, vg-41): cada punto acaba en una decisión o en una tarea de Tasks
 * (kind `central.weekly_action`, con el token de la persona y referencia idempotente). Solo con la revisión abierta y solo
 * Dirección. Tasks simulado. Datos ficticios.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import { DECISIONS_TABLE, WEEKLY_ACTIONS_TABLE, WEEKLY_REVIEWS_TABLE, WEEKLY_TASK_KIND, validateOperations } from '../../supabase/functions/_domain/central/mod.ts';

const uuid = () => crypto.randomUUID();
const calls: Array<{ url: string; auth: string | null; body: any }> = [];
const taskIds = new Map<string, string>();
const tasksFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const body = JSON.parse(String(init?.body ?? '{}'));
  calls.push({ url, auth: new Headers(init?.headers).get('Authorization'), body });
  if (!taskIds.has(body.external_ref)) taskIds.set(body.external_ref, uuid());
  return Response.json({ created: true, routed: 'pending', task: { kind: 'task', id: taskIds.get(body.external_ref), title: body.title, revision: 1, pending: true } });
};

let app: TestApp;
let seq = 0;
const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `wa-${++seq}`, operations } });
const revision = async (id: string) => Number((await app.t.db.query<{ r: string }>(`select revision as r from central.weekly_reviews where id = $1`, [id])).rows[0]!.r);

test.before(async () => {
  app = await createTestApp({ app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!,
    createHandler: (c) => createCentralApp({ ...c, origins: [CENTRAL_ORIGINS[0]!] }, { tasksApiBase: 'https://tasks.example.invalid', tasksFetch }) });
});
test.after(async () => { await app.close(); });

test('acciones · dominio: una decisión lleva su decisión; una tarea, la que crea Tasks; solo Dirección', () => {
  const ins = (fields: Record<string, unknown>) => [{ op: 'insert', table: WEEKLY_ACTIONS_TABLE, id: 'a', fields: { review_id: uuid(), kpi: 'central.legal_overdue', label: 'Vencidas', ...fields } }];
  assert.equal(validateOperations(ins({ kind: 'decision', decision_id: uuid() }), { role: 'owner' }), null);
  assert.equal(validateOperations(ins({ kind: 'decision' }), { role: 'owner' })?.details.field, 'decision_id');
  assert.equal(validateOperations(ins({ kind: 'task' }), { role: 'owner' })?.details.field, 'task_target_id');
  assert.equal(validateOperations(ins({ kind: 'decision', decision_id: uuid() }), { role: 'editor' })?.code, 'FORBIDDEN');
});

test('acciones · decisión enlazada y tarea pedida a Tasks en una revisión abierta; cerrada, ya no', async () => {
  const review = uuid();
  const decision = uuid();
  const setup = await commit([
    { op: 'insert', table: WEEKLY_REVIEWS_TABLE, id: review, fields: { week: '2026-W45' } },
    { op: 'insert', table: DECISIONS_TABLE, id: decision, fields: { decided_on: '2026-11-02', name: 'Revisar vencimientos cada lunes', summary: 'Dirección revisa los vencimientos cada lunes.' } },
  ]);
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  const [r] = (await app.t.db.query<{ code: string }>(`select code from central.weekly_reviews where id = $1`, [review])).rows;

  const linked = await commit([{ op: 'insert', table: WEEKLY_ACTIONS_TABLE, id: uuid(), fields: { review_id: review, kpi: 'central.legal_overdue', label: 'Vencidas', kind: 'decision', decision_id: decision } }]);
  assert.equal(linked.status, 200, JSON.stringify(linked.data));

  const requestId = uuid();
  const body = { requestId, code: r!.code, kpi: 'central.legal_overdue', label: 'Vencidas', title: 'Semana 45: vencidas', note: 'Llamar a la gestoría' };
  const asked = await app.call(`/api/v1/weekly/${review}/task`, { body });
  assert.equal(asked.status, 200, JSON.stringify(asked.data));
  const sent = calls.at(-1)!;
  assert.equal(sent.url, 'https://tasks.example.invalid/api/v1/requests/task');
  assert.equal(sent.body.kind, WEEKLY_TASK_KIND);
  assert.equal(sent.body.source, 'central');
  assert.match(sent.body.external_ref, /^RSM_\d{4}_\d{3}:/);
  assert.equal(sent.auth, 'Bearer ' + app.tokens.owner, 'con el token de la persona');
  // Repetir con el mismo requestId no duplica la acción.
  assert.equal((await app.call(`/api/v1/weekly/${review}/task`, { body })).status, 200);
  const rows = (await app.t.db.query<{ kind: string }>(`select kind from central.weekly_actions where review_id = $1 and deleted_at is null order by kind`, [review])).rows.map((x) => x.kind);
  assert.deepEqual(rows, ['decision', 'task']);

  // El editor sin ámbito de Dirección no pide tareas.
  assert.equal((await app.call(`/api/v1/weekly/${review}/task`, { token: app.tokens.editor, body: { ...body, requestId: uuid() } })).status, 403);

  // Cerrada la revisión, ya no admite acciones.
  const closed = await commit([{ op: 'update', table: WEEKLY_REVIEWS_TABLE, id: review, expectedRevision: await revision(review), fields: { status: 'cerrada', held_on: '2026-11-03' } }]);
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  const late = await commit([{ op: 'insert', table: WEEKLY_ACTIONS_TABLE, id: uuid(), fields: { review_id: review, kpi: 'central.legal_overdue', label: 'Vencidas', kind: 'decision', decision_id: decision } }]);
  assert.equal(late.status, 422, JSON.stringify(late.data));
  assert.equal((late.data as { error: { code: string } }).error.code, 'REVIEW_CLOSED');
});
