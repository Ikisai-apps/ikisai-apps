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

test('storage · recogida de huérfanos: solo en apps activadas, 30 días de espera, nunca lo legal y se vuelve a comprobar', async () => {
  const app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: 'https://booking.ikisai.com', createHandler: (config) =>
    createApp({ ...config, app: 'booking', slug: 'booking-api', origins: ['https://booking.ikisai.com'] }) });
  try {
    const db = app.t.db;
    // Independiente de qué apps hayan activado ya la recogida en sus migraciones: se parte de ninguna activada.
    await db.exec(`delete from core.file_gc_apps; create table booking.test_docs (id uuid primary key, file_id uuid);`);
    const mk = async (app_: string) => (await db.query<{ id: string }>(`insert into core.files (app, bucket, path, filename, mime, size, sha256, status, created_at)
      values ($1, 'booking-documents', gen_random_uuid()::text, 'a.webp', 'image/webp', 10, repeat('a', 64), 'verified', now() - interval '5 days') returning id`, [app_])).rows[0]!.id;
    const orphan = await mk('booking'); const kept = await mk('booking'); const legal = await mk('booking'); const other = await mk('tasks');
    await db.query(`insert into booking.test_docs values (gen_random_uuid(), $1), (gen_random_uuid(), $2)`, [kept, legal]);
    await db.query(`select core.register_file_field('booking', 'booking', 'test_docs', 'file_id', 'legal')`);
    // Sin activar, no toca nada.
    assert.deepEqual((await db.query<{ r: any }>(`select core.file_gc_mark(100) r`)).rows[0]!.r, { marked: 0, cleared: 0 });
    await db.query(`select core.enable_file_gc('booking')`);
    await db.query(`select core.file_gc_mark(100)`);
    const state = async (id: string) => (await db.query<{ orphaned_at: string | null; retention_class: string | null }>(`select orphaned_at, retention_class from core.files where id = $1`, [id])).rows[0]!;
    assert.ok((await state(orphan)).orphaned_at, 'el huérfano queda marcado');
    assert.equal((await state(kept)).retention_class, 'legal');
    assert.equal((await state(other)).orphaned_at, null, 'apps sin activar, intactas');
    assert.equal((await db.query<{ r: any[] }>(`select core.file_gc_claim(100) r`)).rows[0]!.r.length, 0, 'antes de 30 días no se borra');
    // Pasan 30 días; el «legal» deja de estar referenciado pero sigue protegido.
    await db.query(`delete from booking.test_docs where file_id = $1`, [legal]);
    await db.query(`select core.file_gc_mark(100)`);
    await db.query(`update core.files set orphaned_at = now() - interval '31 days' where orphaned_at is not null`);
    const claim = (await db.query<{ r: any[] }>(`select core.file_gc_claim(100) r`)).rows[0]!.r;
    assert.deepEqual(claim.map((c) => c.id), [orphan], 'solo el huérfano operativo; el legal nunca');
    await db.query(`select core.file_gc_done($1)`, [orphan]);
    assert.equal((await db.query(`select 1 from core.files where id = $1`, [orphan])).rows.length, 0);
  } finally {
    await app.close();
  }
});
