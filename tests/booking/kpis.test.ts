/** Booking · indicadores para Central (API.md §18): claves, agregados y ocupación mensual. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
});
test.after(async () => { await app.close(); });

async function ok(operations: unknown[]) {
  const res = await app.call('/api/v1/commands', { body: { requestId: `kpi-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}

test('indicadores · agregados de reservas, personas, eventos, señales, refuerzos y ocupación', async () => {
  const today = (await app.t.db.query<{ d: string }>(`select ((now() at time zone 'Europe/Madrid')::date)::text d`)).rows[0]!.d;
  const plus = (days: number) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

  // habitación de 4 plazas (2 camas dobles) + 1 supletoria que no cuenta
  const room = uuid();
  await ok([
    { op: 'insert', table: TABLES.spaces, id: room, fields: { name: 'Habitación KPI', kind: 'habitacion' } },
    { op: 'insert', table: TABLES.beds, id: uuid(), fields: { space_id: room, label: 'Cama 1', kind: 'doble', capacity: 2 } },
    { op: 'insert', table: TABLES.beds, id: uuid(), fields: { space_id: room, label: 'Cama 2', kind: 'doble', capacity: 2 } },
    { op: 'insert', table: TABLES.beds, id: uuid(), fields: { space_id: room, label: 'Supletoria', kind: 'supletoria', capacity: 1 } },
  ]);
  const res = uuid(); const event = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Retiro KPI', status: 'pre_reservada', start_date: plus(10), end_date: plus(12), expected_guests: 7 } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  await ok([
    { op: 'insert', table: TABLES.finance, id: res, fields: { deposit_required: 300, deposit_paid: 100 } },
    { op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: event, space_id: room, group_label: 'Grupo', persons: 2 } },
    { op: 'insert', table: TABLES.staffNeeds, id: uuid(), fields: { event_id: event, need_type: 'cocina', persons: 1 } },
  ]);

  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('central', $1, 'reader')`, [user]);
  const out = (await app.t.rpc('core_read', { p_app: 'central', p_actor: user, p_name: 'booking.central_kpi_projection', p_args: { limit: 500 } })) as any;
  const rows = out.rows as Array<Record<string, any>>;
  assert.ok(rows.length <= 500);
  const one = (kpi: string) => rows.find((r) => r.kpi === kpi && r.period === 'actual')!;
  assert.equal(Number(one('booking.reservations_confirmed_90d').value), 1);
  assert.equal(Number(one('booking.guests_expected_90d').value), 7);
  assert.equal(Number(one('booking.events_next_30d').value), 1);
  assert.equal(Number(one('booking.deposits_pending').value), 1);
  assert.equal(Number(one('booking.staff_needs_open').value), 1);
  assert.deepEqual(Object.keys(rows[0]!).sort(), ['computed_at', 'direction', 'kpi', 'label', 'link', 'period', 'period_end', 'period_start', 'unit', 'value']);

  const occupancy = rows.filter((r) => r.kpi === 'booking.occupancy_rate');
  assert.equal(occupancy.length, 16, '12 meses anteriores, el actual y 3 siguientes');
  // 2 personas × 2 noches = 4 personas-noche sobre 4 plazas base × días del mes (repartidas entre uno o dos meses)
  const total = occupancy.reduce((sum, r) => sum + Number(r.value) * 4 * ((Date.parse(r.period_end) - Date.parse(r.period_start)) / 86_400_000 + 1) / 100, 0);
  assert.ok(Math.abs(total - 4) < 0.2, `personas-noche reconstruidas ≈ 4 (${total})`);
  assert.ok(occupancy.every((r) => /^\d{4}-\d{2}$/.test(r.period) && r.unit === 'pct'));
});
