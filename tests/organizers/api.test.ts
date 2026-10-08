/**
 * Organizers · `organizers-api` de punta a punta (docs/organizers/API.md §6): canje del enlace emitido por Booking, lecturas
 * y acciones de Booking dentro y fuera del ámbito del organizador, y enlaces de sus huéspedes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createOrganizersApp, ORGANIZERS_ORIGINS } from '../../supabase/functions/organizers-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const ORIGIN = ORGANIZERS_ORIGINS[0]!;
const uuid = () => crypto.randomUUID();
let booking: TestApp;
let organizers: (r: Request) => Promise<Response>;
let seq = 0;

async function call(path: string, init: { token?: string | null; body?: unknown; method?: string; origin?: string } = {}) {
  const res = await organizers(new Request(`${booking.supabase.url}/functions/v1/organizers-api${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { Origin: init.origin ?? ORIGIN, 'Content-Type': 'application/json', ...(init.token ? { Authorization: 'Bearer ' + init.token } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }));
  return { status: res.status, data: await res.json().catch(() => null) };
}
const code = (res: { data: any }) => res.data?.error?.code;

async function commit(operations: unknown[]) {
  const res = await booking.call('/api/v1/commands', { body: { requestId: `org-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
async function reservation(confirm: boolean, title: string): Promise<string> {
  const id = uuid();
  await commit([{ op: 'insert', table: TABLES.reservations, id, fields: { title, status: 'pre_reservada', start_date: '2027-09-10', end_date: '2027-09-12', expected_guests: 12 } }]);
  if (confirm) await commit([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: id, event_id: uuid(), from_status: 'pre_reservada' } }]);
  return id;
}
/** El personal de Booking emite el enlace del organizador (uno por reserva, misma cuenta por correo); se canjea en Organizers. */
async function organizerSession(reservations: string[], email: string): Promise<string> {
  let token = '';
  for (const reservation_id of reservations) {
    const link = await booking.call('/api/v1/portal-links', { token: booking.tokens.editor, body: { app: 'organizers', scope: { reservation_id }, person: { name: 'Organizadora', email } } });
    assert.equal(link.status, 200, JSON.stringify(link.data));
    token = link.data.url.split('/i/')[1];
  }
  const session = await call('/api/v1/auth/link', { body: { token } });
  assert.equal(session.status, 200, JSON.stringify(session.data));
  return session.data.token;
}

let R1: string; // confirmada
let R2: string; // sin confirmar
let R3: string; // de otra organizadora
let org: string;
let other: string;

test.before(async () => {
  booking = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
  organizers = createOrganizersApp({ url: booking.supabase.url, anonKey: booking.supabase.anonKey, serviceKey: booking.supabase.serviceKey, fetch: booking.supabase.fetch, origins: [ORIGIN], release: 'test' });
  R1 = await reservation(true, 'Retiro de primavera');
  R2 = await reservation(false, 'Retiro de otoño');
  R3 = await reservation(true, 'Retiro ajeno');
  org = await organizerSession([R1, R2], 'organizadora@example.invalid');
  other = await organizerSession([R3], 'otra@example.invalid');
});
test.after(async () => { await booking.close(); });

test('organizers · auth: health público, sin token 401, origen ajeno 403, enlace inválido 401', async () => {
  const health = await call('/api/v1/health');
  assert.equal(health.status, 200); assert.equal(health.data.app, 'organizers');
  assert.equal((await call('/api/v1/bootstrap')).status, 401);
  assert.equal((await call('/api/v1/bootstrap', { token: org, origin: 'https://foreign.example' })).status, 403);
  const bad = await call('/api/v1/auth/link', { body: { token: 'A'.repeat(43) } });
  assert.equal(bad.status, 401); assert.equal(code(bad), 'LINK_INVALID');
});

test('organizers · el enlace da acceso de editor con ámbito por reserva; members solo devuelve a la propia persona', async () => {
  const boot = await call('/api/v1/bootstrap', { token: org });
  assert.equal(boot.status, 200, JSON.stringify(boot.data));
  assert.equal(boot.data.membership.role, 'editor');
  const grants = boot.data.membership.scopes.grants.map((g: any) => g.reservation_id).sort();
  assert.deepEqual(grants, [R1, R2].sort());
  const members = await call('/api/v1/members', { token: org });
  assert.equal(members.status, 200, JSON.stringify(members.data));
  assert.equal(members.data.length, 1);
  assert.equal(members.data[0].displayName, 'Organizadora');
});

test('organizers · lecturas de Booking: solo sus retiros; fuera de ámbito OUT_OF_SCOPE', async () => {
  const mine = await call('/api/v1/read/booking.portal_reservations', { token: org, body: {} });
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  const ids = mine.data.items.map((r: any) => r.id).sort();
  assert.deepEqual(ids, [R1, R2].sort());
  assert.equal(mine.data.items.find((r: any) => r.id === R1).confirmed, true);
  assert.equal(mine.data.items.find((r: any) => r.id === R2).confirmed, false);

  assert.equal((await call('/api/v1/read/booking.portal_guests', { token: org, body: { reservation_id: R2 } })).data.confirmed, false);
  const foreign = await call('/api/v1/read/booking.portal_guests', { token: org, body: { reservation_id: R3 } });
  assert.equal(foreign.status, 403); assert.equal(code(foreign), 'OUT_OF_SCOPE');
  assert.equal(code(await call('/api/v1/read/booking.portal_kitchen_summary', { token: other, body: { reservation_id: R1 } })), 'OUT_OF_SCOPE');
  // Lo que Booking publica solo para Guests no se puede leer desde Organizers.
  assert.ok((await call('/api/v1/read/booking.portal_my_guest', { token: org, body: {} })).status >= 400);
});

test('organizers · asistentes: alta con declaración, datos, restricciones, cocina y baja; nunca en reservas ajenas', async () => {
  const add = (reservation_id: string, guest_id: string, extra: Record<string, unknown> = {}) =>
    call('/api/v1/invoke/booking.portal_add_guest', { token: org, body: { reservation_id, guest_id, fields: { first_name: 'Ana', last_name_1: 'Sintética' }, ...extra } });

  assert.equal(code(await add(R2, uuid(), { declaration: true })), 'RESERVATION_NOT_CONFIRMED');
  assert.equal(code(await add(R3, uuid(), { declaration: true })), 'OUT_OF_SCOPE');
  const ana = uuid();
  assert.equal(code(await add(R1, ana)), 'DECLARATION_REQUIRED');
  const created = await add(R1, ana, { declaration: true, declaration_version: 'org-v1' });
  assert.equal(created.status, 200, JSON.stringify(created.data));

  let list = await call('/api/v1/read/booking.portal_guests', { token: org, body: { reservation_id: R1 } });
  let row = list.data.items.find((g: any) => g.id === ana);
  assert.equal(row.display_name, 'Ana S.');
  assert.ok(row.missing.length > 0);

  const updated = await call('/api/v1/invoke/booking.portal_update_guest', { token: org, body: { guest_id: ana, expectedRevision: row.revision, fields: { email: 'ana@example.invalid' } } });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  const stale = await call('/api/v1/invoke/booking.portal_update_guest', { token: org, body: { guest_id: ana, expectedRevision: row.revision, fields: { phone: '600000000' } } });
  assert.equal(code(stale), 'VERSION_CONFLICT');
  assert.equal(code(await call('/api/v1/invoke/booking.portal_update_guest', { token: other, body: { guest_id: ana, fields: { phone: '600000000' } } })), 'OUT_OF_SCOPE');

  const restrictions = await call('/api/v1/invoke/booking.portal_set_restrictions', { token: org, body: { guest_id: ana, items: [{ restriction_type: 'alergia', subject: 'frutos secos', severity: 'grave' }] } });
  assert.equal(restrictions.status, 200, JSON.stringify(restrictions.data));
  const kitchen = await call('/api/v1/read/booking.portal_kitchen_summary', { token: org, body: { reservation_id: R1 } });
  assert.equal(kitchen.status, 200, JSON.stringify(kitchen.data));
  assert.ok(kitchen.data.totals.some((t: any) => t.restriction_type === 'alergia' && t.subject === 'frutos secos'));
  assert.ok(kitchen.data.named.some((n: any) => n.guest === 'Ana S.'), 'lo escribió la organizadora: lo ve con nombre');

  list = await call('/api/v1/read/booking.portal_guests', { token: org, body: { reservation_id: R1 } });
  row = list.data.items.find((g: any) => g.id === ana);
  assert.equal(row.fields.email, 'ana@example.invalid');
  const removed = await call('/api/v1/invoke/booking.portal_remove_guest', { token: org, body: { guest_id: ana, expectedRevision: row.revision } });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  list = await call('/api/v1/read/booking.portal_guests', { token: org, body: { reservation_id: R1 } });
  assert.equal(list.data.items.some((g: any) => g.id === ana), false);
});

test('organizers · enlaces de huésped: solo de huésped y de sus reservas; lista, revoca y no amplía', async () => {
  const guest = uuid();
  const added = await call('/api/v1/invoke/booking.portal_add_guest', { token: org, body: { reservation_id: R1, guest_id: guest, fields: { first_name: 'Leo' } } });
  assert.equal(added.status, 200, JSON.stringify(added.data));

  assert.equal((await call('/api/v1/portal-links', { token: org, body: { app: 'organizers', scope: { reservation_id: R1 }, person: { name: 'Otro' } } })).status, 403);
  assert.equal((await call('/api/v1/portal-links', { token: org, body: { app: 'guests', scope: { reservation_id: R3, guest_id: uuid() }, person: { name: 'Nadie' } } })).status, 403);

  const link = await call('/api/v1/portal-links', { token: org, body: { app: 'guests', scope: { reservation_id: R1, guest_id: guest }, person: { name: 'Leo' }, label: 'Leo' } });
  assert.equal(link.status, 200, JSON.stringify(link.data));
  assert.match(link.data.url, /^https:\/\/guests\.ikisai\.com\/i\/[A-Za-z0-9_-]{43}$/);
  assert.equal(link.data.shownOnce, true);

  const listed = await call(`/api/v1/portal-links?reservation=${R1}`, { token: org });
  assert.equal(listed.status, 200, JSON.stringify(listed.data));
  assert.ok(listed.data.items.every((l: any) => l.app === 'guests'), 'no ve el enlace de organizador');
  assert.ok(listed.data.items.some((l: any) => l.linkId === link.data.linkId && l.scope.guest_id === guest));
  assert.equal((await call(`/api/v1/portal-links?reservation=${R3}`, { token: org })).status, 403);

  assert.equal((await call(`/api/v1/portal-links/${link.data.linkId}/extend`, { token: org, body: { until: '2030-01-01T00:00:00Z' } })).status, 403);
  assert.ok((await call(`/api/v1/portal-links/${link.data.linkId}/revoke`, { token: other, body: {} })).status >= 400);
  const revoked = await call(`/api/v1/portal-links/${link.data.linkId}/revoke`, { token: org, body: {} });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
  const after = await call(`/api/v1/portal-links?reservation=${R1}`, { token: org });
  assert.ok(after.data.items.find((l: any) => l.linkId === link.data.linkId).revokedAt);
});

test('organizers · fechas (fase 2): calendario por fines de semana, marcar posibles, releer; nunca fuera de ámbito', async () => {
  const id = uuid();
  await commit([{ op: 'insert', table: TABLES.reservations, id, fields: { title: 'Retiro en estudio', status: 'en_estudio' } }]);
  const token = await organizerSession([id], 'disena@example.invalid');

  const dates = await call('/api/v1/read/booking.portal_dates', { token, body: { reservation_id: id } });
  assert.equal(dates.status, 200, JSON.stringify(dates.data));
  assert.equal(dates.data.mode, 'calendar');
  const weekends = await call('/api/v1/read/booking.portal_availability', { token, body: { reservation_id: id } });
  assert.equal(weekends.status, 200, JSON.stringify(weekends.data));
  const free = weekends.data.weekends.filter((w: any) => w.status !== 'ocupado').slice(0, 2);
  assert.equal(free.length, 2);

  const set = await call('/api/v1/invoke/booking.portal_set_date_preferences', { token, body: { reservation_id: id, options: free.map((w: any) => ({ start: w.start, end: w.end })) } });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  const again = await call('/api/v1/read/booking.portal_dates', { token, body: { reservation_id: id } });
  assert.deepEqual(again.data.options.map((o: any) => o.start), free.map((w: any) => w.start));
  assert.ok(again.data.options.every((o: any) => o.proposed_by === 'organizer' && o.organizer_ok));

  assert.equal(code(await call('/api/v1/read/booking.portal_dates', { token: other, body: { reservation_id: id } })), 'OUT_OF_SCOPE');
  assert.equal(code(await call('/api/v1/invoke/booking.portal_set_date_preferences', { token: other, body: { reservation_id: id, options: [] } })), 'OUT_OF_SCOPE');
});

test('organizers · diseño (fase 2): borrador con extras solo en estudio o negociación; peticiones sobre la propuesta', async () => {
  const id = uuid();
  await commit([{ op: 'insert', table: TABLES.reservations, id, fields: { title: 'Retiro a diseñar', status: 'negociacion' } }]);
  const token = await organizerSession([id], 'borrador@example.invalid');

  const rates = await call('/api/v1/read/booking.portal_rates', { token, body: { reservation_id: id } });
  assert.equal(rates.status, 200, JSON.stringify(rates.data));
  const draft = await call('/api/v1/invoke/booking.portal_update_draft', { token, body: { reservation_id: id, fields: { expected_guests: 18, requires_meals: true, organizer_notes: 'Necesitamos proyector', internal_notes: 'no se cuela' } } });
  assert.equal(draft.status, 200, JSON.stringify(draft.data));
  const stored = (await booking.t.db.query<Record<string, any>>('select expected_guests, requires_meals, organizer_notes, internal_notes from booking.reservations where id = $1', [id])).rows[0]!;
  assert.deepEqual([stored.expected_guests, stored.requires_meals, stored.organizer_notes, stored.internal_notes], [18, true, 'Necesitamos proyector', null]);
  assert.equal(code(await call('/api/v1/invoke/booking.portal_update_draft', { token, body: { reservation_id: id, extras: [{ rate_id: uuid(), quantity: 1 }] } })), 'EXTRA_NOT_OFFERED');

  assert.deepEqual((await call('/api/v1/read/booking.portal_proposals', { token, body: { reservation_id: id } })).data.items, []);
  assert.equal(code(await call('/api/v1/invoke/booking.portal_request', { token, body: { reservation_id: id, kind: 'comentario' } })), 'INVALID_FIELDS');
  const asked = await call('/api/v1/invoke/booking.portal_request', { token, body: { reservation_id: id, kind: 'quiere_confirmar' } });
  assert.equal(asked.status, 200, JSON.stringify(asked.data));
  const mine = await call('/api/v1/read/booking.portal_my_requests', { token, body: { reservation_id: id } });
  assert.deepEqual(mine.data.items.map((r: any) => [r.kind, r.status, r.mine]), [['quiere_confirmar', 'enviada', true]]);

  assert.equal(code(await call('/api/v1/invoke/booking.portal_update_draft', { token: other, body: { reservation_id: id, fields: { expected_guests: 1 } } })), 'OUT_OF_SCOPE');
  // En prerreserva el diseño queda cerrado: los cambios se hablan con el personal.
  const pending = await call('/api/v1/invoke/booking.portal_update_draft', { token: org, body: { reservation_id: R2, fields: { expected_guests: 3 } } });
  assert.equal(code(pending), 'DRAFT_LOCKED');
});
