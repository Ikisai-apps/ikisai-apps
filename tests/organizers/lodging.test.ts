/**
 * Organizers · Alojamiento y Presupuesto con las supletorias por retiro (Booking #491, API §25), desde `organizers-api`:
 * - `portal_rooms`: camas fijas siempre; las supletorias, solo las activadas, con `kind: 'supletoria'`; el contador `extra`;
 * - reparto «quién y dónde» (`portal_assign_bed`, `source = 'organizer'`): asignar, cambiar de cama y dejarla libre; una
 *   supletoria sin activar no se reparte;
 * - `portal_extra_beds`: activar y quitar con sus límites, y con la propuesta aceptada, pendiente de Ikisai;
 * - `portal_proposals`: las líneas que pone el personal.
 * Nació como caracterización antes del cambio (#487).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startOrganizersServer, type OrganizersTestServer } from './server.ts';

let api: OrganizersTestServer;
let token = '';
let reservation = '';
let room: { spaceId: string; beds: string[]; extra: string[] };
let ana = '';

async function call(path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${api.url}/api/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const code = (res: { data: any }) => res.data?.error?.code;
const rooms = async () => (await call('/read/booking.portal_rooms', { reservation_id: reservation })).data;
const bedOf = (data: any, bedId: string) => data.rooms.flatMap((r: any) => r.beds).find((b: any) => b.bed_id === bedId);

test.before(async () => {
  api = await startOrganizersServer();
  reservation = await api.reservation({ title: 'Retiro con supletorias', confirm: true });
  room = await api.room(reservation, { name: 'Hab 1', beds: 2, extra: 2, enSuite: true });
  const link = await api.organizerLink([reservation], 'supletorias@example.invalid', 'Sara');
  token = (await call('/auth/link', { token: link })).data.token;
  ana = crypto.randomUUID();
  const added = await call('/invoke/booking.portal_add_guest', { reservation_id: reservation, guest_id: ana, fields: { first_name: 'Ana' }, declaration: true, declaration_version: 'org-v1' });
  assert.equal(added.status, 200, JSON.stringify(added.data));
});
test.after(async () => { await api.close(); });

test('portal_rooms: camas fijas y el contador de supletorias; sin activar, las supletorias no salen en el reparto', async () => {
  const data = await rooms();
  const hab = data.rooms.find((r: any) => r.space_id === room.spaceId);
  assert.ok(hab, JSON.stringify(data));
  assert.equal(hab.name, 'Hab 1');
  assert.equal(hab.en_suite, true);
  assert.deepEqual(hab.beds.map((b: any) => [b.label, b.kind, b.free]), [['Cama 1', 'individual', true], ['Cama 2', 'individual', true]]);
  assert.equal(hab.beds_total, 2, 'las supletorias no suman plazas');
  assert.equal(hab.beds.some((b: any) => b.kind === 'supletoria'), false);
  assert.equal(hab.extra_total, 0, 'ninguna activada');
  assert.equal(hab.extra_max, 2);
  assert.deepEqual({ possible: hab.extra.possible, wanted: hab.extra.wanted }, { possible: 2, wanted: 0 });
});

test('reparto del organizador: asignar, cambiar de cama y dejarla libre; una supletoria no se puede asignar', async () => {
  const assign = (bed: string | null) => call('/invoke/booking.portal_assign_bed', { reservation_id: reservation, guest_id: ana, bed_id: bed });

  assert.equal((await assign(room.beds[0]!)).status, 200);
  let bed = bedOf(await rooms(), room.beds[0]!);
  assert.equal(bed.guest_id, ana);
  assert.equal(bed.source, 'organizer');
  assert.equal(bed.status, 'confirmed');

  assert.equal((await assign(room.beds[1]!)).status, 200);
  let data = await rooms();
  assert.equal(bedOf(data, room.beds[0]!).guest_id, undefined, 'la anterior queda libre');
  assert.equal(bedOf(data, room.beds[1]!).guest_id, ana);

  assert.equal(code(await assign(room.extra[0]!)), 'NOT_OFFERED', 'una supletoria sin activar no se reparte');

  assert.equal((await assign(null)).status, 200);
  data = await rooms();
  assert.ok(room.beds.every((id) => bedOf(data, id).guest_id === undefined && bedOf(data, id).free));
});

test('presupuesto: portal_proposals trae las líneas del personal y ninguna de supletorias', async () => {
  await api.seedRates();
  const proposal = await api.sendProposal(reservation, 20);
  const out = await call('/read/booking.portal_proposals', { reservation_id: reservation });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  const sent = out.data.items.find((p: any) => p.id === proposal);
  assert.equal(sent.status, 'enviada');
  assert.deepEqual(sent.lines.map((l: any) => [l.description, Number(l.quantity), Number(l.unit_amount)]), [['Estancia con pensión completa', 40, 70]]);
  assert.equal(sent.lines.some((l: any) => /supletori/i.test(l.description)), false);
  assert.equal(Number(sent.total), 2800);
});

test('supletorias: el organizador activa cuántas quiere, hasta las posibles; las activadas se reparten y no se quitan ocupadas', async () => {
  const extra = (count: number) => call('/invoke/booking.portal_extra_beds', { reservation_id: reservation, space_id: room.spaceId, count });
  assert.equal(code(await extra(3)), 'EXTRA_BEDS_LIMIT');

  const two = await extra(2);
  assert.equal(two.status, 200, JSON.stringify(two.data));
  let data = await rooms();
  const hab = data.rooms.find((r: any) => r.space_id === room.spaceId);
  assert.equal(hab.extra_total, 2);
  assert.equal(hab.beds_total, 2, 'las plazas fijas no cambian');
  assert.deepEqual(hab.beds.filter((b: any) => b.kind === 'supletoria').map((b: any) => b.label), ['Supletoria 1', 'Supletoria 2']);
  assert.ok(data.extra_rate, 'el precio de la plaza supletoria llega al portal');
  assert.ok(Number(data.extra_rate.amount_with_vat) > 0);

  // Una supletoria activada ya se reparte; ocupada, no se puede quitar.
  const bed = hab.beds.find((b: any) => b.kind === 'supletoria').bed_id;
  assert.equal((await call('/invoke/booking.portal_assign_bed', { reservation_id: reservation, guest_id: ana, bed_id: bed })).status, 200);
  assert.equal(bedOf(await rooms(), bed).guest_id, ana);
  assert.equal(code(await extra(0)), 'EXTRA_BED_IN_USE');
  assert.equal((await call('/invoke/booking.portal_assign_bed', { reservation_id: reservation, guest_id: ana, bed_id: null })).status, 200);
  assert.equal((await extra(0)).status, 200);
  data = await rooms();
  assert.equal(data.rooms.find((r: any) => r.space_id === room.spaceId).extra_total, 0);
});

test('supletorias con la propuesta aceptada: quedan pendientes de Ikisai', async () => {
  const proposal = (await call('/read/booking.portal_proposals', { reservation_id: reservation })).data.items[0].id;
  await api.acceptProposal(proposal);
  const out = await call('/invoke/booking.portal_extra_beds', { reservation_id: reservation, space_id: room.spaceId, count: 1 });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.equal(out.data.requested, 1);
  assert.equal(out.data.proposal.status, 'aceptada');
  const data = await rooms();
  assert.equal(data.extra_pending_mode, true);
  const hab = data.rooms.find((r: any) => r.space_id === room.spaceId);
  assert.equal(hab.extra.requested, 1);
  assert.equal(hab.extra.wanted, 1);
  assert.equal(hab.extra_total, 0, 'aún no se cobra: lo confirma Ikisai');
});
