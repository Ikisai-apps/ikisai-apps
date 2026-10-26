/**
 * Organizers · propuestas del equipo de Ikisai (decisión de VG del 26-10-2026, migración 0703), contra las Edge sobre
 * PGlite: dirección (nivel de casa «dirección» y ámbito «todos») no escribe en un retiro que no es suyo; lo propone, y quien
 * organiza ese retiro lo acepta o lo descarta. Nadie más ve la propuesta, y dirección no decide las suyas.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createOrganizersApp, ORGANIZERS_ORIGINS } from '../../supabase/functions/organizers-api/app.ts';
import { TABLES as BOOKING } from '../../supabase/functions/_domain/booking/mod.ts';
import { TABLES, TEAM_PROPOSAL_KIND } from '../../supabase/functions/_domain/organizers/mod.ts';

const uuid = () => crypto.randomUUID();
let booking: TestApp;
let organizers: (r: Request) => Promise<Response>;
let seq = 0;

type Res = { status: number; data: any };
async function org(path: string, init: { token?: string | null; body?: unknown } = {}): Promise<Res> {
  const res = await organizers(new Request(`${booking.supabase.url}/functions/v1/organizers-api${path}`, {
    method: init.body === undefined ? 'GET' : 'POST',
    headers: { Origin: ORGANIZERS_ORIGINS[0]!, 'Content-Type': 'application/json', ...(init.token ? { Authorization: 'Bearer ' + init.token } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }));
  return { status: res.status, data: await res.json().catch(() => null) };
}
const code = (res: Res) => res.data?.error?.code;

async function staff(operations: unknown[]) {
  const res = await booking.call('/api/v1/commands', { body: { requestId: `tp-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
async function reservation(title: string): Promise<string> {
  const id = uuid();
  await staff([{ op: 'insert', table: BOOKING.reservations, id, fields: { title, status: 'pre_reservada', start_date: '2027-10-08', end_date: '2027-10-10', expected_guests: 10 } }]);
  return id;
}
async function organizerSession(reservation_id: string, email: string): Promise<{ token: string; id: string }> {
  const link = await booking.call('/api/v1/portal-links', { token: booking.tokens.editor, body: { app: 'organizers', scope: { reservation_id }, person: { name: 'Organizadora', email } } });
  assert.equal(link.status, 200, JSON.stringify(link.data));
  const session = await org('/api/v1/auth/link', { body: { token: link.data.url.split('/i/')[1] } });
  assert.equal(session.status, 200, JSON.stringify(session.data));
  const me = await org('/api/v1/me', { token: session.data.token });
  return { token: session.data.token, id: me.data.userId };
}
const commit = (token: string, operations: unknown[]) => org('/api/v1/commands', { token, body: { requestId: `tp-${++seq}-${uuid()}`, operations } });
const suggest = (token: string, reservation_id: string, operations: unknown[]) =>
  org('/api/v1/suggestions', { token, body: { requestId: `tp-${++seq}-${uuid()}`, kind: TEAM_PROPOSAL_KIND, summary: 'Propuesta del equipo de Ikisai', detail: { reservation_id }, operations } });

let R1: string; let R2: string; let R3: string;
let ana: { token: string; id: string }; let otra: { token: string; id: string }; let dire: { token: string; id: string };

test.before(async () => {
  booking = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
  organizers = createOrganizersApp({ url: booking.supabase.url, anonKey: booking.supabase.anonKey, serviceKey: booking.supabase.serviceKey, fetch: booking.supabase.fetch, release: 'test', origins: [ORGANIZERS_ORIGINS[0]!] });
  R1 = await reservation('Retiro de Ana');
  R2 = await reservation('Retiro que organiza dirección');
  R3 = await reservation('Retiro de otra');
  ana = await organizerSession(R1, 'ana-tp@example.invalid');
  otra = await organizerSession(R3, 'otra-tp@example.invalid');
  // Dirección: organiza R2 y, por su nivel de casa, tiene «todos» (lo concede Core; aquí, a mano).
  dire = await organizerSession(R2, 'dire-tp@example.invalid');
  await booking.t.db.query(`update core.memberships set scopes = jsonb_set(scopes, '{grants}', (scopes -> 'grants') || '[{"all": true}]'::jsonb) where app = 'organizers' and user_id = $1`, [dire.id]);
  await booking.t.db.query(`insert into core.house_levels (user_id, level) values ($1, 'direccion') on conflict (user_id) do update set level = 'direccion'`, [dire.id]);
});
test.after(async () => { await booking.close(); });

test('organizers · dirección no escribe en un retiro que no es suyo: lo propone; en el suyo escribe', async () => {
  const offer = { op: 'insert', table: TABLES.offers, id: uuid(), fields: { reservation_id: R1, name: 'Masaje', price: 30 } };
  const direct = await commit(dire.token, [offer]);
  assert.equal(direct.status, 403);
  assert.equal(code(direct), 'SUGGESTION_REQUIRED');
  // También por debajo de la Edge: el gancho de la base de datos pide permiso propio («todos» lo ve, K8, pero no escribe).
  await assert.rejects(
    booking.t.db.query(`select core.commit('organizers', $1, $2, null, null, $3::jsonb)`, [dire.id, `sql-${uuid()}`, JSON.stringify([offer])]),
    /SUGGESTION_REQUIRED/);
  const own = await commit(dire.token, [{ op: 'insert', table: TABLES.offers, id: uuid(), fields: { reservation_id: R2, name: 'Paseo', price: 0 } }]);
  assert.equal(own.status, 200, JSON.stringify(own.data));
});

test('organizers · la propuesta la ve y la acepta quien organiza ese retiro; nadie más la decide', async () => {
  const id = uuid();
  const sent = await suggest(dire.token, R1, [{ op: 'insert', table: TABLES.offers, id, fields: { reservation_id: R1, name: 'Masaje', price: 30 } }]);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.status, 'pending');

  const seenByAna = await org('/api/v1/suggestions?scope=pending', { token: ana.token });
  assert.equal(seenByAna.status, 200, JSON.stringify(seenByAna.data));
  assert.ok(seenByAna.data.items.some((s: any) => s.id === sent.data.id));
  const seenByOtra = await org('/api/v1/suggestions?scope=pending', { token: otra.token });
  assert.ok(!seenByOtra.data.items.some((s: any) => s.id === sent.data.id), 'otro organizador no la ve');
  const seenByDire = await org('/api/v1/suggestions?scope=pending', { token: dire.token });
  assert.ok(!seenByDire.data.items.some((s: any) => s.id === sent.data.id), 'dirección no la tiene para decidir');
  const mine = await org('/api/v1/suggestions?scope=mine', { token: dire.token });
  assert.ok(mine.data.items.some((s: any) => s.id === sent.data.id), 'dirección la sigue en las suyas');

  assert.equal((await org(`/api/v1/suggestions/${sent.data.id}/approve`, { token: dire.token, body: {} })).status, 404);
  assert.equal((await org(`/api/v1/suggestions/${sent.data.id}/approve`, { token: otra.token, body: {} })).status, 404);

  const approved = await org(`/api/v1/suggestions/${sent.data.id}/approve`, { token: ana.token, body: {} });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.status, 'approved');
  const rows = await booking.t.db.query<{ reservation_id: string; name: string }>('select reservation_id, name from organizers.offers where id = $1', [id]);
  assert.deepEqual(rows.rows.map((r) => [r.reservation_id, r.name]), [[R1, 'Masaje']]);
});

test('organizers · un material propuesto pasa a la biblioteca de quien lo acepta', async () => {
  const id = uuid();
  const sent = await suggest(dire.token, R1, [{ op: 'insert', table: TABLES.materials, id, fields: { reservation_id: R1, owner_id: dire.id, kind: 'link', title: 'Mapa', url: 'https://example.invalid/mapa', published: false, window: 'always', position: 1 } }]);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  // Tal cual, el dueño sería dirección: el gancho lo impide.
  assert.notEqual((await org(`/api/v1/suggestions/${sent.data.id}/approve`, { token: ana.token, body: {} })).status, 200);
  const fixed = sent.data.operations.map((op: any) => ({ ...op, fields: { ...op.fields, owner_id: ana.id } }));
  const approved = await org(`/api/v1/suggestions/${sent.data.id}/approve`, { token: ana.token, body: { operations: fixed } });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  const rows = await booking.t.db.query<{ owner_id: string }>('select owner_id from organizers.materials where id = $1', [id]);
  assert.equal(rows.rows[0]?.owner_id, ana.id);
});

test('organizers · descartar no cambia nada, y sin el nivel «dirección» no se puede proponer', async () => {
  const id = uuid();
  const sent = await suggest(dire.token, R1, [{ op: 'insert', table: TABLES.offers, id, fields: { reservation_id: R1, name: 'Cata', price: 12 } }]);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const rejected = await org(`/api/v1/suggestions/${sent.data.id}/reject`, { token: ana.token, body: { comment: 'Este año no' } });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.data));
  assert.equal(rejected.data.status, 'rejected');
  assert.equal((await booking.t.db.query('select 1 from organizers.offers where id = $1', [id])).rows.length, 0);

  const notDire = await suggest(otra.token, R3, [{ op: 'insert', table: TABLES.offers, id: uuid(), fields: { reservation_id: R3, name: 'X', price: 1 } }]);
  assert.equal(notDire.status, 403);
});
