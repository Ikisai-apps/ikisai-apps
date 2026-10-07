/** Central · reglas puras del dominio (cliente y Edge): visibilidad, estado derivado y validación. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { canSeeReserved, dueState, personStatus, todayInMadrid, validateOperations, visibleRow, TABLES } from '../../supabase/functions/_domain/central/mod.ts';

test('dominio · datos reservados: owner siempre, editor solo con ámbito people, lector nunca', () => {
  assert.equal(canSeeReserved({ role: 'owner' }), true);
  assert.equal(canSeeReserved({ role: 'editor', scopes: { people: true } }), true);
  assert.equal(canSeeReserved({ role: 'editor', scopes: { people: 'true' } }), false);
  assert.equal(canSeeReserved({ role: 'reader', scopes: { people: true } }), false);
  assert.equal(visibleRow(TABLES.people, { role: 'reader' }), true);
  assert.equal(visibleRow(TABLES.personRecords, { role: 'editor', scopes: null }), false);
});

test('dominio · vencimientos: vencido, por vencer según antelación, cerrado nunca vence', () => {
  assert.equal(dueState('2026-10-06', '2026-10-07'), 'vencido');
  assert.equal(dueState('2026-10-07', '2026-10-07'), 'por_vencer');
  assert.equal(dueState('2026-11-06', '2026-10-07', 30), 'por_vencer');
  assert.equal(dueState('2026-11-07', '2026-10-07', 30), 'al_dia');
  assert.equal(dueState('2020-01-01', '2026-10-07', 30, true), 'al_dia');
  assert.equal(dueState(null, '2026-10-07'), 'al_dia');
  assert.match(todayInMadrid(new Date('2026-12-31T23:30:00Z')), /^2027-01-01$/);
});

test('dominio · estado documental y de formación de una persona', () => {
  const today = '2026-10-07';
  assert.deepEqual(personStatus([], today), { documents: 'no_aplica', training: 'no_aplica' });
  assert.deepEqual(personStatus([
    { kind: 'documento', status: 'ok' }, { kind: 'documento', status: 'pendiente' },
    { kind: 'formacion', status: 'ok', expires_on: '2026-10-01' },
  ], today), { documents: 'pendiente', training: 'caducado' });
  assert.deepEqual(personStatus([{ kind: 'documento', status: 'ok', expires_on: '2027-01-01' }, { kind: 'formacion', status: 'ok', deleted_at: 'x', expires_on: '2020-01-01' }], today),
    { documents: 'completo', training: 'no_aplica' });
});

test('dominio · validación con la fila actual en un update parcial', () => {
  const owner = { role: 'owner' };
  const current = () => ({ kind: 'formacion', record_type: 'manipulador_alimentos', issued_on: '2026-05-01' });
  const issue = validateOperations([{ op: 'update', table: TABLES.personRecords, id: 'x', fields: { expires_on: '2026-04-01' } }], owner, current);
  assert.equal(issue?.details.field, 'expires_on');
  assert.equal(validateOperations([{ op: 'update', table: TABLES.personRecords, id: 'x', fields: { record_type: 'datos_fiscales' } }], owner, current)?.details.field, 'record_type');
  assert.equal(validateOperations([{ op: 'insert', table: TABLES.personPrivate, id: 'x', fields: { person_id: crypto.randomUUID(), email: 'no-es-correo' } }], owner)?.details.field, 'email');
  assert.equal(validateOperations([{ op: 'insert', table: TABLES.personPrivate, id: 'x', fields: { person_id: crypto.randomUUID() } }], { role: 'editor' })?.code, 'FORBIDDEN');
  assert.equal(validateOperations([{ op: 'call', procedure: 'central.x' }], owner)?.code, 'INVALID_OPERATION');
});
