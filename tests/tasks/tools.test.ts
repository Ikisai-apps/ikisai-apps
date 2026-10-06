/**
 * Tasks · herramientas de dominio para agentes (`_domain/tasks/tools.ts`): cada herramienta valida su entrada y su lote
 * pasa la validación compartida y el hook SQL sobre PGlite, como lo haría el de un agente por MCP.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, TASK_TOOL_SPECS, buildTaskTool, validateOperations, type Dataset, type TaskToolName } from '../../packages/domain-tasks/src/index.ts';
import { createTasksDb, insert, newId, type TasksDb } from './db.ts';

let db: TasksDb;
let tab = '', inbox = '', other = '', otherTab = '', phase = '', label1 = '', label2 = '', archived = '';
test.before(async () => {
  db = await createTasksDb();
  const area = await db.area('Obra');
  tab = area.tab; inbox = area.inbox; phase = area.families.phase!;
  other = newId(); label1 = newId(); label2 = newId(); archived = newId();
  await db.commit([
    insert('tasks.projects', other, { tab_id: tab, title: 'Fase 2', position: 4096 }),
    insert('tasks.labels', label1, { tab_id: tab, family_id: phase, name: 'Uno' }),
    insert('tasks.labels', label2, { tab_id: tab, family_id: phase, name: 'Dos' }),
    insert('tasks.labels', archived, { tab_id: tab, family_id: phase, name: 'Vieja', archived: true }),
  ]);
  otherTab = (await db.area('Otra')).tab;
});
test.after(async () => { await db.close(); });

/** Construye, valida como la Edge y confirma; devuelve el lote. */
async function run(name: TaskToolName, input: unknown) {
  const ops = buildTaskTool(name, await db.data(), input);
  validateOperations(ops, { role: 'editor', scopes: '*' });
  if (ops.length) await db.commit(ops);
  return ops;
}
async function fails(name: TaskToolName, input: unknown, code: string, data?: Dataset) {
  try { buildTaskTool(name, data ?? await db.data(), input); } catch (error) {
    assert.ok(error instanceof DomainError, String(error));
    assert.equal(error.code, code, error.message);
    return;
  }
  assert.fail(`${name} debía fallar con ${code}`);
}
const task = async (id: string) => (await db.data())['tasks.tasks'].find((t) => t.id === id)!;
const created = (ops: { op: string; table?: string; id?: string }[]) => ops.find((o) => o.op === 'insert' && o.table === 'tasks.tasks')!.id!;

test('herramientas: especificaciones completas y únicas, con esquema de objeto y pistas MCP', () => {
  assert.deepEqual(TASK_TOOL_SPECS.map((s) => s.name).sort(), ['tasks_complete', 'tasks_create_task', 'tasks_delete', 'tasks_move', 'tasks_set_dependencies', 'tasks_set_labels', 'tasks_update_task']);
  for (const spec of TASK_TOOL_SPECS) {
    assert.equal((spec.inputSchema as any).type, 'object');
    assert.equal((spec.inputSchema as any).additionalProperties, false);
    assert.ok(spec.description.length > 20);
  }
  assert.equal(TASK_TOOL_SPECS.find((s) => s.name === 'tasks_delete')!.annotations.destructiveHint, true);
});

test('herramientas: crear, editar, etiquetar, depender, completar, mover y borrar, cada lote aceptado por el hook', async () => {
  const parent = created(await run('tasks_create_task', { project_id: inbox, title: '  Instalación eléctrica ', priority: 'high', due: '2026-11-01', label_ids: [label1] }));
  assert.equal((await task(parent)).title, 'Instalación eléctrica');
  const child = created(await run('tasks_create_task', { project_id: inbox, parent_id: parent, title: 'Cableado' }));
  const before = created(await run('tasks_create_task', { project_id: inbox, title: 'Pedir material' }));

  assert.deepEqual((await run('tasks_update_task', { task_id: child, note: 'Del cuadro a la cocina', cost: 120.5 })).map((o) => o.op), ['update']);
  assert.deepEqual(await run('tasks_update_task', { task_id: child, cost: 120.5 }), [], 'sin cambios reales no hay lote');
  await run('tasks_set_labels', { task_id: child, label_ids: [label1, label2] });
  await run('tasks_set_dependencies', { task_id: child, depends_on_ids: [before] });
  let data = await db.data();
  assert.equal(data['tasks.task_labels'].filter((l) => l.task_id === child && !l.deleted_at).length, 2);
  assert.equal(data['tasks.task_dependencies'].filter((d) => d.task_id === child && !d.deleted_at).length, 1);

  // La hija depende de una tarea pendiente: el hook no la deja completar. Completada la dependencia, sí.
  await assert.rejects(run('tasks_complete', { task_id: parent }), /TASK_BLOCKED/);
  await run('tasks_complete', { task_id: before });
  // Completar el contenedor completa sus hijas; el padre no se escribe.
  const done = await run('tasks_complete', { task_id: parent });
  assert.deepEqual(done.map((o) => o.id), [child]);
  await run('tasks_complete', { task_id: child, done: false });
  assert.equal((await task(child)).done, false);

  // Mover el padre con su hija y sus puentes a otro proyecto de la misma área.
  await run('tasks_move', { task_id: parent, project_id: other });
  data = await db.data();
  assert.deepEqual([parent, child].map((id) => data['tasks.tasks'].find((t) => t.id === id)!.project_id), [other, other]);
  assert.ok(data['tasks.task_labels'].filter((l) => l.task_id === child && !l.deleted_at).every((l) => l.project_id === other));

  // Borrar arrastra a las hijas vivas.
  const removed = await run('tasks_delete', { task_id: parent });
  assert.deepEqual(removed.map((o) => o.op), ['delete', 'delete']);
  assert.ok((await task(child)).deleted_at);
});

test('herramientas: entradas inválidas o fuera de alcance se rechazan antes de construir nada', async () => {
  const t = created(await run('tasks_create_task', { project_id: inbox, title: 'Revisar' }));
  const child = created(await run('tasks_create_task', { project_id: inbox, parent_id: t, title: 'Hija' }));
  await fails('tasks_create_task', null, 'INVALID_INPUT');
  await fails('tasks_create_task', { project_id: inbox }, 'INVALID_INPUT');
  await fails('tasks_create_task', { project_id: inbox, title: '   ' }, 'INVALID_INPUT');
  await fails('tasks_create_task', { project_id: inbox, title: 'x', sorpresa: 1 }, 'INVALID_INPUT');
  await fails('tasks_create_task', { project_id: 'no-es-un-uuid', title: 'x' }, 'INVALID_INPUT');
  await fails('tasks_create_task', { project_id: newId(), title: 'x' }, 'NOT_FOUND');
  await fails('tasks_create_task', { project_id: inbox, title: 'x', due: '1 de enero' }, 'INVALID_INPUT');
  await fails('tasks_create_task', { project_id: inbox, title: 'x', priority: 'urgente' }, 'INVALID_INPUT');
  await fails('tasks_create_task', { project_id: inbox, title: 'x', label_ids: [archived] }, 'INVALID_INPUT');
  await fails('tasks_create_task', { project_id: inbox, title: 'x', label_ids: [label1, label1] }, 'INVALID_INPUT');
  await fails('tasks_create_task', { project_id: inbox, title: 'x', parent_id: child }, 'INVALID_INPUT');
  await fails('tasks_create_task', { project_id: other, title: 'x', parent_id: t }, 'INVALID_INPUT');
  await fails('tasks_update_task', { task_id: t }, 'INVALID_INPUT');
  await fails('tasks_update_task', { task_id: t, cost: -1 }, 'INVALID_INPUT');
  await fails('tasks_update_task', { task_id: t, done: true }, 'INVALID_INPUT');
  await fails('tasks_complete', { task_id: t, done: 'sí' }, 'INVALID_INPUT');
  const otherInbox = (await db.data())['tasks.projects'].find((p) => p.tab_id === otherTab && p.system === 'inbox')!.id;
  await fails('tasks_move', { task_id: t, project_id: otherInbox }, 'INVALID_INPUT');
  await fails('tasks_move', { task_id: t, project_id: inbox, parent_id: child }, 'INVALID_INPUT');
  await fails('tasks_set_dependencies', { task_id: t, depends_on_ids: [t] }, 'INVALID_INPUT');
  await fails('tasks_set_labels', { task_id: t }, 'INVALID_INPUT');
  await fails('nada' as TaskToolName, {}, 'NOT_FOUND');
  // Lo que no está en el conjunto visible no existe; tampoco lo que está en la papelera.
  const hidden = await db.data();
  hidden['tasks.tasks'] = hidden['tasks.tasks'].filter((x) => x.id !== t);
  await fails('tasks_complete', { task_id: t }, 'NOT_FOUND', hidden);
  await run('tasks_delete', { task_id: t });
  await fails('tasks_update_task', { task_id: t, title: 'Otra' }, 'NOT_FOUND');
});
