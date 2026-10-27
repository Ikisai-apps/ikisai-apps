/**
 * `_worker.js` de Pages de las ocho apps (proxy de mismo origen a su Edge): la IP del cliente va en `X-Ikisai-Client-Ip`
 * desde `CF-Connecting-IP`, para que los frenos por IP del núcleo (visitantes, códigos por correo, traspaso) vean al móvil y
 * no la salida de Cloudflare; el visitante del kit (`X-Visitor`) se reenvía; y nada inventado por el navegador pasa (ni una
 * IP falsa ni otras cabeceras). Generaliza tests/flow/proxy.test.ts (27-10-2026).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APPS = ['tasks', 'invoices', 'booking', 'food', 'central', 'organizers', 'guests', 'flow'];
const env = { ASSETS: { fetch: async () => new Response('x') } };

for (const app of APPS) {
  test(`proxy de ${app} · X-Ikisai-Client-Ip desde CF-Connecting-IP, X-Visitor sí, lo inventado no`, async () => {
    const worker = (await import(pathToFileURL(path.resolve(here, `../../apps/${app}/public/_worker.js`)).href)).default as { fetch(r: Request, env: unknown): Promise<Response> };
    const realFetch = globalThis.fetch;
    let seen: Headers | null = null; let url = '';
    globalThis.fetch = (async (u: string, init: RequestInit) => { url = u; seen = new Headers(init.headers); return Response.json({ ok: true }); }) as typeof fetch;
    try {
      const res = await worker.fetch(new Request(`https://${app}.ikisai.com/api/v1/public/contact?lang=es`, {
        headers: { 'X-Visitor': 'v'.repeat(43), 'X-Ikisai-Client-Ip': '10.0.0.1', 'X-Otra': 'x', 'CF-Connecting-IP': '198.51.100.20', Authorization: 'Bearer t' },
      }), env);
      assert.equal(res.status, 200);
      assert.ok(url.endsWith(`/functions/v1/${app}-api/api/v1/public/contact?lang=es`), url);
      assert.equal(seen!.get('x-ikisai-client-ip'), '198.51.100.20', 'la IP la pone el proxy');
      assert.equal(seen!.get('x-visitor'), 'v'.repeat(43));
      assert.equal(seen!.get('authorization'), 'Bearer t');
      assert.equal(seen!.get('x-otra'), null);
      assert.equal(seen!.get('cf-connecting-ip'), null);
      assert.equal(seen!.get('origin'), `https://${app}.ikisai.com`);

      // Sin CF-Connecting-IP (no pasa por Cloudflare) no hay IP: nunca la del navegador.
      await worker.fetch(new Request(`https://${app}.ikisai.com/api/v1/me`, { headers: { 'X-Ikisai-Client-Ip': '10.0.0.1' } }), env);
      assert.equal(seen!.get('x-ikisai-client-ip'), null);
    } finally { globalThis.fetch = realFetch; }
  });
}
