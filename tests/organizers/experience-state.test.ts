/**
 * Organizers · estado de cada apartado de la Experiencia (pasada única, zona 3): qué ven, qué falta y qué llega más
 * adelante. «0 publicados» nunca es «Lo ven».
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextOf, sectionsOf, stepsOf, type SectionsInput } from '../../apps/organizers/src/app/experience-state.ts';

const base = (over: Partial<SectionsInput> = {}): SectionsInput => ({
  exp: null, materials: [], questions: [], answers: [], program: null, menu: null, rooms: null, ...over,
});
const room = (beds: Array<Record<string, unknown>>) => ({ beds: beds.map((b) => ({ kind: 'cama', ...b })) });

test('organizers · programa: cargando, sin datos, más adelante, por hacer, oculto y visible', () => {
  assert.equal(sectionsOf(base()).programa.state, 'loading');
  assert.equal(sectionsOf(base({ program: { error: 'NETWORK' } })).programa.state, 'unknown');
  assert.equal(sectionsOf(base({ program: { confirmed: false, items: [] } })).programa.state, 'later');
  const todo = sectionsOf(base({ program: { confirmed: true, items: [] } })).programa;
  assert.deepEqual([todo.state, todo.textKey, todo.nextKey], ['todo', 'Aún sin actividades', 'Añade la primera actividad']);
  const items = [{ day: '2027-05-14' }, { day: '2027-05-15' }, { day: '2027-05-15' }];
  const hidden = sectionsOf(base({ program: { confirmed: true, items } })).programa;
  assert.deepEqual([hidden.state, hidden.textKey, hidden.vars], ['hidden', '{n} actividades en {d} días', { n: 3, d: 2 }]);
  const ok = sectionsOf(base({ exp: { program_visible: true, program_window: 'during' }, program: { confirmed: true, items } })).programa;
  assert.deepEqual([ok.state, ok.window], ['ok', 'during']);
});

test('organizers · menú: sin compartir, oculto o visible con sus servicios y comentarios', () => {
  assert.equal(sectionsOf(base({ menu: { available: false, status: 'provisional', services: [] } })).menu.state, 'later');
  const hidden = sectionsOf(base({ menu: { available: true, status: 'provisional', services: [{}, {}] }, comments: 1 })).menu;
  assert.deepEqual([hidden.state, hidden.textKey, hidden.extraKey], ['hidden', 'Provisional · {n} servicios', '1 comentario tuyo a cocina']);
  const ok = sectionsOf(base({ exp: { menu_visible: true }, menu: { available: true, status: 'confirmado', services: [{}] } })).menu;
  assert.deepEqual([ok.state, ok.textKey, ok.extraKey], ['ok', 'Confirmado · 1 servicio', undefined]);
});

test('organizers · alojamiento: sin evento, sin habitaciones, camas pedidas, oculto y visible', () => {
  assert.equal(sectionsOf(base({ rooms: { error: 'EVENT_REQUIRED' } })).alojamiento.state, 'later');
  assert.equal(sectionsOf(base({ rooms: { error: 'NETWORK' } })).alojamiento.state, 'unknown');
  assert.equal(sectionsOf(base({ rooms: { rooms: [], pending: [] } })).alojamiento.textKey, 'Ikisai aún no ha asignado habitaciones');
  const rooms = [room([
    { guest_id: 'a' }, { guest_id: 'b', status: 'requested' }, { kind: 'supletoria' }, { kind: 'supletoria', guest_id: 'c' }, {},
  ])];
  const todo = sectionsOf(base({ rooms: { rooms, pending: [{}, {}] } })).alojamiento;
  // Camas: las 3 normales y la supletoria ocupada; con cama, a y c (b está pedida sin aprobar).
  assert.deepEqual([todo.state, todo.vars, todo.count, todo.extraKey, todo.nextKey], ['todo', { a: 2, n: 4 }, 2, '{n} camas pedidas por aprobar', 'Aprobar las camas pedidas']);
  assert.equal(sectionsOf(base({ rooms: { rooms, pending: [] } })).alojamiento.state, 'hidden');
  assert.equal(sectionsOf(base({ exp: { lodging_visible: true }, rooms: { rooms, pending: [] } })).alojamiento.state, 'ok');
});

test('organizers · materiales: vacío, sin publicar (nunca «Lo ven»), oculto y publicados', () => {
  assert.equal(sectionsOf(base()).materiales.state, 'vacio');
  // 0 publicados no es «ok» aunque la casilla esté marcada.
  const none = sectionsOf(base({ exp: { materials_visible: true }, materials: [{ published: false }, { published: false }] })).materiales;
  assert.deepEqual([none.state, none.textKey], ['todo', '{n} sin publicar']);
  assert.notEqual(none.state, 'ok');
  // El logotipo no se publica nunca: no cuenta como material sin publicar.
  assert.equal(sectionsOf(base({ materials: [{ is_logo: true, published: false }] })).materiales.state, 'vacio');
  const hidden = sectionsOf(base({ materials: [{ published: true, window: 'before' }, { published: false }] })).materiales;
  assert.deepEqual([hidden.state, hidden.textKey, hidden.vars], ['hidden', '{p} de {n} publicados', { n: 2, p: 1 }]);
  const ok = sectionsOf(base({ exp: { materials_visible: true }, materials: [{ published: true, window: 'before' }] })).materiales;
  assert.deepEqual([ok.state, ok.textKey, ok.window], ['ok', '1 publicado', 'before']);
});

test('organizers · preguntas: vacío, sin publicar, oculto y visible con sus respuestas', () => {
  assert.equal(sectionsOf(base()).preguntas.state, 'vacio');
  assert.equal(sectionsOf(base({ exp: { questions_visible: true }, questions: [{ published: false }] })).preguntas.state, 'todo');
  assert.equal(sectionsOf(base({ questions: [{ published: true }] })).preguntas.state, 'hidden');
  const ok = sectionsOf(base({ exp: { questions_visible: true }, questions: [{ published: true }, { published: true }], answers: [{}, {}, {}] })).preguntas;
  assert.deepEqual([ok.state, ok.textKey, ok.vars], ['ok', '{n} preguntas · {r} respuestas', { n: 2, r: 3 }]);
});

test('organizers · plano y lo siguiente: primero lo oculto, luego lo que falta; el plano no cuenta', () => {
  assert.equal(sectionsOf(base()).plano.state, 'hidden');
  assert.equal(sectionsOf(base({ exp: { map_visible: true } })).plano.state, 'ok');
  const s = sectionsOf(base({
    exp: { questions_visible: true }, materials: [{ published: false }], questions: [{ published: true }],
    program: { confirmed: true, items: [{ day: '2027-05-14' }] }, menu: { available: false, status: 'provisional', services: [] }, rooms: { rooms: [], pending: [] },
  }));
  assert.equal(nextOf(s), 'programa');
  assert.deepEqual(stepsOf(s), ['programa', 'materiales', 'preguntas']);
  const none = sectionsOf(base({ program: { confirmed: false, items: [] }, menu: { available: false, status: 'provisional', services: [] }, rooms: { error: 'EVENT_REQUIRED' } }));
  assert.equal(nextOf(none), null);
  assert.deepEqual(stepsOf(none), []);
});
