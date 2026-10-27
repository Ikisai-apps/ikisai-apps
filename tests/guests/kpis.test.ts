/**
 * Guests · indicadores del portal para el panel de Dirección de Central (P7; API.md §9.20, migración 0601): entradas al
 * portal, partes firmados y sin firmar y partes enviados a SES, por retiro y sin datos de nadie. Solo el owner de Central.
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

test('indicadores · entradas, firmas y SES de los retiros de ahora; muestra y equipo no cuentan; solo el owner de Central', async () => {
  const db = app.t.db;
  const today = (await db.query<{ d: string }>(`select ((now() at time zone 'Europe/Madrid')::date)::text d`)).rows[0]!.d;
  const plus = (days: number) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  const retreat = async (start: number, end: number) => {
    const res = (await db.query<{ id: string }>(`insert into booking.reservations (title, status, start_date, end_date, expected_guests) values ('Retiro KPI', 'confirmada', $1, $2, 5) returning id`, [plus(start), plus(end)])).rows[0]!.id;
    return (await db.query<{ id: string }>(`insert into booking.events (reservation_id) values ($1) returning id`, [res])).rows[0]!.id;
  };
  const guest = (event: string, fields: Record<string, unknown> = {}) => {
    const cols = ['event_id', 'first_name', ...Object.keys(fields)];
    return db.query(`insert into booking.guests (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, [event, 'Prueba', ...Object.values(fields)]);
  };

  // En curso (empezó hace 2 días): entró, firmó y está comunicado; entró, sin firmar y llegado sin comunicar; no entró.
  const now = await retreat(-2, 1);
  const ack = new Date().toISOString();
  await guest(now, { privacy_ack_at: ack, signed_at: ack, arrived_at: ack, ses_status: 'enviado_SES', ses_sent_at: ack });
  await guest(now, { privacy_ack_at: ack, arrived_at: ack });
  await guest(now);
  // La huésped de muestra y una ficha de equipo no cuentan.
  await guest(now, { preview: true, privacy_ack_at: ack });
  await guest(now, { portal_role: 'staff', privacy_ack_at: ack });
  // Un retiro dentro de 40 días queda fuera de la ventana.
  await guest(await retreat(40, 42), { privacy_ack_at: ack });

  const owner = await app.t.createUser();
  await db.query(`insert into core.memberships (app, user_id, role) values ('central', $1, 'owner')`, [owner]);
  const out = (await app.t.rpc('core_read', { p_app: 'central', p_actor: owner, p_name: 'guests.central_kpi_projection', p_args: { limit: 500 } })) as any;
  const rows = out.rows as Array<Record<string, any>>;
  const value = (kpi: string) => Number(rows.find((r) => r.kpi === kpi)!.value);
  assert.equal(value('guests.portal_entered'), 2);
  assert.equal(value('guests.portal_entered_pct'), 66.7);
  assert.equal(value('guests.signatures_done'), 1);
  assert.equal(value('guests.signatures_pending'), 2);
  assert.equal(value('guests.retreats_signatures_pending'), 1);
  assert.equal(value('guests.ses_sent_30d'), 1);
  assert.equal(value('guests.retreats_ses_pending'), 1);
  assert.ok(rows.every((r) => r.period === 'actual' && typeof r.label === 'string' && r.label.length <= 60));
  assert.deepEqual(Object.keys(rows[0]!).sort(), ['computed_at', 'direction', 'kpi', 'label', 'link', 'period', 'period_end', 'period_start', 'unit', 'value']);

  // Un lector de Central no la ve.
  const reader = await app.t.createUser();
  await db.query(`insert into core.memberships (app, user_id, role) values ('central', $1, 'reader')`, [reader]);
  await assert.rejects(app.t.rpc('core_read', { p_app: 'central', p_actor: reader, p_name: 'guests.central_kpi_projection', p_args: {} }));
});
