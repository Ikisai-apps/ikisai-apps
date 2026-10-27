/** Visitantes v2 (0106, C11 v2): varios móviles, correo optativo para guardar y recuperar el acceso, y vínculo con el huésped. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const GUESTS = 'https://guests.ikisai.com';
let app: TestApp;
const R1 = crypto.randomUUID();
const G1 = crypto.randomUUID();
const REQ = crypto.randomUUID();

const pub = (path: string, init: { body?: unknown; visitor?: string | null; method?: string; token?: string } = {}) =>
  app.call(path, { token: init.token ?? null, body: init.body, method: init.method, origin: GUESTS, headers: { ...(init.visitor ? { 'X-Visitor': init.visitor } : {}), 'X-Ikisai-Client-Ip': '10.0.0.1' } });

test.before(async () => {
  app = await createTestApp({ app: 'guests', slug: 'guests-api', origin: GUESTS, createHandler: (config) => createApp({ ...config, app: 'guests', slug: 'guests-api', origins: [GUESTS] }) });
  // Resolutor de reclamación de prueba en lugar del de Booking: la petición REQ es del visitante que la hizo y ya tiene ficha G1 en la reserva R1.
  await app.t.db.exec(`create table public.test_claims (request_id uuid primary key, visitor_id uuid, guest_id uuid, reservation_id uuid);
    create function public.test_visitor_claim(p jsonb) returns jsonb language sql stable as $$
      select jsonb_build_object('guest_id', c.guest_id, 'reservation_id', c.reservation_id) from public.test_claims c
       where c.request_id = (p->>'request_id')::uuid and c.visitor_id = core.current_visitor() $$;
    select core.allow_visitor_claim('booking', 'public.test_visitor_claim');
    create function public.test_portal_until(p_scope jsonb) returns timestamptz language sql stable as $$ select now() + interval '30 days' $$;
    select core.allow_portal_resolver('guests', 'public.test_portal_until');`);
});
test.after(async () => { await app.close(); });

let visitorId: string;
let token1: string;
let token2: string;

test('v2 · un visitante guarda su acceso con un código al correo y lo recupera en otro móvil; cada móvil tiene su token', async () => {
  const born = await pub('/api/v1/public/visitor', { body: { eventCode: 'EVT_X' } });
  assert.equal(born.status, 200, JSON.stringify(born.data)); visitorId = born.data.visitorId; token1 = born.data.token;
  const me0 = await pub('/api/v1/public/visitor/me', { visitor: token1 });
  assert.equal(me0.status, 200); assert.equal(me0.data.emailSaved, false); assert.equal(me0.data.devices, 1);
  // Pide el código (siempre «enviado») y lo verifica desde este móvil: queda guardado.
  const sent = await pub('/api/v1/public/visitor/email', { body: { email: 'Vero@Example.invalid' }, visitor: token1 });
  assert.equal(sent.status, 200); assert.equal(sent.data.sent, true);
  const bad = await pub('/api/v1/public/visitor/email/verify', { body: { email: 'vero@example.invalid', code: '000000' }, visitor: token1 });
  assert.equal(bad.status, 400); assert.equal(bad.data.error.code, 'CODE_INVALID');
  await pub('/api/v1/public/visitor/email', { body: { email: 'vero@example.invalid' }, visitor: token1 });
  const ok = await pub('/api/v1/public/visitor/email/verify', { body: { email: 'vero@example.invalid', code: '123456' }, visitor: token1 });
  assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data.saved, true); assert.equal(ok.data.visitorId, visitorId);
  // Otro móvil, sin visitante: recupera la misma identidad con un token nuevo.
  await pub('/api/v1/public/visitor/email', { body: { email: 'vero@example.invalid' } });
  const rec = await pub('/api/v1/public/visitor/email/verify', { body: { email: 'vero@example.invalid', code: '123456' } });
  assert.equal(rec.status, 200, JSON.stringify(rec.data)); assert.equal(rec.data.recovered, true); assert.equal(rec.data.visitorId, visitorId);
  token2 = rec.data.token; assert.notEqual(token2, token1);
  const me = await pub('/api/v1/public/visitor/me', { visitor: token2 });
  assert.equal(me.data.emailSaved, true); assert.equal(me.data.emailHint, 'v•••@e•••.invalid'); assert.equal(me.data.devices, 2);
  // «Mis eventos» se rehace desde el núcleo: el alta por QR cuenta, y Guests anota las visitas siguientes.
  assert.equal((await pub('/api/v1/public/visitor/visit', { body: { eventCode: 'EVT_Y' }, visitor: token2 })).status, 200);
  assert.deepEqual((await pub('/api/v1/public/visitor/me', { visitor: token2 })).data.eventCodes, ['EVT_Y', 'EVT_X']);
  assert.equal((await app.t.db.query<{ n: number }>(`select count(*)::int n from core.visitors where id = $1 and auth_user_id is not null`, [visitorId])).rows[0]!.n, 1);
  assert.equal((await app.t.db.query<{ n: number }>(`select count(*)::int n from core.visitor_email_requests`)).rows[0]!.n, 3, 'el núcleo guarda solo el hash del correo');
});

test('v2 · salir de un móvil revoca solo ese token; el freno corta la sexta petición de código por correo en una hora', async () => {
  const out = await pub('/api/v1/public/visitor/logout', { body: {}, visitor: token1 });
  assert.equal(out.status, 200);
  assert.equal((await pub('/api/v1/public/visitor/me', { visitor: token1 })).status, 401);
  assert.equal((await pub('/api/v1/public/visitor/me', { visitor: token2 })).status, 200);
  for (let i = 0; i < 2; i++) assert.equal((await pub('/api/v1/public/visitor/email', { body: { email: 'vero@example.invalid' } })).status, 200);
  const sixth = await pub('/api/v1/public/visitor/email', { body: { email: 'vero@example.invalid' } });
  assert.equal(sixth.status, 429); assert.equal(sixth.data.error.code, 'RATE_LIMITED');
});

test('v2 · freno por IP: la IP del proxy no da de alta más de 30 visitantes por hora', async () => {
  const ipCall = () => app.call('/api/v1/public/visitor', { token: null, body: {}, origin: GUESTS, headers: { 'X-Ikisai-Client-Ip': '10.0.0.77' } });
  let last = 0;
  for (let i = 0; i < 30; i++) last = (await ipCall()).status;
  assert.equal(last, 200);
  const over = await ipCall();
  assert.equal(over.status, 429); assert.equal(over.data.error.code, 'RATE_LIMITED');
});

test('v2 · traspaso entre dominios: un código de un solo uso da un token propio del mismo visitante en el otro dominio', async () => {
  const hand = await pub('/api/v1/public/visitor/handoff', { body: {}, visitor: token2 });
  assert.equal(hand.status, 200, JSON.stringify(hand.data)); assert.match(hand.data.code, /^[0-9a-f]{64}$/);
  const otherIp = await app.call('/api/v1/public/visitor/handoff/redeem', { token: null, body: { code: hand.data.code }, origin: GUESTS, headers: { 'X-Ikisai-Client-Ip': '10.0.0.9' } });
  assert.equal(otherIp.status, 401, 'desde otra IP no se canjea (fijación de identidad)');
  const got = await pub('/api/v1/public/visitor/handoff/redeem', { body: { code: hand.data.code } });
  assert.equal(got.status, 200, JSON.stringify(got.data)); assert.equal(got.data.visitorId, visitorId); assert.notEqual(got.data.token, token2);
  const twice = await pub('/api/v1/public/visitor/handoff/redeem', { body: { code: hand.data.code } });
  assert.equal(twice.status, 401); assert.equal(twice.data.error.code, 'CODE_INVALID');
  assert.equal((await pub('/api/v1/public/visitor/me', { visitor: got.data.token })).data.devices, 2);
});

test('v2 · el visitante reclama la ficha de su petición aceptada: enlace de un solo uso; el huésped une y separa su móvil', async () => {
  await app.t.db.query(`insert into public.test_claims (request_id, visitor_id, guest_id, reservation_id) values ($1, $2, $3, $4)`, [REQ, visitorId, G1, R1]);
  const other = await pub('/api/v1/public/visitor', { body: {} });
  const foreign = await pub('/api/v1/public/visitor/claim', { body: { requestId: REQ }, visitor: other.data.token });
  assert.equal(foreign.status, 404, 'la petición no es de ese visitante');
  const claim = await pub('/api/v1/public/visitor/claim', { body: { requestId: REQ }, visitor: token2 });
  assert.equal(claim.status, 200, JSON.stringify(claim.data)); assert.match(claim.data.loginToken, /^[A-Za-z0-9_-]{43}$/); assert.equal(claim.data.guestId, G1);
  const ids = (await app.t.db.query<{ ids: string[] }>('select core.visitor_guest_ids($1) ids', [visitorId])).rows[0]!.ids;
  assert.deepEqual(ids, [G1]);
  // El enlace abre la ficha del huésped una sola vez.
  const session = await pub('/api/v1/auth/link', { body: { token: claim.data.loginToken } });
  assert.equal(session.status, 200, JSON.stringify(session.data)); assert.equal(session.data.grant.guest_id, G1); assert.equal(session.data.grant.reservation_id, R1);
  const again = await pub('/api/v1/auth/link', { body: { token: claim.data.loginToken } });
  assert.equal(again.status, 401); assert.equal(again.data.error.code, 'LINK_INVALID');
  // Con la sesión del huésped: unir este móvil (idempotente), y separarlo.
  const linked = await pub('/api/v1/visitor-link', { body: { guestId: G1 }, visitor: token2, token: session.data.token });
  assert.equal(linked.status, 200, JSON.stringify(linked.data)); assert.equal(linked.data.linked, true); assert.equal(linked.data.visitorId, visitorId);
  const notMine = await pub('/api/v1/visitor-link', { body: { guestId: crypto.randomUUID() }, visitor: token2, token: session.data.token });
  assert.equal(notMine.status, 403);
  const gone = await pub('/api/v1/visitor-link/' + G1, { method: 'DELETE', token: session.data.token });
  assert.equal(gone.status, 200); assert.equal(gone.data.revoked, 1);
  assert.deepEqual((await app.t.db.query<{ ids: string[] }>('select core.visitor_guest_ids($1) ids', [visitorId])).rows[0]!.ids, []);
  const events = (await app.t.db.query<{ event: string }>('select event from core.visitor_events where visitor_id = $1 order by id', [visitorId])).rows.map((r) => r.event);
  for (const e of ['created', 'email_requested', 'email_saved', 'email_recovered', 'token_added', 'token_revoked', 'linked', 'claimed', 'claim_redeemed', 'unlinked']) assert.ok(events.includes(e), e);
});
