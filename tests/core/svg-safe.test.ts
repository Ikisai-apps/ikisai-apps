/** Subidas · SVG sin contenido activo (MUELA-092): la verificación rechaza el SVG con scripts, incrustados, manejadores o enlaces. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { svgUnsafeReason } from '../../supabase/functions/_kit/uploads.ts';
import { createTestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const CLEAN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><!-- <script> en un comentario --><rect id="Comedor" x="1" y="1" width="40" height="20" fill="none" stroke="#000"/><text x="2" y="12">Salón · online</text></svg>';

test('svg · un dibujo limpio pasa; lo activo, no', () => {
  assert.equal(svgUnsafeReason(CLEAN), null);
  assert.equal(svgUnsafeReason('<svg><script>alert(1)</script></svg>'), 'script');
  assert.equal(svgUnsafeReason('<svg><svg:script xlink:href="x"/></svg>'), 'script');
  assert.equal(svgUnsafeReason('<svg><foreignObject><div/></foreignObject></svg>'), 'foreignObject');
  assert.equal(svgUnsafeReason('<svg><iframe src="x"/></svg>'), 'embed');
  assert.equal(svgUnsafeReason('<svg onload="alert(1)"></svg>'), 'handler');
  assert.equal(svgUnsafeReason('<svg><rect\nONCLICK = "x"/></svg>'), 'handler');
  assert.equal(svgUnsafeReason('<svg><a href="java&#x09;script:alert(1)"><rect/></a></svg>'), 'link');
  assert.equal(svgUnsafeReason('<svg><a xlink:href="data:text/html;base64,AA"/></svg>'), 'link');
  assert.equal(svgUnsafeReason('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>'), 'entity');
});

test('svg · la verificación marca el SVG activo como no disponible y acepta el limpio', async () => {
  const objects = new Map<string, Uint8Array>();
  const r2 = { accountId: 'cuenta', accessKeyId: 'AK', secretAccessKey: 'SK', bucket: 'ikisai-objects' };
  const app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: 'https://booking.ikisai.com', createHandler: (config) => {
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.host === 'cuenta.r2.cloudflarestorage.com') {
        const data = objects.get(decodeURIComponent(url.pathname));
        return data ? new Response(data, { headers: { 'content-length': String(data.byteLength) } }) : new Response('no', { status: 404 });
      }
      return config.fetch(input, init);
    }) as typeof fetch;
    return createApp({ ...config, fetch: fakeFetch, app: 'booking', slug: 'booking-api', origins: ['https://booking.ikisai.com'],
      uploads: { bucket: 'booking-documents', allowedMime: ['image/svg+xml'] }, storage: { r2, defaultProvider: 'r2' } });
  } });
  const send = async (text: string) => {
    const bytes = new TextEncoder().encode(text);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const ticket = await app.call('/api/v1/uploads', { token: app.tokens.editor, body: { filename: 'plano.svg', mime: 'image/svg+xml', size: bytes.byteLength, sha256: sha } });
    assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
    objects.set(decodeURIComponent(new URL(ticket.data.uploadUrl).pathname), bytes);
    return { id: ticket.data.id as string, res: await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { token: app.tokens.editor, body: {} }) };
  };
  try {
    const bad = await send('<svg xmlns="http://www.w3.org/2000/svg" onload="fetch(\'//x\')"><rect/></svg>');
    assert.equal(bad.res.status, 422, JSON.stringify(bad.res.data));
    assert.equal(bad.res.data.error?.code ?? bad.res.data.code, 'UNSUPPORTED_MEDIA');
    const row = await app.t.db.query<{ status: string }>('select status from core.files where id = $1', [bad.id]);
    assert.equal(row.rows[0]!.status, 'missing');
    assert.equal((await app.call(`/api/v1/files/${bad.id}`, { token: app.tokens.editor })).status, 404, 'no se firma su lectura');
    const good = await send(CLEAN);
    assert.equal(good.res.status, 200, JSON.stringify(good.res.data));
  } finally {
    await app.close();
  }
});
