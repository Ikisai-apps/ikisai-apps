/**
 * Tasks · núcleo del cliente (apps/tasks/src/core.ts) para los oficios de Central (P2, PR 2; docs/tasks/API.md §32):
 * `tradeSource()` se lee de `tasks.settings` como `zoneSource()`, y `refreshTrades()` lee `central.trade_options`, guarda la
 * respuesta en el dispositivo (sin red se siguen viendo los nombres) y se borra al cerrar sesión.
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
const { TasksCore, tradeOptionsFrom } = await import('../../apps/tasks/src/core.ts');

const ROWS = [
  { trade_id: 'a', parent_id: null, name: 'Fontanería', path: 'Fontanería', position: 1, source_label_id: null },
  { trade_id: 'b', parent_id: 'a', name: 'ACS', path: 'Fontanería › ACS', position: 2, source_label_id: 'l1' },
];

test('tradeSource: «labels» sin fila (o borrada) y «central» con el ajuste', () => {
  const core = new TasksCore({ readOnly: true });
  assert.equal(core.tradeSource(), 'labels');
  (core.data as any)['tasks.settings'] = [{ id: 's1', key: 'trade_source', value: 'central', deleted_at: '2026-10-18T00:00:00Z' }];
  assert.equal(core.tradeSource(), 'labels');
  (core.data as any)['tasks.settings'] = [{ id: 's1', key: 'zone_source', value: 'spaces' }, { id: 's2', key: 'trade_source', value: 'central' }];
  assert.equal(core.tradeSource(), 'central');
  assert.equal(core.zoneSource(), 'spaces');
});

test('tradeOptionsFrom: acepta {rows} o una lista y descarta lo que no es un oficio', () => {
  assert.deepEqual(tradeOptionsFrom({ rows: ROWS, total: 2 }), ROWS);
  assert.deepEqual(tradeOptionsFrom([{ name: 'sin id' }, { trade_id: 'x', name: 'X' }]), [{ trade_id: 'x', parent_id: null, name: 'X', path: null, position: 0, source_label_id: null }]);
  assert.deepEqual(tradeOptionsFrom(null), []);
});

test('refreshTrades: guarda la última respuesta; sin red se queda con ella; al cerrar sesión se borra', async () => {
  store.clear();
  const core = new TasksCore({ readOnly: true });
  const client = core.client as any;
  let calls: Array<[string, any]> = [];
  let fail = false;
  client.session = () => ({ userId: 'u1' });
  client.api = async (path: string, init: any) => { calls.push([path, init]); if (fail) throw new Error('sin red'); return { rows: ROWS, total: 2 }; };
  let changes = 0;
  core.onChange((kind) => { if (kind === 'data') changes += 1; });
  assert.equal(await core.refreshTrades(), true);
  assert.deepEqual(calls, [['/read/central.trade_options', { method: 'POST', json: { limit: 2000 } }]]);
  assert.deepEqual(core.trades, ROWS);
  assert.equal(changes, 1);

  // Otro arranque en el mismo dispositivo, sin red: los nombres salen de lo guardado.
  const again = new TasksCore({ readOnly: true });
  (again.client as any).session = () => ({ userId: 'u1' });
  (again.client as any).api = async () => { throw new Error('sin red'); };
  assert.deepEqual(again.trades, ROWS);
  assert.equal(await again.refreshTrades(), false);
  assert.deepEqual(again.trades, ROWS);

  // Sin sesión no pide nada.
  calls = []; fail = false;
  client.session = () => null;
  assert.equal(await core.refreshTrades(), false);
  assert.deepEqual(calls, []);

  client.logout = async () => {};
  await core.logout();
  assert.deepEqual(core.trades, []);
  assert.deepEqual(new TasksCore({ readOnly: true }).trades, []);
});
