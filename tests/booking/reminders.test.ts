/** Booking · textos de recordatorio para huéspedes y organizadores (apps/booking/src/app/reminders.ts). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { datesPhrase, esDate, guestReminder, missingLabels, nameAndInitial, organizerReminder } from '../../apps/booking/src/app/reminders.ts';
import { guestMissing } from '../../supabase/functions/_domain/booking/mod.ts';

test('etiquetas legibles de lo que falta, incluido contact', () => {
  assert.deepEqual(missingLabels(['birth_date', 'contact', 'document_number', 'campo_raro']), ['fecha de nacimiento', 'teléfono o correo', 'número de documento', 'campo_raro']);
  assert.ok(guestMissing({ first_name: 'Ana' }, 'operativo').includes('contact'));
});

test('fechas en español sin zona horaria', () => {
  assert.equal(esDate('2026-07-05'), '05/07/2026');
  assert.equal(datesPhrase('2026-07-05', '2026-07-09'), 'del 05/07/2026 al 09/07/2026');
  assert.equal(datesPhrase(null, null), '');
});

test('recordatorio para el huésped: datos y firma', () => {
  const text = guestReminder({ guest: { first_name: 'Ana', last_name_1: 'García' }, title: 'Retiro Test', start: '2026-07-05', end: '2026-07-09', missing: ['birth_date', 'contact'], unsigned: true });
  assert.equal(text, 'Hola, Ana: para tu estancia en Retiro Test del 05/07/2026 al 09/07/2026 nos falta: fecha de nacimiento, teléfono o correo y la firma del parte de entrada. Puedes completarlo desde tu enlace personal.');
  const only = guestReminder({ guest: { first_name: 'Ana' }, title: 'Retiro Test', missing: ['birth_date'], unsigned: false });
  assert.equal(only, 'Hola, Ana: para tu estancia en Retiro Test nos falta: fecha de nacimiento. Puedes completarlo desde tu enlace personal.');
});

test('recordatorio para el organizador: nombre e inicial, nunca apellidos completos', () => {
  assert.equal(nameAndInitial({ first_name: 'Luis', last_name_1: 'pérez', last_name_2: 'Gil' }), 'Luis P.');
  assert.equal(nameAndInitial({}), 'Sin nombre');
  const text = organizerReminder({ contact: 'Org Sintética', title: 'Retiro Test', guests: [{ first_name: 'Ana', last_name_1: 'García' }, { first_name: 'Luis', last_name_1: 'Pérez' }] });
  assert.match(text, /^Hola, Org Sintética: de Retiro Test, 2 huéspedes tienen datos pendientes: Ana G\., Luis P\./);
  assert.doesNotMatch(text, /García|Pérez/);
  assert.match(organizerReminder({ contact: null, title: 'X', guests: [{ first_name: 'Ana' }] }), /^Hola: de X, 1 huésped tiene datos pendientes: Ana\./);
});
