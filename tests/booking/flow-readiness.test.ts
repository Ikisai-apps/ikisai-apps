/** Booking · «Listo para Flow» (0492): la cadena de condiciones de flow_guests_of (0486) y la línea de la ficha. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, type TestDatabase } from '../../packages/test-kit/src/pglite.ts';
import { flowReadyLine, READS, type FlowReadiness } from '../../supabase/functions/_domain/booking/mod.ts';

let t: TestDatabase;
let editor: string;
let seq = 0;
test.before(async () => {
  t = await createTestDatabase();
  editor = await t.createUser();
  await t.db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, 'editor')`, [editor]);
});
test.after(async () => { await t.close(); });

const commit = (operations: unknown[], actor = editor) => {
  const id = `fr-${++seq}`;
  return t.rpc('core_commit', { p_app: 'booking', p_actor: actor, p_request_id: id, p_digest: id, p_expected_cursor: null, p_operations: operations }) as Promise<any>;
};
const readiness = (reservationId: string, actor = editor) =>
  t.rpc('core_read', { p_app: 'booking', p_actor: actor, p_name: READS.flowReadiness, p_args: { reservation_id: reservationId } }) as Promise<FlowReadiness>;
const visible = async (event: string) => Number((await t.db.query<{ n: string }>(`select count(*) n from booking.flow_guests_projection where event_id = $1`, [event])).rows[0]!.n);
async function code(promise: Promise<unknown>) {
  try { await promise; return 'OK'; } catch (error) { return String((error as Error).message).match(/[A-Z_]{5,}/)?.[0] ?? String(error); }
}
async function reservation(confirm: boolean) {
  const res = crypto.randomUUID(); const event = crypto.randomUUID();
  await commit([{ op: 'insert', table: 'booking.reservations', id: res, fields: { title: 'Retiro sintético', status: 'pre_reservada', start_date: '2031-11-06', end_date: '2031-11-08', expected_guests: 20 } }]);
  if (confirm) await commit([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  return { res, event };
}

test('flow_readiness: cada condición de flow_guests_of, en orden, con los recuentos que la explican', async () => {
  const pending = await reservation(false);
  assert.deepEqual([(await readiness(pending.res)).failing, (await readiness(pending.res)).event_id], ['no_event', null], 'sin evento todavía');

  const { res, event } = await reservation(true);
  let r = await readiness(res);
  assert.deepEqual([r.event_id, r.failing, r.guests], [event, 'no_guests', 0]);

  // el de muestra y el anonimizado no los ve Flow: siguen sin contar, pero se dicen
  const sample = crypto.randomUUID(); const gone = crypto.randomUUID(); const ana = crypto.randomUUID();
  await commit([
    { op: 'insert', table: 'booking.guests', id: sample, fields: { event_id: event, first_name: 'Muestra' } },
    { op: 'insert', table: 'booking.guests', id: gone, fields: { event_id: event, first_name: 'Antiguo' } },
  ]);
  await t.db.query(`update booking.guests set preview = true where id = $1`, [sample]);
  await t.db.query(`update booking.guests set anonymized_at = now() where id = $1`, [gone]);
  r = await readiness(res);
  assert.deepEqual([r.failing, r.guests, r.preview, r.anonymized], ['no_guests', 0, 1, 1]);
  assert.equal(await visible(event), 0, 'lo mismo que vería Flow');

  await commit([{ op: 'insert', table: 'booking.guests', id: ana, fields: { event_id: event, first_name: 'Ana' } }]);
  r = await readiness(res);
  assert.deepEqual([r.failing, r.guests], [null, 1]);
  assert.equal(await visible(event), r.guests, 'cuenta lo mismo que la vista de flow_guests_of');

  // una reserva cancelada o perdida saca a sus huéspedes de Flow aunque el evento siga vivo
  for (const status of ['cancelada', 'perdida']) {
    await t.db.query(`update booking.reservations set status = $2 where id = $1`, [res, status]);
    r = await readiness(res);
    assert.deepEqual([r.failing, r.status], ['reservation_closed', status]);
    assert.equal(await visible(event), 0);
  }
  await t.db.query(`update booking.reservations set status = 'confirmada' where id = $1`, [res]);

  // sin evento vivo
  await t.db.query(`update booking.events set deleted_at = now() where id = $1`, [event]);
  assert.deepEqual([(await readiness(res)).failing, (await readiness(res)).event_id], ['no_event', null]);
  await t.db.query(`update booking.events set deleted_at = null where id = $1`, [event]);

  // la lee también un reader; una reserva borrada no existe
  const reader = await t.createUser();
  await t.db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, 'reader')`, [reader]);
  assert.equal((await readiness(res, reader)).failing, null);
  assert.ok(!JSON.stringify(await readiness(res, reader)).includes('Ana'), 'solo cuentas');
  await t.db.query(`update booking.reservations set deleted_at = now() where id = $1`, [pending.res]);
  assert.equal(await code(readiness(pending.res)), 'NOT_FOUND');
});

test('flowReadyLine: una línea con lo que falla, y nunca un «sí» sin saber si hay flujo', () => {
  const base: FlowReadiness = { event_id: 'ev', failing: null, status: 'confirmada', guests: 12, preview: 0, anonymized: 0 };
  assert.deepEqual(flowReadyLine(base, 1), { ok: true, unknown: false, text: 'Sí: Flow ve 12 huéspedes en 1 flujo. Cada persona necesita el flujo en su ámbito.' });
  assert.equal(flowReadyLine(base, 0).text, 'No: ningún flujo de Flow está enlazado a este evento. En Flow, elige este evento en el flujo.');
  assert.deepEqual([flowReadyLine(base, null).ok, flowReadyLine(base, null).unknown], [false, true]);
  assert.equal(flowReadyLine({ ...base, failing: 'reservation_closed', status: 'cancelada' }, 1).text, 'No: la reserva está cancelada; Flow no ve a sus huéspedes.');
  assert.equal(flowReadyLine({ ...base, failing: 'no_event', event_id: null }, null).text, 'No: la reserva no tiene evento; se crea al confirmarla.');
  assert.equal(flowReadyLine({ ...base, failing: 'no_guests', guests: 0, preview: 1, anonymized: 2 }, 1).text,
    'No: el evento no tiene huéspedes que Flow pueda ver (no cuentan: 1 de muestra y 2 anonimizados).');
  assert.equal(flowReadyLine({ ...base, failing: 'no_guests', guests: 0 }, 1).text, 'No: el evento no tiene huéspedes que Flow pueda ver.');
});
