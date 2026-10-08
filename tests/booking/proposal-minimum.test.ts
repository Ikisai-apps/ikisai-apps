/** Booking · enviar por debajo del mínimo solo con motivo, y campos nuevos del detalle de la reserva para el portal (B14). */
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

const commands = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `mn-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commands(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); }
const proposalRow = async (id: string) => (await app.t.db.query<Record<string, any>>(`select * from booking.proposals where id = $1`, [id])).rows[0]!;

test('mínimo · por debajo pide motivo y lo guarda; por encima no; el detalle del portal trae los campos de B14', async () => {
  const cond = uuid(); const res = uuid();
  await ok([{ op: 'insert', table: TABLES.conditions, id: cond, fields: { name: 'Con mínimo', is_default: true, minimum_total: 2500 } }]);
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Retiro mínimo', status: 'negociacion', event_type: 'formacion', start_date: '2028-06-02', end_date: '2028-06-04',
    expected_guests: 10, special_setup: true, technical_support: true } }]);

  const low = uuid();
  await ok([{ op: 'call', procedure: PROCEDURES.newProposalVersion, args: { reservation_id: res, proposal_id: low } }]);
  await ok([{ op: 'insert', table: TABLES.proposalLines, id: uuid(), fields: { proposal_id: low, description: 'Jornada', unit: 'unidad', quantity: 1, unit_amount: 2400 } }]);
  const refused = await commands([{ op: 'call', procedure: PROCEDURES.sendProposal, args: { proposal_id: low } }]);
  assert.equal(refused.status, 422); assert.equal(refused.data.error.code, 'BELOW_MINIMUM');
  assert.equal((await proposalRow(low)).status, 'borrador');
  await ok([{ op: 'call', procedure: PROCEDURES.sendProposal, args: { proposal_id: low, below_minimum_reason: 'Cliente recurrente, precio pactado' } }]);
  const sent = await proposalRow(low);
  assert.deepEqual([sent.status, Number(sent.total), sent.below_minimum_reason], ['enviada', 2400, 'Cliente recurrente, precio pactado']);

  // por encima del mínimo, el motivo no se guarda aunque llegue
  const high = uuid();
  await ok([{ op: 'call', procedure: PROCEDURES.newProposalVersion, args: { reservation_id: res, proposal_id: high } }]);
  await ok([{ op: 'insert', table: TABLES.proposalLines, id: uuid(), fields: { proposal_id: high, description: 'Jornada', unit: 'unidad', quantity: 1, unit_amount: 3000 } }]);
  await ok([{ op: 'call', procedure: PROCEDURES.sendProposal, args: { proposal_id: high, below_minimum_reason: 'no aplica' } }]);
  assert.equal((await proposalRow(high)).below_minimum_reason, null);

  // B14
  const org = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('organizers', $1, 'editor', $2::jsonb)`, [org, JSON.stringify({ grants: [{ reservation_id: res }] })]);
  const detail = (await app.t.rpc('core_read', { p_app: 'organizers', p_actor: org, p_name: 'booking.portal_reservation_detail', p_args: { reservation_id: res } })) as any;
  assert.deepEqual([detail.event_type, detail.special_setup, detail.technical_support, detail.dates_definitive, detail.organizer_notes, typeof detail.revision],
    ['formacion', true, true, false, null, 'number']);
});
