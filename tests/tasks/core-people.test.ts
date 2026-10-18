/**
 * Tasks · núcleo del cliente (apps/tasks/src/core.ts) para las personas de Central (P2, PR 3b; docs/tasks/API.md §33):
 * `peopleSource()` se lee de `tasks.settings` como `tradeSource()`, y `refreshPeople()` lee `central.people_options`, guarda la
 * respuesta en el dispositivo (sin red se siguen viendo los nombres y las iniciales) y se borra al cerrar sesión.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as any).window = globalThis;
const { TasksCore, peopleOptionsFrom } = await import('../../apps/tasks/src/core.ts');

const ROWS = [
  { person_id: 'a', name: 'Ana Núñez', user_id: null, active: true, house_level: 'staff', initials: 'AN' },
  { person_id: 'b', name: 'Marta Ruiz', user_id: 'u1', active: true, house_level: 'outsider', initials: null },
];

test('peopleSource: «labels» sin fila (o borrada) y «central» con el ajuste', () => {
  const core = new TasksCore({ readOnly: true });
  assert.equal(core.peopleSource(), 'labels');
  (core.data as any)['tasks.settings'] = [{ id: 's1', key: 'people_source', value: 'central', deleted_at: '2026-10-18T00:00:00Z' }];
  assert.equal(core.peopleSource(), 'labels');
  (core.data as any)['tasks.settings'] = [{ id: 's1', key: 'trade_source', value: 'central' }, { id: 's2', key: 'people_source', value: 'central' }];
  assert.equal(core.peopleSource(), 'central');
});

test('peopleOptionsFrom: acepta {rows} o una lista, descarta lo que no es una persona y limpia nivel e iniciales', () => {
  assert.deepEqual(peopleOptionsFrom({ rows: ROWS, total: 2 }), ROWS);
  assert.deepEqual(peopleOptionsFrom([{ name: 'sin id' }, { person_id: 'x', name: 'X', house_level: 'jefa', initials: '  ' }]),
    [{ person_id: 'x', name: 'X', user_id: null, active: true, house_level: null, initials: null }]);
  assert.deepEqual(peopleOptionsFrom(null), []);
});

test('refreshPeople: guarda la última respuesta; sin red se queda con ella; al cerrar sesión se borra', async () => {
  store.clear();
  const core = new TasksCore({ readOnly: true });
  const client = core.client as any;
  let calls: Array<[string, any]> = [];
  client.session = () => ({ userId: 'u1' });
  client.api = async (path: string, init: any) => { calls.push([path, init]); return { rows: ROWS, total: 2 }; };
  let changes = 0;
  core.onChange((kind) => { if (kind === 'data') changes += 1; });
  assert.equal(await core.refreshPeople(), true);
  assert.deepEqual(calls, [['/read/central.people_options', { method: 'POST', json: { limit: 2000 } }]]);
  assert.deepEqual(core.people, ROWS);
  assert.equal(changes, 1);

  // Otro arranque en el mismo dispositivo, sin red: los nombres salen de lo guardado.
  const again = new TasksCore({ readOnly: true });
  (again.client as any).session = () => ({ userId: 'u1' });
  (again.client as any).api = async () => { throw new Error('sin red'); };
  assert.deepEqual(again.people, ROWS);
  assert.equal(await again.refreshPeople(), false);
  assert.deepEqual(again.people, ROWS);

  // Sin sesión no pide nada.
  calls = [];
  client.session = () => null;
  assert.equal(await core.refreshPeople(), false);
  assert.deepEqual(calls, []);

  client.logout = async () => {};
  await core.logout();
  assert.deepEqual(core.people, []);
  assert.deepEqual(new TasksCore({ readOnly: true }).people, []);
});
