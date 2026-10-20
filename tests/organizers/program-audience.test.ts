/**
 * Organizers · «Para quién» de cada actividad del programa (MUELA-065, Booking #664): lo que llega, la etiqueta de la lista
 * y lo que se envía a `portal_program_save`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { audienceFields, audienceOf, audienceText } from '../../apps/organizers/src/app/program-audience.ts';

const names: Record<string, string> = { a: 'Ana', b: 'Leo', c: 'Marta', d: 'Juan', e: 'Sara' };
const nameOf = (id: string) => names[id] ?? null;

test('organizers · para quién: sin el dato o desconocido es «todos», y «todos» no se escribe en la lista', () => {
  assert.deepEqual(audienceOf({}), { audience: 'todos', ids: [] });
  assert.deepEqual(audienceOf({ audience: 'raro', audience_guest_ids: ['a'] }), { audience: 'todos', ids: [] });
  assert.deepEqual(audienceOf({ audience: 'adultos', audience_guest_ids: ['a'] }), { audience: 'adultos', ids: [] }, 'la lista solo cuenta con «personas»');
  assert.equal(audienceText({ audience: 'todos' }, nameOf), null);
  assert.equal(audienceText({ audience: 'adultos' }, nameOf), 'Solo adultos');
  assert.equal(audienceText({ audience: 'menores' }, nameOf), 'Solo menores');
});

test('organizers · para quién: con personas, sus nombres (como mucho 3) y sin nombrar a quien ya no está', () => {
  assert.equal(audienceText({ audience: 'personas', audience_guest_ids: ['b'] }, nameOf), 'Solo: Leo');
  assert.equal(audienceText({ audience: 'personas', audience_guest_ids: ['a', 'b', 'c', 'd', 'e'] }, nameOf), 'Solo: Ana, Leo, Marta y 2 más');
  assert.equal(audienceText({ audience: 'personas', audience_guest_ids: ['zz', 'b'] }, nameOf), 'Solo: Leo');
  assert.equal(audienceText({ audience: 'personas', audience_guest_ids: ['zz'] }, nameOf), 'Solo algunas personas');
});

test('organizers · para quién: lo que se envía, con la lista vacía fuera de «personas» y al menos una persona dentro', () => {
  assert.deepEqual(audienceFields('todos', ['a']), { ok: true, fields: { audience: 'todos', audience_guest_ids: [] } });
  assert.deepEqual(audienceFields('menores', []), { ok: true, fields: { audience: 'menores', audience_guest_ids: [] } });
  assert.deepEqual(audienceFields('personas', ['b', 'b', 'a']), { ok: true, fields: { audience: 'personas', audience_guest_ids: ['b', 'a'] } });
  assert.deepEqual(audienceFields('personas', []), { ok: false, error: 'Elige al menos a una persona.' });
  const many = Array.from({ length: 101 }, (_, i) => `g${i}`);
  assert.deepEqual(audienceFields('personas', many), { ok: false, error: 'Como mucho 100 personas.' });
});
