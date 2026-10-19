/**
 * Organizers · el extracto de Pagos (pasada única, zona 2): lo que queda por pagar, lo próximo (señal y saldo) y los
 * movimientos (facturas y pagos recibidos). El saldo nunca lleva fecha y una rectificativa nunca es un pago.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Contract, PortalInvoice, PortalMoney } from '../../apps/organizers/src/app/api.ts';
import { statementOf } from '../../apps/organizers/src/app/pay-state.ts';

const format = {
  t: (s: string, vars?: Record<string, string | number>) => s.replace(/\{([a-z_]+)\}/gi, (m, k: string) => (vars && k in vars ? String(vars[k]) : m)),
  money: (n: number) => `${n} €`,
  day: (d: string) => d,
};
const contract: Contract = { proposal_version: 1, total: 2800, deposit_required: 840, prices_include_vat: true, vat_amount: 254.55, payment_type: 'transferencia',
  due: [{ kind: 'senal', date: '2026-11-01', amount: 840 }, { kind: 'saldo', date: '2027-03-01', amount: 1960 }] };
const invoice = (over: Partial<PortalInvoice> & Pick<PortalInvoice, 'id' | 'number' | 'total'>): PortalInvoice => ({
  issue_date: '2026-10-10', type: 'F2', rectifies: null, base: over.total, tax: 0, withholding: 0, status: 'registrada', collected: false, collected_at: null, has_document: false, purpose: null, ...over,
});
const money = (invoices: PortalInvoice[], collected: number, pending: number): PortalMoney => ({
  reservation_id: 'r', currency: 'EUR', invoices, totals: { invoiced: invoices.reduce((s, i) => s + Number(i.total), 0), collected, pending },
});

test('organizers · extracto: señal pagada en parte, «Pagado 300 de 840»; el saldo sin fecha', () => {
  const s = statementOf(contract, money([invoice({ id: 'a', number: '0101', total: 300, collected: true, collected_at: '2026-10-12', purpose: 'senal' }), invoice({ id: 'b', number: '0102', total: 700 })], 300, 700), format);
  assert.equal(s.total, 2500);
  assert.equal(s.contracted, 2800);
  const [senal, saldo] = s.upcoming;
  assert.equal(senal!.id, 'senal');
  assert.equal(senal!.amount, 540);
  assert.equal(senal!.meta, 'antes del 2026-11-01 · Pagado 300 € de 840 €');
  assert.equal(senal!.chip?.text, 'Pendiente');
  assert.equal(saldo!.id, 'saldo');
  assert.equal(saldo!.amount, 1960);
  assert.equal(saldo!.date, null);
  assert.equal(saldo!.meta, 'cuando te llegue la factura');
  assert.ok(!saldo!.meta.includes('antes del'), 'el plazo del saldo es interno de Ikisai');
  // Movimientos: dos facturas y un pago recibido (el de la cobrada), del más reciente al más antiguo.
  assert.deepEqual(s.moves.map((m) => [m.kind, m.label]), [['in', 'Pago recibido · Señal'], ['doc', 'Factura 0101'], ['doc', 'Factura 0102']]);
  assert.equal(s.moves[0]!.meta, '2026-10-12 · te quedan 2500 €');
});

test('organizers · extracto: una factura de saldo sin cobrar se cita; una rectificativa sale como factura, nunca como pago', () => {
  const s = statementOf(contract, money([
    invoice({ id: 'a', number: '0101', total: 840, collected: true, collected_at: '2026-10-12', purpose: 'senal' }),
    invoice({ id: 'b', number: '0102', total: 1960, issue_date: '2027-02-01', purpose: 'saldo' }),
    invoice({ id: 'r', number: 'R-0001', type: 'R1', total: -100, rectifies: ['0101'], collected: true, collected_at: '2026-10-20' }),
  ], 840, 1960), format);
  assert.deepEqual(s.upcoming.map((u) => u.id), ['saldo'], 'la señal está cubierta');
  assert.equal(s.upcoming[0]!.meta, 'factura enviada el 2027-02-01');
  const rect = s.moves.filter((m) => m.label.includes('R-0001'));
  assert.deepEqual(rect.map((m) => [m.kind, m.label]), [['doc', 'Rectificativa R-0001']]);
  assert.ok(rect[0]!.meta.includes('rectifica 0101'));
  assert.equal(s.moves.filter((m) => m.kind === 'in').length, 1);
});

test('organizers · extracto: sin `collected_at` no hay pago recibido (las cifras siguen bien)', () => {
  const s = statementOf(contract, money([invoice({ id: 'a', number: '0101', total: 300, collected: true })], 300, 0), format);
  assert.equal(s.total, 2500);
  assert.deepEqual(s.moves.map((m) => m.kind), ['doc']);
});

test('organizers · extracto: sin contrato, el total es lo facturado sin pagar y no hay «próximamente»', () => {
  const s = statementOf(null, money([invoice({ id: 'a', number: 'F1', total: 1100, collected: false })], 0, 1100), format);
  assert.equal(s.hasContract, false);
  assert.equal(s.total, 1100);
  assert.deepEqual(s.upcoming, []);
  assert.equal(s.moves.length, 1);
  const paid = statementOf(null, money([invoice({ id: 'a', number: 'F1', total: 1100, collected: true, collected_at: '2026-10-11' })], 1100, 0), format);
  assert.equal(paid.moves.find((m) => m.kind === 'in')!.meta, '2026-10-11', 'sin contrato no se dice cuánto queda');
});
