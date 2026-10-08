/**
 * Tasks · `_worker.js` de Pages: los recursos de la cáscara con nombre fijo salen con `Cache-Control: no-cache` (se
 * revalidan siempre), y las fuentes e imágenes conservan la caché que traigan. Sin eso, la primera carga sin service worker
 * tomaba durante horas la cáscara vieja de la caché HTTP del navegador (8-10-2026).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const worker = (await import(pathToFileURL(path.resolve(here, '../../apps/tasks/public/_worker.js')).href)).default as { fetch(r: Request, env: unknown): Promise<Response> };
const env = { ASSETS: { fetch: async () => new Response('x', { status: 200, headers: { 'Cache-Control': 'public, max-age=14400, must-revalidate', ETag: 'W/"1"' } }) } };
const get = async (p: string) => worker.fetch(new Request(`https://tasks.ikisai.com${p}`), env);

test('worker: no-cache para la cáscara sin huella; las fuentes e imágenes, con su caché', async () => {
  for (const p of ['/', '/index.html', '/shell-ui.js', '/feedback-ui.js', '/kit.css', '/manifest.webmanifest', '/sw.js', '/version.json']) {
    const res = await get(p);
    assert.equal(res.headers.get('cache-control'), 'no-cache', p);
    assert.equal(res.headers.get('etag'), 'W/"1"', `${p}: conserva el ETag para revalidar con 304`);
  }
  for (const p of ['/icons/tasks-192.png', '/fonts/inter.woff2']) assert.equal((await get(p)).headers.get('cache-control'), 'public, max-age=14400, must-revalidate', p);
});

test('worker: las rutas de worker no pasan por el proxy (400 claro, sin llamar a la Edge)', async () => {
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
  try {
    for (const p of ['/api/v1/worker/requests/task', '/api/v1/worker']) {
      const res = await worker.fetch(new Request(`https://tasks.ikisai.com${p}`, { method: 'POST', headers: { 'X-Ikisai-Worker-Key': 'k', 'Content-Type': 'application/json' }, body: '{}' }), env);
      assert.equal(res.status, 400, p);
      assert.equal((await res.json() as any).error.code, 'WORKER_ROUTE_NOT_PROXIED');
    }
    assert.equal(called, false, 'no se reenvía nada a la Edge');
    // El resto de la API sigue pasando.
    await worker.fetch(new Request('https://tasks.ikisai.com/api/v1/bootstrap'), env);
    assert.equal(called, true);
  } finally { globalThis.fetch = realFetch; }
});

