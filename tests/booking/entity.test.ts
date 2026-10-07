/** Booking · datos de la entidad (Central) para la cabecera de la propuesta: `GET /api/v1/entity`. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';

let app: TestApp;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
});
test.after(async () => { await app.close(); });

test('entidad · vacía: aviso en vez de fallo; con datos y logotipo: URL firmada y sin bucket ni ruta', async () => {
  const empty = await app.call('/api/v1/entity', { token: app.tokens.reader });
  assert.equal(empty.status, 200, JSON.stringify(empty.data));
  assert.deepEqual(empty.data, { entity: null, logoUrl: null });

  const sha = 'a'.repeat(64);
  const file = (await app.t.db.query<{ id: string }>(
    `insert into core.files (app, bucket, path, filename, mime, size, sha256, status) values ('central', 'central-documents', 'central/entidad/logo.png', 'logo.png', 'image/png', 10, $1, 'verified') returning id`, [sha])).rows[0]!.id;
  await app.t.db.query(`insert into central.entity (legal_name, trade_name, tax_id, address_line, postal_code, city, province, logo_file_id)
    values ('Entidad Sintética S.L.', 'Sintética', 'B00000000', 'Calle Falsa 1', '00000', 'Villaprueba', 'Provincia', $1)`, [file]);

  const res = await app.call('/api/v1/entity', { token: app.tokens.editor });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.entity.legal_name, 'Entidad Sintética S.L.');
  assert.equal(res.data.entity.tax_id, 'B00000000');
  assert.equal(res.data.entity.logo_mime, 'image/png');
  assert.ok(!('logo_path' in res.data.entity) && !('logo_bucket' in res.data.entity));
  assert.match(res.data.logoUrl, /\/storage\/v1\/object\/sign\/central-documents\/central\/entidad\/logo\.png\?token=/);
});
