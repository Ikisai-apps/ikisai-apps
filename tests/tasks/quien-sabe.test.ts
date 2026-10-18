/**
 * Tasks · «Quién sabe hacerlo» (P2, PR 4; docs/tasks/API.md §34): las funciones puras de apps/tasks/src/who-knows.ts (orden,
 * unión de varios oficios y filtro de aprendices) y `refreshCapabilities()` del núcleo (lectura, caché en el dispositivo, el 403
 * de la disponibilidad para el outsider y el borrado al cerrar sesión). Personas e ids inventados.
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
const { TasksCore, whoKnows, hasApprentices, capabilityOptionsFrom, availabilityOptionsFrom } = await import('../../apps/tasks/src/core.ts');

const cap = (person_id: string, trade_id: string, level: 0 | 1 | 2, inherited = false) => ({ person_id, trade_id, level, inherited });
const av = (person_id: string, availability: string, availability_rank: number) => ({ person_id, availability, availability_rank });
const NAMES: Record<string, string> = { ana: 'Ana Núñez', bea: 'Beatriz Lara', ciro: 'Ciro Pons', dani: 'Dani Soto', eva: 'Eva Mora' };
const nameOf = (id: string) => NAMES[id] ?? '';

test('orden: grado de mayor a menor, después disponibilidad (1 primero) y después nombre', () => {
  const caps = [cap('ana', 'acs', 1), cap('bea', 'acs', 2), cap('ciro', 'acs', 1), cap('dani', 'acs', 2), cap('eva', 'acs', 1)];
  const avail = [av('ana', 'baja', 4), av('bea', 'media', 2), av('ciro', 'alta', 1), av('dani', 'alta', 1), av('eva', 'baja', 4)];
  assert.deepEqual(whoKnows(['acs'], caps, avail, { nameOf }).map((w) => w.person_id), ['dani', 'bea', 'ciro', 'ana', 'eva']);
  const first = whoKnows(['acs'], caps, avail, { nameOf })[0];
  assert.deepEqual(first, { person_id: 'dani', level: 2, availability: 'alta', availability_rank: 1 });
});

test('sin disponibilidad (el outsider no la lee): solo por grado y nombre; quien no tiene dato va detrás de quien sí', () => {
  const caps = [cap('eva', 'acs', 1), cap('ana', 'acs', 1), cap('bea', 'acs', 2)];
  assert.deepEqual(whoKnows(['acs'], caps, [], { nameOf }).map((w) => [w.person_id, w.availability_rank]), [['bea', null], ['ana', null], ['eva', null]]);
  assert.deepEqual(whoKnows(['acs'], caps, [av('eva', 'media', 2)], { nameOf }).map((w) => w.person_id), ['bea', 'eva', 'ana']);
});

test('varios oficios: se juntan sin repetir, con el mejor grado de cada persona', () => {
  const caps = [cap('ana', 'acs', 1), cap('ana', 'cuadro', 2), cap('bea', 'cuadro', 1), cap('ciro', 'pintura', 2), cap('dani', 'acs', 0), cap('dani', 'cuadro', 1)];
  const out = whoKnows(['acs', 'cuadro'], caps, [], { nameOf });
  assert.deepEqual(out.map((w) => [w.person_id, w.level]), [['ana', 2], ['bea', 1], ['dani', 1]]);
  assert.equal(out.length, new Set(out.map((w) => w.person_id)).size);
});

test('aprendices: fuera por defecto; con «Ver también aprendices», al final', () => {
  const caps = [cap('ana', 'acs', 0), cap('bea', 'acs', 1), cap('ciro', 'acs', 0)];
  assert.deepEqual(whoKnows(['acs'], caps, [], { nameOf }).map((w) => w.person_id), ['bea']);
  assert.deepEqual(whoKnows(['acs'], caps, [], { nameOf, apprentices: true }).map((w) => [w.person_id, w.level]), [['bea', 1], ['ana', 0], ['ciro', 0]]);
  assert.equal(hasApprentices(['acs'], caps), true);
  // Quien aprende un oficio pero sabe otro de la ficha no es «aprendiz»: sale con su mejor grado.
  assert.equal(hasApprentices(['acs', 'cuadro'], [cap('ana', 'acs', 0), cap('ana', 'cuadro', 1)]), false);
});

test('sin oficio, sin capacidades o solo con personas desconocidas: lista vacía; la herencia no se calcula aquí', () => {
  const caps = [cap('ana', 'acs', 2)];
  assert.deepEqual(whoKnows([], caps), []);
  assert.deepEqual(whoKnows(['acs'], []), []);
  assert.deepEqual(whoKnows(['acs'], caps, [], { known: () => false }), []);
  // La madre «fontaneria» no da nada en la hija «acs»: eso lo resuelve Central (la fila heredada viene con `inherited`).
  assert.deepEqual(whoKnows(['acs'], [cap('bea', 'fontaneria', 2)]), []);
  assert.deepEqual(whoKnows(['acs'], [cap('bea', 'fontaneria', 2), cap('bea', 'acs', 2, true)]).map((w) => w.person_id), ['bea']);
});

test('capabilityOptionsFrom y availabilityOptionsFrom: aceptan {rows} o una lista y descartan lo que no vale', () => {
  assert.deepEqual(capabilityOptionsFrom({ rows: [cap('a', 't', 2, true), { person_id: 'b', trade_id: 't', level: 7 }, { person_id: 'c', trade_id: 't', level: null }, { trade_id: 't', level: 1 }, { person_id: 'd', trade_id: 't', level: '1' }] }),
    [cap('a', 't', 2, true), cap('d', 't', 1)]);
  assert.deepEqual(availabilityOptionsFrom([av('a', 'alta', 1), { person_id: 'b', availability: 'media' }, { person_id: 'c', availability_rank: '3' }]),
    [av('a', 'alta', 1), av('c', '', 3)]);
  assert.deepEqual(capabilityOptionsFrom(null), []);
});

test('refreshCapabilities: lee las dos, guarda en el dispositivo, sin red se queda con lo último, el 403 vacía la disponibilidad y se borra al cerrar sesión', async () => {
  store.clear();
  const CAPS = [cap('ana', 'acs', 2), cap('bea', 'acs', 1, true)];
  const AVAIL = [av('ana', 'media', 2), av('bea', 'alta', 1)];
  const core = new TasksCore({ readOnly: true });
  const client = core.client as any;
  let calls: Array<[string, any]> = [];
  client.session = () => ({ userId: 'u1' });
  client.api = async (path: string, init: any) => { calls.push([path, init]); return path.endsWith('capability_options') ? { rows: CAPS, total: 2 } : { rows: AVAIL, total: 2 }; };
  assert.equal(await core.refreshCapabilities(), true);
  assert.deepEqual(calls, [
    ['/read/central.capability_options', { method: 'POST', json: { limit: 2000 } }],
    ['/read/central.availability_options', { method: 'POST', json: { limit: 2000 } }],
  ]);
  assert.deepEqual(core.capabilities, CAPS);
  assert.deepEqual(core.availability, AVAIL);

  // Otro arranque sin red: sale lo guardado.
  const again = new TasksCore({ readOnly: true });
  (again.client as any).session = () => ({ userId: 'u1' });
  (again.client as any).api = async () => { throw new Error('sin red'); };
  assert.deepEqual(again.capabilities, CAPS);
  assert.equal(await again.refreshCapabilities(), false);
  assert.deepEqual(again.availability, AVAIL);

  // El outsider: lee las capacidades, pero la disponibilidad da 403 y se ordena solo por grado (sin error).
  client.api = async (path: string) => {
    if (path.endsWith('availability_options')) throw Object.assign(new Error('FORBIDDEN'), { status: 403 });
    return { rows: CAPS };
  };
  assert.equal(await core.refreshCapabilities(), true);
  assert.deepEqual(core.availability, []);
  assert.deepEqual(new TasksCore({ readOnly: true }).availability, []);

  // Más de una página: se piden las siguientes con `offset`.
  const many = Array.from({ length: 2001 }, (_, i) => cap(`p${i}`, 'acs', 1));
  calls = [];
  client.api = async (path: string, init: any) => { calls.push([path, init.json]); const o = init.json.offset ?? 0; return { rows: path.endsWith('capability_options') ? many.slice(o, o + 2000) : [] }; };
  await core.refreshCapabilities();
  assert.equal(core.capabilities.length, 2001);
  assert.deepEqual(calls.slice(0, 2).map((c) => c[1]), [{ limit: 2000 }, { limit: 2000, offset: 2000 }]);

  // Sin sesión no pide nada.
  calls = [];
  client.session = () => null;
  assert.equal(await core.refreshCapabilities(), false);
  assert.deepEqual(calls, []);

  client.logout = async () => {};
  await core.logout();
  assert.deepEqual(core.capabilities, []);
  assert.deepEqual(core.availability, []);
  const fresh = new TasksCore({ readOnly: true });
  assert.deepEqual([fresh.capabilities, fresh.availability], [[], []]);
});
