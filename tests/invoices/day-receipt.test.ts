/**
 * «Justificante del día» (API.md §17.5, `app/day-receipt.ts`): un ticket, sin serie ni numeración de factura (VG, 27-10);
 * desglose por producto (cierre del día) o por pedido (liquidación). Capa pura.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dayReceipt, type ReceiptEntry } from '../../apps/invoices/src/app/day-receipt.ts';

const day = (f: Partial<ReceiptEntry> = {}): ReceiptEntry => ({
  source_app: 'flow', source_ref: 'flow:project:p1:2026-10-31', kind: 'income', entry_date: '2026-10-31', description: 'Barra · Evento de octubre · 31-10',
  amount_cents: 123450, net_cents: 112227, tax_cents: 11223, tax_rate: 10, pending_refunds_cents: 200, methods: { cash: 80000, bizum: 43450 },
  detail: [{ code: 'A', name: 'Montadito clásico A', quantity: 100, amount_cents: 70000 }, { name: 'Caña', quantity: 205, amount_cents: 53250 }], ...f,
});

test('es un ticket (VG, 27-10): sin serie ni número de factura, IVA incluido', () => {
  const r = dayReceipt(day());
  assert.equal(r.title, 'Ticket de ventas');
  assert.equal(r.number, null, 'sin número de cobro (cierre del día)');
  assert.equal(r.kind, 'ticket');
  assert.match(r.notice, /no es una factura/);
  assert.deepEqual(r.methods, [{ label: 'Metálico', cents: 80000 }, { label: 'Bizum', cents: 43450 }]);
  assert.deepEqual(r.lines.map((l) => l.label), ['A · Montadito clásico A', 'Caña']);
  assert.deepEqual([r.rate, r.netCents, r.taxCents, r.totalCents, r.pendingRefundsCents], [10, 112227, 11223, 123450, 200]);
});

test('un cobro de la caja (API.md §17.9): ticket con su número de cobro, o factura simplificada según receipt_kind', () => {
  const sale = day({ description: 'Cobro 57', receipt_number: '57', receipt_kind: 'ticket', methods: { bitcoin: 123450 } });
  const t = dayReceipt(sale);
  assert.deepEqual([t.title, t.number, t.kind], ['Ticket de venta', '57', 'ticket']);
  assert.match(t.notice, /Ticket nº 57: no es una factura/);
  assert.deepEqual(t.methods, [{ label: 'Bitcoin', cents: 123450 }]);
  const f = dayReceipt({ ...sale, receipt_kind: 'invoice' });
  assert.deepEqual([f.title, f.number, f.kind], ['Factura simplificada', '57', 'invoice']);
  assert.match(f.notice, /Factura simplificada nº 57/);
});

test('liquidación de cuenta de cliente: desglose por pedido; un gasto no tiene justificante de ventas', () => {
  const r = dayReceipt(day({ source_ref: 'flow:settlement:9f1c', description: 'Cuenta del cliente 112 · liquidación', pending_refunds_cents: 0, amount_cents: 3600, net_cents: 3273, tax_cents: 327,
    methods: { bizum: 3600 }, detail: [{ code: 'P 14', name: 'Pedido 14', quantity: 1, amount_cents: 2100 }, { code: 'P 31', name: 'Pedido 31', quantity: 1, amount_cents: 1500 }] }));
  assert.deepEqual(r.lines.map((l) => [l.label, l.cents]), [['P 14 · Pedido 14', 2100], ['P 31 · Pedido 31', 1500]]);
  assert.throws(() => dayReceipt(day({ kind: 'expense' })), /Solo los ingresos/);
  // 0245: el justificante es solo de lo fiscal
  assert.throws(() => dayReceipt(day({ nature: 'process' })), /proceso/);
  assert.equal(dayReceipt(day({ nature: 'fiscal' })).title, 'Ticket de ventas');
});
