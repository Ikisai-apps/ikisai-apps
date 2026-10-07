/** Booking · enlaces de los portales Organizers y Guests (contrato §3.6; Core, ronda 24): emisión y caducidad ligada a la reserva. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

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
  const res = await app.call('/api/v1/commands', { body: { requestId: `pl-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
const validUntil = async (scope: unknown) =>
  (await app.t.db.query<{ v: string | null }>(`select booking.portal_link_valid_until($1::jsonb)::text v`, [JSON.stringify(scope)])).rows[0]!.v;
const revision = async (id: string) => Number((await app.t.db.query<{ revision: string }>(`select revision from booking.reservations where id = $1`, [id])).rows[0]!.revision);

test('portales · caducidad: fin de la reserva + 3 días (hora de Madrid), se mueve con la fecha; cancelada o inexistente, caducado', async () => {
  const id = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id, fields: { title: 'Retiro portal', status: 'negociacion', start_date: '2027-06-10', end_date: '2027-06-12', expected_guests: 12 } }]);
  // 12 + 3 = 15 de junio, hasta el final del día en Madrid (UTC+2 en verano)
  assert.equal(new Date((await validUntil({ reservation_id: id }))!).toISOString(), '2027-06-15T22:00:00.000Z');
  assert.equal(await validUntil({ reservation_id: id, guest_id: uuid() }), await validUntil({ reservation_id: id }), 'el de huésped sigue a su reserva');

  await ok([{ op: 'update', table: TABLES.reservations, id, expectedRevision: await revision(id), fields: { end_date: '2027-06-20' } }]);
  assert.equal(new Date((await validUntil({ reservation_id: id }))!).toISOString(), '2027-06-23T22:00:00.000Z');

  // sin fecha de salida: 90 días desde el alta
  const noDates = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: noDates, fields: { title: 'Sin fechas', status: 'en_estudio' } }]);
  const created = (await app.t.db.query<{ c: string }>(`select (created_at + interval '90 days')::text c from booking.reservations where id = $1`, [noDates])).rows[0]!.c;
  assert.equal(new Date((await validUntil({ reservation_id: noDates }))!).getTime(), new Date(created).getTime());

  await ok([{ op: 'update', table: TABLES.reservations, id, expectedRevision: await revision(id), fields: { status: 'cancelada' } }]);
  assert.equal(await validUntil({ reservation_id: id }), null);
  assert.equal(await validUntil({ reservation_id: uuid() }), null);
  assert.equal(await validUntil({ reservation_id: 'no-uuid' }), null);
});

test('portales · Booking emite el enlace del organizador (lector no), lo lista, lo amplía y lo revoca', async () => {
  const id = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id, fields: { title: 'Retiro enlaces', status: 'pre_reservada', start_date: '2027-07-01', end_date: '2027-07-03', expected_guests: 8, contact_name: 'Persona Organizadora' } }]);
  const body = { app: 'organizers', scope: { reservation_id: id }, person: { name: 'Persona Organizadora', email: 'organizadora@example.invalid' } };
  assert.equal((await app.call('/api/v1/portal-links', { token: app.tokens.reader, body })).status, 403);
  const issued = await app.call('/api/v1/portal-links', { token: app.tokens.editor, body });
  assert.equal(issued.status, 200, JSON.stringify(issued.data));
  assert.match(issued.data.url, /^https:\/\/organizers\.ikisai\.com\/i\/[A-Za-z0-9_-]{43}$/);
  assert.equal(new Date(issued.data.validUntil).toISOString(), '2027-07-06T22:00:00.000Z');

  const list = await app.call(`/api/v1/portal-links?reservation=${id}`, { token: app.tokens.editor });
  assert.equal(list.status, 200);
  assert.equal(list.data.items.length, 1);
  assert.ok(!JSON.stringify(list.data).includes(issued.data.url.split('/i/')[1]), 'la lista no repite el token');

  const later = '2027-08-01T10:00:00.000Z';
  const ext = await app.call(`/api/v1/portal-links/${issued.data.linkId}/extend`, { token: app.tokens.editor, body: { until: later } });
  assert.equal(ext.status, 200, JSON.stringify(ext.data));
  assert.equal(new Date(ext.data.validUntil).toISOString(), later);
  const rev = await app.call(`/api/v1/portal-links/${issued.data.linkId}/revoke`, { token: app.tokens.editor, body: {} });
  assert.equal(rev.status, 200);
  assert.ok(rev.data.revokedAt);
});
