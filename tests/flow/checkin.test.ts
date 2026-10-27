/**
 * Flow · check-in del evento (migración 0911, paso 5), sobre PGlite. Plantilla `checkin` (Llegada → Cama → Firma →
 * Salida), marca «Cama» de Flow y llegada/salida hacia booking-api (simulada con `appsFetch`). Si la proyección de Booking
 * (#751) aún no está en las migraciones, se crea aquí una vista sintética con su misma forma. Datos inventados.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
const V1 = '0f10a000-0000-4000-8000-000000000001';
const EVENT = crypto.randomUUID();
const GUEST = crypto.randomUUID();
const OTHER_GUEST = crypto.randomUUID(); // de otro evento
const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
let flow = '';
const sent: Array<{ url: string; auth: string | null; body: any }> = [];
let reply: { status: number; body: unknown } = { status: 200, body: { results: [{ result: { guest_id: GUEST, arrived_at: '2026-10-30T10:00:00Z' } }] } };

test.before(async () => {
  const appsFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }, { appsFetch }) });
  const exists = (await app.t.db.query<{ v: string | null }>(`select to_regclass('booking.flow_guests_projection')::text as v`)).rows[0]!.v;
  if (!exists) {
    await app.t.db.exec(`create view booking.flow_guests_projection as
      select * from (values
        ('${EVENT}'::uuid, '${GUEST}'::uuid, 1::bigint, 'Ana P.'::text, null::text, 'Roble'::text, 'Cama 1'::text, '2026-10-30'::date, '2026-11-01'::date, null::timestamptz, null::timestamptz, false),
        ('${uuid()}'::uuid, '${OTHER_GUEST}'::uuid, 1::bigint, 'Luis G.', null, null, null, null, null, null, null, false)
      ) g(event_id, guest_id, guest_revision, display_name, portal_role, space_name, bed_label, from_date, to_date, arrived_at, left_at, signed)`);
    await app.t.db.exec(`select core.allow_read('flow', 'booking.flow_guests_projection', 'view', '{reader,editor,owner}')`);
  }
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[], token = app.tokens.owner) => app.call('/api/v1/commands', { token, body: { requestId: `c-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[], token = app.tokens.owner) { const r = await commit(operations, token); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.results[0].result; }
async function rows(table: string): Promise<any[]> { const s = await app.call(`/api/v1/snapshot?tables=${table}`); return s.data.tables[0].rows; }
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
const code = async (operations: unknown[], token = app.tokens.owner) => (await commit(operations, token)).data.error?.code;

test('check-in · «Nuevo flujo de llegadas» (solo owner) nace de la plantilla con sus cuatro columnas', async () => {
  flow = uuid();
  assert.equal((await commit([call(PROCEDURES.createFlow, { template_key: 'checkin', project_id: flow })], app.tokens.editor)).status, 403);
  const out = await ok([call(PROCEDURES.createFlow, { template_key: 'checkin', project_id: flow, name: 'Llegadas · Encuentro de prueba', booking_event_id: EVENT })]);
  assert.equal(out.template_key, 'checkin'); assert.equal(out.template_version, 1);
  const cols = (await rows(TABLES.columns)).filter((c) => c.project_id === flow).sort((a, b) => a.position - b.position);
  assert.deepEqual(cols.map((c) => [c.key, c.label, c.behavior, c.config.stage]), [
    ['arrival', 'Llegada', 'guest_presence', 'arrival'], ['bed', 'Cama', 'guest_presence', 'bed'],
    ['signature', 'Firma', 'guest_presence', 'signature'], ['departure', 'Salida', 'guest_presence', 'departure']]);
  const p = (await rows(TABLES.projects)).find((x) => x.id === flow);
  assert.equal(p.booking_event_id, EVENT); assert.equal(p.serves_public, false);
  assert.equal(await code([call(PROCEDURES.createFlow, { template_key: 'nada', project_id: uuid() })]), 'NOT_FOUND');
});

test('check-in · «En su cama» es una marca de Flow, por procedimiento, que se deshace; la barra no la tiene', async () => {
  await ok([call(PROCEDURES.markPresence, { project_id: flow, guest_id: GUEST, step: 'bed' })]);
  await ok([call(PROCEDURES.markPresence, { project_id: flow, guest_id: GUEST, step: 'bed' })]); // repetir no duplica
  let live = (await rows(TABLES.presenceMarks)).filter((m) => m.project_id === flow && !m.deleted_at);
  assert.equal(live.length, 1); assert.equal(live[0].done_by, app.users.owner);
  await ok([call(PROCEDURES.markPresence, { project_id: flow, guest_id: GUEST, step: 'bed', undo: true })]);
  live = (await rows(TABLES.presenceMarks)).filter((m) => m.project_id === flow && !m.deleted_at);
  assert.equal(live.length, 0);
  assert.equal(await code([call(PROCEDURES.markPresence, { project_id: V1, guest_id: GUEST, step: 'bed' })]), 'INVALID_OPERATION');
  assert.equal(await code([call(PROCEDURES.markPresence, { project_id: flow, guest_id: GUEST, step: 'bed' })], app.tokens.editor), 'PROJECT_OUT_OF_SCOPE');
  assert.equal(await code([{ op: 'insert', table: TABLES.presenceMarks, id: uuid(), fields: { project_id: flow, guest_id: GUEST, step: 'bed' } }]), 'PROCEDURE_ONLY');
});

test('check-in · llegada y salida van a booking-api con el token de la persona; solo huéspedes del evento del flujo', async () => {
  const arrive = await app.call(`/api/v1/checkin/${flow}/guests/${GUEST}/arrive`, { body: {} });
  assert.equal(arrive.status, 200, JSON.stringify(arrive.data));
  const last = sent.at(-1)!;
  assert.match(last.url, /\/functions\/v1\/booking-api\/api\/v1\/commands$/);
  assert.equal(last.auth, `Bearer ${app.tokens.owner}`);
  assert.deepEqual(last.body.operations, [{ op: 'call', procedure: 'booking.guest_arrive', args: { guest_id: GUEST } }]);
  await app.call(`/api/v1/checkin/${flow}/guests/${GUEST}/leave`, { body: { undo: true } });
  assert.deepEqual(sent.at(-1)!.body.operations[0].args, { guest_id: GUEST, undo: true });
  assert.equal(sent.at(-1)!.body.operations[0].procedure, 'booking.guest_leave');

  const before = sent.length;
  assert.equal((await app.call(`/api/v1/checkin/${flow}/guests/${OTHER_GUEST}/arrive`, { body: {} })).status, 404);
  assert.equal((await app.call(`/api/v1/checkin/${V1}/guests/${GUEST}/arrive`, { body: {} })).status, 403); // la barra no es de check-in
  assert.equal((await app.call(`/api/v1/checkin/${flow}/guests/${GUEST}/arrive`, { token: app.tokens.reader, body: {} })).status, 403);
  assert.equal((await app.call(`/api/v1/checkin/${flow}/guests/${GUEST}/arrive`, { token: app.tokens.editor, body: {} })).data.error.code, 'PROJECT_OUT_OF_SCOPE');
  assert.equal(sent.length, before); // nada de eso llegó a Booking
});

test('check-in · los errores de Booking llegan tal cual; sin acceso a Booking, NEEDS_ACCESS', async () => {
  reply = { status: 409, body: { error: { code: 'SES_ALREADY_REGISTERED', message: 'Comunicado a SES.', details: null } } };
  const ses = await app.call(`/api/v1/checkin/${flow}/guests/${GUEST}/arrive`, { body: { undo: true } });
  assert.equal(ses.status, 409); assert.equal(ses.data.error.code, 'SES_ALREADY_REGISTERED');
  reply = { status: 403, body: { error: { code: 'FORBIDDEN', message: 'No.', details: null } } };
  const forbidden = await app.call(`/api/v1/checkin/${flow}/guests/${GUEST}/arrive`, { body: {} });
  assert.equal(forbidden.status, 403); assert.equal(forbidden.data.error.code, 'NEEDS_ACCESS');
});

test('check-in · sin evento de Booking ligado, NO_BOOKING_EVENT', async () => {
  const bare = uuid();
  await ok([call(PROCEDURES.createFlow, { template_key: 'checkin', project_id: bare })]);
  const r = await app.call(`/api/v1/checkin/${bare}/guests/${GUEST}/arrive`, { body: {} });
  assert.equal(r.status, 409); assert.equal(r.data.error.code, 'NO_BOOKING_EVENT');
});
