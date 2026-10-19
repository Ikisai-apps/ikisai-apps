/** Invoices · recorrido de la entrega a la gestoría (tanda 27, `app/delivery-state.ts`). Capa pura. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryState } from '../../apps/invoices/src/app/delivery-state.ts';

test('recorrido de la entrega: validar, preparar, enviar, entregada, archivada; desfasada vuelve a preparar; lo que queda fuera se dice', () => {
  assert.deepEqual(deliveryState({ pending: 0, ready: 0, latest: null }), { stage: 'validar', bad: [], seal: 'Vacía', caption: 'Vacía: no hay facturas validadas en el periodo' });
  const almost = deliveryState({ pending: 2, ready: 12, latest: null });
  assert.deepEqual([almost.stage, almost.bad, almost.seal, almost.caption], ['validar', ['validar'], 'Casi lista', 'Casi lista: 12 facturas para la gestoría · 2 facturas por resolver se quedan fuera']);
  assert.deepEqual([deliveryState({ pending: 0, ready: 1, latest: null }).stage, deliveryState({ pending: 0, ready: 1, latest: null }).caption], ['preparar', 'Lista: 1 factura para la gestoría. Prepara la entrega.']);
  const generated = { status: 'generada' as const, stale: false, archived: false, delivered_to: null };
  assert.equal(deliveryState({ pending: 0, ready: 3, latest: generated }).stage, 'enviar');
  assert.equal(deliveryState({ pending: 1, ready: 3, latest: generated }).caption, 'Preparada: descárgala y envíala a la gestoría · 1 factura por resolver se queda fuera');
  const delivered = deliveryState({ pending: 0, ready: 3, latest: { ...generated, status: 'entregada', delivered_to: 'correo del 7 de abril' } });
  assert.deepEqual([delivered.stage, delivered.caption], ['entregada', 'Entregada: correo del 7 de abril']);
  assert.equal(deliveryState({ pending: 0, ready: 3, latest: { ...generated, status: 'entregada', archived: true } }).stage, 'archivada');
  const stale = deliveryState({ pending: 0, ready: 3, latest: { ...generated, status: 'entregada', stale: true } });
  assert.deepEqual([stale.stage, stale.bad, stale.seal], ['preparar', ['preparar'], 'Desfasada']);
});
