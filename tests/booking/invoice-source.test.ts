/** Booking · lectura para facturar desde una reserva (Finance §14.8; Booking API.md §19). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

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
  const res = await app.call('/api/v1/commands', { body: { requestId: `inv-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}

test('factura · desde la propuesta aceptada (tarifa, extra con descuento y ajuste) o por el importe final; Finance la lee, Food no', async () => {
  const conditions = uuid(); const stay = uuid(); const sound = uuid();
  await ok([
    { op: 'insert', table: TABLES.conditions, id: conditions, fields: { name: 'Condiciones factura', vat_rate: 10, is_default: true } },
    { op: 'insert', table: TABLES.rates, id: stay, fields: { name: 'Alojamiento en grupo', layer: 'por_persona', unit: 'persona_noche', amount: 40 } },
    { op: 'insert', table: TABLES.rates, id: sound, fields: { name: 'Equipo de sonido', layer: 'extra', unit: 'estancia', amount: 120 } },
  ]);
  const res = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Retiro factura', status: 'negociacion', start_date: '2027-12-01', end_date: '2027-12-03', expected_guests: 10, contact_name: 'Persona Organizadora', customer_type: 'asociacion' } }]);
  const proposal = uuid();
  await ok([{ op: 'call', procedure: PROCEDURES.newProposalVersion, args: { reservation_id: res, proposal_id: proposal } }]);
  await ok([
    { op: 'insert', table: TABLES.proposalLines, id: uuid(), fields: { proposal_id: proposal, rate_id: stay, description: 'Alojamiento en grupo', unit: 'persona_noche', quantity: 20, unit_amount: 40, position: 1 } },
    { op: 'insert', table: TABLES.proposalLines, id: uuid(), fields: { proposal_id: proposal, rate_id: sound, description: 'Equipo de sonido', unit: 'estancia', quantity: 1, unit_amount: 120, discount_pct: 50, position: 2 } },
    { op: 'insert', table: TABLES.proposalLines, id: uuid(), fields: { proposal_id: proposal, description: 'Descuento de grupo', unit: 'porcentaje', quantity: 1, unit_amount: -10, position: 3 } },
  ]);
  await ok([{ op: 'call', procedure: PROCEDURES.sendProposal, args: { proposal_id: proposal } }]);
  await ok([{ op: 'call', procedure: PROCEDURES.acceptProposal, args: { proposal_id: proposal } }]);

  const finance = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('invoices', $1, 'editor')`, [finance]);
  const out = (await app.t.rpc('core_read', { p_app: 'invoices', p_actor: finance, p_name: 'booking.reservation_invoice_source', p_args: { reservation_id: res } })) as any;
  assert.deepEqual(out.reservation, { id: res, code: out.reservation.code, label: 'Retiro factura', revision: out.reservation.revision, check_in: '2027-12-01', check_out: '2027-12-03' });
  assert.deepEqual(out.customer, { name: 'Persona Organizadora', kind: 'asociacion', tax_id: null, id_type: null, country: null, address: null });
  assert.equal(out.prices_include_vat, true);
  assert.equal(out.invoiced, null);
  assert.deepEqual(out.lines.map((l: any) => [l.kind, l.description, Number(l.quantity), Number(l.unit_price), Number(l.discount_amount), Number(l.vat_rate), l.income_category]), [
    ['tarifa', 'Alojamiento en grupo', 20, 40, 0, 10, 'alojamiento'],
    ['extra', 'Equipo de sonido', 1, 120, 60, 10, 'extras'],
    ['ajuste', 'Descuento de grupo', 1, -86, 0, 10, 'alojamiento'], // −10 % de (800 + 60)
  ]);
  // la suma de las líneas cuadra con el total aceptado
  const sum = out.lines.reduce((s: number, l: any) => s + Number(l.quantity) * Number(l.unit_price) - Number(l.discount_amount), 0);
  assert.equal(Math.round(sum * 100) / 100, Number(out.proposal.total));

  // sin propuesta aceptada: una línea por el importe final
  const plain = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: plain, fields: { title: 'Sin propuesta', status: 'negociacion' } }]);
  await ok([{ op: 'insert', table: TABLES.finance, id: plain, fields: { final_amount: 1500 } }]);
  const simple = (await app.t.rpc('core_read', { p_app: 'invoices', p_actor: finance, p_name: 'booking.reservation_invoice_source', p_args: { reservation_id: plain } })) as any;
  assert.deepEqual(simple.lines.map((l: any) => [l.description, Number(l.unit_price)]), [['Estancia · Sin propuesta', 1500]]);

  const food = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('food', $1, 'reader')`, [food]);
  await assert.rejects(app.t.rpc('core_read', { p_app: 'food', p_actor: food, p_name: 'booking.reservation_invoice_source', p_args: { reservation_id: res } }), (e: any) => e.code === 'INVALID_OPERATION');
});
