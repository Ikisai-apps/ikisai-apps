/** Sesión única entre apps (contrato §3.4) y catálogo del lanzador (§3.3). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, TEST_PASSWORD, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const ORIGIN = 'https://invoices.ikisai.com';
const BOOKING = 'https://booking.ikisai.com';
let app: TestApp;
let booking: (request: Request) => Promise<Response>;

const passOf = (headers: Headers) => headers.get('set-cookie')?.match(/ikisai_sso=([^;]*)/)?.[1] ?? null;

async function callBooking(path: string, init: { body?: unknown; headers?: Record<string, string>; token?: string } = {}) {
  const res = await booking(new Request(`${app.supabase.url}/functions/v1/booking-api${path}`, {
    method: init.body === undefined ? 'GET' : 'POST',
    headers: { Origin: BOOKING, 'Content-Type': 'application/json', ...(init.token ? { Authorization: 'Bearer ' + init.token } : {}), ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }));
  return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
}

test.before(async () => {
  app = await createTestApp({ app: 'invoices', slug: 'invoices-api', origin: ORIGIN, createHandler: (config) => createApp({ ...config, app: 'invoices', slug: 'invoices-api', origins: [ORIGIN] }) });
  booking = createApp({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch, app: 'booking', slug: 'booking-api', origins: [BOOKING] });
});
test.after(async () => { await app.close(); });

let pass: string;

test('sso · entrar con contraseña emite el pase en una cookie HttpOnly de .ikisai.com limitada a /api/v1/auth', async () => {
  const login = await app.call('/api/v1/auth/login', { token: null, body: { email: 'owner@example.invalid', password: TEST_PASSWORD } });
  assert.equal(login.status, 200); assert.ok(login.data.token);
  const cookie = login.headers.get('set-cookie') ?? '';
  assert.match(cookie, /ikisai_sso=[A-Za-z0-9_-]{43};/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\/api\/v1\/auth/); assert.match(cookie, /Domain=\.ikisai\.com/); assert.match(cookie, /Max-Age=2592000/);
  pass = passOf(login.headers)!;
  const stored = await app.t.db.query<{ digest: string }>('select digest from core.sso_passes');
  assert.equal(stored.rows.length, 1); assert.notEqual(stored.rows[0]!.digest, pass, 'solo se guarda el resumen');
});

test('sso · con el pase otra app obtiene su propia sesión, solo si la cuenta tiene acceso', async () => {
  const denied = await callBooking('/api/v1/auth/sso', { body: {}, headers: { 'X-Ikisai-Sso': pass } });
  assert.equal(denied.status, 403); assert.equal(denied.data.error.code, 'NO_MEMBERSHIP');
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, 'editor')`, [app.users.owner]);
  const ok = await callBooking('/api/v1/auth/sso', { body: {}, headers: { 'X-Ikisai-Sso': pass } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.ok(ok.data.token); assert.ok(ok.data.refreshToken);
  const boot = await callBooking('/api/v1/bootstrap', { token: ok.data.token });
  assert.equal(boot.status, 200); assert.equal(boot.data.app, 'booking'); assert.equal(boot.data.membership.role, 'editor');
  // También desde la cookie si se llama directamente a la Edge.
  const viaCookie = await app.call('/api/v1/auth/sso', { token: null, body: {}, headers: { Cookie: `otra=1; ikisai_sso=${pass}` } });
  assert.equal(viaCookie.status, 200);
});

test('sso · pase falso o ausente → 401 NO_SSO y la cookie se borra', async () => {
  const none = await app.call('/api/v1/auth/sso', { token: null, body: {} });
  assert.equal(none.status, 401); assert.equal(none.data.error.code, 'NO_SSO'); assert.match(none.headers.get('set-cookie') ?? '', /Max-Age=0/);
  const fake = await app.call('/api/v1/auth/sso', { token: null, body: {}, headers: { 'X-Ikisai-Sso': 'A'.repeat(43) } });
  assert.equal(fake.status, 401);
});

test('catálogo · GET apps lista las apps con acceso y su rol, en orden del lanzador', async () => {
  const apps = await app.call('/api/v1/apps');
  assert.equal(apps.status, 200); assert.equal(apps.data.current, 'invoices');
  assert.deepEqual(apps.data.items.map((a: any) => [a.id, a.role]), [['booking', 'editor'], ['invoices', 'owner']]);
  assert.equal(apps.data.items[1].aliasDomain, 'tramita.ikisai.com');
  assert.equal((await app.call('/api/v1/apps', { token: null })).status, 401);
});

test('sso · cerrar sesión revoca el pase del dispositivo; cambiar la contraseña revoca todos y emite uno nuevo', async () => {
  const login = await app.call('/api/v1/auth/login', { token: null, body: { email: 'owner@example.invalid', password: TEST_PASSWORD } });
  const second = passOf(login.headers)!;
  const out = await app.call('/api/v1/auth/logout', { token: login.data.token, body: {}, headers: { 'X-Ikisai-Sso': second } });
  assert.equal(out.status, 200); assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0/);
  assert.equal((await app.call('/api/v1/auth/sso', { token: null, body: {}, headers: { 'X-Ikisai-Sso': second } })).status, 401);
  assert.equal((await app.call('/api/v1/auth/sso', { token: null, body: {}, headers: { 'X-Ikisai-Sso': pass } })).status, 200, 'el pase de otro dispositivo sigue');
  const pw = await app.call('/api/v1/auth/password', { body: { currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD + 'x' }, headers: { 'X-Ikisai-Sso': pass } });
  assert.equal(pw.status, 200, JSON.stringify(pw.data));
  const fresh = passOf(pw.headers)!;
  assert.ok(fresh && fresh !== pass);
  assert.equal((await app.call('/api/v1/auth/sso', { token: null, body: {}, headers: { 'X-Ikisai-Sso': pass } })).status, 401, 'el pase antiguo queda revocado');
  assert.equal((await app.call('/api/v1/auth/sso', { token: null, body: {}, headers: { 'X-Ikisai-Sso': fresh } })).status, 200);
});
