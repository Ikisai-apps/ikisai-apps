/** Booking · tanda 27 (petición de Organizers, «Comparar versiones»): `booking.portal_proposals` con `include_history`
 *  da también las versiones sustituidas y caducadas, con su `status` y `superseded_by_version`; nunca borradores ni
 *  rechazadas. Sin el argumento, lo de siempre. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });

async function ok(operations: unknown[]) {
  const res = await app.call('/api/v1/commands', { body: { requestId: `pv-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
const read = (actor: string, args: Record<string, unknown>) => app.t.rpc('core_read', { p_app: 'organizers', p_actor: actor, p_name: 'booking.portal_proposals', p_args: args }) as Promise<any>;
async function version(res: string, amount: number): Promise<string> {
  const id = uuid();
  await ok([{ op: 'call', procedure: PROCEDURES.newProposalVersion, args: { reservation_id: res, proposal_id: id } }]);
  await ok([{ op: 'insert', table: TABLES.proposalLines, id: uuid(), fields: { proposal_id: id, description: 'Estancia', unit: 'unidad', quantity: 1, unit_amount: amount } }]);
  return id;
}
const send = (id: string) => ok([{ op: 'call', procedure: PROCEDURES.sendProposal, args: { proposal_id: id, below_minimum_reason: 'Prueba' } }]);
const statusOf = async (id: string) => (await app.t.db.query<{ status: string }>('select status from booking.proposals where id = $1', [id])).rows[0]!.status;

test('versiones · el portal ve las sustituidas y caducadas solo si las pide; nunca borradores ni rechazadas', async () => {
  const res = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Retiro con versiones', status: 'negociacion', event_type: 'retiro', start_date: '2028-06-02', end_date: '2028-06-04', expected_guests: 10 } }]);
  const org = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('organizers', $1, 'editor', $2::jsonb)`, [org, JSON.stringify({ grants: [{ reservation_id: res }] })]);

  await ok([{ op: 'insert', table: TABLES.conditions, id: uuid(), fields: { name: 'Condiciones de versiones', is_default: true, vat_rate: 10 } }]);
  const v1 = await version(res, 1000);
  await send(v1);
  const v2 = await version(res, 1200);
  await send(v2);
  assert.equal(await statusOf(v1), 'sustituida');
  const v3 = await version(res, 1300); // borrador

  const today = await read(org, { reservation_id: res });
  assert.deepEqual(today.items.map((p: any) => [p.version, p.status]), [[2, 'enviada']], 'sin pedir el historial, como hoy');
  assert.equal(today.items[0].superseded_by_version, null);

  const history = await read(org, { reservation_id: res, include_history: true });
  assert.deepEqual(history.items.map((p: any) => [p.version, p.status, p.superseded_by_version]), [[2, 'enviada', null], [1, 'sustituida', 2]]);
  assert.equal(Number(history.items[1].total), 1000, 'con su importe y sus líneas, el mismo formato');
  assert.equal(history.items[1].lines.length, 1);
  assert.equal(history.items[1].conditions.name, 'Condiciones de versiones');

  // caducada sí; rechazada y borrador, nunca (una enviada se marca a mano rechazada o caducada)
  await app.t.db.query(`update booking.proposals set status = 'caducada' where id = $1`, [v2]);
  await send(v3);
  await app.t.db.query(`update booking.proposals set status = 'rechazada' where id = $1`, [v3]);
  await version(res, 1400); // otro borrador
  const later = await read(org, { reservation_id: res, include_history: true });
  assert.deepEqual(later.items.map((p: any) => [p.version, p.status]), [[2, 'caducada'], [1, 'sustituida']]);
  assert.deepEqual((await read(org, { reservation_id: res })).items, [], 'sin historial, ni caducadas');
  assert.deepEqual((await read(org, { reservation_id: res, include_history: 'sí' })).items, [], 'solo `true` pide el historial');
});
