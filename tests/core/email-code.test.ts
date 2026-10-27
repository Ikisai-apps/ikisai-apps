/** 0108 · Entrar con un código por correo en los portales (decisión de VG del 27-10-2026). El código solo llega a una cuenta
 *  de portal con un enlace vigente en esa app; la respuesta no distingue correos; no sirve para el personal ni tras revocar. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createOrganizersApp, ORGANIZERS_ORIGINS } from '../../supabase/functions/organizers-api/app.ts';
import { TABLES as BOOKING } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
let booking: TestApp;
let on: (r: Request) => Promise<Response>;
let off: (r: Request) => Promise<Response>;
let seq = 0;

type Res = { status: number; data: any };
const call = (handler: () => (r: Request) => Promise<Response>) => async (path: string, init: { token?: string; body?: unknown } = {}): Promise<Res> => {
  const res = await handler()(new Request(`${booking.supabase.url}/functions/v1/organizers-api${path}`, {
    method: init.body === undefined ? 'GET' : 'POST',
    headers: { Origin: ORGANIZERS_ORIGINS[0]!, 'Content-Type': 'application/json', ...(init.token ? { Authorization: 'Bearer ' + init.token } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }));
  return { status: res.status, data: await res.json().catch(() => null) };
};
const org = call(() => on);
const orgOff = call(() => off);
const code = (res: Res) => res.data?.error?.code;

async function staff(operations: unknown[]) {
  const res = await booking.call('/api/v1/commands', { body: { requestId: `ec-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
async function reservation(): Promise<string> {
  const id = uuid();
  await staff([{ op: 'insert', table: BOOKING.reservations, id, fields: { title: 'Retiro con código', status: 'pre_reservada', start_date: '2027-09-10', end_date: '2027-09-12', expected_guests: 12 } }]);
  await staff([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: id, event_id: uuid(), from_status: 'pre_reservada' } }]);
  return id;
}
async function link(reservation_id: string, email: string) {
  const res = await booking.call('/api/v1/portal-links', { token: booking.tokens.editor, body: { app: 'organizers', scope: { reservation_id }, person: { name: 'Organizadora', email } } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data as { linkId: string; url: string };
}
const send = (email: string) => org('/api/v1/auth/email-code', { body: { email } });

test.before(async () => {
  booking = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
  const base = { url: booking.supabase.url, anonKey: booking.supabase.anonKey, serviceKey: booking.supabase.serviceKey, fetch: booking.supabase.fetch, release: 'test', origins: [ORGANIZERS_ORIGINS[0]!] };
  on = createOrganizersApp({ ...base, emailCode: true });
  off = createOrganizersApp({ ...base, emailCode: false });
});
test.after(async () => { await booking.close(); });

test('código por correo · quien organiza entra con el código del correo de su enlace; no vale dos veces ni equivocado', async () => {
  const email = 'marta-org@example.invalid';
  await link(await reservation(), email);
  assert.equal((await org('/api/v1/auth/config')).data.emailCode, true);

  const sent = await send('  Marta-Org@Example.invalid ');
  assert.deepEqual([sent.status, sent.data], [200, { sent: true }]);
  const mail = booking.supabase.lastEmailCode();
  assert.equal(mail?.email, email);

  assert.equal(code(await org('/api/v1/auth/email-code/verify', { body: { email, code: '000000' === mail!.code ? '111111' : '000000' } })), 'EMAIL_CODE_INVALID');
  assert.equal(code(await org('/api/v1/auth/email-code/verify', { body: { email, code: 'abc' } })), 'EMAIL_CODE_INVALID');
  const session = await org('/api/v1/auth/email-code/verify', { body: { email, code: mail!.code } });
  assert.equal(session.status, 200, JSON.stringify(session.data));
  assert.ok(session.data.token && session.data.refreshToken);
  const me = await org('/api/v1/me', { token: session.data.token });
  assert.equal(me.status, 200, JSON.stringify(me.data));
  assert.equal(me.data.email, email);
  assert.equal(code(await org('/api/v1/auth/email-code/verify', { body: { email, code: mail!.code } })), 'EMAIL_CODE_INVALID', 'un solo uso');
});

test('código por correo · no llega al personal, a un correo desconocido ni tras revocar el enlace; la respuesta es la misma', async () => {
  const before = booking.supabase.lastEmailCode();
  for (const email of ['editor@example.invalid', 'owner@example.invalid', 'nadie@example.invalid']) {
    const res = await send(email);
    assert.deepEqual([res.status, res.data], [200, { sent: true }], email);
    assert.equal(booking.supabase.lastEmailCode(), before, `${email}: no se envía nada`);
    assert.equal(code(await org('/api/v1/auth/email-code/verify', { body: { email, code: '123456' } })), 'EMAIL_CODE_INVALID', email);
  }

  const email = 'revocada-org@example.invalid';
  const issued = await link(await reservation(), email);
  await send(email);
  const pending = booking.supabase.lastEmailCode();
  assert.equal(pending?.email, email);
  const revoked = await booking.call(`/api/v1/portal-links/${issued.linkId}/revoke`, { token: booking.tokens.editor, body: {} });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
  // El código ya enviado tampoco abre: la cuenta ya no podría entrar por su enlace.
  assert.equal(code(await org('/api/v1/auth/email-code/verify', { body: { email, code: pending!.code } })), 'EMAIL_CODE_INVALID');
  await send(email);
  assert.equal(booking.supabase.lastEmailCode(), pending, 'tras revocar, no se envía otro');
});

test('código por correo · apagado (sin correo propio en Auth): 503 y auth/config lo dice', async () => {
  assert.equal((await orgOff('/api/v1/auth/config')).data.emailCode, false);
  assert.equal(code(await orgOff('/api/v1/auth/email-code', { body: { email: 'x@example.invalid' } })), 'EMAIL_CODE_DISABLED');
  assert.equal(code(await orgOff('/api/v1/auth/email-code/verify', { body: { email: 'x@example.invalid', code: '123456' } })), 'EMAIL_CODE_DISABLED');
});

test('código por correo · fuerza bruta (0110): al séptimo intento en 15 minutos responde 429 aunque el código sea el bueno', async () => {
  const email = 'paciente-org@example.invalid';
  await link(await reservation(), email);
  await send(email);
  const mail = booking.supabase.lastEmailCode();
  assert.equal(mail?.email, email);
  for (let i = 0; i < 6; i++) assert.equal(code(await org('/api/v1/auth/email-code/verify', { body: { email, code: '000000' } })), 'EMAIL_CODE_INVALID', `intento ${i + 1}`);
  assert.equal(code(await org('/api/v1/auth/email-code/verify', { body: { email, code: mail!.code } })), 'RATE_LIMITED', 'el séptimo no se mira');
  // Otro correo no está afectado.
  const other = 'otra-org@example.invalid';
  await link(await reservation(), other);
  await send(other);
  const ok = await org('/api/v1/auth/email-code/verify', { body: { email: other, code: booking.supabase.lastEmailCode()!.code } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
});

test('código por correo · envíos (0110): un envío por minuto; el segundo responde igual pero no envía; un envío nuevo reinicia los intentos', async () => {
  const email = 'insistente-org@example.invalid';
  await link(await reservation(), email);
  assert.deepEqual((await send(email)).data, { sent: true });
  const last = booking.supabase.lastEmailCode();
  assert.equal(last?.email, email);
  const second = await send(email);
  assert.deepEqual([second.status, second.data], [200, { sent: true }]);
  assert.equal(booking.supabase.lastEmailCode(), last, 'dentro del minuto no envía otro');
  // El contador de verificación se reinicia con un envío (aquí, a nivel de núcleo, porque la cadencia de un minuto no se espera en la prueba).
  const db = booking.t.db;
  let ok = true;
  for (let i = 0; i < 7; i++) ok = (await db.query<{ r: boolean }>(`select core.rate_hit('email-code:verify:${email}', 6, interval '15 minutes') r`)).rows[0]!.r;
  assert.equal(ok, false, 'el séptimo no cabe');
  await db.query(`select core.rate_reset('email-code:verify:${email}')`);
  assert.equal((await db.query<{ r: boolean }>(`select core.rate_hit('email-code:verify:${email}', 6, interval '15 minutes') r`)).rows[0]!.r, true, 'tras reiniciar, cabe');
});
