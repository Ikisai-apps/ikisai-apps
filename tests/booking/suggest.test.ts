/** Booking · FB_2026_014: nombres existentes, parecidos por mayúsculas, tildes o espacios, y aviso de nuevo. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchName, normalizeName, suggestMessage, uniqueNames } from '../../apps/booking/src/ui/suggest.ts';

test('sugerencias · normaliza, deduplica y distingue exacto, parecido y nuevo', () => {
  assert.equal(normalizeName('  Sala   Róble '), 'sala roble');
  assert.deepEqual(uniqueNames(['Planta baja', 'planta  baja', null, '', 'Edificio norte', 'Ático']), ['Ático', 'Edificio norte', 'Planta baja']);
  const zones = ['Planta baja', 'Edificio norte'];
  assert.deepEqual(matchName('Planta baja', zones), { kind: 'exact', match: 'Planta baja' });
  assert.deepEqual(matchName('planta  BÁJA', zones), { kind: 'similar', match: 'Planta baja' });
  assert.deepEqual(matchName('Edificio sur', zones), { kind: 'new' });
  assert.deepEqual(matchName('  ', zones), { kind: 'empty' });
  // elegir (zona): exacto, sin aviso; parecido, propone el existente; nuevo, lo dice
  assert.equal(suggestMessage(matchName('Planta baja', zones), 'pick'), null);
  assert.deepEqual(suggestMessage(matchName('planta baja', zones), 'pick'), { text: 'Ya existe «Planta baja».', use: 'Planta baja', warn: true });
  assert.deepEqual(suggestMessage(matchName('Edificio sur', zones), 'pick'), { text: 'Nuevo: no existe todavía.', warn: false });
  // único (nombre de espacio): repetido o parecido avisa; nuevo, nada
  assert.equal(suggestMessage(matchName('Sala Encina', ['Sala Roble']), 'unique'), null);
  assert.equal(suggestMessage(matchName('sala roble', ['Sala Roble']), 'unique')!.text, 'Ya hay uno que se llama «Sala Roble».');
});
