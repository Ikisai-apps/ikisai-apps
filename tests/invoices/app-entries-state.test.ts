/**
 * Ingresos y gastos de apps (0244, `app/app-entries-state.ts`): el resultado de un evento sin IVA (apuntes de apps +
 * emitidas asignadas − recibidas validadas asignadas − gastos de apps), las cifras de la lista y si un apunte ya está
 * entregado. Capa pura.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { appEntriesSummary, appName, entriesTotals, entryDelivered, eventResults, type EntryLike, type EventSources } from '../../apps/invoices/src/app/app-entries-state.ts';

const EVENT = 'ev-oct';
let n = 0;
const entry = (f: Partial<EntryLike> = {}): EntryLike => ({
  id: `ae${++n}`, source_app: 'flow', source_ref: `flow:project:p:2026-10-${30 + (n % 2)}`, kind: 'income', entry_date: '2026-10-31', description: 'Barra · 31-10',
  amount_cents: 110000, net_cents: 100000, tax_cents: 10000, tax_rate: 10, event_id: EVENT, deleted_at: null, ...f,
});
const sources = (f: Partial<EventSources> = {}): EventSources => ({
  entries: [], lines: [{ id: 'l1', invoice_id: 'i1', deleted_at: null }, { id: 'l2', invoice_id: 'i1', deleted_at: null }, { id: 'l3', invoice_id: 'i2', deleted_at: null }],
  invoices: [
    { id: 'i1', code: 'FVR_2026_070', status: 'validada', object: 'pan', invoice_date: '2026-10-29', supplier_id: 's', deleted_at: null },
    { id: 'i2', code: 'FVR_2026_071', status: 'pendiente_revision', object: 'hielo', invoice_date: '2026-10-30', supplier_id: 's', deleted_at: null },
  ],
  allocations: [
    { id: 'a1', invoice_line_id: 'l1', target_app: 'booking', target_kind: 'event', target_id: EVENT, target_label: 'Retiro de octubre · 2026-10-30', allocated_amount: 150.5, deleted_at: null },
    { id: 'a2', invoice_line_id: 'l2', target_app: 'booking', target_kind: 'event', target_id: EVENT, target_label: 'Retiro de octubre · 2026-10-30', allocated_amount: 49.5, deleted_at: null },
    { id: 'a3', invoice_line_id: 'l3', target_app: 'booking', target_kind: 'event', target_id: EVENT, target_label: 'Retiro de octubre · 2026-10-30', allocated_amount: 80, deleted_at: null },
    { id: 'a4', invoice_line_id: 'l1', target_app: 'tasks', target_kind: 'project', target_id: EVENT, target_label: 'Otro', allocated_amount: 999, deleted_at: null },
  ],
  issuedAllocations: [{ id: 'b1', issued_invoice_id: 'e1', target_app: 'booking', target_kind: 'event', target_id: EVENT, target_label: 'Retiro de octubre · 2026-10-30', allocated_amount: 300, deleted_at: null }],
  issued: [{ id: 'e1', full_number: 'F_12_26', status: 'emitida', description: 'Alojamiento del retiro', issue_date: '2026-10-28', deleted_at: null }],
  ...f,
});

test('resultado del evento sin IVA: ingresos de apps y emitidas menos recibidas validadas y gastos de apps', () => {
  const [r] = eventResults(sources({ entries: [entry(), entry({ net_cents: 5000, amount_cents: 5500, tax_cents: 500 }), entry({ kind: 'expense', net_cents: 2000, amount_cents: 2200, tax_cents: 200, description: 'Hielo de la barra' })] }));
  assert.equal(r!.eventId, EVENT);
  assert.equal(r!.label, 'Retiro de octubre · 2026-10-30');
  assert.equal(r!.appIncomeCents, 105000);
  assert.equal(r!.issuedIncomeCents, 30000);
  // Las dos líneas de la misma factura se suman en un movimiento; la pendiente de revisar no cuenta y se dice
  assert.equal(r!.invoiceExpenseCents, 20000);
  assert.equal(r!.pendingInvoices, 1);
  assert.equal(r!.appExpenseCents, 2000);
  assert.equal(r!.resultCents, 105000 + 30000 - 20000 - 2000);
  assert.deepEqual(r!.moves.map((m) => [m.kind, m.sign, m.cents]), [['issued', 1, 30000], ['invoice', -1, 20000], ['app', 1, 100000], ['app', 1, 5000], ['app', -1, 2000]]);
});

test('sin evento, borrados, anuladas y emitidas en borrador quedan fuera; solo apuntes de apps también da evento', () => {
  const out = eventResults(sources({
    entries: [entry({ event_id: null }), entry({ deleted_at: '2026-10-31T10:00:00Z' }), entry({ event_id: 'otro' })],
    invoices: [{ id: 'i1', code: 'X', status: 'anulada', object: null, invoice_date: null, supplier_id: 's', deleted_at: null }, { id: 'i2', code: 'Y', status: 'validada', object: null, invoice_date: null, supplier_id: 's', deleted_at: '2026-10-01' }],
    issued: [{ id: 'e1', full_number: null, status: 'borrador', description: null, issue_date: null, deleted_at: null }],
  }));
  assert.deepEqual(out.map((r) => [r.eventId, r.label, r.resultCents]), [['otro', null, 100000]]);
});

test('cifras de la lista y apunte entregado', () => {
  const totals = entriesTotals([entry(), entry({ event_id: null }), entry({ kind: 'expense', amount_cents: 2200 }), entry({ deleted_at: 'x' })]);
  assert.deepEqual(totals, { count: 3, incomeCents: 220000, expenseCents: 2200, withoutEvent: 1 });
  const exports = [{ status: 'generada', deleted_at: null, manifest: { app_entries: [{ id: 'a' }] } }, { status: 'entregada', deleted_at: null, manifest: { app_entries: [{ id: 'b' }] } }, { status: 'entregada', deleted_at: null, manifest: {} }];
  assert.equal(entryDelivered('a', exports), false);
  assert.equal(entryDelivered('b', exports), true);
  assert.equal(appName('flow'), 'Flow');
  assert.equal(appName('nueva'), 'Nueva');
});

test('resumen del periodo: la misma cuenta que invoices.app_entries_summary_for', () => {
  const s = appEntriesSummary([
    entry({ entry_date: '2026-10-31', amount_cents: 123250, net_cents: 112045, tax_cents: 11205 }),
    entry({ entry_date: '2026-10-30', amount_cents: 0, net_cents: 0, tax_cents: 0 }),
    entry({ entry_date: '2026-10-29', kind: 'expense', amount_cents: 5500, net_cents: 5000, tax_cents: 500 }),
    entry({ entry_date: '2026-09-30', amount_cents: 999, net_cents: 908, tax_cents: 91 }),
  ], { from: '2026-10-01', to: '2026-12-31' });
  assert.deepEqual(s.income, { count: 2, base: 1120.45, quota: 112.05, total: 1232.5, quota_by_rate: [{ rate: 10, base: 1120.45, quota: 112.05 }] });
  assert.deepEqual(s.expense, { count: 1, base: 50, quota: 5, total: 55 });
});
