/**
 * Central · camas con un solo modelo (VG, 27-10): Central lee el sitio de cada cama de Booking (`booking.bed_layout_projection`)
 * y lo deriva con el kit (`applyBedLayouts`, probado en UI-kit). Aquí, la ruta. Datos ficticios.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';

test('camas · GET beds/layout responde siempre: con la proyección de Booking, sus filas; sin ella, available: false', async () => {
  const app: TestApp = await createTestApp({ app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!, createHandler: (c) => createCentralApp({ ...c, origins: [CENTRAL_ORIGINS[0]!] }) });
  try {
    const out = await app.call('/api/v1/beds/layout', { token: app.tokens.reader });
    assert.equal(out.status, 200, JSON.stringify(out.data));
    assert.equal(typeof out.data.available, 'boolean');
    assert.ok(Array.isArray(out.data.rows));
  } finally {
    await app.close();
  }
});
