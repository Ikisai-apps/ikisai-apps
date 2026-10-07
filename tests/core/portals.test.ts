/** Enlaces personales de los portales (contrato §3.6): emisión desde Booking y Organizers, canje, caducidad dinámica. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const BOOKING = 'https://booking.ikisai.com';
let app: TestApp;
let organizers: (r: Request) => Promise<Response>;
let guests: (r: Request) => Promise<Response>;
const R1 = crypto.randomUUID();
const R2 = crypto.randomUUID();
const G1 = crypto.randomUUID();

async function callPortal(handler: (r: Request) => Promise<Response>, portal: string, path: string, init: { body?: unknown; token?: string; method?: string } = {}) {
  const origin = `https://${portal}.ikisai.com`;
  const res = await handler(new Request(`${app.supabase.url}/functions/v1/${portal}-api${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { Origin: origin, 'Content-Type': 'application/json', ...(init.token ? { Authorization: 'Bearer ' + init.token } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }));
  return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
}
const tokenOf = (url: string) => url.split('/i/')[1]!;
const setUntil = (reservation: string, days: number) => app.t.db.query(`insert into public.test_until (reservation_id, until) values ($1, now() + make_interval(days => $2))
  on conflict (reservation_id) do update set until = excluded.until`, [reservation, days]);

test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING, createHandler: (config) => createApp({ ...config, app: 'booking', slug: 'booking-api', origins: [BOOKING], portalIssuer: true }) });
  const base = { url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch };
  organizers = createApp({ ...base, app: 'organizers', slug: 'organizers-api', origins: ['https://organizers.ikisai.com'], portalIssuer: true });
  guests = createApp({ ...base, app: 'guests', slug: 'guests-api', origins: ['https://guests.ikisai.com'] });
  // Resolvedor de prueba en lugar del de Booking: la validez sale de una tabla que la prueba mueve.
  await app.t.db.exec(`create table public.test_until (reservation_id uuid primary key, until timestamptz);
    create function public.test_portal_until(p_scope jsonb) returns timestamptz language sql stable as $$ select until from public.test_until where reservation_id = (p_scope->>'reservation_id')::uuid $$;
    select core.allow_portal_resolver('organizers', 'public.test_portal_until'); select core.allow_portal_resolver('guests', 'public.test_portal_until');`);
  await setUntil(R1, 30); await setUntil(R2, 30);
});
test.after(async () => { await app.close(); });

let orgToken: string;
let orgSession: string;
let orgLinkId: string;

test('portales · el personal de Booking emite el enlace del organizador (lector no); mismo correo = misma cuenta', async () => {
  assert.equal((await app.call('/api/v1/portal-links', { token: app.tokens.reader, body: { app: 'organizers', scope: { reservation_id: R1 }, person: { name: 'Paco' } } })).status, 403);
  const first = await app.call('/api/v1/portal-links', { token: app.tokens.editor, body: { app: 'organizers', scope: { reservation_id: R1 }, person: { name: 'Paco', email: 'paco@example.invalid' } } });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.match(first.data.url, /^https:\/\/organizers\.ikisai\.com\/i\/[A-Za-z0-9_-]{43}$/); assert.equal(first.data.shownOnce, true); assert.ok(first.data.validUntil);
  orgToken = tokenOf(first.data.url); orgLinkId = first.data.linkId;
  const second = await app.call('/api/v1/portal-links', { body: { app: 'organizers', scope: { reservation_id: R2 }, person: { name: 'Paco', email: 'PACO@example.invalid' } } });
  assert.equal(second.data.userId, first.data.userId, 'recurrencia: misma cuenta');
  const stored = await app.t.db.query<{ n: number }>('select count(*)::int n from core.portal_links where digest = $1', [orgToken]);
  assert.equal(stored.rows[0]!.n, 0, 'solo se guarda el resumen del token');
});

test('portales · el organizador canjea su enlace: sesión propia, pase común y acceso a sus dos reservas', async () => {
  const bad = await callPortal(organizers, 'organizers', '/api/v1/auth/link', { body: { token: 'A'.repeat(43) } });
  assert.equal(bad.status, 401); assert.equal(bad.data.error.code, 'LINK_INVALID');
  const ok = await callPortal(organizers, 'organizers', '/api/v1/auth/link', { body: { token: orgToken } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.ok(ok.data.token);
  assert.match(ok.headers.get('set-cookie') ?? '', /ikisai_sso=/);
  orgSession = ok.data.token;
  const boot = await callPortal(organizers, 'organizers', '/api/v1/bootstrap', { token: orgSession });
  assert.equal(boot.status, 200); assert.deepEqual(boot.data.membership.scopes.grants.map((g: any) => g.reservation_id).sort(), [R1, R2].sort());
  // El enlace de organizers no sirve en guests.
  assert.equal((await callPortal(guests, 'guests', '/api/v1/auth/link', { body: { token: orgToken } })).data.error.code, 'LINK_INVALID');
});

test('portales · la caducidad sigue a la fecha de la reserva; el personal amplía a mano y revoca', async () => {
  await setUntil(R1, -1);
  const expired = await callPortal(organizers, 'organizers', '/api/v1/auth/link', { body: { token: orgToken } });
  assert.equal(expired.status, 401); assert.equal(expired.data.error.code, 'LINK_EXPIRED');
  await setUntil(R1, 60);
  assert.equal((await callPortal(organizers, 'organizers', '/api/v1/auth/link', { body: { token: orgToken } })).status, 200, 'la fecha se movió: vale otra vez');
  await setUntil(R1, -1);
  const ext = await app.call(`/api/v1/portal-links/${orgLinkId}/extend`, { body: { until: new Date(Date.now() + 5 * 86400e3).toISOString() } });
  assert.equal(ext.status, 200, JSON.stringify(ext.data));
  assert.equal((await callPortal(organizers, 'organizers', '/api/v1/auth/link', { body: { token: orgToken } })).status, 200, 'ampliado a mano');
  const list = await app.call(`/api/v1/portal-links?reservation=${R1}`);
  assert.equal(list.data.items.length, 1); assert.equal(list.data.items[0].linkId, orgLinkId);
  await setUntil(R1, 30);
});

test('portales · el organizador emite enlaces de huésped solo de sus reservas; el huésped entra en Guests', async () => {
  const notMine = await callPortal(organizers, 'organizers', '/api/v1/portal-links', { token: orgSession, body: { app: 'guests', scope: { reservation_id: crypto.randomUUID(), guest_id: G1 }, person: { name: 'Ana' } } });
  assert.equal(notMine.status, 403);
  const orgLink = await callPortal(organizers, 'organizers', '/api/v1/portal-links', { token: orgSession, body: { app: 'organizers', scope: { reservation_id: R1 }, person: { name: 'Otro' } } });
  assert.equal(orgLink.status, 403);
  const guestLink = await callPortal(organizers, 'organizers', '/api/v1/portal-links', { token: orgSession, body: { app: 'guests', scope: { reservation_id: R1, guest_id: G1 }, person: { name: 'Ana López' } } });
  assert.equal(guestLink.status, 200, JSON.stringify(guestLink.data)); assert.match(guestLink.data.url, /^https:\/\/guests\.ikisai\.com\/i\//);
  const entered = await callPortal(guests, 'guests', '/api/v1/auth/link', { body: { token: tokenOf(guestLink.data.url) } });
  assert.equal(entered.status, 200, JSON.stringify(entered.data));
  const boot = await callPortal(guests, 'guests', '/api/v1/bootstrap', { token: entered.data.token });
  assert.deepEqual(boot.data.membership.scopes.grants, [{ reservation_id: R1, guest_id: G1 }]);
  const listed = await callPortal(organizers, 'organizers', `/api/v1/portal-links?reservation=${R1}`, { token: orgSession });
  assert.equal(listed.status, 200); assert.ok(listed.data.items.every((l: any) => l.app === 'guests'), 'el organizador solo ve los enlaces de huésped');
  const revoked = await callPortal(organizers, 'organizers', `/api/v1/portal-links/${guestLink.data.linkId}/revoke`, { token: orgSession, body: {} });
  assert.equal(revoked.status, 200);
  assert.equal((await callPortal(guests, 'guests', '/api/v1/auth/link', { body: { token: tokenOf(guestLink.data.url) } })).data.error.code, 'LINK_INVALID');
  const extend = await callPortal(organizers, 'organizers', `/api/v1/portal-links/${guestLink.data.linkId}/extend`, { token: orgSession, body: { until: new Date(Date.now() + 86400e3).toISOString() } });
  assert.equal(extend.status, 403, 'solo el personal amplía');
});

test('portales · un miembro del portal solo se ve a sí mismo en members', async () => {
  const otro = await app.call('/api/v1/portal-links', { body: { app: 'organizers', scope: { reservation_id: crypto.randomUUID() }, person: { name: 'Otra organizadora', email: 'otra@example.invalid' } } });
  assert.equal(otro.status, 200);
  const members = await callPortal(organizers, 'organizers', '/api/v1/members', { token: orgSession });
  assert.equal(members.status, 200); assert.equal(members.data.length, 1); assert.equal(members.data[0].displayName, 'Paco');
});
