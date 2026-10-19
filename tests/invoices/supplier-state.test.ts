/** Invoices · lo que se le debe a cada proveedor y su extracto (tanda 27, `app/supplier-state.ts`). Capa pura. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { movesOf, supplierDebt, upcomingOf, type SupplierInvoice } from '../../apps/invoices/src/app/supplier-state.ts';

const TODAY = '2026-10-19';
const money = (v: number) => `${v.toFixed(2).replace('.', ',')} €`;
let n = 0;
const inv = (f: Partial<SupplierInvoice> = {}): SupplierInvoice => ({ id: `i${++n}`, code: `FVR_${n}`, object: 'material', status: 'validada', invoice_date: '2026-09-01', due_date: null, payment_status: 'pendiente', payment_source: null, paid_at: null, calculated_total: 100, ...f });

test('«Le debes»: lo pagado sin confirmar cuenta como pagado, con «n por confirmar»; vencidas y por resolver; anuladas fuera', () => {
  const list = [
    inv({ calculated_total: 899.37, due_date: '2026-10-01' }),
    inv({ payment_status: 'pagada', payment_source: 'sin_confirmar', paid_at: '2026-09-01' }),
    inv({ status: 'pendiente_revision', calculated_total: 50 }),
    inv({ status: 'anulada', calculated_total: 1000 }),
  ];
  const d = supplierDebt(list, TODAY, money);
  assert.deepEqual([d.owed, d.overdue, d.unconfirmed, d.toResolve, d.yearTotal, d.tone], [949.37, 1, 1, 1, 1049.37, 'alert']);
  assert.equal(d.text, 'Le debes 949,37 € · 1 vencida · 1 por confirmar · 1 por resolver');
  assert.equal(supplierDebt([inv({ payment_status: 'pagada', payment_source: 'confirmado', paid_at: '2026-09-02' })], TODAY, money).text, 'Al día');
});

test('extracto: lo próximo por vencimiento y los movimientos del año con lo que queda tras cada uno', () => {
  const a = inv({ code: 'A', invoice_date: '2026-09-01', payment_status: 'pagada', payment_source: 'confirmado', paid_at: '2026-09-05', calculated_total: 100 });
  const b = inv({ code: 'B', invoice_date: '2026-09-10', due_date: '2026-10-10', calculated_total: 200 });
  const c = inv({ code: 'C', invoice_date: '2026-10-01', due_date: '2026-10-30', calculated_total: 50 });
  const d = inv({ code: 'D', invoice_date: '2025-12-01', payment_status: 'pagada', paid_at: null, calculated_total: 70 });
  assert.deepEqual(upcomingOf([a, b, c, d], TODAY).map((m) => [m.label, m.meta, m.chip?.text]), [['B · material', 'vencida hace 9 días', 'Vencida'], ['C · material', 'vence el 30 oct', 'Pendiente']]);
  assert.deepEqual(movesOf([a, b, c, d], '2026', money).map((m) => [m.kind, m.label, m.meta]), [
    ['doc', 'A · material', '1 sept · quedan 100,00 €'],
    ['in', 'Pago de A', '5 sept · quedan 0,00 €'],
    ['doc', 'B · material', '10 sept · quedan 200,00 €'],
    ['doc', 'C · material', '1 oct · quedan 250,00 €'],
  ]);
  // Un pago sin fecha sale como tal (en el año de la factura)
  assert.equal(movesOf([d], '2025', money).find((m) => m.kind === 'in')?.label, 'Pago sin fecha de D');
});
