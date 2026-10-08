/** Cuenta de servicio de Google común (_kit/google.ts): firma RS256 verificable, token en memoria y errores tipados. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleTokenSource, GoogleAuthError, parseServiceAccount } from '../../supabase/functions/_kit/google.ts';

async function serviceAccount() {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`;
  return { json: JSON.stringify({ client_email: 'svc@proyecto.iam.gserviceaccount.com', private_key: pem }), publicKey: pair.publicKey };
}

test('google · sin cuenta válida la integración queda apagada', () => {
  assert.equal(parseServiceAccount('no es json'), null);
  assert.equal(createGoogleTokenSource({ serviceAccountJson: '', scope: 'x' }), null);
});

test('google · firma un JWT verificable con el ámbito pedido y reutiliza el token hasta que caduca', async () => {
  const { json, publicKey } = await serviceAccount();
  let calls = 0; let now = 1_000_000;
  const fake = (async (_url: string, init: RequestInit) => {
    calls++;
    const assertion = new URLSearchParams(String(init.body)).get('assertion')!;
    const [h, p, s] = assertion.split('.');
    const dec = (x: string) => Uint8Array.from(atob(x.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    assert.ok(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, dec(s!), new TextEncoder().encode(`${h}.${p}`)), 'firma válida');
    assert.equal(JSON.parse(new TextDecoder().decode(dec(p!))).scope, 'https://www.googleapis.com/auth/drive');
    return new Response(JSON.stringify({ access_token: 'tok-' + calls, expires_in: 3600 }), { status: 200 });
  }) as unknown as typeof fetch;
  const source = createGoogleTokenSource({ serviceAccountJson: json, scope: 'https://www.googleapis.com/auth/drive', fetch: fake, now: () => now })!;
  assert.equal(source.clientEmail, 'svc@proyecto.iam.gserviceaccount.com');
  assert.equal(await source.accessToken(), 'tok-1');
  assert.equal(await source.accessToken(), 'tok-1', 'en memoria');
  now += 3600_000;
  assert.equal(await source.accessToken(), 'tok-2', 'renovado al caducar');
});

test('google · 5xx es recuperable y 400 es un bloqueo', async () => {
  const { json } = await serviceAccount();
  const answer = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch;
  await assert.rejects(createGoogleTokenSource({ serviceAccountJson: json, scope: 's', fetch: answer(503) })!.accessToken(), (e: unknown) => e instanceof GoogleAuthError && e.kind === 'recoverable');
  await assert.rejects(createGoogleTokenSource({ serviceAccountJson: json, scope: 's', fetch: answer(400) })!.accessToken(), (e: unknown) => e instanceof GoogleAuthError && e.kind === 'blocked');
});
