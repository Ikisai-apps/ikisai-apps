/** Booking · ajustes y devoluciones del cobro del alojamiento (1403), un solo apunte en Finance; lectura de eventos para Finance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES, walkinFinanceEntry } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
/** El id del apunte que da Finance (un uuid). */
const ENTRY = '00000000-0000-4000-8000-0000000000e1';
const sent: Array<{ body: any; caller: string | null }> = [];
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, workerKey: 'clave-sintetica', origins: [BOOKING_ORIGINS[0]!], appsFetch: (async (_url: string, init: RequestInit) => {
      sent.push({ body: JSON.parse(String(init.body)), caller: new Headers(init.headers).get('X-Ikisai-Caller') });
      return new Response(JSON.stringify({ results: [{ result: { entry_id: ENTRY, status: sent.length > 1 ? 'replaced' : 'created' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch }),
  });
});
test.after(async () => { await app.close(); });
const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `wr-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; }
const row = async (id: string) => (await app.t.db.query<Record<string, any>>(`select * from booking.walkin_charges where id = $1`, [id])).rows[0]!;

test('apunte con devolución: un solo apunte por lo cobrado menos lo devuelto; métodos y desglose suman el importe', () => {
  const base = { id: 'c-1', event_id: 'ev', nights: 2, price_cents: 2000, amount_cents: 4000, method: 'cash' as const, paid_day: '2032-10-02', title: 'Jornadas', guest: 'Ana S.', space: 'Albergue', bed: 'Cama 1' };
  const same = walkinFinanceEntry({ ...base, refund_cents: 1500, refund_method: 'cash' });
  assert.deepEqual([same.amount_cents, same.methods, same.detail.map((d) => d.amount_cents)], [2500, { cash: 2500 }, [4000, -1500]]);
  const other = walkinFinanceEntry({ ...base, refund_cents: 1000, refund_method: 'bizum' });
  assert.deepEqual([other.amount_cents, other.methods], [3000, { cash: 4000, bizum: -1000 }]);
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  assert.equal(sum(other.methods), other.amount_cents);
  assert.equal(other.detail.reduce((a, d) => a + d.amount_cents, 0), other.amount_cents);
  assert.equal(other.source_ref, 'booking:stay:c-1', 'el mismo apunte');
  assert.deepEqual(walkinFinanceEntry(base).methods, { cash: 4000 }, 'sin devolución, como antes');
});

test('ajustar o devolver un cobro ya enviado lo deja por reenviar; el reenvío sustituye el apunte con las cabeceras de servidor', async () => {
  const res = uuid(); const event = uuid(); const space = uuid(); const bed = uuid(); const guest = uuid(); const assignment = uuid(); const charge = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Jornadas con devolución', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: '2032-10-01', end_date: '2032-10-04', expected_guests: 50 } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  await ok([
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name: 'Albergue', kind: 'habitacion' } },
    { op: 'insert', table: TABLES.beds, id: bed, fields: { space_id: space, label: 'Cama 1' } },
    { op: 'insert', table: TABLES.guests, id: guest, fields: { event_id: event, first_name: 'Ana' } },
    { op: 'insert', table: TABLES.roomAssignments, id: assignment, fields: { event_id: event, space_id: space, bed_id: bed, guest_id: guest, persons: 1, from_date: '2032-10-01', to_date: '2032-10-03' } },
    { op: 'insert', table: TABLES.walkinCharges, id: charge, fields: { event_id: event, assignment_id: assignment, guest_id: guest, nights: 2, price_cents: 2000, amount_cents: 4000, method: 'cash', paid_at: '2032-10-01T18:00:00Z' } },
  ]);
  const send = () => app.call(`/api/v1/walkins/${charge}/send/finance`, { body: {} });
  assert.equal((await send()).status, 200);
  let c = await row(charge);
  await ok([{ op: 'update', table: TABLES.walkinCharges, id: charge, expectedRevision: Number(c.revision), fields: { finance_entry_id: ENTRY, finance_sent_at: new Date().toISOString() } }]);

  // devolver sin cobrar no vale; más de lo cobrado, tampoco
  c = await row(charge);
  const bad = await commit([{ op: 'update', table: TABLES.walkinCharges, id: charge, expectedRevision: Number(c.revision), fields: { refund_cents: 5000, refund_method: 'cash', refunded_at: new Date().toISOString() } }]);
  assert.notEqual(bad.status, 200, 'más de lo cobrado no entra');

  // una devolución: queda por reenviar, y el reenvío va por lo cobrado menos lo devuelto
  await ok([{ op: 'update', table: TABLES.walkinCharges, id: charge, expectedRevision: Number(c.revision), fields: { refund_cents: 1000, refund_method: 'bizum', refunded_at: new Date().toISOString() } }]);
  c = await row(charge);
  assert.equal(c.finance_sent_at, null, 'por reenviar');
  assert.equal(c.finance_entry_id, ENTRY, 'el mismo apunte');
  assert.equal((await send()).status, 200);
  const resend = sent.at(-1)!;
  assert.equal(resend.caller, 'booking');
  const args = resend.body.operations[0].args;
  assert.deepEqual([args.source_ref, args.amount_cents, args.methods], [`booking:stay:${charge}`, 3000, { cash: 4000, bizum: -1000 }]);

  // un ajuste de noches también lo deja por reenviar
  await ok([{ op: 'update', table: TABLES.walkinCharges, id: charge, expectedRevision: Number(c.revision), fields: { finance_sent_at: new Date().toISOString() } }]);
  c = await row(charge);
  await ok([{ op: 'update', table: TABLES.walkinCharges, id: charge, expectedRevision: Number(c.revision), fields: { nights: 3, amount_cents: 6000 } }]);
  assert.equal((await row(charge)).finance_sent_at, null);
});

test('Finance lee a qué reserva y en qué estado está cada evento, sin datos personales; la retención por defecto es de 2 horas', async () => {
  const res = uuid(); const event = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Para Finance', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: '2032-11-01', end_date: '2032-11-02', expected_guests: 5, contact_name: 'Persona Sintética' } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const reader = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('invoices', $1, 'reader')`, [reader]);
  const out = await app.t.rpc('core_read', { p_app: 'invoices', p_actor: reader, p_name: 'booking.event_reservations_for_invoices', p_args: { event_ids: [event, uuid(), 'no-uuid'] } }) as any;
  assert.deepEqual(out, [{ reservation_id: res, event_id: event, status: 'confirmada' }]);
  assert.ok(!JSON.stringify(out).includes('Sintética'));
  assert.equal((await app.t.db.query<{ h: number }>(`select lodging_hold_hours h from booking.reservations where id = $1`, [res])).rows[0]!.h, 2);
});
