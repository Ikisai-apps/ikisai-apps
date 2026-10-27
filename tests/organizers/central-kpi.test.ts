/**
 * Organizers · indicadores para el panel de Dirección de Central (P7; API.md §22, migración 0705): retiros próximos con y
 * sin acceso de quien organiza, comentarios de asistentes abiertos e informes enviados. Solo agregados.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

let app: TestApp;
test.before(async () => {
  app = await createTestApp({
    app: 'tasks', slug: 'tasks-api', origin: 'https://tasks.ikisai.com',
    createHandler: (config) => createApp({ ...config, app: 'tasks', slug: 'tasks-api' }),
  });
});
test.after(async () => { await app.close(); });

test('indicadores · retiros próximos con y sin quien organiza, comentarios abiertos e informes; los lee Central', async () => {
  const db = app.t.db;
  const today = (await db.query<{ d: string }>(`select ((now() at time zone 'Europe/Madrid')::date)::text d`)).rows[0]!.d;
  const plus = (days: number) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  const retreat = async (start: number, status = 'confirmada') => (await db.query<{ id: string }>(
    `insert into booking.reservations (title, status, start_date, end_date, expected_guests) values ('Retiro KPI', $1, $2, $3, 5) returning id`,
    [status, plus(start), plus(start + 2)])).rows[0]!.id;
  const staff = await app.t.createUser();
  const organizer = await app.t.createUser();
  let n = 0;
  const link = (reservation: string, revoked = false) => db.query(
    `insert into core.portal_links (app, user_id, digest, scope, created_by, issuer_app, revoked_at) values ('organizers', $1, $2, $3, $4, 'booking', $5)`,
    [organizer, (++n).toString(16).padStart(64, '0'), JSON.stringify({ reservation_id: reservation }), staff, revoked ? new Date().toISOString() : null]);
  const report = (app_: string, subject: string, destination: string, status = 'open', daysAgo = 1) => db.query(
    `insert into core.feedback_reports (id, code, request_id, digest, reporter_user_id, reporter_kind, origin_app, subject, intent, message, destination, routing_status, status, created_at)
     values (gen_random_uuid(), $1, $1, 'd', $2, $3, $4, $5, 'suggestion', 'Comentario sintético', $6, 'none', $7, now() - make_interval(days => $8))`,
    [`FB_KPI_${++n}`, organizer, app_ === 'guests' ? 'guest' : 'organizer', app_, subject, destination, status, daysAgo]);

  await link(await retreat(5));                    // con acceso
  await link(await retreat(12));                   // con acceso
  const revoked = await retreat(20); await link(revoked, true); // solo un enlace revocado: sin acceso
  await retreat(25);                               // sin enlace
  await link(await retreat(40));                   // fuera de los 30 días
  await link(await retreat(8, 'pre_reservada'));   // aún no confirmado: fuera

  await report('guests', 'event', 'organizer');
  await report('guests', 'event', 'organizer');
  await report('guests', 'event', 'organizer', 'dismissed');
  await report('guests', 'event', 'organizer', 'open', 45);  // hace más de 30 días
  await report('guests', 'application', 'qa');                // de la app, no del retiro
  await report('organizers', 'application', 'qa');
  await report('organizers', 'event', 'operations', 'verified');

  const owner = await app.t.createUser();
  await db.query(`insert into core.memberships (app, user_id, role) values ('central', $1, 'reader')`, [owner]);
  const out = (await app.t.rpc('core_read', { p_app: 'central', p_actor: owner, p_name: 'organizers.central_kpi_projection', p_args: { limit: 500 } })) as any;
  const rows = out.rows as Array<Record<string, any>>;
  const value = (kpi: string) => Number(rows.find((r) => r.kpi === kpi)!.value);
  assert.equal(value('organizers.retreats_next_30d'), 2);
  assert.equal(value('organizers.retreats_without_access'), 2);
  assert.equal(value('organizers.guest_comments_open_30d'), 2);
  assert.equal(value('organizers.reports_sent_30d'), 2);
  assert.ok(rows.every((r) => r.period === 'actual' && typeof r.label === 'string' && r.label.length <= 60 && r.unit === 'count'));
  assert.deepEqual(Object.keys(rows[0]!).sort(), ['computed_at', 'direction', 'kpi', 'label', 'link', 'period', 'period_end', 'period_start', 'unit', 'value']);
  assert.equal(JSON.stringify(rows).includes('Comentario sintético'), false, 'sin textos de nadie');
});
