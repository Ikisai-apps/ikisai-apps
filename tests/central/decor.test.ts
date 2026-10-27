/** Central · finca y decoración (encargo de VG del 27-10): reglas puras de `apps/central/src/app/decor.ts`. Datos ficticios. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DECOR_ITEMS, decorForPlan, decorOperations, elevationLines, estateMeta, gridOf, iconProblem, type DecorChange, type DecorRow } from '../../apps/central/src/app/decor.ts';

test('finca · escala, origen y alturas del SVG; sin escala, se pide al subir', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 800" data-meters-per-unit="0.25" data-origin-x="10" data-origin-y="20">
    <rect data-band="Altura 3 · Albergue" x="0" y="400" width="1000" height="200"/>
    <rect data-band="Altura 1 · Salas" x="0" y="0" width="1000" height="160"/>
    <rect x="0" y="0" width="5" height="5"/>
    <rect data-band="Sin alto" x="0" y="10" width="10"/>
  </svg>`;
  const meta = estateMeta(svg);
  assert.equal(meta.metersPerUnit, 0.25);
  assert.deepEqual([meta.originX, meta.originY], [10, 20]);
  assert.deepEqual(meta.bands, [{ name: 'Altura 1 · Salas', y0: 0, y1: 0.2 }, { name: 'Altura 3 · Albergue', y0: 0.5, y1: 0.75 }]);
  assert.deepEqual(gridOf(meta), { metersPerUnit: 0.25, originX: 10, originY: 20 });
  const bare = estateMeta('<svg viewBox="0 0 10 10"></svg>');
  assert.equal(bare.metersPerUnit, null);
  assert.equal(gridOf(bare), null, 'sin escala no hay retícula');
  assert.equal(estateMeta('<svg viewBox="0 0 10 10" data-meters-per-unit="-1"></svg>').metersPerUnit, null);
});

test('iconos · SVG, PNG o GIF de hasta 1 MB, con nombre y 1 o 4 celdas', () => {
  const ok = { type: 'image/gif', size: 900_000 };
  assert.equal(iconProblem(ok, 'Planta', 4), null);
  assert.equal(iconProblem(ok, '  ', 1), 'Ponle un nombre al icono.');
  assert.equal(iconProblem({ type: 'image/jpeg', size: 10 }, 'Mesa', 1), 'El icono tiene que ser SVG, PNG o GIF.');
  assert.equal(iconProblem({ type: 'image/png', size: 1024 * 1024 + 1 }, 'Mesa', 1), 'El icono no puede pasar de 1 MB.');
  assert.equal(iconProblem(ok, 'Mesa', 2), 'Elige 1 celda o 4.');
});

test('decoración · cada cambio de la pieza como operación de Recursos, con su «Deshacer»', () => {
  const item = { id: 'i1', planId: 'p1', iconId: 'ic1', cellX: 3.2, cellY: 7, scale: 1, size: 4, rotation: 450 };
  const before: DecorRow = { id: 'i1', revision: 3, plan_id: 'p1', icon_id: 'ic1', cell_x: 1, cell_y: 2, scale: 1, size: 4, rotation: 0, layer: 'general' };
  const add = decorOperations({ type: 'add', item }, null)!;
  assert.deepEqual(add.op, { op: 'insert', table: DECOR_ITEMS, id: 'i1', fields: { plan_id: 'p1', icon_id: 'ic1', cell_x: 3, cell_y: 7, scale: 1, size: 4, rotation: 90, layer: 'general', op: 'add' } });
  assert.deepEqual(add.undo(1), { op: 'delete', table: DECOR_ITEMS, id: 'i1', expectedRevision: 1 });
  const move = decorOperations({ type: 'move', item }, before)!;
  assert.deepEqual(move.op, { op: 'update', table: DECOR_ITEMS, id: 'i1', expectedRevision: 3, fields: { cell_x: 3, cell_y: 7 } });
  assert.deepEqual(move.undo(4), { op: 'update', table: DECOR_ITEMS, id: 'i1', expectedRevision: 4, fields: { cell_x: 1, cell_y: 2 } });
  const rotate = decorOperations({ type: 'rotate', item: { ...item, rotation: 270 } }, before)!;
  assert.deepEqual(rotate.op.op === 'update' && rotate.op.fields, { rotation: 270 });
  const remove = decorOperations({ type: 'remove', item }, before)!;
  assert.deepEqual(remove.op, { op: 'delete', table: DECOR_ITEMS, id: 'i1', expectedRevision: 3 });
  assert.equal(remove.undo(0).op, 'restore');
  assert.equal(decorOperations({ type: 'move', item } as DecorChange, null), null, 'sin la fila de antes no se mueve');
});

test('decoración · solo la capa general y viva de ese plano, con la URL de su icono', () => {
  const rows = [
    { id: 'a', revision: 1, plan_id: 'p1', icon_id: 'ic1', cell_x: 0, cell_y: 0, scale: 5, size: 1, rotation: 0, layer: 'general' },
    { id: 'b', revision: 1, plan_id: 'p1', icon_id: 'ic1', cell_x: 1, cell_y: 0, scale: 5, size: 1, rotation: 0, layer: 'event' },
    { id: 'c', revision: 1, plan_id: 'p2', icon_id: 'ic1', cell_x: 1, cell_y: 0, scale: 5, size: 1, rotation: 0, layer: 'general' },
    { id: 'd', revision: 2, plan_id: 'p1', icon_id: 'ic2', cell_x: 2, cell_y: 0, scale: 5, size: 1, rotation: 0, layer: 'general', deleted_at: '2026-10-27T00:00:00Z' },
  ];
  assert.deepEqual(decorForPlan(rows, 'p1', (id) => `/icon/${id}`), [{ id: 'a', planId: 'p1', iconId: 'ic1', iconUrl: '/icon/ic1', cellX: 0, cellY: 0, scale: 5, size: 1, rotation: 0 }]);
});

test('finca · curvas de nivel: cota de cada altura y lo que sube hasta la siguiente', () => {
  const bands = [{ name: 'Altura 1 · Salas', y0: 0.8, y1: 0.9 }, { name: 'Altura 3 · Albergue', y0: 0.5, y1: 0.6 }, { name: 'Altura 5 · Depósito', y0: 0.1, y1: 0.2 }];
  const alturas = [{ name: 'Altura 1', elevation_m: 12 }, { name: 'Altura 3', elevation_m: 30.5 }, { name: 'Altura 5', elevation_m: null }];
  assert.deepEqual(elevationLines(bands, alturas).map((l) => [l.elevation, l.toNext, l.label]), [
    [12, 18.5, 'Altura 1 · Salas · 12 m (+18,5 m hasta Altura 3)'],
    [30.5, null, 'Altura 3 · Albergue · 30,5 m'],
    [null, null, 'Altura 5 · Depósito · sin cota'],
  ]);
});
