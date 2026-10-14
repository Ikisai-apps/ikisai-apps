/**
 * Organizers · solicitudes para apuntarse (Booking O2, «Apuntarme», API de Booking §26.3), desde `organizers-api`:
 * - el organizador ve las que Ikisai le pasa, con nombres y mensaje, y nada de la cuenta que las pidió;
 * - aceptar crea las fichas en su lista de asistentes y da la entrada de Guests a quien lo pidió;
 * - descartar con mensaje: la persona lo ve en su portal de huésped; una ya decidida da `JOIN_REQUEST_DECIDED`;
 * - otro organizador no las ve.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startOrganizersServer, type OrganizersTestServer } from './server.ts';

let api: OrganizersTestServer;
let token = '';
let reservation = '';

async function call(path: string, body?: unknown, bearer = token): Promise<{ status: number; data: any }> {
  const res = await fetch(`${api.url}/api/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const code = (res: { data: any }) => res.data?.error?.code;
const requests = async () => (await call('/read/booking.portal_join_requests', { reservation_id: reservation })).data.items;
const decide = (id: string, decision: string, comment?: string) =>
  call('/invoke/booking.portal_join_request_decide', { reservation_id: reservation, id, decision, ...(comment ? { comment } : {}) });
const openRetreats = async (account: string) =>
  (await api.booking.t.rpc('core_read', { p_app: 'guests', p_actor: account, p_name: 'booking.portal_open_retreats', p_args: { from: '2027-03-01', to: '2027-04-01' } }) as any).items;

test.before(async () => {
  api = await startOrganizersServer();
  reservation = await api.reservation({ title: 'Retiro abierto', confirm: true });
  const link = await api.organizerLink([reservation], 'apuntarme@example.invalid', 'Sara');
  token = (await call('/auth/link', { token: link })).data.token;
});
test.after(async () => { await api.close(); });

test('el organizador ve las solicitudes que le pasa Ikisai, con nombres y mensaje', async () => {
  await api.joinRequest(reservation, ['Marta', 'Nico'], '¿Queda sitio para dos?');
  const items = await requests();
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].persons, items[0].message, items[0].status], [['Marta', 'Nico'], '¿Queda sitio para dos?', 'pendiente']);
  assert.equal('account_id' in items[0], false, 'la cuenta de quien lo pide no llega al organizador');
});

test('aceptar: las personas entran en sus asistentes y quien lo pidió tiene su entrada en Guests', async () => {
  const { account } = await api.joinRequest(reservation, ['Leo']);
  const j = (await requests()).find((x: any) => x.persons[0] === 'Leo');
  const out = await decide(j.id, 'aceptar', '¡Bienvenido!');
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.equal(out.data.guest_ids.length, 1);
  const guests = (await call('/read/booking.portal_guests', { reservation_id: reservation })).data;
  assert.ok(guests.items.some((g: any) => g.display_name.startsWith('Leo')), JSON.stringify(guests.items));
  const mine = (await requests()).find((x: any) => x.id === j.id);
  assert.deepEqual([mine.status, mine.comment], ['aceptada', '¡Bienvenido!']);
  const open = (await openRetreats(account)).find((r: any) => r.reservation_id === reservation);
  assert.deepEqual([open.joined, open.request.status, open.request.comment], [true, 'aceptada', '¡Bienvenido!']);
  assert.equal(code(await decide(j.id, 'descartar')), 'JOIN_REQUEST_DECIDED');
});

test('descartar con mensaje: no entra nadie y la persona ve el mensaje en Guests', async () => {
  const { account } = await api.joinRequest(reservation, ['Iker']);
  const before = (await call('/read/booking.portal_guests', { reservation_id: reservation })).data.items.length;
  const j = (await requests()).find((x: any) => x.persons[0] === 'Iker');
  assert.equal((await decide(j.id, 'descartar', 'Esta vez ya estamos completos.')).status, 200);
  assert.equal((await call('/read/booking.portal_guests', { reservation_id: reservation })).data.items.length, before);
  const open = (await openRetreats(account)).find((r: any) => r.reservation_id === reservation);
  assert.deepEqual([open.joined, open.request.status, open.request.comment], [false, 'descartada', 'Esta vez ya estamos completos.']);
});

test('otro organizador no ve ni decide las solicitudes de este retiro', async () => {
  const other = await api.reservation({ title: 'Otro retiro', confirm: true });
  const link = await api.organizerLink([other], 'otro@example.invalid', 'Pablo');
  const otherToken = (await call('/auth/link', { token: link }, '')).data.token;
  const read = await call('/read/booking.portal_join_requests', { reservation_id: reservation }, otherToken);
  assert.equal(code(read), 'OUT_OF_SCOPE');
  const pending = (await requests()).find((x: any) => x.status === 'pendiente');
  assert.equal(pending.persons.join(), 'Marta,Nico');
  const res = await call('/invoke/booking.portal_join_request_decide', { reservation_id: reservation, id: pending.id, decision: 'aceptar' }, otherToken);
  assert.equal(code(res), 'OUT_OF_SCOPE');
});
