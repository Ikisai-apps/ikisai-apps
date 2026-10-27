/** Fase 6 (pagos en línea, petición F5): qué enlaces de pago de Finance enseña Organizers. Puro, sin red. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clearPending, markPending, payableInvoices, payLinkOf, payOnDemand, payState, pendingOf, PENDING_MS, returnOf } from '../../apps/organizers/src/app/pay-link.ts';
import type { PortalInvoice } from '../../apps/organizers/src/app/api.ts';

const NOW = Date.parse('2026-11-02T10:00:00Z');
const invoice = (over: Partial<PortalInvoice> = {}): PortalInvoice => ({
  id: crypto.randomUUID(), number: 'F2026-0100', issue_date: '2026-11-01', type: 'F1', rectifies: null, base: 300, tax: 0, withholding: 0, total: 300,
  status: 'emitida', collected: false, collected_at: null, has_document: true, purpose: 'senal',
  payment_link: { url: 'https://buy.stripe.com/test_abc123', provider: 'stripe', expires_at: '2026-11-10T00:00:00Z' }, ...over,
});

test('pagar en línea · se enseña el enlace de la pasarela de una factura sin cobrar y vigente', () => {
  assert.equal(payLinkOf(invoice(), NOW), 'https://buy.stripe.com/test_abc123');
  assert.equal(payLinkOf(invoice({ payment_link: { url: 'https://sis.redsys.es/sis/realizarPago?x=1' } }), NOW), 'https://sis.redsys.es/sis/realizarPago?x=1');
});

test('pagar en línea · nunca: cobrada, rectificada, sin enlace, caducado, http, otro dominio o con credenciales', () => {
  for (const [why, over] of [
    ['cobrada', { collected: true }], ['rectificada', { status: 'rectificada' as const }], ['sin enlace', { payment_link: null }],
    ['caducado', { payment_link: { url: 'https://buy.stripe.com/x', expires_at: '2026-11-01T00:00:00Z' } }],
    ['http', { payment_link: { url: 'http://buy.stripe.com/x' } }],
    ['otro dominio', { payment_link: { url: 'https://buy.stripe.com.example.invalid/x' } }],
    ['suplantado', { payment_link: { url: 'https://evil.example.invalid/?https://buy.stripe.com' } }],
    ['credenciales', { payment_link: { url: 'https://a:b@buy.stripe.com/x' } }],
    ['no es URL', { payment_link: { url: 'pagar aquí' } }],
  ] as const) {
    assert.equal(payLinkOf(invoice(over as Partial<PortalInvoice>), NOW), null, why);
  }
});

test('pagar en línea · la lista solo lleva las que se pueden pagar, en su orden', () => {
  const a = invoice({ number: 'A' }); const b = invoice({ number: 'B', collected: true }); const c = invoice({ number: 'C' });
  assert.deepEqual(payableInvoices([a, b, c], NOW).map((p) => p.invoice.number), ['A', 'C']);
});

test('pago en curso · estados: pagar, en curso 72 h, caducado y cobrada', () => {
  assert.equal(payState({ collected: false }, null, NOW), 'pagar');
  assert.equal(payState({ collected: false }, NOW - 60_000, NOW), 'en_curso');
  assert.equal(payState({ collected: false }, NOW - PENDING_MS + 1, NOW), 'en_curso');
  assert.equal(payState({ collected: false }, NOW - PENDING_MS, NOW), 'caducado');
  assert.equal(payState({ collected: true }, NOW - 60_000, NOW), 'cobrada');
});

test('pago en curso · la marca del dispositivo, y sin almacenamiento no se rompe', () => {
  const data = new Map<string, string>();
  const s = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
  const id = crypto.randomUUID();
  assert.equal(pendingOf(id, s), null);
  markPending(id, NOW, s);
  assert.equal(pendingOf(id, s), NOW);
  clearPending(id, s);
  assert.equal(pendingOf(id, s), null);
  const broken = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); }, removeItem: () => { throw new Error('no'); } };
  markPending(id, NOW, broken); clearPending(id, broken);
  assert.equal(pendingOf(id, broken), null);
  assert.equal(pendingOf(id, null), null);
});

test('pago en curso · la vuelta de la pasarela se lee del final de la ruta', () => {
  const id = crypto.randomUUID();
  assert.deepEqual(returnOf(`#/retiro/${crypto.randomUUID()}/pagos?pago=ok&factura=${id.toUpperCase()}`), { outcome: 'ok', invoiceId: id });
  assert.deepEqual(returnOf('#/retiro/x/pagos?pago=cancelado'), { outcome: 'cancelado', invoiceId: null });
  assert.equal(returnOf('#/retiro/x/pagos'), null);
  assert.equal(returnOf('#/retiro/x/pagos?pago=pagado'), null);
  assert.deepEqual(returnOf('#/retiro/x/pagos?pago=ok&factura=<script>'), { outcome: 'ok', invoiceId: null });
});


test('pagar en línea · sin enlace se pide al pulsar: solo la emitida sin cobrar, con importe y sin enlace vigente', () => {
  assert.equal(payOnDemand(invoice({ payment_link: null }), NOW), true);
  assert.equal(payOnDemand(invoice({ payment_link: { url: 'https://checkout.stripe.com/x', expires_at: '2026-11-01T00:00:00Z' } }), NOW), true, 'caducado: se pide otro');
  assert.equal(payOnDemand(invoice(), NOW), false, 'con enlace vigente, se usa ese');
  for (const [why, over] of [['cobrada', { collected: true }], ['rectificada', { status: 'rectificada' as const }],
    ['registrada (otra herramienta)', { status: 'registrada' as const }], ['a cero', { total: 0 }]] as const) {
    assert.equal(payOnDemand(invoice({ payment_link: null, ...over } as Partial<PortalInvoice>), NOW), false, why);
  }
});
