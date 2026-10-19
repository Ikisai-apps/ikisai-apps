/**
 * Tasks · R6 PR 4: costes de tarea y proyecto (docs/tasks/API.md §37), funciones puras. Coste medio ponderado con las
 * entradas con coste (también las que lo reciben después), materiales gastados, costes a mano y el campo «Coste» de antes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { averageUnitCost, costEntryOperation, manualCosts, projectCostOf, taskCost } from '../../packages/domain-tasks/src/index.ts';

const ITEM = 'i-lejia', OTHER = 'i-trapo', TASK = 't1', TASK2 = 't2', PROJECT = 'p1';
const movements = [
  { id: 'm1', item_id: ITEM, kind: 'entrada_manual', quantity: 10, unit_cost: 2 },
  { id: 'm2', item_id: ITEM, kind: 'entrada_factura', quantity: 10, unit_cost: null },
  { id: 'm3', item_id: ITEM, kind: 'consumo_tarea', quantity: -3, unit_cost: null },
  { id: 'm4', item_id: OTHER, kind: 'entrada_manual', quantity: 5, unit_cost: null },
  { id: 'm5', item_id: ITEM, kind: 'entrada_manual', quantity: 100, unit_cost: 99, deleted_at: '2026-10-19' },
];
const movementCosts = [{ movement_id: 'm2', unit_cost: 3 }];
const costEntries = [
  { id: 'c1', target_app: 'tasks', target_ref: `task:${TASK}`, amount: 120, description: 'Alquiler de andamio' },
  { id: 'c2', target_app: 'tasks', target_ref: `task:${TASK}`, amount: 5, description: 'Borrado', deleted_at: '2026-10-19' },
  { id: 'c3', target_app: 'tasks', target_ref: `project:${PROJECT}`, amount: 30, description: 'Permiso de obra' },
  { id: 'c4', target_app: 'food', target_ref: `task:${TASK}`, amount: 999, description: 'De otra app' },
];
const data: any = {
  'tasks.tasks': [
    { id: TASK, project_id: PROJECT, cost: 10, deleted_at: null },
    { id: TASK2, project_id: PROJECT, cost: null, deleted_at: null },
    { id: 't3', project_id: PROJECT, cost: 1000, deleted_at: '2026-10-19' },
  ],
  'tasks.task_materials': [
    { id: 'a', task_id: TASK, item_id: ITEM, consumed: 1.5, deleted_at: null },
    { id: 'b', task_id: TASK, item_id: OTHER, consumed: 2, deleted_at: null },
    { id: 'c', task_id: TASK, item_id: ITEM, consumed: null, deleted_at: null },
    { id: 'd', task_id: TASK2, item_id: ITEM, consumed: 0, deleted_at: null },
  ],
};

test('R6 · coste medio: entradas con coste (también el que llega después); sin coste, null', () => {
  assert.equal(averageUnitCost(ITEM, movements, movementCosts), 2.5);
  assert.equal(averageUnitCost(ITEM, movements), 2, 'sin el coste tardío, solo la primera entrada');
  assert.equal(averageUnitCost(OTHER, movements, movementCosts), null);
});

test('R6 · coste de una tarea: materiales gastados × coste medio, a mano y el campo de antes', () => {
  const c = taskCost(data, TASK, { movements, movementCosts, costEntries });
  assert.deepEqual(c.materials.map((m) => [m.material.id, m.unitCost, m.amount]), [['a', 2.5, 3.75], ['b', null, null]]);
  assert.deepEqual([c.materialsAmount, c.uncosted, c.manualAmount, c.legacy, c.total], [3.75, 1, 120, 10, 133.75]);
  assert.deepEqual(manualCosts(costEntries, `task:${TASK}`).map((e) => e.id), ['c1']);
  assert.equal(taskCost(data, TASK2, { movements, movementCosts, costEntries }).total, 0, '«No se usó» no cuesta');
});

test('R6 · coste de un proyecto: sus tareas vivas y sus costes a mano', () => {
  assert.equal(projectCostOf(data, PROJECT, { movements, movementCosts, costEntries }), 163.75);
});

test('R6 · alta de un coste a mano: destino de Tasks, descripción y importe', () => {
  const op = costEntryOperation({ id: 'x', kind: 'task', targetId: TASK, amount: 120.456, description: '  Andamio  ' });
  assert.deepEqual(op, { op: 'insert', table: 'resources.cost_entries', id: 'x', fields: { target_app: 'tasks', target_ref: `task:${TASK}`, amount: 120.46, description: 'Andamio' } });
  assert.throws(() => costEntryOperation({ id: 'y', kind: 'task', targetId: TASK, amount: 5, description: ' ' }), /Describe/);
  assert.throws(() => costEntryOperation({ id: 'y', kind: 'task', targetId: TASK, amount: 0, description: 'x' }), /importe/);
});
