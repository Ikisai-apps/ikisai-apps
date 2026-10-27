/**
 * Flow · ligar un flujo a un evento de Booking (FL4, migración 0925), sobre PGlite: solo con acceso al evento en Booking
 * (miembro de Booking o personal del evento) y a un evento que existe. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { seedBookingEvent } from './booking-event.ts';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
const V1 = '0f10a000-0000-4000-8000-000000000001';
const EVENT = crypto.randomUUID();
let app: TestApp;
let seq = 0;

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
  await seedBookingEvent(app.t.db, EVENT); // sin miembros de Booking todavía
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `ea-${++seq}-${crypto.randomUUID()}`, operations } });
async function project(id: string): Promise<any> { return (await app.call(`/api/v1/snapshot?tables=${TABLES.projects}`)).data.tables[0].rows.find((r: any) => r.id === id); }
const link = async (event: string) => { const p = await project(V1); return commit([{ op: 'update', table: TABLES.projects, id: V1, expectedRevision: p.revision, fields: { booking_event_id: event } }]); };

test('evento · el owner de Flow sin acceso en Booking no liga el flujo al evento (ni al crear ni al cambiarlo)', async () => {
  const r = await link(EVENT);
  assert.equal(r.status, 403, JSON.stringify(r.data)); assert.equal(r.data.error.code, 'EVENT_NOT_ACCESSIBLE');
  const created = await commit([{ op: 'call', procedure: PROCEDURES.createFlow, args: { template_key: 'checkin', project_id: crypto.randomUUID(), name: 'Llegadas', booking_event_id: EVENT } }]);
  assert.equal(created.status, 403, JSON.stringify(created.data)); assert.equal(created.data.error.code, 'EVENT_NOT_ACCESSIBLE');
  assert.equal((await project(V1)).booking_event_id, null);
});

test('evento · del personal del evento o miembro de Booking, sí; un evento que no existe, nunca', async () => {
  await app.t.db.query(`insert into booking.staff_assignments (event_id, member_user_id, person_name, function, work_date, status)
    values ($1, $2, 'Persona de prueba', 'cocina', '2026-10-31', 'confirmada')`, [EVENT, app.users.owner]);
  assert.equal((await app.t.db.query<{ n: number }>(`select count(*)::int n from core.memberships where app = 'booking' and user_id = $1`, [app.users.owner])).rows[0]!.n, 0);
  const r = await link(EVENT);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await project(V1)).booking_event_id, EVENT);
  const ghost = await link(crypto.randomUUID());
  assert.equal(ghost.status, 403); assert.equal(ghost.data.error.code, 'EVENT_NOT_ACCESSIBLE');
});
