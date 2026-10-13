/**
 * Booking · caracterización de espacios y camas con la fuente de hoy (`booking.spaces` y `beds`). La misma con Recursos
 * como fuente está en `r2-mirror.test.ts`; las aserciones, en `spaces-characterization.shared.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';
import { characterize } from './spaces-characterization.shared.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
});
test.after(async () => { await app.close(); });

async function ok(operations: unknown[]) {
  const res = await app.call('/api/v1/commands', { body: { requestId: `seed-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}

/**
 * Inventario de la prueba. **Lo único que cambia en R2** (hoy: lotes de Booking).
 * Albergue (edificio) › «Habitación Encina» (con baño, 3 plazas: individual, doble y una supletoria) y «Sala del Roble».
 */
async function seedInventory() {
  const room = uuid(); const hall = uuid(); const single = uuid(); const double = uuid(); const extra = uuid();
  await ok([
    { op: 'insert', table: TABLES.spaces, id: room, fields: { name: 'H-12 interna', public_name: 'Habitación Encina', kind: 'habitacion', zone: 'Albergue', en_suite: true, accessible: true } },
    { op: 'insert', table: TABLES.spaces, id: hall, fields: { name: 'Sala grande', public_name: 'Sala del Roble', kind: 'sala', zone: 'Albergue', capacity: 40 } },
    { op: 'insert', table: TABLES.beds, id: single, fields: { space_id: room, label: 'Cama 1', kind: 'individual', capacity: 1, position: 1 } },
    { op: 'insert', table: TABLES.beds, id: double, fields: { space_id: room, label: 'Cama 2', kind: 'doble', capacity: 2, position: 2 } },
    { op: 'insert', table: TABLES.beds, id: extra, fields: { space_id: room, label: 'Supletoria', kind: 'supletoria', capacity: 1, position: 3 } },
  ]);
  return { room, hall, single, double, extra };
}

test('caracterización · lo que ven portales e indicadores a partir de espacios y camas (fuente: Booking)', async () => {
  await characterize(app, seedInventory);
});
