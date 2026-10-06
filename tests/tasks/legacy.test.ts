/**
 * Tasks · puente con el modelo anidado de la interfaz heredada: `compose` y `decompose`.
 * Cada caso edita el modelo como lo hace la interfaz, confirma los lotes contra PGlite (hook incluido)
 * y comprueba que el modelo recompuesto es el editado.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { adoptLegacyIds, compose, decompose, validateOperations, type LegacyTab, type LegacyTask, type Operation } from '../../packages/domain-tasks/src/index.ts';
import { createTasksDb, newId, rejects, type TasksDb } from './db.ts';

let db: TasksDb;
test.before(async () => { db = await createTasksDb(); });
test.after(async () => { await db.close(); });

const model = async () => compose(await db.data());
const find = (tabs: LegacyTab[], tabId: string) => tabs.find((t) => t.id === tabId)!;

/** Guarda el modelo editado: valida como el cliente, confirma cada lote y devuelve las operaciones enviadas. */
async function save(tabs: LegacyTab[]): Promise<Operation[][]> {
  adoptLegacyIds(tabs);
  const batches = decompose(await db.data(), tabs);
  for (const batch of batches) validateOperations(batch, { role: 'owner', scopes: '*' });
  // Sin sync-client de por medio, cada lote se recalcula sobre las revisiones que dejó el anterior.
  for (let round = 0, next = batches; next.length && round < 4; round += 1, next = decompose(await db.data(), tabs)) await db.commit(next[0]!);
  assert.deepEqual(decompose(await db.data(), tabs), [], 'tras guardar no queda nada por enviar');
  return batches;
}

/** Quita lo que cambia en cada guardado (versiones y fechas) para comparar modelos. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, v) => (['version', 'updatedAt', 'deletedAt', 'deleteBatch'].includes(key) ? undefined : v)));
}

const newTask = (text: string, extra: Partial<LegacyTask> = {}): LegacyTask => ({
  id: newId(), text, note: '', done: false, priority: 'normal', due: '', labels: [], owner: null, parentId: null, order: 1024, attachments: [],
  deleted: false, deletedAt: null, deleteBatch: null, dependsOn: [], cost: null, version: 1, updatedAt: '', ...extra,
});

test('legacy · componer y descomponer sin cambios no genera operaciones', async () => {
  await db.area('Estable');
  const tabs = await model();
  assert.deepEqual(decompose(await db.data(), tabs), []);
  assert.equal(tabs[0]!.projects[0]!.system, 'inbox');
  assert.deepEqual(tabs[0]!.families.map((f) => f.system), ['person', 'trade', 'phase', 'building', 'space']);
});

test('legacy · área nueva creada por la interfaz: ids fijos de familia pasan a uuid con su clave de sistema', async () => {
  const tabs = await model();
  const id = newId();
  tabs.push({
    id, name: 'Reforma', color: null, deleted: false, version: 1, updatedAt: '', labels: [], views: [],
    families: ['person', 'trade', 'phase', 'building', 'space'].map((key) => ({ id: key, name: key, color: '#6f5a8f', archived: false, system: null, version: 1 })),
    projects: [{
      id: newId(), system: 'inbox', title: 'Entrada', note: 'Captura rápida. Clasificar después.', status: 'active', priority: 'normal', due: '', ownLabels: [], owner: null,
      attachments: [], deleted: false, deletedAt: null, order: 1024, color: null, budget: null, version: 1, updatedAt: '', tasks: [],
    }],
  });
  tabs.at(-1)!.labels.push({ id: newId(), text: 'Ana', family: 'person', parent: null, archived: false, version: 1 });
  tabs.at(-1)!.views.push({ id: newId(), name: 'Por persona', search: '', filters: { person: [tabs.at(-1)!.labels[0]!.id] }, groupBy: 'person', deleted: false, version: 1 });
  const batches = await save(tabs);
  assert.equal(batches.length, 1);
  const saved = find(await model(), id);
  const person = saved.families.find((f) => f.system === 'person')!;
  assert.match(person.id, /^[0-9a-f-]{36}$/);
  assert.equal(saved.labels[0]!.family, person.id);
  assert.equal(saved.views[0]!.groupBy, person.id);
  assert.deepEqual(Object.keys(saved.views[0]!.filters), [person.id]);
  assert.deepEqual(plain(saved), plain(find(tabs, id)));
});

test('legacy · tareas: crear con hijas, etiquetas y dependencias; editar; completar el contenedor; mover', async () => {
  const { tab } = await db.area('Trabajo');
  let tabs = await model();
  let area = find(tabs, tab);
  const fase = area.families.find((f) => f.system === 'phase')!.id;
  const label = { id: newId(), text: 'Estructura', family: fase, parent: null, archived: false, version: 1 };
  const sub = { id: newId(), text: 'Cimentación', family: fase, parent: label.id, archived: false, version: 1 };
  const deep = { id: newId(), text: 'Zapatas', family: fase, parent: sub.id, archived: false, version: 1 };
  area.labels.push(deep, sub, label);
  const destino = { ...structuredClone(area.projects[0]!), id: newId(), system: null, title: 'Fase 2', order: 2048, tasks: [] };
  area.projects.push(destino);
  const inbox = area.projects[0]!;
  const enfoscar = newTask('Enfoscar'), obra = newTask('Obra', { order: 2048, labels: [label.id] });
  const h1 = newTask('Hija 1', { parentId: obra.id, order: 3072 }), h2 = newTask('Hija 2', { parentId: obra.id, order: 4096, dependsOn: [enfoscar.id], cost: 120.5, due: '2026-11-02' });
  inbox.tasks.push(h2, h1, obra, enfoscar);
  await save(tabs);
  tabs = await model(); area = find(tabs, tab);
  let tasks = area.projects[0]!.tasks;
  assert.deepEqual(tasks.map((t) => t.text), ['Enfoscar', 'Obra', 'Hija 1', 'Hija 2']);
  const saved2 = tasks.find((t) => t.id === h2.id)!;
  assert.deepEqual([saved2.blocked, saved2.blockedBy, saved2.hiddenBlockers, saved2.cost, saved2.due], [true, [enfoscar.id], 0, 120.5, '2026-11-02']);
  assert.equal(area.labels.length, 3);

  // Editar un campo y cambiar etiquetas en un guardado: una operación por fila.
  tasks.find((t) => t.id === enfoscar.id)!.note = 'Dos capas';
  tasks.find((t) => t.id === obra.id)!.labels = [sub.id];
  let batches = await save(tabs);
  assert.deepEqual(batches[0]!.map((o) => `${o.op} ${o.table}`).sort(), ['delete tasks.task_labels', 'insert tasks.task_labels', 'update tasks.tasks']);

  // Completar el contenedor: la interfaz marca las hijas; con la condición pendiente, el servidor lo rechaza entero.
  tabs = await model(); area = find(tabs, tab); tasks = area.projects[0]!.tasks;
  for (const t of tasks) if (t.parentId === obra.id) t.done = true;
  await rejects(save(tabs), 'TASK_BLOCKED');
  tasks.find((t) => t.id === enfoscar.id)!.done = true;
  await save(tabs);
  tabs = await model(); area = find(tabs, tab); tasks = area.projects[0]!.tasks;
  assert.equal(tasks.find((t) => t.id === obra.id)!.done, true, 'el contenedor se muestra hecho');
  assert.equal((await db.data())['tasks.tasks'].find((t) => t.id === obra.id)!.done, false, 'pero su columna no se escribe');
  assert.deepEqual(decompose(await db.data(), tabs), []);

  // Mover el contenedor con sus hijas a otro proyecto: los puentes siguen a la tarea.
  const moving = tasks.filter((t) => t.id === obra.id || t.parentId === obra.id);
  area.projects[0]!.tasks = tasks.filter((t) => !moving.includes(t));
  find(tabs, tab).projects.find((p) => p.id === destino.id)!.tasks.push(...moving);
  batches = await save(tabs);
  assert.equal(batches.length, 1);
  const data = await db.data();
  assert.ok(data['tasks.tasks'].filter((t) => moving.some((m) => m.id === t.id)).every((t) => t.project_id === destino.id));
  assert.ok(data['tasks.task_labels'].filter((l) => l.task_id === obra.id && !l.deleted_at).every((l) => l.project_id === destino.id));
  assert.ok(data['tasks.task_dependencies'].filter((d) => d.task_id === h2.id).every((d) => d.project_id === destino.id));
  assert.deepEqual(plain(find(await model(), tab)), plain(find(tabs, tab)));
});

test('legacy · papelera: borrar un padre arrastra a sus hijas; restaurar el lote; quitar del modelo es borrar', async () => {
  const { tab } = await db.area('Papelera');
  let tabs = await model();
  const parent = newTask('Padre'), a = newTask('A', { parentId: parent.id, order: 2048 }), b = newTask('B', { parentId: parent.id, order: 3072 }), suelta = newTask('Suelta', { order: 4096 });
  find(tabs, tab).projects[0]!.tasks.push(parent, a, b, suelta);
  await save(tabs);
  tabs = await model();
  let tasks = find(tabs, tab).projects[0]!.tasks;
  tasks.find((t) => t.id === parent.id)!.deleted = true;
  let batches = await save(tabs);
  assert.deepEqual(batches[0]!.map((o) => o.op), ['delete', 'delete', 'delete']);
  tabs = await model(); tasks = find(tabs, tab).projects[0]!.tasks;
  const deleted = tasks.filter((t) => t.deleted);
  assert.equal(deleted.length, 3);
  assert.equal(new Set(deleted.map((t) => t.deleteBatch)).size, 1, 'el lote de borrado se reconoce por su fecha común');
  // Restaurar como lo hace la interfaz: todo el lote de borrado y el padre.
  const batchOf = tasks.find((t) => t.id === a.id)!.deleteBatch;
  for (const t of tasks) if (t.deleteBatch === batchOf) t.deleted = false;
  batches = await save(tabs);
  assert.deepEqual(batches[0]!.map((o) => o.op), ['restore', 'restore', 'restore']);
  // Quitar una tarea del modelo equivale a enviarla a la papelera; editar y borrar a la vez sale en dos lotes.
  tabs = await model();
  const project = find(tabs, tab).projects[0]!;
  project.tasks = project.tasks.filter((t) => t.id !== suelta.id);
  const edited = project.tasks.find((t) => t.id === b.id)!;
  edited.note = 'Última nota'; edited.deleted = true;
  batches = await save(tabs);
  assert.deepEqual(batches.map((batch) => batch.map((o) => o.op).sort()), [['delete', 'update'], ['delete']]);
  const data = await db.data();
  assert.ok(data['tasks.tasks'].find((t) => t.id === suelta.id)!.deleted_at);
  const row = data['tasks.tasks'].find((t) => t.id === b.id)!;
  assert.ok(row.deleted_at && row.note === 'Última nota');
});

test('legacy · catálogo, vistas y proyecto: archivar familia arrastra etiquetas; el catálogo no se borra', async () => {
  const { tab } = await db.area('Catálogo');
  let tabs = await model();
  let area = find(tabs, tab);
  const oficio = area.families.find((f) => f.system === 'trade')!;
  const activa = { id: newId(), text: 'Albañilería', family: oficio.id, parent: null, archived: false, version: 1 };
  const yaArchivada = { id: newId(), text: 'Yesería', family: oficio.id, parent: null, archived: true, version: 1 };
  area.labels.push(activa, yaArchivada);
  const proyecto = { ...structuredClone(area.projects[0]!), id: newId(), system: null, title: 'Cocina', order: 2048, ownLabels: [activa.id], budget: 2500, color: '#b76b3d', due: '2026-12-01', tasks: [] };
  area.projects.push(proyecto);
  area.views.push({ id: newId(), name: 'Oficios', search: 'azulejo', filters: { [oficio.id]: [activa.id], _state: ['pending'] }, groupBy: oficio.id, deleted: false, version: 1 });
  await save(tabs);
  assert.deepEqual(plain(find(await model(), tab)), plain(find(tabs, tab)));

  tabs = await model(); area = find(tabs, tab);
  area.families.find((f) => f.id === oficio.id)!.archived = true;
  await save(tabs);
  area = find(await model(), tab);
  assert.deepEqual(area.labels.map((l) => [l.text, l.archived, l.beforeFamilyArchive]).sort(), [['Albañilería', true, false], ['Yesería', true, true]]);
  tabs = await model(); area = find(tabs, tab);
  area.families.find((f) => f.id === oficio.id)!.archived = false;
  await save(tabs);
  area = find(await model(), tab);
  assert.deepEqual(area.labels.map((l) => [l.text, l.archived, l.beforeFamilyArchive]).sort(), [['Albañilería', false, undefined], ['Yesería', true, undefined]]);

  // Quitar una etiqueta del modelo no la borra; vistas y proyectos sí van a la papelera y vuelven.
  tabs = await model(); area = find(tabs, tab);
  area.labels = area.labels.filter((l) => l.id !== activa.id);
  area.views[0]!.deleted = true;
  area.projects.find((p) => p.id === proyecto.id)!.deleted = true;
  const batches = await save(tabs);
  assert.deepEqual(batches[0]!.map((o) => `${o.op} ${o.table}`).sort(), ['delete tasks.projects', 'delete tasks.saved_views']);
  area = find(await model(), tab);
  assert.equal(area.labels.length, 2);
  assert.ok(area.views[0]!.deleted && area.projects.find((p) => p.id === proyecto.id)!.deleted);
});

test('legacy · adjuntos: lo nuevo viaja con marcador de blob; quitarlo borra la fila; sin huella se rechaza', async () => {
  const { tab } = await db.area('Adjuntos');
  const tabs = await model();
  const project = find(tabs, tab).projects[0]!;
  const sha = 'cd'.repeat(32);
  project.attachments.push({ id: newId(), name: 'plano.pdf', mime: 'application/pdf', size: 900, sha256: sha });
  const [batch] = decompose(await db.data(), tabs);
  assert.deepEqual(batch!.map((o) => [o.op, o.table, o.fields!.file_id, o.fields!.task_id]), [['insert', 'tasks.attachments', { $blob: sha }, null]]);
  validateOperations(batch!, { role: 'owner', scopes: '*' });
  project.attachments = [{ id: newId(), name: 'incrustado.png' }];
  assert.throws(() => decompose([] as never, tabs), /./);
});

test('legacy · acceso por proyecto: área restringida y bloqueos privados', async () => {
  const { tab, inbox } = await db.area('Compartida');
  const mine = newId(), secret = newId(), tMine = newId(), tSecret = newId();
  await db.commit([
    { op: 'insert', table: 'tasks.projects', id: mine, fields: { tab_id: tab, title: 'Mío', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: secret, fields: { tab_id: tab, title: 'Privado', position: 3072 } },
    { op: 'insert', table: 'tasks.tasks', id: tMine, fields: { tab_id: tab, project_id: mine, title: 'Pintar', position: 1024 } },
    { op: 'insert', table: 'tasks.tasks', id: tSecret, fields: { tab_id: tab, project_id: secret, title: 'Oculta', position: 1024 } },
    { op: 'insert', table: 'tasks.task_dependencies', id: newId(), fields: { tab_id: tab, project_id: mine, task_id: tMine, depends_on_id: tSecret, position: 1024 } },
  ]);
  const scopes = { projects: { [tab]: [mine] } };
  const all = await db.data();
  // El espejo de un acceso por proyecto solo tiene lo visible: aquí se simula filtrando el proyecto privado.
  const mirror = { ...all, 'tasks.projects': all['tasks.projects'].filter((p) => p.id !== secret && p.id !== inbox), 'tasks.tasks': all['tasks.tasks'].filter((t) => t.project_id === mine) };
  const area = find(compose(mirror, { scopes }), tab);
  assert.equal(area.restricted, true);
  const task = area.projects.find((p) => p.id === mine)!.tasks[0]!;
  assert.deepEqual([task.blocked, task.blockedBy, task.hiddenBlockers], [true, [], 1], 'sin dato del servidor, la condición oculta bloquea');
  const told = find(compose(mirror, { scopes, hiddenBlockers: {} }), tab).projects.find((p) => p.id === mine)!.tasks[0]!;
  assert.deepEqual([told.blocked, told.hiddenBlockers], [false, 0], 'el servidor dice que la condición oculta ya está cumplida');
  assert.equal(find(compose(all, { scopes: '*' }), tab).restricted, undefined);
});
