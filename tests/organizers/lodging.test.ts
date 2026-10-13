/**
 * Organizers · caracterización de Alojamiento y Presupuesto **antes** de las supletorias activables por el organizador
 * (tanda de Booking del 13-10-2026). Fija lo que el portal ve y hace hoy, para que el cambio de Booking se note donde debe:
 * - `portal_rooms`: las habitaciones del retiro con sus camas fijas; las supletorias no salen y no se pueden asignar;
 * - reparto «quién y dónde» (`portal_assign_bed`, `source = 'organizer'`): asignar, cambiar de cama y dejarla libre;
 * - `portal_proposals`: las líneas que pone el personal; ninguna de supletorias.
 * Cuando Booking publique, estas pruebas cambian con su contrato (supletorias activadas en `rooms[].beds` con
 * `kind: 'supletoria'`, `extra_total` y `extra_free`, y `portal_extra_beds`).
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

test('caracterización · portal_rooms: solo camas fijas; las supletorias no salen ni cuentan', async () => {
  const data = await rooms();
  const hab = data.rooms.find((r: any) => r.space_id === room.spaceId);
  assert.ok(hab, JSON.stringify(data));
  assert.equal(hab.name, 'Hab 1');
  assert.equal(hab.en_suite, true);
  assert.deepEqual(hab.beds.map((b: any) => [b.label, b.kind, b.free]), [['Cama 1', 'individual', true], ['Cama 2', 'individual', true]]);
  assert.equal(hab.beds_total, 2, 'las supletorias no suman plazas');
  assert.equal(hab.beds.some((b: any) => b.kind === 'supletoria'), false);
  assert.equal(hab.extra_total, undefined, 'aún no hay contador de supletorias');
});

test('caracterización · reparto del organizador: asignar, cambiar de cama y dejarla libre; una supletoria no se puede asignar', async () => {
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

  assert.equal(code(await assign(room.extra[0]!)), 'NOT_OFFERED', 'hoy una supletoria no se reparte desde el portal');

  assert.equal((await assign(null)).status, 200);
  data = await rooms();
  assert.ok(room.beds.every((id) => bedOf(data, id).guest_id === undefined && bedOf(data, id).free));
});

test('caracterización · presupuesto: portal_proposals trae las líneas del personal y ninguna de supletorias', async () => {
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
