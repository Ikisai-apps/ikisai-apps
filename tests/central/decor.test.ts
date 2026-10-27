/** Central · finca y decoración (encargo de VG del 27-10): reglas puras de `apps/central/src/app/decor.ts`. Datos ficticios. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DECOR_ITEMS, SPACE_IMAGES, headerOf, headerOperations, contoursFromBands, contoursFromCurves, movePoint, pathPoints, withContourPoints, decorForPlan, decorOperations, elevationLines, estateMeta, gridOf, iconProblem, imageProblem, type DecorChange, type DecorRow } from '../../apps/central/src/app/decor.ts';

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

test('finca · alturas como trazados con data-name «Altura N» (la forma del SVG que traza Core)', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" data-meters-per-unit="1" data-orientation="sur-arriba">
    <g id="alturas">
      <path data-name="Altura 2" d="M20.0 150.0 L380.0 150.0 L380.0 240.0 L20.0 240.0 Z"/>
      <path data-name="Altura 1" d="M20.0 240.0 L380.0 240.0 L380.0 270.0 L20.0 270.0 Z"/>
    </g>
    <path id="parcela" data-name="Finca" d="M10 10 L390 10 L390 290 Z"/>
    <path data-name="Albergue" d="M100 160 L140 160 L140 190 Z"/>
    <rect data-name="Piscina" x="120" y="100" width="14" height="7"/>
  </svg>`;
  const meta = estateMeta(svg);
  assert.equal(meta.metersPerUnit, 1);
  assert.deepEqual(meta.bands, [{ name: 'Altura 2', y0: 0.5, y1: 0.8 }, { name: 'Altura 1', y0: 0.8, y1: 0.9 }]);
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

test('finca · la etiqueta de cada cota, en la línea de arriba de su banda; las bandas sin altura, fuera', () => {
  const bands = [{ name: 'Altura 1', y0: 0.7, y1: 0.8 }, { name: 'Altura 10 · otra', y0: 0.1, y1: 0.2 }, { name: 'Mirador', y0: 0.3, y1: 0.4 }];
  const alturas = [{ id: 'a1', name: 'Altura 1' }, { id: 'a10', name: 'Altura 10' }];
  assert.deepEqual(contoursFromBands(bands, alturas), [{ spaceId: 'a1', x: 0.02, y: 0.7 }, { spaceId: 'a10', x: 0.02, y: 0.1 }]);
});

test('imágenes del centro · PNG, JPG o SVG de hasta 5 MB, con título', () => {
  assert.equal(imageProblem({ type: 'image/png', size: 4_000_000 }, 'Albergue · alzado norte'), null);
  assert.equal(imageProblem({ type: 'image/png', size: 10 }, ' '), 'Ponle un título a la imagen.');
  assert.equal(imageProblem({ type: 'image/gif', size: 10 }, 'X'), 'La imagen tiene que ser PNG, JPG o SVG.');
  assert.equal(imageProblem({ type: 'image/jpeg', size: 5 * 1024 * 1024 + 1 }, 'X'), 'La imagen no puede pasar de 5 MB.');
});

test('finca · curvas de nivel data-contour: puntos relativos y la etiqueta en su punto medio', () => {
  const svg = `<svg viewBox="0 0 400 200" data-meters-per-unit="1">
    <path data-contour="Altura 1" d="M0 180 L100 170 L200 175 L300 160 L400 165"/>
    <path data-contour="Altura 2" d="M0 120 L400 110"/>
    <path data-name="Albergue" d="M100 50 L140 50 L140 80 Z"/>
  </svg>`;
  const meta = estateMeta(svg);
  assert.deepEqual(meta.contours.map((c) => [c.name, c.points.length, c.anchor]), [['Altura 1', 5, [0.5, 0.875]], ['Altura 2', 2, [0.5, 0.575]]]);
  assert.deepEqual(meta.bands, []);
  assert.deepEqual(contoursFromCurves(meta.contours, [{ id: 'a1', name: 'Altura 1' }, { id: 'a2', name: 'Altura 2' }]), [{ spaceId: 'a1', x: 0.5, y: 0.875 }, { spaceId: 'a2', x: 0.5, y: 0.575 }]);
});

test('curvas editables · cambiar los puntos de una altura sin tocar las demás; mover un punto sin salirse', () => {
  const raw = [{ spaceId: 'a1', x: 0.5, y: 0.8 }, { spaceId: 'a2', x: 0.5, y: 0.6, points: [[0, 0.6], [1, 0.6]] }];
  const next = withContourPoints(raw, 'a1', [[0, 0.81234], [0.5, 0.79], [1, 0.8]], [0.5, 0.8]);
  assert.deepEqual(next, [{ spaceId: 'a1', x: 0.5, y: 0.8, points: [[0, 0.8123], [0.5, 0.79], [1, 0.8]] }, raw[1]]);
  assert.deepEqual(raw[0], { spaceId: 'a1', x: 0.5, y: 0.8 }, 'no toca la lista de antes');
  assert.deepEqual(withContourPoints(null, 'a3', [[0, 0.1], [1, 0.2]], [0.5, 0.15]), [{ spaceId: 'a3', x: 0.5, y: 0.15, points: [[0, 0.1], [1, 0.2]] }]);
  assert.deepEqual(movePoint([[0.1, 0.1], [0.98, 0.5]], 1, 0.05, -0.6), [[0.1, 0.1], [1, 0]]);
});

test('curvas Bézier · de cada curva, su punto medio y su final (no los de control); absolutas y relativas', () => {
  assert.deepEqual(pathPoints('M0 0 C0 10 10 10 10 0 s 10 -10 10 0 Q 25 10 30 0 h5 v5 z'), [[0, 0], [5, 7.5], [10, 0], [15, -7.5], [20, 0], [25, 5], [30, 0], [35, 0], [35, 5]]);
  assert.deepEqual(pathPoints('M10 20 L30 40 50 60'), [[10, 20], [30, 40], [50, 60]], 'las coordenadas seguidas tras M o L son rectas');
  const meta = estateMeta(`<svg viewBox="0 0 400 300" data-meters-per-unit="1">
    <path data-contour="Altura 2" d="M10 200 C100 180 300 180 390 200"/>
    <path data-contour="Altura 4" d="M10 100 c90 -20 290 -20 380 0"/>
  </svg>`);
  assert.deepEqual(meta.contours.map((c) => [c.name, c.points.length, c.anchor]), [['Altura 2', 3, [0.5, 0.6167]], ['Altura 4', 3, [0.5, 0.2833]]]);
});

test('silueta de cabecera · una por app: el lote quita la app de la anterior y se la pone a la nueva (Recursos 0816)', () => {
  const images = [
    { id: 's1', revision: 2, kind: 'silueta', header_for: ['guests', 'central'] },
    { id: 's2', revision: 5, kind: 'silueta', header_for: [] },
    { id: 'f1', revision: 1, kind: 'foto', header_for: [] },
    { id: 'old', revision: 1, kind: 'silueta', header_for: ['organizers'], deleted_at: '2026-10-27T00:00:00Z' },
  ];
  assert.equal(headerOf(images, 'guests'), 's1');
  assert.equal(headerOf(images, 'organizers'), null, 'la borrada no cuenta');
  assert.deepEqual(headerOperations(images, 'guests', 's2'), [
    { op: 'update', table: SPACE_IMAGES, id: 's1', expectedRevision: 2, fields: { header_for: ['central'] } },
    { op: 'update', table: SPACE_IMAGES, id: 's2', expectedRevision: 5, fields: { header_for: ['guests'] } },
  ]);
  assert.deepEqual(headerOperations(images, 'organizers', 's1'), [{ op: 'update', table: SPACE_IMAGES, id: 's1', expectedRevision: 2, fields: { header_for: ['guests', 'central', 'organizers'] } }]);
  assert.deepEqual(headerOperations(images, 'central', null), [{ op: 'update', table: SPACE_IMAGES, id: 's1', expectedRevision: 2, fields: { header_for: ['guests'] } }]);
  assert.deepEqual(headerOperations(images, 'guests', 's1'), [], 'si ya lo es, nada');
  assert.deepEqual(headerOperations(images, 'guests', 'f1').map((o) => o.id), ['s1'], 'una foto no puede ser cabecera: solo se quita la anterior');
});
