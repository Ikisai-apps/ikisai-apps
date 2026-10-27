/**
 * Flow · indicadores para Central (P7, migración 0950), sobre PGlite: `flow.central_kpi_projection` con el contrato de
 * docs/central/API.md §7.2, leída por un miembro de Central. Solo agregados de flujos activos y fuera del modo pruebas.
 * Los datos se siembran directamente (con fechas de días anteriores), sin pasar por los procedimientos. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
const uuid = () => crypto.randomUUID();
let app: TestApp;
let paySeq = 0;

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
});
test.after(async () => { await app.close(); });

async function kpis(): Promise<Record<string, any>> {
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('central', $1, 'reader')`, [user]);
  const out = (await app.t.rpc('core_read', { p_app: 'central', p_actor: user, p_name: 'flow.central_kpi_projection', p_args: { limit: 500 } })) as any;
  return Object.fromEntries((out.rows as any[]).map((r) => [r.kpi, r]));
}

test('flow · central_kpi_projection: ventas de ayer, cierres pendientes, pedidos sin entregar y existencias bajo umbral', async () => {
  const db = app.t.db;
  const before = await kpis();
  assert.deepEqual(Object.keys(before).sort(), ['flow.buffers_below_target', 'flow.day_closures_pending', 'flow.orders_unfinished_past', 'flow.sales_yesterday']);
  const s = before['flow.sales_yesterday'];
  assert.deepEqual([s.unit, s.period, s.direction, s.link], ['eur', 'actual', 'up', 'https://flow.ikisai.com/#/']);
  for (const k of ['flow.day_closures_pending', 'flow.orders_unfinished_past', 'flow.buffers_below_target']) assert.equal(before[k].direction, 'down');

  const live = uuid(), pruebas = uuid();
  const ago = (days: number) => `((now() at time zone 'Europe/Madrid')::date - ${days} + time '12:00') at time zone 'Europe/Madrid'`;
  await db.query(`set session_replication_role = replica`);
  try {
    await db.query(`insert into flow.projects (id, name) values ($1, 'Barra de prueba')`, [live]);
    await db.query(`insert into flow.projects (id, name, test_mode) values ($1, 'Modo pruebas', true)`, [pruebas]);
    // Ayer: dos cobros y una devolución en el flujo vivo (12,50 + 3,00 − 1,50); uno en modo pruebas que no cuenta.
    const order = async (project: string, days: number, status: 'paid' | 'delivered', cents: number[]) => {
      const id = uuid();
      await db.query(`insert into flow.orders (id, project_id, status, pay_seq, paid_at, total_cents, delivered_at, created_at)
                      values ($1, $2, $3, $4, ${ago(days)}, 0, case when $3 = 'delivered' then ${ago(days)} end, ${ago(days)})`, [id, project, status, ++paySeq]);
      for (const c of cents) await db.query(`insert into flow.payments (order_id, project_id, kind, method, amount_cents, created_at) values ($1, $4, $2, 'cash', $3, ${ago(days)})`, [id, c < 0 ? 'reversal' : 'charge', c, project]);
    };
    await order(live, 1, 'delivered', [1250, -150]);
    await order(live, 1, 'paid', [300]);
    await order(pruebas, 1, 'paid', [9900]);
    // Hace 3 días: vendido y cerrado; hace 40: fuera de la ventana.
    await order(live, 3, 'delivered', [500]);
    await db.query(`insert into flow.day_closures (project_id, day, data, closed_at) values ($1, (now() at time zone 'Europe/Madrid')::date - 3, '{}', now())`, [live]);
    await order(live, 40, 'delivered', [700]);
    // Hoy: cobrado sin entregar, aún no cuenta.
    await order(live, 0, 'paid', [200]);
    await db.query(`insert into flow.buffers (project_id, key, item_key, name, unit, location, capacity, level, threshold_pct) values
      ($1, 'a', 'pan', 'Pan', 'ud', 'mesa', 20, 4, 25), ($1, 'b', 'queso', 'Queso', 'ud', 'nevera', 20, 5, 25),
      ($1, 'c', 'agua', 'Agua', 'ud', 'nevera', 0, 0, 25), ($2, 'd', 'pan', 'Pan', 'ud', 'mesa', 20, 0, 25)`, [live, pruebas]);
  } finally {
    await db.query(`set session_replication_role = origin`);
  }

  const after = await kpis();
  assert.equal(Number(after['flow.sales_yesterday'].value) - Number(before['flow.sales_yesterday'].value), 14);
  assert.equal(Number(after['flow.day_closures_pending'].value) - Number(before['flow.day_closures_pending'].value), 1); // ayer
  assert.equal(Number(after['flow.orders_unfinished_past'].value) - Number(before['flow.orders_unfinished_past'].value), 1);
  assert.equal(Number(after['flow.buffers_below_target'].value) - Number(before['flow.buffers_below_target'].value), 1); // 4 < 5; 5 no
});

test('flow · central_kpi_projection: solo Central (y el servicio) la lee', async () => {
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('flow', $1, 'owner')`, [user]);
  await assert.rejects(app.t.rpc('core_read', { p_app: 'flow', p_actor: user, p_name: 'flow.central_kpi_projection', p_args: { limit: 5 } }));
});
