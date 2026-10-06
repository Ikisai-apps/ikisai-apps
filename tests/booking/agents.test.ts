/**
 * Booking · agentes de IA de extremo a extremo (contrato §3.1): un owner crea un agente editor y el agente trabaja con
 * su clave `ika_`. Lo cotidiano pasa; cancelar una reserva, tocar importes y confirmar exigen aprobación
 * humana (`agentRisk` de Booking y procedimiento no seguro); con la propuesta aprobada, el mismo lote se aplica.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createFakeCalendarAdapter } from '../../supabase/functions/booking-api/calendar/adapter.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const { reservations: RESERVATIONS, finance: FINANCE, guests: GUESTS } = TABLES;
const CONFIRM = 'booking.confirm_reservation';
const uuid = () => crypto.randomUUID();

let app: TestApp;
let agentKey: string;
let reservationId: string;
let eventId: string;

test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], calendar: { adapter: createFakeCalendarAdapter() } }),
  });
});
test.after(async () => { await app.close(); });

const asAgent = (requestId: string, operations: unknown[], extra: Record<string, unknown> = {}) =>
  app.call('/api/v1/commands', { token: agentKey, body: { requestId, operations, ...extra } });
const revision = async (table: string, id: string) => Number((await app.t.db.query<{ revision: string }>(`select revision from ${table} where id = $1`, [id])).rows[0]!.revision);

test('agentes · alta del agente y política: calendar_retry es segura, confirmar no', async () => {
  const issued = await app.call('/api/v1/agents', { body: { name: 'Asistente de reservas', role: 'editor' } });
  assert.equal(issued.status, 200, JSON.stringify(issued.data));
  agentKey = issued.data.token;
  const boot = await app.call('/api/v1/bootstrap', { token: agentKey });
  assert.equal(boot.status, 200, JSON.stringify(boot.data));
  assert.ok(boot.data.agentPolicy.safeActions.includes('booking.calendar_retry'), JSON.stringify(boot.data.agentPolicy));
  assert.equal(boot.data.agentPolicy.safeProcedures.includes(CONFIRM), false);
  // un agente editor sin `scopes.guests` no ve huéspedes, igual que un editor humano
  assert.equal((await app.call(`/api/v1/snapshot?tables=${GUESTS}`, { token: agentKey })).data.tables?.[0]?.rows?.length ?? 0, 0);
});

test('agentes · lo cotidiano pasa sin aprobación: crear una pre-reserva, cambiar contacto, reintentar Calendar', async () => {
  reservationId = uuid();
  const created = await asAgent('ag-new', [
    { op: 'insert', table: RESERVATIONS, id: reservationId, fields: { title: 'Retiro del agente', status: 'pre_reservada', start_date: '2027-05-07', end_date: '2027-05-09', expected_guests: 12 } },
    { op: 'insert', table: FINANCE, id: reservationId, fields: {} },
  ]);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const phone = await asAgent('ag-phone', [{ op: 'update', table: RESERVATIONS, id: reservationId, expectedRevision: await revision(RESERVATIONS, reservationId), fields: { contact_phone: '600000000' } }]);
  assert.equal(phone.status, 200, JSON.stringify(phone.data));
  const retry = await app.call('/api/v1/invoke/booking.calendar_retry', { token: agentKey, body: { reservationId } });
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
});

test('agentes · confirmar, cancelar e importes exigen aprobación (428) con el motivo', async () => {
  const confirm = await asAgent('ag-confirm', [{ op: 'call', procedure: CONFIRM, args: { reservation_id: reservationId, event_id: uuid(), from_status: 'pre_reservada' } }]);
  assert.equal(confirm.status, 428); assert.equal(confirm.data.error.code, 'CONFIRMATION_REQUIRED');
  assert.ok(confirm.data.error.details.risk.reasons.includes(`call:${CONFIRM}`), JSON.stringify(confirm.data.error.details));

  const cancel = await asAgent('ag-cancel', [{ op: 'update', table: RESERVATIONS, id: reservationId, expectedRevision: await revision(RESERVATIONS, reservationId), fields: { status: 'cancelada' } }]);
  assert.equal(cancel.status, 428);
  assert.ok(cancel.data.error.details.risk.reasons.includes('booking:status:cancelada'), JSON.stringify(cancel.data.error.details));

  const money = await asAgent('ag-money', [{ op: 'update', table: FINANCE, id: reservationId, expectedRevision: await revision(FINANCE, reservationId), fields: { deposit_paid: 100 } }]);
  assert.equal(money.status, 428);
  assert.ok(money.data.error.details.risk.reasons.includes('booking:finance'));
  assert.equal((await app.t.db.query<{ status: string }>(`select status from booking.reservations where id = $1`, [reservationId])).rows[0]!.status, 'pre_reservada', 'nada se aplicó');
});

test('agentes · con la propuesta aprobada por el owner humano, la confirmación se aplica una vez', async () => {
  const operations = [{ op: 'call', procedure: CONFIRM, args: { reservation_id: reservationId, event_id: (eventId = uuid()), from_status: 'pre_reservada' } }];
  const proposal = await app.call('/api/v1/proposals', { token: agentKey, body: { requestId: 'ag-confirm-ok', operations } });
  assert.equal(proposal.status, 200, JSON.stringify(proposal.data));
  const id = proposal.data.id;
  assert.equal((await app.call(`/api/v1/proposals/${id}/approve`, { token: app.tokens.editor, body: {} })).status, 403, 'solo un owner humano aprueba');
  const approved = await app.call(`/api/v1/proposals/${id}/approve`, { body: {} });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  const applied = await asAgent('ag-confirm-ok', operations, { confirmationId: id });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  const row = (await app.t.db.query<{ status: string }>(`select status from booking.reservations where id = $1`, [reservationId])).rows[0]!;
  assert.equal(row.status, 'confirmada');
  assert.equal((await app.t.db.query(`select 1 from booking.events where id = $1`, [eventId])).rows.length, 1);
  assert.equal((await app.call(`/api/v1/proposals/${id}`)).data.status, 'consumed');
});
