/**
 * Tasks · núcleo del cliente (apps/tasks/src/core.ts): `settle()` vuelve con el modelo al día aunque al llamarla hubiera
 * un guardado local en vuelo. Antes cancelaba el refresco pendiente y, si `refresh()` se retiraba por ese guardado, nadie
 * lo volvía a programar a tiempo: «Sincronizar ahora» devolvía el modelo viejo (intermitente de la CI en ui.spec.ts,
 * «adjuntos del proyecto», 18-10-2026: el otro dispositivo había recibido la fila y abría la ficha sin ella).
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';

(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
(globalThis as any).window = globalThis;
const { TasksCore } = await import('../../apps/tasks/src/core.ts');

test('settle: con un guardado local en vuelo espera a que termine y vuelve con lo recibido', async () => {
  const core = new TasksCore({ readOnly: true }) as any;
  const fresh = { 'tasks.attachments': [{ id: 'a1', project_id: 'p1', task_id: null, name: 'nota.txt' }] };
  core.read = async () => fresh;
  let emitted = 0;
  core.onChange((kind: string) => { if (kind === 'data') emitted += 1; });
  core.dirty = true;
  core.localPending = 1;
  setTimeout(() => { core.localPending = 0; }, 60);
  await core.settle();
  assert.equal(core.data, fresh, 'el modelo incluye lo recibido al volver de settle()');
  assert.equal(emitted, 1);
});

test('settle: sin nada pendiente vuelve enseguida y no relee', async () => {
  const core = new TasksCore({ readOnly: true }) as any;
  let reads = 0;
  core.read = async () => { reads += 1; return {}; };
  core.dirty = false;
  await core.settle();
  assert.equal(reads, 0);
});

test('aviso del espejo: la revisión confirmada pasa ya a la copia en memoria (nada de planificar con la vieja)', () => {
  const core = new TasksCore({ readOnly: true }) as any;
  core.data = { ...core.data, 'tasks.saved_views': [{ id: 'v1', name: 'Pendientes', revision: 0 }, { id: 'v2', name: 'Otra', revision: 3 }] };
  core.tableChanged('tasks.saved_views', [{ id: 'v1', name: 'Pendientes', revision: 1 }, { id: 'v3', name: 'Nueva', revision: 1 }]);
  const rows = core.data['tasks.saved_views'];
  assert.deepEqual(rows.map((r: any) => [r.id, r.revision]), [['v1', 1], ['v2', 3]], 'solo sube la revisión de la confirmada; lo demás (la nueva, la que no viene) lo pone al día el refresco');
  assert.equal(core.dirty, true, 'y queda programado el refresco completo');
});

test('aviso del espejo con un guardado local en vuelo: no toca la copia en memoria (el espejo aún no lo contiene)', () => {
  const core = new TasksCore({ readOnly: true }) as any;
  const before = [{ id: 'v1', revision: 0 }];
  core.data = { ...core.data, 'tasks.saved_views': before };
  core.localPending = 1;
  core.tableChanged('tasks.saved_views', [{ id: 'v1', revision: 1 }]);
  assert.equal(core.data['tasks.saved_views'], before);
});
