/** Tasks · pruebas del dominio compartido (`supabase/functions/_domain/tasks`). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DomainError, TABLES, WRITABLE, applyOperations, archiveFamilyOps, canProject, completionBlockers, createTabOps, createTaskOps, deleteTaskOps, findCycle,
  fullTab, isAdministrator, moveTaskOps, restoreTaskOps, setDependenciesOps, setTaskDoneOps, setTaskLabelsOps, someTab, statuses, validateOperations,
  visibleRow, type Operation,
} from '../../packages/domain-tasks/src/index.ts';
import { OTHER_TAB, TAB, counter, dataset, dependency, family, label, project, tab, task, taskLabel, uid } from './fixtures.ts';

const P1 = uid(10), P2 = uid(11);
const owner = { role: 'owner' as const, scopes: '*' };

function code(fn: () => void): string {
  try { fn(); } catch (error) { assert.ok(error instanceof DomainError, String(error)); return error.code; }
  return 'OK';
}

test('ámbitos: "*", null, lista de áreas, objeto con áreas y proyectos, y formas inválidas', () => {
  for (const all of ['*', null, undefined]) { assert.ok(fullTab(all, TAB)); assert.ok(canProject(all, TAB, P1)); }
  assert.ok(fullTab([TAB], TAB)); assert.equal(fullTab([TAB], OTHER_TAB), false);
  const limited = { tabs: [OTHER_TAB], projects: { [TAB]: [P1] } };
  assert.ok(fullTab(limited, OTHER_TAB)); assert.equal(fullTab(limited, TAB), false);
  assert.ok(canProject(limited, TAB, P1)); assert.equal(canProject(limited, TAB, P2), false);
  assert.ok(someTab(limited, TAB)); assert.equal(someTab({ projects: { [TAB]: [] } }, TAB), false);
  for (const bad of ['todo', 7, true, { tabs: 'x', projects: [] }]) { assert.equal(fullTab(bad, TAB), false); assert.equal(canProject(bad, TAB, P1), false); }
  assert.ok(isAdministrator({ role: 'owner', scopes: '*' }));
  assert.equal(isAdministrator({ role: 'owner', scopes: [TAB] }), false);
  assert.equal(isAdministrator({ role: 'owner', scopes: '*', kind: 'agent' }), false);
});

test('visibilidad: un acceso por proyecto ve su área, el catálogo completo, sus proyectos y lo que cuelga de ellos; no las vistas', () => {
  const scopes = { tabs: [], projects: { [TAB]: [P1] } };
  assert.ok(visibleRow('tasks.tabs', { id: TAB }, scopes));
  assert.equal(visibleRow('tasks.tabs', { id: OTHER_TAB }, scopes), false);
  assert.ok(visibleRow('tasks.families', { tab_id: TAB }, scopes));
  assert.ok(visibleRow('tasks.labels', { tab_id: TAB }, scopes));
  assert.equal(visibleRow('tasks.saved_views', { tab_id: TAB }, scopes), false);
  assert.ok(visibleRow('tasks.projects', { id: P1, tab_id: TAB }, scopes));
  assert.equal(visibleRow('tasks.projects', { id: P2, tab_id: TAB }, scopes), false);
  for (const table of ['tasks.tasks', 'tasks.task_labels', 'tasks.task_dependencies', 'tasks.project_labels', 'tasks.attachments']) {
    assert.ok(visibleRow(table, { tab_id: TAB, project_id: P1 }, scopes), table);
    assert.equal(visibleRow(table, { tab_id: TAB, project_id: P2 }, scopes), false, table);
  }
  assert.equal(visibleRow('tasks.desconocida', { tab_id: TAB }, '*'), false);
});

test('metadatos: todas las tablas tienen columnas escribibles y ninguna incluye las del contrato', () => {
  for (const table of TABLES) {
    assert.ok(WRITABLE[table].length > 0, table);
    for (const system of ['id', 'revision', 'created_at', 'updated_at', 'updated_by', 'deleted_at', 'done_at']) assert.equal(WRITABLE[table].includes(system), false, `${table}.${system}`);
  }
});

test('validación: tipos, obligatorios, inmutables y operaciones prohibidas', () => {
  const ok: Operation = { op: 'insert', table: 'tasks.tasks', id: uid(100), fields: { tab_id: TAB, project_id: P1, title: 'Pintar', position: 1024 } };
  assert.equal(code(() => validateOperations([ok], owner)), 'OK');
  const variant = (fields: Record<string, unknown>, table = 'tasks.tasks') => code(() => validateOperations([{ ...ok, table, fields: { ...ok.fields, ...fields } }], owner));
  assert.equal(variant({ title: '   ' }), 'REQUIRED_TEXT');
  assert.equal(variant({ due: '2026-02-30' }), 'INVALID_DATE');
  assert.equal(variant({ due: '2026-10-06' }), 'OK');
  assert.equal(variant({ cost: -1 }), 'INVALID_AMOUNT');
  assert.equal(variant({ cost: null }), 'OK');
  assert.equal(variant({ priority: 'urgente' }), 'INVALID_PRIORITY');
  assert.equal(variant({ done: 'sí' }), 'INVALID_DONE');
  assert.equal(variant({ position: Number.NaN }), 'INVALID_ORDER');
  assert.equal(variant({ parent_id: uid(100) }), 'INVALID_PARENT');
  assert.equal(variant({ project_id: 'p1' }), 'INVALID_ID');
  assert.equal(variant({ done_at: '2026-10-06T00:00:00Z' }), 'INVALID_FIELDS');
  assert.equal(code(() => validateOperations([{ op: 'insert', table: 'tasks.tasks', id: uid(100), fields: { tab_id: TAB, project_id: P1, position: 1 } }], owner)), 'REQUIRED_TEXT');
  assert.equal(code(() => validateOperations([{ op: 'insert', table: 'tasks.projects', id: uid(101), fields: { tab_id: TAB, title: 'Otra', position: 1, system: 'inbox' } }], owner)), 'INBOX_PROTECTED');
  assert.equal(code(() => validateOperations([{ op: 'insert', table: 'tasks.families', id: uid(102), fields: { tab_id: TAB, name: 'Fase', color: 'verde' } }], owner)), 'INVALID_FAMILY');
  assert.equal(code(() => validateOperations([{ op: 'update', table: 'tasks.tasks', id: uid(100), expectedRevision: 1, fields: { tab_id: OTHER_TAB } }], owner)), 'IMMUTABLE_FIELD');
  assert.equal(code(() => validateOperations([{ op: 'delete', table: 'tasks.labels', id: uid(103), expectedRevision: 1 }], owner)), 'ARCHIVE_REQUIRED');
  assert.equal(code(() => validateOperations([ok, { ...ok, op: 'update', expectedRevision: 1, fields: { note: 'x' } }], owner)), 'DUPLICATE_OPERATION');
  assert.equal(code(() => validateOperations([{ op: 'call', procedure: 'tasks.import_rows', args: {} }], owner)), 'INVALID_OPERATION');
  assert.equal(code(() => validateOperations([{ op: 'call', procedure: 'tasks.import_rows', args: {} }], { ...owner, allowCalls: true })), 'OK');
  assert.equal(code(() => validateOperations([{ op: 'insert', table: 'tasks.otra', id: uid(1), fields: {} }], owner)), 'INVALID_OPERATION');
  assert.equal(code(() => validateOperations([ok], { role: 'reader', scopes: '*' })), 'FORBIDDEN');
});

test('validación: vistas guardadas y adjuntos', () => {
  const view = (fields: Record<string, unknown>) => code(() => validateOperations([{ op: 'insert', table: 'tasks.saved_views', id: uid(200), fields: { tab_id: TAB, name: 'Pendientes', ...fields } }], owner));
  assert.equal(view({ filters: { _state: ['pending'], _availability: ['ready'], _project: [P1], [uid(50)]: [uid(51)] }, group_by: uid(50) }), 'OK');
  assert.equal(view({ filters: { _state: ['abierta'] } }), 'INVALID_VIEW');
  assert.equal(view({ filters: { person: [uid(51)] } }), 'INVALID_VIEW');
  assert.equal(view({ group_by: 'persona' }), 'INVALID_VIEW');
  const sha = 'a'.repeat(64);
  const file = (fields: Record<string, unknown>) => code(() => validateOperations([{ op: 'insert', table: 'tasks.attachments', id: uid(201), fields: { tab_id: TAB, project_id: P1, name: 'plano.pdf', mime: 'application/pdf', size: 1000, sha256: sha, file_id: { $blob: sha }, ...fields } }], owner));
  assert.equal(file({}), 'OK');
  assert.equal(file({ file_id: uid(300) }), 'OK');
  assert.equal(file({ file_id: { $blob: 'corto' } }), 'INVALID_ATTACHMENT');
  assert.equal(file({ mime: 'text/html' }), 'INVALID_ATTACHMENT');
  assert.equal(file({ size: 26 * 1024 * 1024 }), 'INVALID_ATTACHMENT');
});

test('validación: descartes de ámbito que no necesitan la base', () => {
  const guest = { role: 'editor' as const, scopes: { tabs: [], projects: { [TAB]: [P1] } } };
  const insert = (table: string, fields: Record<string, unknown>) => code(() => validateOperations([{ op: 'insert', table, id: uid(400), fields }], guest));
  assert.equal(insert('tasks.tasks', { tab_id: TAB, project_id: P1, title: 'Mía', position: 1 }), 'OK');
  assert.equal(insert('tasks.tasks', { tab_id: TAB, project_id: P2, title: 'Ajena', position: 1 }), 'FORBIDDEN');
  assert.equal(insert('tasks.projects', { tab_id: TAB, title: 'Nuevo', position: 1 }), 'FORBIDDEN');
  assert.equal(insert('tasks.labels', { tab_id: TAB, family_id: uid(50), name: 'Nueva' }), 'FORBIDDEN');
  assert.equal(insert('tasks.tabs', { name: 'Área', position: 1 }), 'FORBIDDEN');
  assert.equal(code(() => validateOperations([{ op: 'update', table: 'tasks.tabs', id: TAB, expectedRevision: 1, fields: { name: 'X' } }], guest)), 'FORBIDDEN');
  // Sin `tab_id` en la operación no se puede decidir aquí: lo decide el hook SQL.
  assert.equal(code(() => validateOperations([{ op: 'update', table: 'tasks.tasks', id: uid(401), expectedRevision: 1, fields: { note: 'x' } }], guest)), 'OK');
});

test('estados: Pintar bloqueada por Enfoscar; condición heredada del padre; padre calculado desde sus hijas', () => {
  const enfoscar = task(uid(20), P1, { title: 'Enfoscar' });
  const pintar = task(uid(21), P2, { title: 'Pintar' });
  const obra = task(uid(22), P1, { title: 'Obra' });
  const hija1 = task(uid(23), P1, { parent_id: obra.id, done: true });
  const hija2 = task(uid(24), P1, { parent_id: obra.id });
  const input = () => ({
    tasks: [enfoscar, pintar, obra, hija1, hija2], projects: [project(P1), project(P2)],
    dependencies: [dependency(uid(30), pintar, enfoscar.id), dependency(uid(31), obra, enfoscar.id)],
  });
  let s = statuses(input());
  assert.deepEqual(s.get(pintar.id), { done: false, container: false, blockedBy: [enfoscar.id] });
  assert.deepEqual(s.get(hija2.id)!.blockedBy, [enfoscar.id], 'la hija hereda la condición del padre');
  assert.equal(s.get(obra.id)!.done, false); assert.equal(s.get(obra.id)!.container, true);
  assert.deepEqual(completionBlockers(hija2.id, input()), [enfoscar.id]);
  enfoscar.done = true;
  s = statuses(input());
  assert.deepEqual(s.get(pintar.id)!.blockedBy, []);
  assert.deepEqual(completionBlockers(pintar.id, input()), []);
  hija2.done = true;
  assert.equal(statuses(input()).get(obra.id)!.done, true, 'padre hecho cuando lo están todas sus hijas vivas');
  // Borrar la condición no la cumple; tampoco borrar su proyecto.
  enfoscar.deleted_at = '2026-10-06T09:00:00.000Z';
  assert.deepEqual(statuses(input()).get(pintar.id)!.blockedBy, [enfoscar.id]);
  enfoscar.deleted_at = null;
  const withDeletedProject = { ...input(), projects: [project(P1, { deleted_at: '2026-10-06T09:00:00.000Z' }), project(P2)] };
  assert.deepEqual(statuses(withDeletedProject).get(pintar.id)!.blockedBy, [enfoscar.id]);
  // Una arista borrada deja de contar; una condición fuera del conjunto (oculta) cuenta como incumplida.
  const removed = { ...input(), dependencies: [dependency(uid(30), pintar, enfoscar.id, { deleted_at: '2026-10-06T09:00:00.000Z' })] };
  assert.deepEqual(statuses(removed).get(pintar.id)!.blockedBy, []);
  const hidden = { ...input(), tasks: [pintar], dependencies: [dependency(uid(30), pintar, enfoscar.id)] };
  assert.deepEqual(statuses(hidden).get(pintar.id)!.blockedBy, [enfoscar.id]);
});

test('ciclos: directo, de varios pasos, por herencia del padre y por jerarquía', () => {
  const a = task(uid(40), P1), b = task(uid(41), P1), c = task(uid(42), P1);
  assert.equal(findCycle({ tasks: [a, b, c], dependencies: [dependency(uid(50), a, b.id), dependency(uid(51), b, c.id)] }), null);
  assert.ok(findCycle({ tasks: [a, b], dependencies: [dependency(uid(50), a, b.id), dependency(uid(51), b, a.id)] }));
  const three = findCycle({ tasks: [a, b, c], dependencies: [dependency(uid(50), a, b.id), dependency(uid(51), b, c.id), dependency(uid(52), c, a.id)] });
  assert.equal(new Set(three).size, 3);
  // Una arista borrada no cuenta.
  assert.equal(findCycle({ tasks: [a, b], dependencies: [dependency(uid(50), a, b.id), dependency(uid(51), b, a.id, { deleted_at: '2026-10-06T09:00:00.000Z' })] }), null);
  const parent = task(uid(43), P1), child = task(uid(44), P1, { parent_id: parent.id });
  assert.ok(findCycle({ tasks: [parent, child], dependencies: [dependency(uid(53), parent, child.id)] }), 'padre → su propia hija');
  assert.ok(findCycle({ tasks: [parent, child], dependencies: [dependency(uid(54), child, parent.id)] }), 'hija → su propio padre');
  // La hija hereda la condición del padre: padre → X y X → hija cierran un ciclo.
  const x = task(uid(45), P1);
  assert.ok(findCycle({ tasks: [parent, child, x], dependencies: [dependency(uid(55), parent, x.id), dependency(uid(56), x, child.id)] }));
  assert.equal(findCycle({ tasks: [parent, child, x], dependencies: [dependency(uid(55), parent, x.id)] }), null);
});

test('operaciones: área nueva con Entrada y cinco familias en un lote válido', () => {
  const ops = createTabOps({ id: TAB, name: 'Obra', position: 1024 }, counter());
  assert.deepEqual(ops.map((o) => o.table), ['tasks.tabs', 'tasks.projects', ...Array(5).fill('tasks.families')]);
  assert.deepEqual(ops[1]!.fields, { tab_id: TAB, title: 'Entrada', system: 'inbox', status: 'active', position: 1024 });
  assert.deepEqual(ops.slice(2).map((o) => o.fields!.system_key), ['person', 'trade', 'phase', 'building', 'space']);
  assert.equal(code(() => validateOperations(ops, owner)), 'OK');
});

test('operaciones: crear tarea hereda las etiquetas del proyecto y reabre al padre hecho', () => {
  const fam = family(uid(60)), l1 = label(uid(61), fam.id), l2 = label(uid(62), fam.id);
  const parent = task(uid(70), P1, { done: true });
  const data = dataset({
    'tasks.tabs': [tab(TAB)], 'tasks.projects': [project(P1)], 'tasks.tasks': [parent], 'tasks.families': [fam], 'tasks.labels': [l1, l2],
    'tasks.project_labels': [{ ...taskLabel(uid(63), parent, l1.id), project_id: P1 } as never],
  });
  const inherited = createTaskOps(data, { id: uid(71), project_id: P1, title: 'Hija', parent_id: parent.id }, counter());
  assert.deepEqual(inherited.map((o) => `${o.op} ${o.table}`), ['update tasks.tasks', 'insert tasks.tasks', 'insert tasks.task_labels']);
  assert.deepEqual(inherited[0], { op: 'update', table: 'tasks.tasks', id: parent.id, expectedRevision: 1, fields: { done: false } });
  assert.equal(inherited[1]!.fields!.position, 2048);
  assert.equal(inherited[2]!.fields!.label_id, l1.id);
  const chosen = createTaskOps(data, { project_id: P1, title: 'Suelta', labelIds: [l2.id], dependsOnIds: [parent.id] }, counter());
  assert.deepEqual(chosen.map((o) => o.table), ['tasks.tasks', 'tasks.task_labels', 'tasks.task_dependencies']);
  assert.equal(chosen[1]!.fields!.label_id, l2.id);
  assert.equal(code(() => validateOperations([...inherited], owner)), 'OK');
  assert.equal(code(() => validateOperations([...chosen], owner)), 'OK');
});

test('operaciones: completar un padre actualiza solo sus hijas vivas pendientes', () => {
  const parent = task(uid(80), P1), a = task(uid(81), P1, { parent_id: parent.id }), b = task(uid(82), P1, { parent_id: parent.id, done: true });
  const gone = task(uid(83), P1, { parent_id: parent.id, deleted_at: '2026-10-06T09:00:00.000Z' });
  const data = dataset({ 'tasks.projects': [project(P1)], 'tasks.tasks': [parent, a, b, gone] });
  assert.deepEqual(setTaskDoneOps(data, parent.id, true), [{ op: 'update', table: 'tasks.tasks', id: a.id, expectedRevision: 1, fields: { done: true } }]);
  assert.deepEqual(setTaskDoneOps(data, parent.id, false).map((o) => o.id), [b.id]);
  assert.deepEqual(setTaskDoneOps(data, a.id, true).map((o) => o.id), [a.id]);
  assert.deepEqual(setTaskDoneOps(data, b.id, true), []);
});

test('operaciones: mover de proyecto arrastra hijas, etiquetas, dependencias propias y adjuntos', () => {
  const fam = family(uid(60)), l1 = label(uid(61), fam.id);
  const parent = task(uid(90), P1), child = task(uid(91), P1, { parent_id: parent.id }), other = task(uid(92), P1);
  const data = dataset({
    'tasks.projects': [project(P1), project(P2)], 'tasks.tasks': [parent, child, other],
    'tasks.task_labels': [taskLabel(uid(93), child, l1.id), taskLabel(uid(94), other, l1.id)],
    'tasks.task_dependencies': [dependency(uid(95), parent, other.id), dependency(uid(96), other, parent.id)],
    'tasks.attachments': [{ ...taskLabel(uid(97), parent, l1.id), task_id: parent.id, name: 'a.pdf', mime: 'application/pdf', size: 1, sha256: 'a'.repeat(64), file_id: uid(98), position: 1 } as never],
  });
  const ops = moveTaskOps(data, parent.id, { project_id: P2 });
  assert.deepEqual(ops.map((o) => `${o.table} ${o.id}`), [
    `tasks.tasks ${parent.id}`, `tasks.tasks ${child.id}`, `tasks.task_labels ${uid(93)}`, `tasks.task_dependencies ${uid(95)}`, `tasks.attachments ${uid(97)}`,
  ]);
  assert.deepEqual(ops[0]!.fields, { project_id: P2, position: 1024 });
  for (const op of ops.slice(1)) assert.deepEqual(op.fields, { project_id: P2 });
  assert.deepEqual(moveTaskOps(data, other.id, { project_id: P1, position: 512 }).map((o) => o.fields), [{ position: 512 }], 'reordenar en su proyecto no toca nada más');
  assert.equal(code(() => validateOperations(ops, owner)), 'OK');
});

test('operaciones: borrar y restaurar por lote de borrado', () => {
  const parent = task(uid(110), P1), a = task(uid(111), P1, { parent_id: parent.id });
  const before = task(uid(112), P1, { parent_id: parent.id, deleted_at: '2026-10-05T10:00:00.000Z' });
  let data = dataset({ 'tasks.projects': [project(P1)], 'tasks.tasks': [parent, a, before] });
  const del = deleteTaskOps(data, parent.id);
  assert.deepEqual(del.map((o) => `${o.op} ${o.id}`), [`delete ${parent.id}`, `delete ${a.id}`]);
  data = applyOperations(data, del, '2026-10-06T12:00:00.000Z');
  assert.deepEqual(restoreTaskOps(data, parent.id).map((o) => o.id).sort(), [parent.id, a.id].sort(), 'no revive la hija borrada antes');
  assert.deepEqual(restoreTaskOps(data, a.id).map((o) => o.id).sort(), [parent.id, a.id].sort(), 'restaurar una hija restaura a su padre');
  assert.deepEqual(deleteTaskOps(data, parent.id), []);
});

test('operaciones: archivar y reactivar una familia recuerda el estado de sus etiquetas', () => {
  const fam = family(uid(120)), active = label(uid(121), fam.id), archived = label(uid(122), fam.id, { archived: true });
  let data = dataset({ 'tasks.families': [fam], 'tasks.labels': [active, archived] });
  const off = archiveFamilyOps(data, fam.id, true);
  assert.deepEqual(off.map((o) => o.fields), [{ archived: true }, { archived: true, archived_before_family: false }, { archived: true, archived_before_family: true }]);
  data = applyOperations(data, off);
  const on = archiveFamilyOps(data, fam.id, false);
  assert.deepEqual(on.map((o) => o.fields), [{ archived: false }, { archived: false, archived_before_family: null }, { archived: true, archived_before_family: null }]);
  assert.deepEqual(archiveFamilyOps(applyOperations(data, on), fam.id, false), []);
});

test('operaciones: etiquetas y dependencias se reconcilian reutilizando la fila borrada', () => {
  const fam = family(uid(130)), l1 = label(uid(131), fam.id), l2 = label(uid(132), fam.id), l3 = label(uid(133), fam.id);
  const t = task(uid(140), P1), dep = task(uid(141), P1);
  const data = dataset({
    'tasks.projects': [project(P1)], 'tasks.tasks': [t, dep],
    'tasks.task_labels': [taskLabel(uid(134), t, l1.id), taskLabel(uid(135), t, l2.id, { deleted_at: '2026-10-05T10:00:00.000Z', revision: 2 })],
    'tasks.task_dependencies': [dependency(uid(142), t, dep.id)],
  });
  const ops = setTaskLabelsOps(data, t.id, [l2.id, l3.id], counter());
  assert.deepEqual(ops.map((o) => `${o.op} ${o.id}`), [`restore ${uid(135)}`, `insert ${uid(1000)}`, `delete ${uid(134)}`]);
  assert.equal(ops[0]!.expectedRevision, 2);
  assert.deepEqual(setTaskLabelsOps(data, t.id, [l1.id]), []);
  assert.deepEqual(setDependenciesOps(data, t.id, []).map((o) => `${o.op} ${o.id}`), [`delete ${uid(142)}`]);
  assert.deepEqual(setDependenciesOps(data, t.id, [dep.id]), []);
});
