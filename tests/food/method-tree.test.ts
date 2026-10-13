/** Food · editor de la elaboración como lista plana con profundidad (FB_2026_028, «subpasos sin restricción»): conversión y reglas. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blockEnd, canIndent, dropDepths, flatten, indent, moveBlock, moveDown, moveUp, normalize, numbering, outdent, snapGap, toTree,
  type FlatRow, type FlatStep,
} from '../../apps/food/src/app/method-tree.ts';
import { methodStepsProblem, type MethodStep } from '../../supabase/functions/_domain/food/mod.ts';

/** Filas a partir de una forma compacta: `'A'` es un paso y `'-a'`, un subpaso (el id es el propio texto). */
const rows = (...spec: string[]): FlatRow[] => spec.map((s) => (s.startsWith('-') ? { id: s.slice(1), depth: 2 } : { id: s, depth: 1 }));
/** La forma compacta de unas filas, para comparar de un vistazo. */
const shape = (list: FlatRow[] | null): string[] | null => list && list.map((r) => (r.depth === 2 ? `-${r.id}` : r.id));

const TREE: MethodStep[] = [
  { id: 'A', text: 'Asar', steps: [{ id: 'a1', text: 'Pelar' }, { id: 'a2', text: 'Cortar' }] },
  { id: 'B', text: 'Triturar' },
  { id: 'C', text: 'Servir', steps: [{ id: 'c1', text: 'Emplatar' }] },
];

test('árbol ⇄ filas planas: ida y vuelta sin perder nada, y numeración 1, 1.1…', () => {
  const flat = flatten(TREE);
  assert.deepEqual(shape(flat), ['A', '-a1', '-a2', 'B', 'C', '-c1']);
  assert.deepEqual(toTree(flat), TREE);
  assert.deepEqual(numbering(flat), ['1', '1.1', '1.2', '2', '3', '3.1']);
  assert.equal(methodStepsProblem(toTree(flat)), null);
  assert.deepEqual(toTree([]), []);
});

test('toTree recorta, quita filas vacías y sube a pasos los subpasos de un paso vacío', () => {
  const flat: FlatStep[] = [
    { id: 'A', text: '  ', depth: 1 }, { id: 'a1', text: ' Pelar ', depth: 2 }, { id: 'a2', text: '', depth: 2 },
    { id: 'B', text: 'Triturar', depth: 1 }, { id: 'b1', text: 'Colar', depth: 2 },
  ];
  assert.deepEqual(toTree(flat), [{ id: 'a1', text: 'Pelar' }, { id: 'B', text: 'Triturar', steps: [{ id: 'b1', text: 'Colar' }] }]);
  // Un subpaso sin paso encima (no debería existir) queda como paso.
  assert.deepEqual(toTree([{ id: 'x', text: 'Suelto', depth: 2 }]), [{ id: 'x', text: 'Suelto' }]);
});

test('la primera fila nunca es un subpaso', () => {
  assert.deepEqual(shape(normalize(rows('-a', 'B'))), ['a', 'B']);
  assert.deepEqual(numbering(rows('-a', '-b')), ['1', '1.1']);
  assert.equal(moveUp(rows('A', '-a1'), 1), null, 'el subpaso del primer paso no puede subir por encima de él');
  assert.equal(moveBlock(rows('A', '-a1', 'B'), 1, 0, 2), null);
  assert.deepEqual(dropDepths(rows('A', 'B'), 0, true), [1]);
});

test('subir y bajar un paso lo mueve con todos sus subpasos', () => {
  const list = rows('A', '-a1', '-a2', 'B', 'C', '-c1');
  assert.deepEqual(shape(moveUp(list, 3)), ['B', 'A', '-a1', '-a2', 'C', '-c1']);
  assert.deepEqual(shape(moveDown(list, 0)), ['B', 'A', '-a1', '-a2', 'C', '-c1']);
  assert.deepEqual(shape(moveDown(list, 3)), ['A', '-a1', '-a2', 'C', '-c1', 'B']);
  assert.equal(moveUp(list, 0), null);
  assert.equal(moveDown(list, 4), null, 'el último paso no baja');
  assert.equal(blockEnd(list, 0), 3);
  assert.equal(blockEnd(list, 1), 2);
});

test('un subpaso pasa de un paso a otro subiendo o bajando', () => {
  const list = rows('A', '-a1', 'B', '-b1', '-b2');
  // b1 sube por encima de su paso: último subpaso del paso anterior (2.1 → 1.2).
  const up = moveUp(list, 3);
  assert.deepEqual(shape(up), ['A', '-a1', '-b1', 'B', '-b2']);
  assert.deepEqual(numbering(up!), ['1', '1.1', '1.2', '2', '2.1']);
  // a1 baja por debajo del paso siguiente: primer subpaso de ese paso.
  assert.deepEqual(shape(moveDown(list, 1)), ['A', 'B', '-a1', '-b1', '-b2']);
  // Entre hermanos, solo intercambia.
  assert.deepEqual(shape(moveDown(list, 3)), ['A', '-a1', 'B', '-b2', '-b1']);
  assert.equal(moveDown(list, 4), null, 'la última fila no baja');
});

test('meter de nivel: un paso sin subpasos pasa a último subpaso del paso anterior', () => {
  const list = rows('A', '-a1', 'B', 'C', '-c1');
  assert.ok(canIndent(list, 2));
  assert.deepEqual(shape(indent(list, 2)), ['A', '-a1', '-B', 'C', '-c1']);
  assert.equal(indent(list, 0), null, 'el primer paso no se mete');
  assert.equal(indent(list, 3), null, 'un paso con subpasos no se mete (dos niveles como máximo)');
  assert.equal(indent(list, 1), null, 'un subpaso ya está en el segundo nivel');
  assert.equal(canIndent(list, 3), false);
});

test('sacar de nivel: el subpaso pasa a paso justo detrás del suyo y sus hermanos de debajo se quedan donde estaban', () => {
  const list = rows('A', '-a1', '-a2', '-a3', 'B');
  const out = outdent(list, 2);
  assert.deepEqual(shape(out), ['A', '-a1', '-a3', 'a2', 'B']);
  assert.deepEqual(numbering(out!), ['1', '1.1', '1.2', '2', '3']);
  assert.deepEqual(shape(outdent(list, 3)), ['A', '-a1', '-a2', 'a3', 'B']);
  assert.equal(outdent(list, 0), null, 'un paso no se saca más');
});

test('soltar al arrastrar: profundidades posibles en cada hueco y bloques de varias filas', () => {
  const list = rows('A', '-a1', 'B', '-b1', '-b2', 'C');
  // Una sola fila puede caer como paso (entre pasos) o como subpaso (con un paso encima).
  const rest = rows('A', '-a1', 'B', '-b1', 'C'); // sin b2
  assert.deepEqual(dropDepths(rest, 2, true), [1, 2]);
  assert.deepEqual(dropDepths(rest, 4, true), [1, 2]);
  assert.deepEqual(dropDepths(rest, 3, true), [2], 'entre un paso y su subpaso solo cabe un subpaso');
  // Un paso con subpasos no puede ser subpaso.
  assert.deepEqual(dropDepths(rest, 2, false), [1]);
  // ... y si cae entre subpasos, se ajusta al principio o al final de ese paso.
  const restA = rows('B', '-b1', '-b2', 'C');
  assert.equal(snapGap(restA, 1), 0);
  assert.equal(snapGap(restA, 2), 3);
  assert.equal(snapGap(restA, 3), 3);
  // Arrastrar b2 entre A y su subpaso como subpaso: primer subpaso de A.
  assert.deepEqual(shape(moveBlock(list, 4, 1, 2)), ['A', '-b2', '-a1', 'B', '-b1', 'C']);
  // Arrastrar b2 a la izquierda al final: paso nuevo al final.
  assert.deepEqual(shape(moveBlock(list, 4, 5, 1)), ['A', '-a1', 'B', '-b1', 'C', 'b2']);
  // Arrastrar el paso C a la derecha bajo A: subpaso de A.
  assert.deepEqual(shape(moveBlock(list, 5, 2, 2)), ['A', '-a1', '-C', 'B', '-b1', '-b2']);
  // Un paso con subpasos no cae como subpaso ni en medio de otro paso.
  assert.equal(moveBlock(list, 2, 1, 2), null);
  assert.equal(moveBlock(list, 0, 2, 1), null);
  // Mover A al final con sus subpasos.
  assert.deepEqual(shape(moveBlock(list, 0, 4, 1)), ['B', '-b1', '-b2', 'C', 'A', '-a1']);
});

test('cualquier movimiento válido deja una lista que el servidor acepta', () => {
  const tree = toTree(flatten(TREE).map((r) => ({ ...r })));
  let list = flatten(tree);
  const ops = [(l: FlatStep[]) => moveDown(l, 1), (l: FlatStep[]) => outdent(l, 2), (l: FlatStep[]) => indent(l, 3), (l: FlatStep[]) => moveUp(l, 5), (l: FlatStep[]) => moveDown(l, 0)];
  for (const op of ops) {
    const next = op(list);
    if (!next) continue;
    list = next;
    assert.equal(list[0]!.depth, 1);
    assert.equal(methodStepsProblem(toTree(list)), null);
    assert.equal(toTree(list).reduce((n, s) => n + 1 + (s.steps?.length ?? 0), 0), 6, 'no se pierde ninguna fila');
  }
});
