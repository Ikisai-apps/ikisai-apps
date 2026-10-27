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

// Regla 1 de VG (26-10-2026, migración 0481): el enlace vale mientras exista la reserva, también terminada, cancelada o perdida.
test('portales · sin caducidad: vale mientras la reserva exista; borrada o inexistente, no', async () => {
  const id = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id, fields: { title: 'Retiro portal', status: 'negociacion', start_date: '2020-06-10', end_date: '2020-06-12', expected_guests: 12 } }]);
  assert.equal(await validUntil({ reservation_id: id }), 'infinity', 'aunque terminó hace años');
  assert.equal(await validUntil({ reservation_id: id, guest_id: uuid() }), 'infinity', 'el de huésped sigue a su reserva');
  const noDates = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: noDates, fields: { title: 'Sin fechas', status: 'en_estudio' } }]);
  assert.equal(await validUntil({ reservation_id: noDates }), 'infinity');
  await ok([{ op: 'update', table: TABLES.reservations, id, expectedRevision: await revision(id), fields: { status: 'cancelada' } }]);
  assert.equal(await validUntil({ reservation_id: id }), 'infinity', 'cancelada: se sigue entrando');
  await app.t.db.query(`update booking.reservations set deleted_at = now() where id = $1`, [noDates]);
  assert.equal(await validUntil({ reservation_id: noDates }), null);
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
  assert.equal(String(issued.data.validUntil).toLowerCase(), 'infinity');

  const list = await app.call(`/api/v1/portal-links?reservation=${id}`, { token: app.tokens.editor });
  assert.equal(list.status, 200);
  assert.equal(list.data.items.length, 1);
  assert.ok(!JSON.stringify(list.data).includes(issued.data.url.split('/i/')[1]), 'la lista no repite el token');

  const later = '2027-08-01T10:00:00.000Z';
  const ext = await app.call(`/api/v1/portal-links/${issued.data.linkId}/extend`, { token: app.tokens.editor, body: { until: later } });
  assert.equal(ext.status, 200, JSON.stringify(ext.data));
  assert.equal(String(ext.data.validUntil).toLowerCase(), 'infinity', 'ampliar no acorta: sigue sin caducidad');
  const rev = await app.call(`/api/v1/portal-links/${issued.data.linkId}/revoke`, { token: app.tokens.editor, body: {} });
  assert.equal(rev.status, 200);
  assert.ok(rev.data.revokedAt);
});
