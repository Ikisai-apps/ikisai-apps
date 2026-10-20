/** Booking · tanda 36 (MUELA-049): «Monta el dormitorio» en cuadrantes y las plazas de cualquier estancia con camas. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dorm, extraCapacity, spaceCapacity } from '../../supabase/functions/_domain/booking/mod.ts';

const bed = (id: string, cell?: unknown) => ({ id, cell });

test('dormitorio · sin distribución guardada: 4 de ancho, el fondo justo y las camas en orden', () => {
  const { grid, cells, moved } = dorm.arrange(null, [bed('a'), bed('b'), bed('c')]);
  assert.deepEqual(grid, { cols: 4, rows: 2 });
  assert.deepEqual([...cells.entries()], [['a', { x: 0, y: 0, rot: 0 }], ['b', { x: 2, y: 0, rot: 0 }], ['c', { x: 0, y: 1, rot: 0 }]]);
  assert.deepEqual(moved, ['a', 'b', 'c']);
});

test('dormitorio · respeta lo guardado; lo que choca o se sale se recoloca, y el fondo crece si no cabe', () => {
  const { grid, cells, moved } = dorm.arrange({ cols: 2, rows: 2 }, [
    bed('a', { x: 0, y: 0, rot: 90 }), bed('b', { x: 1, y: 0, rot: 90 }), bed('c', { x: 0, y: 0, rot: 0 }), bed('d', { x: 5, y: 9, rot: 0 }),
  ]);
  assert.deepEqual(cells.get('a'), { x: 0, y: 0, rot: 90 });
  assert.deepEqual(cells.get('b'), { x: 1, y: 0, rot: 90 });
  assert.deepEqual(moved, ['c', 'd']);
  assert.deepEqual(grid, { cols: 2, rows: 4 });
  assert.deepEqual(cells.get('c'), { x: 0, y: 2, rot: 0 });
  assert.deepEqual(cells.get('d'), { x: 0, y: 3, rot: 0 });
});

test('dormitorio · no deja salirse ni montarse; girar busca sitio; encoger solo si todo cabe', () => {
  const grid = { cols: 3, rows: 2 };
  const cells = new Map([['a', { x: 0, y: 0, rot: 0 as const }], ['b', { x: 2, y: 0, rot: 90 as const }]]);
  assert.deepEqual(dorm.placeProblem(grid, cells, 'a', dorm.moved(cells.get('a')!, 'left')), { reason: 'fuera' });
  assert.deepEqual(dorm.placeProblem(grid, cells, 'a', dorm.moved(cells.get('a')!, 'right')), { reason: 'encima', other: 'b' });
  assert.equal(dorm.placeProblem(grid, cells, 'a', dorm.moved(cells.get('a')!, 'down')), null);
  // a lo largo en la última fila no cabe: sube un cuadrante
  const low = new Map([['a', { x: 0, y: 1, rot: 0 as const }]]);
  assert.deepEqual(dorm.rotated(grid, low, 'a', low.get('a')!), { x: 0, y: 0, rot: 90 });
  assert.equal(dorm.fitsIn({ cols: 2, rows: 2 }, cells), false, 'la b se quedaría fuera');
  assert.equal(dorm.fitsIn({ cols: 3, rows: 2 }, cells), true);
  assert.equal(dorm.fitsIn({ cols: 1, rows: 2 }, new Map()), false, 'menos de 2 de ancho no vale');
});

test('plazas · una sala con camas cuenta sus camas; sin camas, su capacidad, como siempre', () => {
  const sala = { id: 's', kind: 'sala', capacity: 40, active: true, deleted_at: null };
  const beds = [
    { id: 'b1', space_id: 's', kind: 'litera', capacity: 2, active: true, deleted_at: null },
    { id: 'b2', space_id: 's', kind: 'individual', capacity: 1, active: true, deleted_at: null },
    { id: 'b3', space_id: 's', kind: 'supletoria', capacity: 1, active: true, deleted_at: null },
  ];
  assert.equal(spaceCapacity(sala as never, beds as never), 3);
  assert.equal(extraCapacity(sala as never, beds as never), 1);
  assert.equal(spaceCapacity(sala as never, []), 40);
  assert.equal(extraCapacity(sala as never, []), 0);
  const room = { id: 'h', kind: 'habitacion', capacity: null, active: true, deleted_at: null };
  assert.equal(spaceCapacity(room as never, []), 0);
});
