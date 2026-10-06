/**
 * Booking · Calendar real: cliente de Google con cuenta de servicio (contra un Google simulado con `fetch` inyectado),
 * bloqueo por calendario sin compartir, ruta de sistema del tick y sincronización tras el commit.
 * La clave RSA se genera en la propia prueba: no hay ningún secreto en el repo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { blockedError, CalendarError, createFakeCalendarAdapter, fatalError } from '../../supabase/functions/booking-api/calendar/adapter.ts';
import { createGoogleCalendarAdapter } from '../../supabase/functions/booking-api/calendar/google.ts';
import { calendarEventId, calendarProjection, TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const CALENDAR = 'calendario-de-prueba@group.calendar.google.com';
const EMAIL = 'cuenta-sintetica@proyecto-de-prueba.iam.gserviceaccount.com';
const uuid = () => crypto.randomUUID();

// --- Google simulado ---------------------------------------------------------
interface FakeGoogle {
  fetch: typeof fetch;
  events: Map<string, any>;
  log: string[];
  tokens: number;
  lastAssertion: string;
  /** Cómo ve la cuenta de servicio el calendario. */
  access: 'writer' | 'reader' | 'none';
  /** Respuesta forzada para la siguiente llamada a la API (no al token). */
  next: { status: number; body?: unknown } | 'network' | null;
  tokenStatus: number;
}

function fakeGoogle(): FakeGoogle {
  const g: FakeGoogle = { events: new Map(), log: [], tokens: 0, lastAssertion: '', access: 'writer', next: null, tokenStatus: 200, fetch: null as unknown as typeof fetch };
  const json = (status: number, body: unknown = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status });
  const denied = () => json(403, { error: { errors: [{ reason: 'forbidden' }] } });
  g.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    if (url.href === 'https://oauth2.googleapis.com/token') {
      g.tokens++;
      g.lastAssertion = new URLSearchParams(String(init.body)).get('assertion') ?? '';
      return g.tokenStatus === 200 ? json(200, { access_token: `token-${g.tokens}`, expires_in: 3600 }) : json(g.tokenStatus, { error: 'invalid_grant' });
    }
    const prefix = `/calendar/v3/calendars/${encodeURIComponent(CALENDAR)}`;
    assert.ok(url.pathname.startsWith(prefix), `ruta inesperada ${url.pathname}`);
    assert.match(String((init.headers as Record<string, string>).Authorization), /^Bearer token-\d+$/);
    const rest = url.pathname.slice(prefix.length);
    g.log.push(`${method} ${rest || '/'}`);
    if (g.next === 'network') { g.next = null; throw new TypeError('fallo de red simulado'); }
    if (g.next) { const forced = g.next; g.next = null; return json(forced.status, forced.body); }
    if (g.access === 'none') return json(404, { error: { errors: [{ reason: 'notFound' }] } });
    if (rest === '') return json(200, { id: CALENDAR, timeZone: 'Europe/Madrid' });
    const id = rest.startsWith('/events/') ? decodeURIComponent(rest.slice('/events/'.length)) : null;
    if (method === 'GET' && rest === '/events') {
      return json(200, { items: [...g.events.values()].filter((e) => String(e.description).includes(url.searchParams.get('q') ?? '')) });
    }
    if (g.access === 'reader') return denied();
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (method === 'PUT' && id) {
      if (!g.events.has(id)) return json(404, { error: { errors: [{ reason: 'notFound' }] } });
      g.events.set(id, { ...body, id, htmlLink: `https://calendar.invalid/${id}` });
      return json(200, g.events.get(id));
    }
    if (method === 'POST' && rest === '/events') {
      if (g.events.has(body.id)) return json(409, { error: { errors: [{ reason: 'duplicate' }] } });
      g.events.set(body.id, { ...body, htmlLink: `https://calendar.invalid/${body.id}` });
      return json(200, g.events.get(body.id));
    }
    if (method === 'DELETE' && id) return g.events.delete(id) ? json(204) : json(404, {});
    return json(400, {});
  }) as typeof fetch;
  return g;
}

let serviceAccountJson: string;
let publicKey: CryptoKey;
test.before(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  publicKey = pair.publicKey;
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
  serviceAccountJson = JSON.stringify({ type: 'service_account', client_email: EMAIL, private_key: pem });
});

const RID = '11111111-2222-3333-4444-555555555555';
const reservation = { id: RID, code: 'RSV_2027_0001', title: 'Retiro Sintético', status: 'pre_reservada', start_date: '2027-03-05', end_date: '2027-03-07', expected_guests: 20 };
const payloadFor = async () => (await calendarProjection(reservation as any, null, 1)).payload!;
const adapterFor = (g: FakeGoogle, now?: () => number) => createGoogleCalendarAdapter({ serviceAccountJson, calendarId: CALENDAR, fetch: g.fetch, ...(now ? { now } : {}) })!;
async function rejects(promise: Promise<unknown>, code: string, kind: 'blocked' | 'recoverable' | 'fatal') {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CalendarError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.blocked ? 'blocked' : error.recoverable ? 'recoverable' : 'fatal', kind);
    return true;
  });
}

test('google: solo se activa con los dos secretos y una clave válida', () => {
  assert.equal(createGoogleCalendarAdapter({}), null);
  assert.equal(createGoogleCalendarAdapter({ serviceAccountJson }), null);
  assert.equal(createGoogleCalendarAdapter({ calendarId: CALENDAR }), null);
  assert.equal(createGoogleCalendarAdapter({ serviceAccountJson: 'esto no es json', calendarId: CALENDAR }), null);
  assert.equal(createGoogleCalendarAdapter({ serviceAccountJson: JSON.stringify({ client_email: EMAIL }), calendarId: CALENDAR }), null);
  assert.equal(createGoogleCalendarAdapter({ serviceAccountJson, calendarId: CALENDAR })!.calendarId, CALENDAR);
});

test('google: JWT RS256 firmado, token reutilizado y renovado al caducar', async () => {
  const g = fakeGoogle();
  let clock = Date.parse('2027-01-01T00:00:00Z');
  const adapter = adapterFor(g, () => clock);
  const id = calendarEventId(RID);
  await adapter.upsert(id, await payloadFor());
  await adapter.upsert(id, await payloadFor());
  assert.equal(g.tokens, 1, 'un solo token para varias llamadas');

  const [header, claims, signature] = g.lastAssertion.split('.') as [string, string, string];
  const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT' });
  const c = decode(claims);
  assert.deepEqual([c.iss, c.scope, c.aud, c.exp - c.iat], [EMAIL, 'https://www.googleapis.com/auth/calendar', 'https://oauth2.googleapis.com/token', 3600]);
  assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, Buffer.from(signature, 'base64url'), new TextEncoder().encode(`${header}.${claims}`)), true);

  clock += 3590_000; // a diez segundos de caducar: se pide otro
  await adapter.upsert(id, await payloadFor());
  assert.equal(g.tokens, 2);
});

test('google: crear, actualizar, adoptar por marcador y borrar', async () => {
  const g = fakeGoogle();
  const adapter = adapterFor(g);
  const id = calendarEventId(RID);
  const created = await adapter.upsert(id, await payloadFor());
  assert.deepEqual(g.log, [`PUT /events/${id}`, 'POST /events'], 'primero actualiza; si no existe, crea con el id elegido');
  assert.deepEqual([created.id, created.htmlLink], [id, `https://calendar.invalid/${id}`]);
  const stored = g.events.get(id);
  assert.deepEqual([stored.summary, stored.colorId, stored.status, stored.start.date, stored.end.date], ['[PRE] Retiro Sintético', '5', 'confirmed', '2027-03-05', '2027-03-08']);

  g.log.length = 0;
  await adapter.upsert(id, { ...(await payloadFor()), summary: 'Retiro Sintético', colorId: '10' });
  assert.deepEqual(g.log, [`PUT /events/${id}`]);
  assert.equal(g.events.get(id).summary, 'Retiro Sintético');
  assert.equal(g.events.size, 1);

  assert.equal((await adapter.findByMarker('RSV_2027_0001'))?.id, id);
  assert.equal(await adapter.findByMarker('RSV_2027_0999'), null);

  await adapter.remove(id);
  assert.equal(g.events.size, 0);
  await adapter.remove(id); // ya no existe: no es un error
});

test('google: calendario sin compartir o solo de lectura es un bloqueo, no un fallo del trabajo', async () => {
  const g = fakeGoogle();
  const adapter = adapterFor(g);
  const id = calendarEventId(RID);
  g.access = 'none';
  await rejects(adapter.upsert(id, await payloadFor()), 'CALENDAR_NOT_SHARED', 'blocked');
  await rejects(adapter.remove(id), 'CALENDAR_NOT_SHARED', 'blocked');
  await rejects(adapter.findByMarker('RSV_2027_0001'), 'CALENDAR_NOT_SHARED', 'blocked');
  g.access = 'reader';
  await rejects(adapter.upsert(id, await payloadFor()), 'CALENDAR_READ_ONLY', 'blocked');
  g.access = 'writer';
  assert.equal((await adapter.upsert(id, await payloadFor())).id, id, 'en cuanto se comparte, funciona sin tocar nada');
});

test('google: red, 5xx y límites de uso son recuperables; credenciales rechazadas bloquean; id ocupado pide otra generación', async () => {
  const g = fakeGoogle();
  const adapter = adapterFor(g);
  const id = calendarEventId(RID);
  const payload = await payloadFor();
  g.next = 'network';
  await rejects(adapter.upsert(id, payload), 'GOOGLE_UNREACHABLE', 'recoverable');
  g.next = { status: 503 };
  await rejects(adapter.upsert(id, payload), 'GOOGLE_BUSY', 'recoverable');
  g.next = { status: 403, body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } };
  await rejects(adapter.upsert(id, payload), 'GOOGLE_BUSY', 'recoverable');
  g.next = { status: 400 };
  await rejects(adapter.upsert(id, payload), 'GOOGLE_HTTP_400', 'fatal');
  g.next = { status: 401 };
  await rejects(adapter.upsert(id, payload), 'GOOGLE_AUTH_ERROR', 'blocked');
  assert.equal(g.tokens, 1);
  await adapter.upsert(id, payload);
  assert.equal(g.tokens, 2, 'tras un 401 se descarta el token y se pide otro');

  // evento borrado a mano que Google no deja reactivar: actualizar dice 410 y crear dice 409
  g.next = { status: 410 };
  await rejects(adapter.upsert(id, payload), 'EVENT_ID_TAKEN', 'fatal');

  const rejected = fakeGoogle();
  rejected.tokenStatus = 400;
  await rejects(adapterFor(rejected).upsert(id, payload), 'GOOGLE_AUTH_ERROR', 'blocked');
  assert.deepEqual(rejected.log, [], 'sin token no se llama a la API');
});

// --- Cola con la app completa -------------------------------------------------
const { reservations: RESERVATIONS } = TABLES;
const WORKER_KEY = 'clave-de-worker-de-prueba';
const fake = createFakeCalendarAdapter(CALENDAR);
const onCommit = createFakeCalendarAdapter(CALENDAR);
let app: TestApp;
let syncing: TestApp['handler']; // misma base de datos, con sincronización tras el commit
let seq = 0;

test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => {
      syncing = createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], calendar: { adapter: onCommit, syncOnCommit: true } });
      return createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], workerKey: WORKER_KEY, calendar: { adapter: fake } });
    },
  });
});
test.after(async () => { await app.close(); });

async function create(title: string): Promise<string> {
  const id = uuid();
  const res = await app.call('/api/v1/commands', { body: { requestId: `g-${++seq}-${uuid()}`, operations: [{ op: 'insert', table: RESERVATIONS, id, fields: { title, status: 'pre_reservada', start_date: '2027-03-05', end_date: '2027-03-07', expected_guests: 20 } }] } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return id;
}
const sql = async (text: string, params: unknown[] = []) => (await app.t.db.query(text, params)).rows as any[];
const job = async (id: string) => (await sql(`select * from booking.calendar_sync_jobs where reservation_id = $1 and status in ('pending','running') order by created_at desc limit 1`, [id]))[0];
const link = async (id: string) => (await sql('select * from booking.calendar_links where reservation_id = $1', [id]))[0];
function workerTick(key: string | null, handler = app.handler) {
  return handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/worker/calendar/tick`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Ikisai-Worker-Key': key } : {}) }, body: '{}',
  }));
}

test('cola: con el calendario sin compartir los trabajos siguen pendientes, con una sola llamada por vuelta, y la app lo ve', async () => {
  const a = await create('Bloqueada A');
  const b = await create('Bloqueada B');
  fake.reset();
  fake.failNext(blockedError('CALENDAR_NOT_SHARED'), 99);

  const first = await (await workerTick(WORKER_KEY)).json();
  assert.deepEqual([first.processed, first.failed, first.pending, first.health], [0, 0, 2, 'calendar_not_shared']);
  assert.equal(fake.calls.upsert, 1, 'un solo intento de escritura aunque haya dos trabajos: el segundo ni se intenta');
  for (const id of [a, b]) {
    const queued = await job(id);
    assert.deepEqual([queued.status, queued.attempts, queued.last_error], ['pending', 0, 'CALENDAR_NOT_SHARED'], 'no gasta intentos');
  }
  await workerTick(WORKER_KEY);
  await workerTick(WORKER_KEY);
  assert.equal((await job(a)).attempts, 0, 'tampoco tras varias vueltas');
  assert.equal(fake.calls.upsert, 3, 'uno por vuelta');

  const status = await app.call('/api/v1/calendar/status', { token: app.tokens.reader });
  assert.equal(status.data.health, 'calendar_not_shared');
  assert.deepEqual(status.data.items.filter((i: any) => [a, b].includes(i.reservationId)).map((i: any) => [i.syncStatus, i.pendingJob, i.lastError]),
    [['pending', true, 'CALENDAR_NOT_SHARED'], ['pending', true, 'CALENDAR_NOT_SHARED']]);

  // se comparte el calendario: la siguiente vuelta sincroniza y el estado vuelve a estar bien
  fake.reset();
  const healed = await (await workerTick(WORKER_KEY)).json();
  assert.deepEqual([healed.processed, healed.failed, healed.pending, healed.health], [2, 0, 0, 'ok']);
  assert.deepEqual([(await link(a)).sync_status, (await link(a)).last_error], ['synced', null]);
  const after = await app.call('/api/v1/calendar/status');
  assert.equal(after.data.health, 'ok');
});

test('cola: la ruta de sistema del tick exige la clave del worker y no depende de ningún usuario', async () => {
  const id = await create('Por planificador');
  assert.equal((await workerTick('otra-clave')).status, 401);
  assert.equal((await workerTick(null)).status, 401);
  assert.equal((await workerTick(WORKER_KEY, syncing)).status, 401, 'sin workerKey configurada la ruta no existe');
  const res = await workerTick(WORKER_KEY);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { processed: 1, failed: 0, pending: 0, health: 'ok' });
  assert.equal(fake.events.has(calendarEventId(id)), true);
});

test('cola: un id que Google ya no acepta se resuelve subiendo la generación', async () => {
  const id = await create('Borrada a mano');
  fake.failNext(fatalError('EVENT_ID_TAKEN'));
  const out = await (await workerTick(WORKER_KEY)).json();
  assert.deepEqual([out.processed, out.failed], [1, 0]);
  const saved = await link(id);
  assert.deepEqual([saved.sync_status, saved.generation, saved.provider_event_id], ['synced', 2, calendarEventId(id, 2)]);
  assert.equal(fake.events.has(calendarEventId(id, 2)), true);
});

test('cola: con syncOnCommit el guardado empuja su propia cola sin esperar al planificador', async () => {
  const id = uuid();
  const res = await syncing(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/commands`, {
    method: 'POST', headers: { Origin: BOOKING_ORIGINS[0]!, 'Content-Type': 'application/json', Authorization: `Bearer ${app.tokens.editor}` },
    body: JSON.stringify({ requestId: `s-${uuid()}`, operations: [{ op: 'insert', table: RESERVATIONS, id, fields: { title: 'Al guardar', status: 'pre_reservada', start_date: '2027-04-02', end_date: '2027-04-04', expected_guests: 12 } }] }),
  }));
  assert.equal(res.status, 200);
  assert.equal(onCommit.events.get(calendarEventId(id))?.summary, '[PRE] Al guardar');
  assert.equal((await link(id)).sync_status, 'synced');
  // y si Google falla, el guardado no se entera
  onCommit.failNext(blockedError('CALENDAR_NOT_SHARED'), 99);
  const other = uuid();
  const saved = await syncing(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/commands`, {
    method: 'POST', headers: { Origin: BOOKING_ORIGINS[0]!, 'Content-Type': 'application/json', Authorization: `Bearer ${app.tokens.editor}` },
    body: JSON.stringify({ requestId: `s-${uuid()}`, operations: [{ op: 'insert', table: RESERVATIONS, id: other, fields: { title: 'Google caído', status: 'pre_reservada', start_date: '2027-04-09', end_date: '2027-04-11', expected_guests: 8 } }] }),
  }));
  assert.equal(saved.status, 200);
  assert.deepEqual([(await job(other)).status, (await job(other)).last_error], ['pending', 'CALENDAR_NOT_SHARED']);
});
