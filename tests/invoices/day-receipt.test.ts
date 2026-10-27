/**
 * «Justificante del día» (API.md §17.5, `app/day-receipt.ts`): sin numeración fiscal mientras la gestoría no decida,
 * con el hueco de la serie preparado; desglose por producto (cierre del día) o por pedido (liquidación). Capa pura.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY_RECEIPT_SERIES, dayReceipt, type ReceiptEntry } from '../../apps/invoices/src/app/day-receipt.ts';

const day = (f: Partial<ReceiptEntry> = {}): ReceiptEntry => ({
  source_app: 'flow', source_ref: 'flow:project:p1:2026-10-31', kind: 'income', entry_date: '2026-10-31', description: 'Barra · Evento de octubre · 31-10',
  amount_cents: 123450, net_cents: 112227, tax_cents: 11223, tax_rate: 10, pending_refunds_cents: 200, methods: { cash: 80000, bizum: 43450 },
  detail: [{ code: 'A', name: 'Montadito clásico A', quantity: 100, amount_cents: 70000 }, { name: 'Caña', quantity: 205, amount_cents: 53250 }], ...f,
});

test('sin serie: «Justificante de ventas», sin número y diciendo que no es factura', () => {
  assert.equal(DAY_RECEIPT_SERIES, null, 'hasta que la gestoría diga ticket o factura simplificada');
  const r = dayReceipt(day());
  assert.equal(r.title, 'Justificante de ventas');
  assert.equal(r.number, null);
  assert.match(r.notice, /no es una factura ni un ticket/);
  assert.deepEqual(r.methods, [{ label: 'Efectivo', cents: 80000 }, { label: 'Bizum', cents: 43450 }]);
  assert.deepEqual(r.lines.map((l) => l.label), ['A · Montadito clásico A', 'Caña']);
  assert.deepEqual([r.rate, r.netCents, r.taxCents, r.totalCents, r.pendingRefundsCents], [10, 112227, 11223, 123450, 200]);
});

test('con serie (el hueco para la factura simplificada): título y número', () => {
  const r = dayReceipt(day(), { series: { code: 'S' }, number: 'S2026-0001' });
  assert.equal(r.title, 'Factura simplificada S2026-0001');
  assert.equal(r.number, 'S2026-0001');
  assert.match(r.notice, /serie S/);
  // Una serie sin número todavía no numera
  assert.equal(dayReceipt(day(), { series: { code: 'S' }, number: null }).number, null);
});

test('liquidación de cuenta de cliente: desglose por pedido; un gasto no tiene justificante de ventas', () => {
  const r = dayReceipt(day({ source_ref: 'flow:settlement:9f1c', description: 'Cuenta del cliente 112 · liquidación', pending_refunds_cents: 0, amount_cents: 3600, net_cents: 3273, tax_cents: 327,
    methods: { bizum: 3600 }, detail: [{ code: 'P 14', name: 'Pedido 14', quantity: 1, amount_cents: 2100 }, { code: 'P 31', name: 'Pedido 31', quantity: 1, amount_cents: 1500 }] }));
  assert.deepEqual(r.lines.map((l) => [l.label, l.cents]), [['P 14 · Pedido 14', 2100], ['P 31 · Pedido 31', 1500]]);
  assert.throws(() => dayReceipt(day({ kind: 'expense' })), /Solo los ingresos/);
});
