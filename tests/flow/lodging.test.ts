/**
 * Flow · «Alójate aquí» en la carta (migración 0936), sobre PGlite: el menú lo ofrece solo si el evento del flujo admite
 * alojamiento (Booking), con el código público; el cliente web se liga una vez al visitante del kit; el traspaso da un
 * código de un uso. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
const V1 = '0f10a000-0000-4000-8000-000000000001';
const IP = '198.51.100.30';
let app: TestApp;
let code = '';
let seq = 0;

const day = (offset: number) => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
  // Jornadas abiertas con una tarifa de alojamiento por persona y noche (Booking 0498), ligadas a la barra v1.
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, 'owner') on conflict do nothing`, [app.users.owner]);
  const commit = (operations: unknown[]) => { const id = `bk-${++seq}`; return app.t.rpc('core_commit', { p_app: 'booking', p_actor: app.users.owner, p_request_id: id, p_digest: id, p_expected_cursor: null, p_operations: operations }); };
  const res = crypto.randomUUID(); const ev = crypto.randomUUID();
  await commit([{ op: 'insert', table: 'booking.rates', id: crypto.randomUUID(), fields: { name: 'Cama en albergue', layer: 'por_persona', unit: 'persona_noche', amount: 25, service: 'alojamiento', event_types: ['jornadas_abiertas'] } }]);
  await commit([{ op: 'insert', table: 'booking.reservations', id: res, fields: { title: 'Jornadas sintéticas', event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: day(10), end_date: day(13), expected_guests: 100, guests_visible: true, contact_name: 'Persona Sintética' } }]);
  await commit([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: ev, from_status: 'pre_reservada' } }]);
  code = (await app.t.db.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [ev])).rows[0]!.c;
  const p = (await app.call(`/api/v1/snapshot?tables=${TABLES.projects}`)).data.tables[0].rows.find((x: any) => x.id === V1);
  const r = await app.call('/api/v1/commands', { body: { requestId: `lg-${++seq}`, operations: [{ op: 'update', table: TABLES.projects, id: V1, expectedRevision: p.revision, fields: { booking_event_id: ev } }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});
test.after(async () => { await app.close(); });

const pub = (path: string, init: { body?: unknown; visitor?: string; customer?: string } = {}) =>
  app.call(`/api/v1/public/${path}`, { token: null, body: init.body ?? {},
    headers: { 'X-Ikisai-Client-Ip': IP, ...(init.visitor ? { 'X-Visitor': init.visitor } : {}), ...(init.customer ? { 'X-Flow-Customer': init.customer } : {}) } });

test('alójate · el menú lo ofrece con el código público del evento, que admite alojamiento', async () => {
  const menu = await app.call('/api/v1/public/menu', { token: null });
  assert.equal(menu.status, 200, JSON.stringify(menu.data));
  assert.deepEqual(menu.data.lodging, { eventCode: code });
});

test('alójate · el cliente web se liga una vez al visitante; el traspaso da un código de un uso', async () => {
  const customer = (await pub('customer')).data.token as string;
  const visitor = (await pub('visitor', { body: { eventCode: code } })).data.token as string;
  const linked = await pub('customer_visitor', { visitor, customer });
  assert.equal(linked.status, 200, JSON.stringify(linked.data)); assert.equal(linked.data.linked, true);
  assert.equal((await pub('customer_visitor', { visitor, customer })).data.linked, true); // repetir no cambia nada
  const other = (await pub('visitor', { body: { eventCode: code } })).data.token as string;
  assert.equal((await pub('customer_visitor', { visitor: other, customer })).data.linked, false); // ya tiene visitante
  assert.equal((await pub('customer_visitor', { customer })).status, 401); // sin visitante
  const handoff = await pub('visitor/handoff', { visitor });
  assert.equal(handoff.status, 200, JSON.stringify(handoff.data)); assert.match(handoff.data.code, /^[0-9a-f]{64}$/);
});
