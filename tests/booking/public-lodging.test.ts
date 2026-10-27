/** Booking · Alojamiento libre, tarjeta 1 (0498): eventos públicos y oferta pública de noches por intervalo. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, type TestDatabase } from '../../packages/test-kit/src/pglite.ts';

let t: TestDatabase;
let owner: string;
let seq = 0;
test.before(async () => {
  t = await createTestDatabase();
  owner = await t.createUser();
  await t.db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, 'owner')`, [owner]);
});
test.after(async () => { await t.close(); });

const commit = (operations: unknown[]) => {
  const id = `pl-${++seq}`;
  return t.rpc('core_commit', { p_app: 'booking', p_actor: owner, p_request_id: id, p_digest: id, p_expected_cursor: null, p_operations: operations }) as Promise<any>;
};
const read = (name: string, args: Record<string, unknown>) => t.rpc('core_public_read', { p_name: name, p_args: args }) as Promise<any>;
async function code(promise: Promise<unknown>) {
  try { await promise; return 'OK'; } catch (error) { return String((error as Error).message).match(/[A-Z_]{5,}/)?.[0] ?? String(error); }
}
const day = (offset: number) => {
  const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10);
};
async function event(fields: Record<string, unknown>) {
  const res = crypto.randomUUID(); const ev = crypto.randomUUID();
  await commit([{ op: 'insert', table: 'booking.reservations', id: res, fields: { title: 'Jornadas sintéticas', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: day(10), end_date: day(13), expected_guests: 100, guests_visible: true, public_summary: 'Llegada desde las 17 h.', contact_name: 'Persona Sintética', ...fields } }]);
  await commit([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: ev, from_status: 'pre_reservada' } }]);
  return { res, ev, code: (await t.db.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [ev])).rows[0]!.c };
}

test('booking_public_events: abiertos, visibles y sin terminar; lodging si vende noches; nada privado', async () => {
  await commit([{ op: 'insert', table: 'booking.rates', id: crypto.randomUUID(), fields: { name: 'Cama en albergue', layer: 'por_persona', unit: 'persona_noche', amount: 25, service: 'alojamiento', event_types: ['jornadas_abiertas'] } }]);
  const open = await event({ title: 'Jornadas visibles' });
  const hidden = await event({ title: 'Jornadas ocultas', guests_visible: false });
  const retreat = await event({ title: 'Retiro con apuntarme', event_type: 'retiro' });
  const past = await event({ title: 'Jornadas pasadas' });
  await t.db.query(`update booking.reservations set start_date = $2, end_date = $3 where id = $1`, [past.res, day(-5), day(-2)]);
  const items = (await read('booking_public_events', {})).items as Array<Record<string, any>>;
  const codes = items.map((i) => i.code);
  assert.ok(codes.includes(open.code) && codes.includes(retreat.code));
  assert.ok(!codes.includes(hidden.code) && !codes.includes(past.code), 'ni ocultos ni terminados');
  const mine = items.find((i) => i.code === open.code)!;
  assert.deepEqual(Object.keys(mine).sort(), ['code', 'ends_on', 'joinable', 'kind', 'lodging', 'name', 'starts_on', 'status', 'summary']);
  assert.equal(mine.lodging, true);
  // 1410: la lectura de un evento por su código lo dice igual
  assert.equal((await read('booking_event', { code: open.code })).lodging, true);
  assert.equal((await read('booking_event', { code: retreat.code })).lodging, false);
  assert.equal(items.find((i) => i.code === retreat.code)!.lodging, false);
  assert.ok(!JSON.stringify(items).includes('Persona Sintética'));
});

test('booking_public_lodging: precio por noche y plazas libres en TODO el intervalo [entrada, salida)', async () => {
  const ev = await event({ title: 'Jornadas con camas', start_date: day(20), end_date: day(24) });
  // 3 camas de 1 plaza (y una supletoria y una de equipo, que no cuentan)
  const space = crypto.randomUUID();
  const beds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  await commit([
    { op: 'insert', table: 'booking.spaces', id: space, fields: { name: 'Albergue sintético', kind: 'habitacion' } },
    ...beds.map((id, i) => ({ op: 'insert', table: 'booking.beds', id, fields: { space_id: space, label: `Cama ${i + 1}`, capacity: 1 } })),
    { op: 'insert', table: 'booking.beds', id: crypto.randomUUID(), fields: { space_id: space, label: 'Supletoria', kind: 'supletoria', capacity: 1 } },
  ]);
  const team = crypto.randomUUID();
  await commit([{ op: 'insert', table: 'booking.beds', id: team, fields: { space_id: space, label: 'Equipo', capacity: 1 } }]);
  await t.db.query(`update booking.beds set team_bed = true where id = $1`, [team]);
  const free = async (from: string, to: string) => Number((await t.db.query<{ n: string }>(`select coalesce(sum(places), 0) n from booking.free_beds($1, $2) where space_id = $3`, [from, to, space])).rows[0]!.n);
  assert.equal(await free(day(20), day(24)), 3);

  // una cama ocupada solo la segunda noche: no vale para el intervalo entero, sí para la primera noche
  const guest = crypto.randomUUID();
  await commit([
    { op: 'insert', table: 'booking.guests', id: guest, fields: { event_id: ev.ev, first_name: 'Ana' } },
    { op: 'insert', table: 'booking.room_assignments', id: crypto.randomUUID(), fields: { event_id: ev.ev, space_id: space, bed_id: beds[0], guest_id: guest, persons: 1, from_date: day(21), to_date: day(22) } },
  ]);
  assert.equal(await free(day(20), day(22)), 2, 'ocupada una de las noches');
  assert.equal(await free(day(20), day(21)), 3, 'la salida de uno es la entrada de otro');
  // una estancia de outsider también ocupa
  const outsider = await t.createUser();
  await t.db.query(`insert into booking.stays (account_id, from_date, to_date, space_id, bed_id) values ($1, $2, $3, $4, $5)`, [outsider, day(22), day(23), space, beds[1]]);
  assert.equal(await free(day(20), day(24)), 1);

  const out = await read('booking_public_lodging', { event_code: ev.code.toLowerCase(), from: day(20), to: day(22), persons: 2 });
  assert.deepEqual([out.nights, out.persons, out.event.code, out.rules_text], [2, 2, ev.code, 'Llegada desde las 17 h.']);
  const mode = out.modes.find((m: any) => m.name === 'Cama en albergue');
  assert.ok(mode, JSON.stringify(out.modes));
  assert.deepEqual([mode.price_night_cents, mode.total_cents], [2500, 2500 * 2 * 2]);
  assert.equal(typeof out.available, 'number');
  assert.ok(out.available >= 2 && out.available <= 20, 'con tope, sin enseñar el aforo interno');
  assert.ok(!JSON.stringify(out).includes('Cama 1') && !JSON.stringify(out).includes('Ana'), 'ni camas ni huéspedes');

  // errores
  assert.equal(await code(read('booking_public_lodging', { event_code: ev.code, from: day(22), to: day(20) })), 'INVALID_FIELDS');
  assert.equal(await code(read('booking_public_lodging', { event_code: ev.code, from: day(19), to: day(21) })), 'INVALID_FIELDS', 'fuera del evento');
  assert.equal(await code(read('booking_public_lodging', { event_code: 'ZZZZZZZZZZ', from: day(20), to: day(21) })), 'NOT_FOUND');
  const hidden = await event({ title: 'No visible', guests_visible: false, start_date: day(20), end_date: day(24) });
  assert.equal(await code(read('booking_public_lodging', { event_code: hidden.code, from: day(20), to: day(21) })), 'NOT_FOUND');
  const retreat = await event({ title: 'Retiro', event_type: 'retiro', start_date: day(20), end_date: day(24) });
  assert.equal(await code(read('booking_public_lodging', { event_code: retreat.code, from: day(20), to: day(21) })), 'NO_LODGING');
});
