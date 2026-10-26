/**
 * Organizers · borrador de la propuesta del equipo de Ikisai (decisión de VG del 26-10-2026, migración 0703): cómo se
 * juntan los cambios de dirección, cómo se ven encima del espejo y qué se ajusta al aceptarlos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { RowOperation, SyncedRow } from '../../packages/sync-client/src/types.ts';
import { describeChange, hasPendingFile, mergeOperations, overlay, ownedBy } from '../../apps/organizers/src/app/proposal-draft.ts';

const R = '00000000-0000-4000-8000-000000000001';
const OFFERS = 'organizers.offers' as const;
const MATERIALS = 'organizers.materials' as const;
const row = (id: string, fields: Record<string, unknown> = {}): SyncedRow => ({ id, revision: 3, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z', updated_by: null, deleted_at: null, reservation_id: R, ...fields });

test('organizers · propuesta: varias ediciones de la misma fila quedan en una operación', () => {
  const a = mergeOperations([], [{ op: 'update', table: OFFERS, id: 'o1', expectedRevision: 3, fields: { name: 'Masaje' } }]);
  const b = mergeOperations(a, [{ op: 'update', table: OFFERS, id: 'o1', expectedRevision: 3, fields: { price: 40 } }]);
  assert.deepEqual(b, [{ op: 'update', table: OFFERS, id: 'o1', expectedRevision: 3, fields: { name: 'Masaje', price: 40 } }]);
  assert.deepEqual(a[0], { op: 'update', table: OFFERS, id: 'o1', expectedRevision: 3, fields: { name: 'Masaje' } }, 'no toca el lote anterior');
});

test('organizers · propuesta: un alta que se edita sigue siendo un alta; si se borra, desaparece', () => {
  const add = mergeOperations([], [{ op: 'insert', table: OFFERS, id: 'n1', fields: { reservation_id: R, name: 'Paseo', price: 0 } }]);
  const edited = mergeOperations(add, [{ op: 'update', table: OFFERS, id: 'n1', expectedRevision: 0, fields: { price: 15 } }]);
  assert.deepEqual(edited, [{ op: 'insert', table: OFFERS, id: 'n1', fields: { reservation_id: R, name: 'Paseo', price: 15 } }]);
  assert.deepEqual(mergeOperations(edited, [{ op: 'delete', table: OFFERS, id: 'n1', expectedRevision: 0 }]), []);
});

test('organizers · propuesta: borrar una fila que ya existía conserva la revisión con la que se vio', () => {
  const ops = mergeOperations([{ op: 'update', table: OFFERS, id: 'o1', expectedRevision: 3, fields: { name: 'X' } }], [{ op: 'delete', table: OFFERS, id: 'o1', expectedRevision: 0 }]);
  assert.deepEqual(ops, [{ op: 'delete', table: OFFERS, id: 'o1', expectedRevision: 3 }]);
});

test('organizers · propuesta: las pantallas ven el borrador encima del espejo, solo en su tabla', () => {
  const rows = [row('o1', { name: 'Masaje', price: 30 }), row('o2', { name: 'Yoga', price: 10 })];
  const ops: Parameters<typeof overlay>[1] = [
    { op: 'update', table: OFFERS, id: 'o1', expectedRevision: 3, fields: { price: 35 } },
    { op: 'delete', table: OFFERS, id: 'o2', expectedRevision: 3 },
    { op: 'insert', table: OFFERS, id: 'n1', fields: { reservation_id: R, name: 'Paseo', price: 0 } },
    { op: 'insert', table: MATERIALS, id: 'm1', fields: { reservation_id: R, title: 'Guía' } },
  ];
  const out = overlay(rows, ops, OFFERS);
  assert.deepEqual(out.map((r) => [r.id, r.name, r.price]), [['o1', 'Masaje', 35], ['n1', 'Paseo', 0]]);
  assert.equal(out.find((r) => r.id === 'n1')?.revision, 0, 'lo nuevo aún no tiene revisión');
  assert.deepEqual(overlay(rows, [], OFFERS), rows);
});

test('organizers · propuesta: al aceptarla, lo nuevo en materiales y preguntas es de quien organiza', () => {
  const ops: RowOperation[] = [
    { op: 'insert', table: MATERIALS, id: 'm1', fields: { reservation_id: R, owner_id: 'direccion', title: 'Guía' } },
    { op: 'insert', table: OFFERS, id: 'n1', fields: { reservation_id: R, name: 'Paseo', price: 0 } },
    { op: 'update', table: MATERIALS, id: 'm2', expectedRevision: 2, fields: { title: 'Mapa' } },
  ];
  const out = ownedBy(ops, 'ana', [MATERIALS, 'organizers.questions']);
  assert.equal((out[0] as { fields: Record<string, unknown> }).fields.owner_id, 'ana');
  assert.deepEqual(out[1], ops[1]);
  assert.deepEqual(out[2], ops[2]);
});

test('organizers · propuesta: un archivo sin subir no viaja en una propuesta', () => {
  assert.equal(hasPendingFile([{ op: 'insert', table: MATERIALS, id: 'm1', fields: { file_id: { $blob: 'abc' } } }]), true);
  assert.equal(hasPendingFile([{ op: 'insert', table: MATERIALS, id: 'm1', fields: { file_id: '00000000-0000-4000-8000-0000000000f1' } }]), false);
  assert.equal(hasPendingFile([{ op: 'delete', table: MATERIALS, id: 'm1', expectedRevision: 1 }]), false);
});

test('organizers · propuesta: cada cambio se describe sin jerga, con el nombre si lo hay', () => {
  assert.deepEqual(describeChange({ op: 'insert', table: OFFERS, id: 'n1', fields: { name: 'Paseo' } }), { action: 'add', what: 'offer', name: 'Paseo' });
  assert.deepEqual(describeChange({ op: 'update', table: MATERIALS, id: 'm1', expectedRevision: 1, fields: { published: true } }, new Map([['m1', { title: 'Guía' }]])),
    { action: 'change', what: 'material', name: 'Guía' });
  assert.deepEqual(describeChange({ op: 'delete', table: 'organizers.questions', id: 'q1', expectedRevision: 1 }), { action: 'remove', what: 'question', name: null });
  assert.deepEqual(describeChange({ op: 'update', table: 'organizers.experiences', id: 'e1', expectedRevision: 1, fields: { menu_visible: true } }), { action: 'change', what: 'experience', name: null });
});
