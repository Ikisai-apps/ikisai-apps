/** Invoices · propuesta de destino de «Por asignar» en Compras (tanda 27, `app/purchase-proposals.ts`). Capa pura. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchLabel, proposeTarget, type PastAllocation, type ProposalTarget } from '../../apps/invoices/src/app/purchase-proposals.ts';

const t = (label: string, app = 'tasks', kind = 'area', id: string | null = label): ProposalTarget => ({ app, kind, id, code: null, label, revision: 1 });
const past: PastAllocation[] = [
  { supplierId: 's1', lineKey: 'tomate pera', date: '2026-09-01', target: t('Cocina') },
  { supplierId: 's1', lineKey: 'lejía', date: '2026-10-01', target: t('Habitaciones') },
  { supplierId: 's2', lineKey: 'tomate pera', date: '2026-10-05', target: t('Otro') },
];

test('propuesta: la misma línea con ese proveedor; si no, lo último con ese proveedor; si no, ninguna', () => {
  assert.equal(proposeTarget('s1', '  Tomate   PERA ', past)?.label, 'Cocina');
  assert.equal(proposeTarget('s1', 'Aceite', past)?.label, 'Habitaciones');
  assert.equal(proposeTarget('s3', 'Tomate pera', past), null);
  assert.equal(batchLabel(2, t('Cocina'), '115,80 €'), 'Asignar los 2 a Cocina · 115,80 €');
  assert.equal(batchLabel(1, t('Cocina'), '10,00 €'), 'Asignar a Cocina · 10,00 €');
});
