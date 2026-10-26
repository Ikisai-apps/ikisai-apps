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

// FB_2026_047, 050 y 051: el espejo de Recursos parte una cama en fija y supletoria; se dibuja una sola pieza, sin las archivadas.
test('dormitorio · una cama de Recursos en dos filas es una pieza; las inactivas van aparte', () => {
  const beds = [
    { id: 'l1-fija', label: 'Litera 1', kind: 'litera', capacity: 1, active: true, resource_id: 'r1', resource_part: 'fija', cell: { x: 0, y: 0, rot: 0 } },
    { id: 'l1-sup', label: 'Litera 1 (supletoria)', kind: 'supletoria', capacity: 1, active: true, resource_id: 'r1', resource_part: 'supletoria', cell: { x: 2, y: 0, rot: 0 } },
    { id: 'sola', label: 'Supletoria 1', kind: 'supletoria', capacity: 1, active: true },
    { id: 'vieja', label: 'Individual 2', kind: 'individual', capacity: 1, active: false, resource_id: 'r3', resource_part: 'fija' },
    { id: 'i1', label: 'Individual 1', kind: 'individual', capacity: 1, active: true, resource_id: 'r2', resource_part: 'fija' },
  ];
  const { pieces, inactive } = dorm.pieces(beds);
  assert.deepEqual(pieces.map((p) => [p.id, p.parts.map((x) => x.id), p.seats, p.extras]), [
    ['l1-fija', ['l1-fija', 'l1-sup'], 1, 1],
    ['sola', ['sola'], 0, 1],
    ['i1', ['i1'], 1, 0],
  ]);
  assert.deepEqual(inactive.map((b) => b.id), ['vieja']);
  // Con la supletoria primero, la principal sigue siendo la fija (su sitio es el que se dibuja).
  const swapped = dorm.pieces([beds[1]!, beds[0]!]);
  assert.equal(swapped.pieces.length, 1);
  assert.equal(swapped.pieces[0]!.id, 'l1-fija');
  // Sin `resource_part` (camas de Booking enlazadas una a una), cada fila es su pieza.
  assert.equal(dorm.pieces([{ id: 'a', resource_id: 'r', capacity: 1 }, { id: 'b', resource_id: 'r', capacity: 1 }]).pieces.length, 2);
});

// FB_2026_046: en la pieza, el nombre corto; el completo va en la barra y en la etiqueta accesible.
test('dormitorio · nombre corto de la cama', () => {
  assert.equal(dorm.shortName('Litera 1 (supletoria)'), 'Litera 1');
  assert.equal(dorm.shortName('Hab 4 · Litera 2'), 'Litera 2');
  assert.equal(dorm.shortName('Cama de matrimonio del apartamento'), 'Cama de matri…');
  assert.equal(dorm.shortName('Individual 1'), 'Individual 1');
});

// FB_2026_052 (VG, 26-10): tamaño fijo por tipo; la doble ocupa 2×2 gire como gire.
test('dormitorio · la doble ocupa 2×2 y no deja montar otra cama encima', () => {
  assert.equal(dorm.sizeOfKind('doble'), 'doble');
  assert.equal(dorm.sizeOfKind('litera'), 'normal');
  assert.deepEqual(dorm.footprint({ x: 1, y: 1, rot: 0 }, 'doble'), { x: 1, y: 1, w: 2, h: 2 });
  assert.deepEqual(dorm.footprint({ x: 1, y: 1, rot: 90 }, 'doble'), { x: 1, y: 1, w: 2, h: 2 });
  const sizes = new Map<string, 'normal' | 'doble'>([['d', 'doble']]);
  const { grid, cells } = dorm.arrange({ cols: 4, rows: 2 }, [bed('d', { x: 0, y: 0, rot: 0 }), bed('s', { x: 0, y: 1, rot: 0 })], sizes);
  // la individual guardada en (0,1) caería dentro de la doble: se recoloca al lado
  assert.deepEqual(cells.get('d'), { x: 0, y: 0, rot: 0 });
  assert.deepEqual(cells.get('s'), { x: 2, y: 0, rot: 0 });
  assert.deepEqual(dorm.placeProblem(grid, cells, 's', { x: 1, y: 1, rot: 0 }, sizes), { reason: 'encima', other: 'd' });
  assert.equal(dorm.fitsIn({ cols: 4, rows: 1 }, cells, sizes), false, 'la doble necesita 2 de fondo');
  // sin tamaños, como antes (2×1)
  assert.equal(dorm.placeProblem(grid, cells, 's', { x: 0, y: 1, rot: 0 }), null);
});
