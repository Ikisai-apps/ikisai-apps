/** «Arqueo del día» (`app/cash-count.ts`): lo cobrado por medio, barra + alojamiento de recepción, devoluciones aparte. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dayCashCount, type CashEntry } from '../../apps/invoices/src/app/cash-count.ts';

const DAY = '2026-10-31';
let n = 0;
const entry = (f: Partial<CashEntry> = {}): CashEntry => ({
  id: `c${++n}`, source_app: 'flow', source_ref: `flow:receipt:r${n}`, kind: 'income', entry_date: DAY, amount_cents: 1000,
  pending_refunds_cents: 0, methods: { cash: 1000 }, deleted_at: null, ...f,
});

test('barra y alojamiento de recepción por medio, con la devolución aparte y el efectivo que tiene que haber', () => {
  const c = dayCashCount([
    entry({ amount_cents: 2500, methods: { cash: 1500, bizum: 1000 } }), // un cobro de la caja
    entry({ source_ref: 'flow:project:p1:2026-10-31', amount_cents: 12000, methods: { cash: 8000, card: 2000, bitcoin: 2000 }, pending_refunds_cents: 300 }), // cierre del día
    entry({ source_app: 'booking', source_ref: 'booking:stay:s1', amount_cents: 3500, methods: { cash: 7000, bizum: -3500 } }), // 2 noches, devuelta 1 por Bizum
    entry({ source_app: 'booking', source_ref: 'booking:stay:s2', entry_date: '2026-10-30', amount_cents: 9999 }), // otro día: fuera
    entry({ kind: 'expense', amount_cents: 500, methods: { cash: 500 } }), // un gasto: no es cobro
    entry({ deleted_at: '2026-10-31T10:00:00Z' }),
  ], DAY);
  assert.deepEqual(c.methods.map((m) => [m.label, m.collectedCents, m.refundedCents, m.netCents]), [
    ['Metálico', 16500, 0, 16500], ['Bizum', 1000, 3500, -2500], ['Tarjeta', 2000, 0, 2000], ['Bitcoin', 2000, 0, 2000],
  ]);
  assert.deepEqual([c.collectedCents, c.refundedCents, c.netCents, c.cashCents], [21500, 3500, 18000, 16500]);
  assert.equal(c.netCents, 2500 + 12000 + 3500, 'el total a cuadrar es la suma de los apuntes');
  assert.deepEqual(c.sources.map((s) => [s.key, s.count, s.netCents]), [['bar', 2, 14500], ['stay', 1, 3500]]);
  assert.deepEqual([c.pendingRefundsCents, c.entries], [300, 3]);
});

test('un cobro sin medios va a «Sin medio» y un día sin cobros sale vacío', () => {
  const c = dayCashCount([entry({ methods: {}, amount_cents: 700 })], DAY);
  assert.deepEqual(c.methods.map((m) => [m.label, m.netCents]), [['Sin medio', 700]]);
  assert.equal(c.cashCents, 0);
  const empty = dayCashCount([], DAY);
  assert.deepEqual([empty.methods.length, empty.netCents, empty.entries], [0, 0, 0]);
});

test('fl-27: una cuenta pendiente no es dinero; cobrada, cuenta el día en que llegó el cobro; el resumen del cierre sale aparte', () => {
  const pending = entry({ source_ref: 'flow:account:a1', amount_cents: 2100, methods: { a_cobrar: 2100 }, description: 'Cuenta de Ana · pendiente de cobro', received_at: '2026-10-31T22:00:00Z' });
  const closing = entry({ source_ref: 'flow:closing:p1:2026-10-31', amount_cents: 0, methods: {}, detail: [
    { code: 'a_cuenta', name: 'Vendido a cuenta', quantity: 2, amount_cents: 0, info_cents: 2100 },
    { code: 'cuentas_abiertas', name: 'Cuentas abiertas', quantity: 1, amount_cents: 0 },
    { code: 'equipo', name: 'Pedido del equipo · Luis', quantity: 1, amount_cents: 0, info_cents: 450 },
    { code: 'equipo', name: 'Pedido del equipo · Eva', quantity: 1, amount_cents: 0, info_cents: 300 }] });
  const c = dayCashCount([entry({ amount_cents: 1000, methods: { cash: 1000 } }), pending, closing], DAY);
  assert.deepEqual([c.cashCents, c.netCents, c.entries], [1000, 1000, 1], 'ni la cuenta pendiente ni el resumen suman dinero');
  assert.deepEqual(c.receivables.map((r) => [r.label, r.cents]), [['Cuenta de Ana', 2100]]);
  assert.deepEqual([c.onAccountCents, c.openAccounts, c.teamOrders, c.teamOrdersCents], [2100, 1, 2, 750]);
  // Se cobra el 3-11 en metálico: el reenvío del mismo apunte (misma fecha de venta) cuenta ese día, no el 31
  const paid = { ...pending, methods: { cash: 2100 }, received_at: '2026-11-03T09:30:00Z' };
  assert.equal(dayCashCount([paid], DAY).cashCents, 0);
  assert.deepEqual(dayCashCount([paid], DAY).receivables, []);
  assert.equal(dayCashCount([paid], '2026-11-03').cashCents, 2100);
  // Cobro a medias: lo cobrado ese día; el resto sigue pendiente en el día de la venta
  const half = { ...pending, methods: { cash: 1000, a_cobrar: 1100 }, received_at: '2026-11-03T09:30:00Z' };
  assert.equal(dayCashCount([half], '2026-11-03').cashCents, 1000);
  assert.deepEqual(dayCashCount([half], DAY).receivables.map((r) => r.cents), [1100]);
});
