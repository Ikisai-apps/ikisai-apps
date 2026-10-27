/**
 * Central · camas con un solo modelo (VG, 27-10): la forma de cada cama se deriva de la de su habitación y de su sitio en
 * Booking (`booking.bed_layout_projection`); Central no la guarda. Datos ficticios.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import { bedShape, deriveBeds, type BedLayout } from '../../supabase/functions/_domain/central/mod.ts';

const room = { points: [[0.1, 0.2], [0.3, 0.2], [0.3, 0.5], [0.1, 0.5]] };

test('camas · bedShape: dos cuadrantes desde la celda, a lo ancho o a lo largo, dentro de la caja de la habitación', () => {
  assert.deepEqual(bedShape(room, { cols: 4, rows: 4 }, { x: 0, y: 0, rot: 0 }).points, [[0.1, 0.2], [0.2, 0.2], [0.2, 0.275], [0.1, 0.275]]);
  assert.deepEqual(bedShape(room, { cols: 4, rows: 4 }, { x: 3, y: 2, rot: 90 }).points, [[0.25, 0.35], [0.3, 0.35], [0.3, 0.5], [0.25, 0.5]]);
  // Una celda que se saldría se queda dentro (Booking ya lo impide; aquí, por si acaso).
  assert.deepEqual(bedShape(room, { cols: 4, rows: 4 }, { x: 3, y: 0, rot: 0 }).points[1], [0.3, 0.2]);
});

test('camas · deriveBeds: la cama toma el dibujo y la forma de su habitación; sin disposición o sin habitación colocada, no sale', () => {
  const rows = [
    { id: 'room', kind: 'habitacion', parentId: 'b', planId: 'plan', planShape: room },
    { id: 'bed1', kind: 'cama', parentId: 'room', planId: 'viejo', planShape: { points: [[0, 0], [1, 0], [1, 1], [0, 1]] } },
    { id: 'bed2', kind: 'cama', parentId: 'room', planId: 'viejo', planShape: { points: [[0, 0], [1, 0], [1, 1], [0, 1]] } },
    { id: 'loose', kind: 'habitacion', parentId: 'b', planId: null, planShape: null },
    { id: 'bed3', kind: 'cama', parentId: 'loose', planId: null, planShape: null },
  ];
  const layouts: BedLayout[] = [
    { resource_bed_id: 'bed1', resource_space_id: 'room', cols: 4, rows: 4, x: 0, y: 0, rot: 0 },
    { resource_bed_id: 'bed3', resource_space_id: 'loose', cols: 4, rows: 4, x: 0, y: 0, rot: 0 },
  ];
  const out = new Map(deriveBeds(rows, layouts).map((r) => [r.id, r]));
  assert.equal(out.get('bed1')!.planId, 'plan');
  assert.deepEqual(out.get('bed1')!.planShape!.points[0], [0.1, 0.2]);
  assert.deepEqual([out.get('bed2')!.planId, out.get('bed2')!.planShape], [null, null], 'sin sitio en Booking, la forma vieja ya no cuenta');
  assert.deepEqual([out.get('bed3')!.planId, out.get('bed3')!.planShape], [null, null], 'con la habitación sin colocar, la cama tampoco');
  assert.equal(out.get('room'), rows[0], 'lo que no es cama, igual');
});

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
