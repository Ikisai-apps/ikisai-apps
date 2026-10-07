/** Uso semántico (contrato §3.8): totales diarios idempotentes, persona solo con aviso aceptado, catálogo, insights y permisos. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const BOOKING = 'https://booking.ikisai.com';
let app: TestApp;
const DEV = crypto.randomUUID();
const today = () => new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10);
const item = (featureId: string, over: Record<string, unknown> = {}) => ({ day: today(), featureId, generation: 1, context: 'production', exposures: 3, activations: 2, successes: 2, errors: 0, sessionsExposed: 1, sessionsActivated: 1, sessionsSucceeded: 1, repeatedAttempts: 0, ...over });

test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING, createHandler: (config) => createApp({ ...config, app: 'booking', slug: 'booking-api', origins: [BOOKING] }) });
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('central', $1, 'owner')`, [app.users.owner]);
});
test.after(async () => { await app.close(); });

test('uso · totales del día: el reintento no cuenta dos veces; sin aviso aceptado no hay persona', async () => {
  const send = (token: string, items: unknown[]) => app.call('/api/v1/usage/batch', { token, body: { deviceId: DEV, items } });
  assert.equal((await send(app.tokens.editor, [item('booking.reserva.guardar')])).data.accepted, 1);
  assert.equal((await send(app.tokens.editor, [item('booking.reserva.guardar')])).data.accepted, 1);
  let rows = await app.t.db.query<{ activations: number; user_key: string }>(`select activations, user_key::text from core.usage_daily where feature_id = 'booking.reserva.guardar'`);
  assert.equal(rows.rows.length, 1); assert.equal(rows.rows[0]!.activations, 2, 'máximo, no suma');
  assert.equal(rows.rows[0]!.user_key, '00000000-0000-0000-0000-000000000000', 'sin aviso aceptado: sin persona');
  assert.equal((await app.call('/api/v1/usage/consent', { token: app.tokens.editor, body: {} })).data.consentedAt !== null, true);
  await send(app.tokens.editor, [item('booking.reserva.guardar', { activations: 5 })]);
  rows = await app.t.db.query(`select activations, user_key::text from core.usage_daily where feature_id = 'booking.reserva.guardar' and user_key <> '00000000-0000-0000-0000-000000000000'`);
  assert.equal(rows.rows[0]!.user_key, app.users.editor); assert.equal(rows.rows[0]!.activations, 5);
  await send(app.tokens.editor, [item('booking.reserva.guardar', { context: 'qa', activations: 40 })]);
  const qa = await app.t.db.query<{ user_key: string }>(`select user_key::text from core.usage_daily where context = 'qa'`);
  assert.equal(qa.rows[0]!.user_key, '00000000-0000-0000-0000-000000000000', 'QA sin persona');
  assert.equal((await send(app.tokens.editor, [item('tasks.otra.cosa')])).status, 422, 'solo funciones de la propia app');
});

test('uso · catálogo de la publicación, insights y tarjeta solo para el owner del ecosistema', async () => {
  const ingest = await app.t.db.query<{ r: any }>(`select core.usage_catalog_ingest('booking', 'v1', $1::jsonb) r`, [JSON.stringify([
    { id: 'booking.reserva.guardar', label: 'Guardar reserva', kind: 'button' },
    { id: 'booking.reserva.nunca_vista', label: 'Botón escondido', kind: 'button' },
    { id: 'booking.ses.anular', label: 'Anular en SES', kind: 'button' },
  ])]);
  assert.equal(ingest.rows[0]!.r.features, 3);
  await app.t.db.exec(`update core.usage_features set generation_at = now() - interval '30 days'`);
  assert.equal((await app.call('/api/v1/usage/review', { token: app.tokens.editor })).status, 403);
  const review = await app.call('/api/v1/usage/review', { token: app.tokens.owner });
  assert.equal(review.status, 200, JSON.stringify(review.data));
  const by = (id: string) => review.data.items.find((i: any) => i.featureId === id);
  assert.equal(by('booking.reserva.nunca_vista').insight, 'POSSIBLY_INACCESSIBLE');
  await app.call('/api/v1/usage/features/booking.ses.anular/settings', { token: app.tokens.owner, body: { frequency: 'rare_critical' } });
  const again = await app.call('/api/v1/usage/review', { token: app.tokens.owner });
  assert.equal(again.data.items.find((i: any) => i.featureId === 'booking.ses.anular').insight, 'RARE_AS_EXPECTED');
  await app.call('/api/v1/usage/features/booking.reserva.nunca_vista/decision', { token: app.tokens.owner, body: { decision: 'keep', reviewAfter: '2099-01-01' } });
  const kept = await app.call('/api/v1/usage/review', { token: app.tokens.owner });
  assert.equal(kept.data.items.find((i: any) => i.featureId === 'booking.reserva.nunca_vista').insight, 'KEPT', 'una decisión evita alertas repetidas');
  const card = await app.call('/api/v1/usage/features/booking.reserva.guardar', { token: app.tokens.owner });
  assert.equal(card.status, 200); assert.equal(card.data.byPerson[0].userId, app.users.editor); assert.equal(card.data.byContext.qa, 40);
  // Retirada: la siguiente versión ya no declara una función.
  await app.t.db.query(`select core.usage_catalog_ingest('booking', 'v2', $1::jsonb)`, [JSON.stringify([{ id: 'booking.reserva.guardar', label: 'Guardar reserva' }, { id: 'booking.ses.anular', label: 'Anular en SES' }])]);
  const removed = await app.t.db.query<{ active: boolean; removed_release: string }>(`select active, removed_release from core.usage_features where feature_id = 'booking.reserva.nunca_vista'`);
  assert.deepEqual(removed.rows[0], { active: false, removed_release: 'v2' });
  assert.equal(await app.t.db.query(`select core.usage_bump_generation(array['booking.reserva.guardar'], 'v3') n`).then((r: any) => r.rows[0].n), 1);
});
