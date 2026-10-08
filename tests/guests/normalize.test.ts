/**
 * Guests · normalizadores de las formas de Organizers (docs/organizers/API.md §15) a las de Guests (API.md §13): la
 * experiencia en filas con nombres en español, las preguntas con `kind`, `prompt` y opciones de texto, y los materiales
 * con `file_id`. La forma propia de Guests pasa igual.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExperience, normalizeMaterial, normalizeQuestion } from '../../apps/guests/src/app/normalize.ts';

test('guests · experiencia en filas de Organizers → módulos de Guests, con ventana, capacidad y nota de precio', () => {
  const out = normalizeExperience({
    revision: 4,
    items: [
      { module: 'alojamiento', visible: true, capability: 'elegir', window: 'siempre', params: { guest_price_text: '+40 € a tu organizador' }, position: 3 },
      { module: 'programa', visible: true, capability: 'ver', window: 'durante', position: 1 },
      { module: 'menu', visible: false, window: 'antes', position: 2 },
      { module: 'comentarios', visible: true, position: 9 },
    ],
  });
  assert.equal(out?.revision, 4);
  assert.deepEqual(out?.modules.program, { visible: true, window: 'during' });
  assert.deepEqual(out?.modules.menu, { visible: false, window: 'before' });
  assert.equal(out?.modules.lodging?.capability, 'choose');
  assert.equal(out?.modules.lodging?.options?.[0]?.guest_note, '+40 € a tu organizador');
  assert.equal('comentarios' in (out?.modules ?? {}), false);
  // La forma de Guests pasa tal cual; lo que no es un objeto, null.
  const own = { revision: 1, modules: { program: { visible: true } } };
  assert.equal(normalizeExperience(own), own);
  assert.equal(normalizeExperience(null), null);
});

test('guests · pregunta de Organizers (kind, prompt, opciones de texto, value) → pregunta de Guests', () => {
  const q = normalizeQuestion({ id: 'q3', kind: 'opcion', prompt: 'Taller', options: ['Cerámica', 'Dibujo'], required: true, open: false, value: 'Dibujo' });
  assert.deepEqual(q, {
    id: 'q3', revision: undefined, type: 'choice', label: 'Taller', help: null, options: [{ value: 'Cerámica', label: 'Cerámica' }, { value: 'Dibujo', label: 'Dibujo' }],
    required: true, open: false, answer: { value: 'Dibujo' },
  });
  assert.equal(normalizeQuestion({ id: 'q1', kind: 'si_no', prompt: '¿Coche?' }).type, 'yes_no');
  assert.equal(normalizeQuestion({ id: 'q1', kind: 'si_no', prompt: '¿Coche?' }).answer, null);
  assert.equal(normalizeQuestion({ id: 'q2', type: 'text', label: 'Hola', options: [], required: false, open: true, answer: { value: 'x' } }).answer?.value, 'x');
});

test('guests · material de Organizers (archivo con file_id, enlace, texto) → material de Guests', () => {
  const file = normalizeMaterial({ id: 'm1', kind: 'archivo', title: 'Programa', file_id: 'f1', mime: 'application/pdf', size: 12, window: 'antes' });
  assert.deepEqual(file.file, { id: 'f1', name: 'Programa', mime: 'application/pdf', size: 12 });
  assert.equal(file.kind, 'file');
  assert.equal(file.window, 'before');
  assert.equal(normalizeMaterial({ id: 'm2', kind: 'enlace', title: 'Grupo', url: 'https://x' }).kind, 'link');
  assert.equal(normalizeMaterial({ id: 'm3', kind: 'texto', title: 'Nota', body: 'Hola' }).file, null);
});
