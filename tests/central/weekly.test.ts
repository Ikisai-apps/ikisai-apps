/**
 * Central · revisión semanal de Dirección (C01, 1521; VG 27-10): una por semana; la preparan el owner y el editor con ámbito
 * `direccion`; al cerrar se guarda la foto de lo que está en crítico o en atención, que después no cambia. Datos ficticios.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import {
  WEEKLY_ITEMS_TABLE, WEEKLY_REVIEWS_TABLE, canPrepareReview, formatWeek, isoWeek, previousNote, validateOperations, weeklySnapshot,
} from '../../supabase/functions/_domain/central/mod.ts';

let app: TestApp;
let seq = 0;
const uuid = () => crypto.randomUUID();
const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `wk-${++seq}`, operations } });
const revision = async (id: string) => Number((await app.t.db.query<{ r: string }>(`select revision as r from central.weekly_reviews where id = $1`, [id])).rows[0]!.r);
const code = (out: { data: unknown }) => (out.data as { error?: { code: string } }).error?.code;
const item = (review: string, kpi: string, state = 'critico') => ({ op: 'insert', table: WEEKLY_ITEMS_TABLE, id: uuid(), fields: { review_id: review, app: 'central', kpi, label: 'Indicador ficticio', period: 'actual', value: 3, unit: 'count', target: 0, state, note: 'Revisar' } });

test.before(async () => {
  app = await createTestApp({ app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!, createHandler: (c) => createCentralApp({ ...c, origins: [CENTRAL_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });

test('semana · dominio: semana ISO, quién la prepara, qué entra en la foto y la nota de la semana anterior', () => {
  assert.equal(isoWeek('2026-10-27'), '2026-W44');
  assert.equal(isoWeek('2026-01-01'), '2026-W01');
  assert.equal(isoWeek('2021-01-03'), '2020-W53');
  assert.equal(formatWeek('2026-W44'), 'Semana 44 de 2026');
  assert.equal(canPrepareReview({ role: 'owner' }), true);
  assert.equal(canPrepareReview({ role: 'editor' }), false);
  assert.equal(canPrepareReview({ role: 'editor', scopes: { direccion: true } }), true);
  assert.equal(canPrepareReview({ role: 'reader', scopes: { direccion: true } }), false);
  const kpi = (k: string, state: string | null, app = 'central') => ({ app, kpi: k, label: k, period: 'actual', value: 1, unit: 'count', target: null, state });
  assert.deepEqual(weeklySnapshot([kpi('a.ok', 'ok'), kpi('b.at', 'atencion'), kpi('c.cr', 'critico'), kpi('d.none', null)]).map((i) => i.kpi), ['c.cr', 'b.at']);
  const reviews = [{ id: 'r1', week: '2026-W42', status: 'cerrada' }, { id: 'r2', week: '2026-W43', status: 'cerrada' }, { id: 'r3', week: '2026-W44', status: 'abierta' }];
  const items = [{ review_id: 'r1', kpi: 'x.y', note: 'La de hace dos' }, { review_id: 'r2', kpi: 'x.y', note: '  ' }];
  assert.equal(previousNote(reviews, items, '2026-W44', 'x.y'), 'La de hace dos', 'sin nota la semana pasada, la anterior que la tenga');
  assert.equal(validateOperations([{ op: 'insert', table: WEEKLY_REVIEWS_TABLE, id: 'w', fields: { week: '2026-W44' } }], { role: 'editor' })?.code, 'FORBIDDEN');
  assert.equal(validateOperations([{ op: 'insert', table: WEEKLY_REVIEWS_TABLE, id: 'w', fields: { week: '2026-44' } }], { role: 'owner' })?.details.field, 'week');
});

test('semana · base: el owner la empieza y la cierra con su foto; el editor sin ámbito no; con ámbito sí; cerrada no cambia', async () => {
  const review = uuid();
  const started = await commit([{ op: 'insert', table: WEEKLY_REVIEWS_TABLE, id: review, fields: { week: '2026-W44' } }]);
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const [row] = (await app.t.db.query<{ code: string }>(`select code from central.weekly_reviews where id = $1`, [review])).rows;
  assert.match(row!.code, /^RSM_\d{4}_\d{3}$/);
  // Una por semana.
  const twice = await commit([{ op: 'insert', table: WEEKLY_REVIEWS_TABLE, id: uuid(), fields: { week: '2026-W44' } }]);
  assert.notEqual(twice.status, 200);

  // El editor sin ámbito de Dirección: ni por la Edge ni saltándosela.
  const byEditor = await commit([{ op: 'update', table: WEEKLY_REVIEWS_TABLE, id: review, expectedRevision: await revision(review), fields: { summary: 'Del editor' } }], app.tokens.editor);
  assert.equal(byEditor.status, 403, JSON.stringify(byEditor.data));
  await assert.rejects(
    app.t.rpc('core_commit', { p_app: 'central', p_actor: app.users.editor, p_request_id: `wk-direct-${uuid()}`, p_digest: 'wk', p_expected_cursor: null,
      p_operations: [{ op: 'update', table: WEEKLY_REVIEWS_TABLE, id: review, expectedRevision: await revision(review), fields: { summary: 'Directo' } }] }),
    (error: any) => error.code === 'FORBIDDEN',
  );
  // Con el ámbito, sí.
  await app.t.db.query(`update core.memberships set scopes = coalesce(scopes, '{}'::jsonb) || '{"direccion": true}'::jsonb where app = 'central' and user_id = $1`, [app.users.editor]);
  const withScope = await commit([{ op: 'update', table: WEEKLY_REVIEWS_TABLE, id: review, expectedRevision: await revision(review), fields: { summary: 'Semana tranquila' } }], app.tokens.editor);
  assert.equal(withScope.status, 200, JSON.stringify(withScope.data));

  // Cerrar: la revisión y su foto en un lote.
  const closed = await commit([
    { op: 'update', table: WEEKLY_REVIEWS_TABLE, id: review, expectedRevision: await revision(review), fields: { status: 'cerrada', held_on: '2026-10-27' } },
    item(review, 'central.legal_overdue'), item(review, 'central.people_records_expired', 'atencion'),
  ]);
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  const [n] = (await app.t.db.query<{ n: string }>(`select count(*) as n from central.weekly_review_items where review_id = $1`, [review])).rows;
  assert.equal(Number(n!.n), 2);
  // Cerrada, su foto no cambia.
  const late = await commit([item(review, 'central.risks_high_open')]);
  assert.equal(late.status, 422, JSON.stringify(late.data));
  assert.equal(code(late), 'REVIEW_CLOSED');
});
