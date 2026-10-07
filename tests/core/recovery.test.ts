/** «¿Has olvidado tu contraseña?» (contrato §3.4): apagado por defecto, no revela cuentas, enlace de un solo uso y cierre de sesiones. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const ORIGIN = 'https://booking.ikisai.com';
let on: TestApp;

test.before(async () => {
  on = await createTestApp({ app: 'booking', slug: 'booking-api', origin: ORIGIN, createHandler: (config) => createApp({ ...config, app: 'booking', slug: 'booking-api', origins: [ORIGIN], passwordRecovery: true }) });
});
test.after(async () => { await on.close(); });

test('recuperación · apagada sin correo propio: la app no ofrece el enlace y las rutas responden 503', async () => {
  const off = await createTestApp({ app: 'booking', slug: 'booking-api', origin: ORIGIN, createHandler: (config) => createApp({ ...config, app: 'booking', slug: 'booking-api', origins: [ORIGIN], passwordRecovery: false }) });
  try {
    assert.deepEqual((await off.call('/api/v1/auth/config', { token: null })).data, { passwordRecovery: false });
    const res = await off.call('/api/v1/auth/recover', { token: null, body: { email: 'editor@example.invalid' } });
    assert.equal(res.status, 503); assert.equal(res.data.error.code, 'RECOVERY_DISABLED');
  } finally { await off.close(); }
});

test('recuperación · misma respuesta exista o no la cuenta; el enlace vuelve a la app, vale una vez y cambia la contraseña', async () => {
  assert.deepEqual((await on.call('/api/v1/auth/config', { token: null })).data, { passwordRecovery: true });
  const unknown = await on.call('/api/v1/auth/recover', { token: null, body: { email: 'nadie@example.invalid' } });
  assert.equal(unknown.status, 200); assert.deepEqual(unknown.data, { sent: true });
  assert.equal(on.supabase.lastRecovery(), null, 'sin cuenta no se envía nada, pero la respuesta es la misma');
  const known = await on.call('/api/v1/auth/recover', { token: null, body: { email: 'EDITOR@example.invalid' } });
  assert.deepEqual(known.data, { sent: true });
  const mail = on.supabase.lastRecovery()!;
  assert.equal(mail.redirectTo, ORIGIN + '/');
  assert.equal((await on.call('/api/v1/auth/reset', { token: null, body: { tokenHash: mail.tokenHash, password: 'corta' } })).status, 422);
  const reset = await on.call('/api/v1/auth/reset', { token: null, body: { tokenHash: mail.tokenHash, password: 'una contraseña nueva larga' } });
  assert.equal(reset.status, 200, JSON.stringify(reset.data)); assert.ok(reset.data.token); assert.equal(reset.data.userId, undefined);
  assert.match(reset.headers.get('set-cookie') ?? '', /ikisai_sso=/);
  const again = await on.call('/api/v1/auth/reset', { token: null, body: { tokenHash: mail.tokenHash, password: 'otra contraseña larga más' } });
  assert.equal(again.status, 400); assert.equal(again.data.error.code, 'RECOVERY_INVALID', 'el enlace es de un solo uso');
});
