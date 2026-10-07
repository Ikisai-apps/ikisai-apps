/** Proveedores de almacenamiento (contrato §3.9): firma SigV4 de R2 con el ejemplo oficial de AWS y selección del proveedor. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { presign } from '../../supabase/functions/_kit/storage.ts';

test('storage · URL prefirmada SigV4: ejemplo oficial de AWS (GET examplebucket/test.txt)', async () => {
  const url = await presign({
    method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', expires: 86400, now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
  assert.match(url, /X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request/);
});

import { createHash } from 'node:crypto';
import { createTestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

test('storage · con R2 por defecto: el ticket apunta a R2, core.files lo anota y la verificación descarga de R2', async () => {
  const objects = new Map<string, Uint8Array>();
  let fakeFetch: typeof fetch = fetch;
  const r2 = { accountId: 'cuenta', accessKeyId: 'AK', secretAccessKey: 'SK', bucket: 'ikisai-objects' };
  const app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: 'https://booking.ikisai.com', createHandler: (config) => {
    fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.host === 'cuenta.r2.cloudflarestorage.com') {
        assert.ok(url.searchParams.get('X-Amz-Signature'), 'URL firmada');
        const data = objects.get(decodeURIComponent(url.pathname));
        return data ? new Response(data, { headers: { 'content-length': String(data.byteLength) } }) : new Response('no', { status: 404 });
      }
      return config.fetch(input, init);
    }) as typeof fetch;
    return createApp({ ...config, fetch: fakeFetch, app: 'booking', slug: 'booking-api', origins: ['https://booking.ikisai.com'],
      uploads: { bucket: 'booking-documents', allowedMime: ['image/webp'] }, storage: { r2, defaultProvider: 'r2' } });
  } });
  try {
    const bytes = new TextEncoder().encode('imagen-r2');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const ticket = await app.call('/api/v1/uploads', { token: app.tokens.editor, body: { filename: 'a.webp', mime: 'image/webp', size: bytes.byteLength, sha256: sha } });
    assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
    const put = new URL(ticket.data.uploadUrl);
    assert.equal(put.host, 'cuenta.r2.cloudflarestorage.com'); assert.match(put.pathname, /^\/ikisai-objects\/booking-documents\/booking\//);
    const row = await app.t.db.query<{ storage_provider: string }>('select storage_provider from core.files where id = $1', [ticket.data.id]);
    assert.equal(row.rows[0]!.storage_provider, 'r2');
    objects.set(decodeURIComponent(put.pathname), bytes); // el cliente haría PUT a esa URL
    const verified = await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { token: app.tokens.editor, body: {} });
    assert.equal(verified.status, 200, JSON.stringify(verified.data)); assert.equal(verified.data.hashVerified, true);
    const read = await app.call(`/api/v1/files/${ticket.data.id}`, { token: app.tokens.editor });
    assert.equal(new URL(read.data.url).host, 'cuenta.r2.cloudflarestorage.com');
  } finally {
    await app.close();
  }
});

test('storage · medición para Central: tamaños, niveles e historial, solo para el owner de Central', async () => {
  const app = await createTestApp({ app: 'central', slug: 'central-api', origin: 'https://central.ikisai.com', createHandler: (config) =>
    createApp({ ...config, app: 'central', slug: 'central-api', origins: ['https://central.ikisai.com'], admin: true }) });
  try {
    await app.t.db.query('select core.storage_snapshot()');
    const res = await app.call('/api/v1/admin/storage', { token: app.tokens.owner });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.ok(Number(res.data.databaseBytes) > 0);
    assert.equal(res.data.levels.database, 'ok');
    assert.ok(res.data.history.length >= 1);
    assert.equal((await app.call('/api/v1/admin/storage', { token: app.tokens.editor })).status, 403);
  } finally {
    await app.close();
  }
});
