/** Propuesta al asignar una línea: la solicitud de compra abierta del mismo proveedor, solo si hay una (ESTADO.md, nota de Core del 8-10). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { proposePurchaseRequest } from '../../apps/invoices/src/app/purchase-match.ts';

const req = (id: string, supplier: string | null, extra: Record<string, unknown> = {}) => ({ id, kind: 'purchase_request', label: `Compra ${id}`, archived: false, supplier, ...extra });

test('una sola solicitud de la misma tienda: se propone, sin mayúsculas, tildes ni forma societaria', () => {
  const items = [req('a', 'Hielos del Sur S.L.'), req('b', 'Ferretería Centro'), req('c', null)];
  assert.equal(proposePurchaseRequest(items, ['HIELOS DEL SUR, SL'])?.id, 'a');
  assert.equal(proposePurchaseRequest(items, [null, 'ferreteria centro'])?.id, 'b', 'también por el rótulo');
});

test('ninguna o varias de la misma tienda, archivadas o sin tienda: no se propone nada', () => {
  assert.equal(proposePurchaseRequest([req('a', 'Hielos del Sur'), req('b', 'Hielos del Sur')], ['Hielos del Sur']), null, 'dos: que elija la persona');
  assert.equal(proposePurchaseRequest([req('a', 'Hielos del Sur', { archived: true })], ['Hielos del Sur']), null);
  assert.equal(proposePurchaseRequest([req('a', null)], ['Hielos del Sur']), null, 'Tasks aún no da la tienda');
  assert.equal(proposePurchaseRequest([req('a', 'Hielos del Sur')], [null, '']), null);
});
