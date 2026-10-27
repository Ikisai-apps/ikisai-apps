/**
 * Flow · `_worker.js` de Pages (proxy de mismo origen a flow-api): reenvía el token del cliente de la carta
 * (`X-Flow-Customer`) y el visitante del kit (`X-Visitor`), pone la IP del cliente desde `CF-Connecting-IP` y no reenvía
 * cabeceras inventadas por el navegador (ni una IP falsa). Sin las dos primeras, la carta en producción no reconoce al
 * móvil: «Mi pedido» y pedir daban CUSTOMER_UNKNOWN (27-10-2026).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const worker = (await import(pathToFileURL(path.resolve(here, '../../apps/flow/public/_worker.js')).href)).default as { fetch(r: Request, env: unknown): Promise<Response> };
const env = { ASSETS: { fetch: async () => new Response('x') } };

test('proxy · reenvía X-Flow-Customer y X-Visitor; la IP la pone el proxy, no el navegador', async () => {
  const realFetch = globalThis.fetch;
  let seen: Headers | null = null; let url = '';
  globalThis.fetch = (async (u: string, init: RequestInit) => { url = u; seen = new Headers(init.headers); return Response.json({ ok: true }); }) as typeof fetch;
  try {
    const res = await worker.fetch(new Request('https://flow.ikisai.com/api/v1/public/mine', {
      headers: { 'X-Flow-Customer': 'a'.repeat(64), 'X-Visitor': 'v'.repeat(43), 'X-Ikisai-Client-Ip': '10.0.0.1', 'X-Otra': 'x', 'CF-Connecting-IP': '198.51.100.20' },
    }), env);
    assert.equal(res.status, 200);
    assert.match(url, /\/functions\/v1\/flow-api\/api\/v1\/public\/mine$/);
    assert.equal(seen!.get('x-flow-customer'), 'a'.repeat(64));
    assert.equal(seen!.get('x-visitor'), 'v'.repeat(43));
    assert.equal(seen!.get('x-ikisai-client-ip'), '198.51.100.20');
    assert.equal(seen!.get('x-otra'), null);
    assert.equal(seen!.get('origin'), 'https://flow.ikisai.com');
  } finally { globalThis.fetch = realFetch; }
});

test('proxy · entradas (VG, 27-10): 301 desde /equipo a la raíz, /carta a ven y el enlace viejo de Guests a la carta', async () => {
  const go = async (u: string) => { const r = await worker.fetch(new Request(u), env); return [r.status, r.headers.get('location')]; };
  assert.deepEqual(await go('https://flow.ikisai.com/equipo'), [301, 'https://flow.ikisai.com/']);
  assert.deepEqual(await go('https://flow.ikisai.com/equipo/?desde=central'), [301, 'https://flow.ikisai.com/?desde=central']);
  assert.deepEqual(await go('https://flow.ikisai.com/carta'), [301, 'https://ven.ikisai.com/']);
  assert.deepEqual(await go('https://flow.ikisai.com/?invitacion=abc&v=def'), [301, 'https://flow.ikisai.com/recorridos/carta?invitacion=abc&v=def']);
  // La raíz (equipo) y la carta nueva se sirven sin redirigir.
  assert.deepEqual(await go('https://flow.ikisai.com/'), [200, null]);
  assert.deepEqual(await go('https://flow.ikisai.com/recorridos/carta?v=abc'), [200, null]);
});
