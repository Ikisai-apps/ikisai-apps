/**
 * Incidencia del usuario en Finance (9-10-2026): validar una factura (`call` invoices.validate) chocó con su propio
 * cambio de categoría. En la tarjeta de conflicto, «Reintentar con lo mío» quitaba el conflicto sin reenviar nada,
 * porque `resolveConflict('mine')` solo sabía rehacer update/delete/restore.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { conflictRetryOperations, type ConflictRecord } from '../../packages/sync-client/src/client.ts';

const current = { id: 'f1', revision: 6, created_at: '', updated_at: '', updated_by: null, deleted_at: null, status: 'pendiente_revision' };
const other = { op: 'update' as const, table: 'invoices.suppliers' as const, id: 's1', expectedRevision: 2, fields: { default_category: 'otros' } };

function callConflict(args: Record<string, unknown>): ConflictRecord {
  return {
    requestId: 'r1', code: 'VERSION_CONFLICT', base: null, current, overlapping: [], detectedAt: '',
    operation: { op: 'call', procedure: 'invoices.validate', args } as unknown as ConflictRecord['operation'],
    otherOperations: [other],
  };
}

test("call con 'mine': se reenvía con la revisión actual del servidor", () => {
  const ops = conflictRetryOperations(callConflict({ id: 'f1', expectedRevision: 5, learn: true }), { choice: 'mine' });
  assert.deepEqual(ops, [other, { op: 'call', procedure: 'invoices.validate', args: { id: 'f1', expectedRevision: 6, learn: true } }]);
});

test("call sin expectedRevision con 'mine': se reenvía tal cual", () => {
  const ops = conflictRetryOperations(callConflict({ id: 'f1' }), { choice: 'mine' });
  assert.deepEqual(ops[1], { op: 'call', procedure: 'invoices.validate', args: { id: 'f1' } });
});

test("call con 'theirs' o 'merge': solo las otras operaciones del lote", () => {
  assert.deepEqual(conflictRetryOperations(callConflict({ expectedRevision: 5 }), { choice: 'theirs' }), [other]);
  assert.deepEqual(conflictRetryOperations(callConflict({ expectedRevision: 5 }), { choice: 'merge', fields: { x: 1 } }), [other]);
});

test("update con 'mine': igual que antes (mis campos sobre la revisión actual)", () => {
  const record: ConflictRecord = {
    requestId: 'r2', code: 'VERSION_CONFLICT', base: null, current, overlapping: ['status'], detectedAt: '', otherOperations: [],
    operation: { op: 'update', table: 'invoices.invoices', id: 'f1', expectedRevision: 5, fields: { notes: 'mía' } } as ConflictRecord['operation'],
  };
  assert.deepEqual(conflictRetryOperations(record, { choice: 'mine' }), [{ op: 'update', table: 'invoices.invoices', id: 'f1', expectedRevision: 6, fields: { notes: 'mía' } }]);
});
