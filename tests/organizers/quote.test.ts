/**
 * Organizers · calculadora del precio con Ikisai (fase 2, API.md §13.2): el mismo dominio que Booking (`suggestLines`,
 * `proposalTotals`, `applyMinimum`), IVA incluido sin sumarlo dos veces, mínimo comercial, señal y extras; y la
 * calculadora privada de margen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { averagePrice, breakEvenAttendees, breakEvenPrice, marginOf, marginPct, offersMargin, priceForMargin, quote, type QuoteInput } from '../../apps/organizers/src/app/quote.ts';
import type { PortalRate } from '../../apps/organizers/src/app/api.ts';

const rate = (fields: Partial<PortalRate> & Pick<PortalRate, 'id' | 'name' | 'layer' | 'unit' | 'amount'>): PortalRate => ({
  description: null, service: null, min_persons: null, max_persons: null, event_types: null, valid_from: null, valid_to: null, active: true, ...fields,
});
const RATES: PortalRate[] = [
  rate({ id: 'r1', name: 'Estancia con pensión completa', layer: 'por_persona', unit: 'persona_noche', amount: 60, service: 'alojamiento', event_types: ['retiro'] }),
  rate({ id: 'r2', name: 'Sala grande', layer: 'recinto', unit: 'dia', amount: 200 }),
  rate({ id: 'x1', name: 'Equipo de sonido', layer: 'extra', unit: 'estancia', amount: 150 }),
];
const CONDITIONS = { prices_include_vat: true, vat_rate: 10, deposit_percent: 30, deposit_minimum: 300, minimum_total: 2500 };
const base = (over: Partial<QuoteInput> = {}): QuoteInput => ({
  reservation: { event_type: 'retiro', start_date: '2027-03-12', end_date: '2027-03-14', expected_guests: 20, uses_accommodation: true, requires_meals: true },
  persons: 20, rates: RATES, conditions: CONDITIONS, extras: [], ...over,
});

test('organizers · calculadora: noches, comidas incluidas, IVA incluido y señal', () => {
  const q = quote(base());
  assert.equal(q.available, true);
  if (!q.available) return;
  assert.equal(q.nights, 2);
  assert.equal(q.mealsIncluded, 4, 'viernes a domingo: dos noches y cuatro comidas por persona');
  // 20 personas × 2 noches × 60 € + 2 días de sala × 200 € (regla de VG: tantos días como noches)
  assert.equal(q.total, 2400 + 400);
  assert.equal(q.payable, 2800);
  assert.equal(q.minimumApplied, false);
  assert.equal(q.vatAmount, 254.55, 'IVA incluido: no se suma encima');
  assert.equal(q.deposit, 840, '30 % de 2800');
});

test('organizers · calculadora: el mínimo por retiro se aplica y la señal sale de lo que se paga', () => {
  const q = quote(base({ persons: 5, reservation: { ...base().reservation, expected_guests: 5 } }));
  assert.equal(q.available, true);
  if (!q.available) return;
  assert.equal(q.total, 600 + 400);
  assert.equal(q.minimumApplied, true);
  assert.equal(q.payable, 2500);
  assert.equal(q.deposit, 750);
});

test('organizers · calculadora: los extras pedidos se suman con su cantidad; sin tarifas, sin fechas o sin personas no calcula', () => {
  const q = quote(base({ extras: [{ rate_id: 'x1', quantity: 2 }] }));
  assert.equal(q.available && q.total, 2800 + 300);
  assert.deepEqual(quote(base({ rates: [] })), { available: false, reason: 'no_rates' });
  assert.deepEqual(quote(base({ reservation: { ...base().reservation, start_date: null, end_date: null } })), { available: false, reason: 'no_dates' });
  assert.deepEqual(quote(base({ persons: 0 })), { available: false, reason: 'no_persons' });
});

test('organizers · calculadora privada: ingresos, gastos, margen y punto de equilibrio', () => {
  assert.deepEqual(marginOf({ price: 300, attendees: 20, ikisai: 3000, otherCosts: 500 }), { revenue: 6000, cost: 3500, margin: 2500, breakEven: 12 });
  assert.deepEqual(marginOf({ price: 0, attendees: 20, ikisai: 3000, otherCosts: 0 }), { revenue: 0, cost: 3000, margin: -3000, breakEven: null });
});

test('organizers · saldo: contratado (Booking) menos cobrado (Finance); cada vencimiento, pagado si lo cobrado lo cubre', async () => {
  const { balanceOf } = await import('../../apps/organizers/src/app/quote.ts');
  const contract = { proposal_version: 2, total: 2800, deposit_required: 840, prices_include_vat: true, vat_amount: 254.55, payment_type: 'transferencia',
    due: [{ kind: 'senal' as const, date: '2026-10-13', amount: 840 }, { kind: 'saldo' as const, date: '2027-03-12', amount: 1960 }] };
  const none = balanceOf(contract, 0);
  assert.deepEqual([none.balance, none.due.map((d) => d.paid)], [2800, [false, false]]);
  const deposit = balanceOf(contract, 840);
  assert.deepEqual([deposit.balance, deposit.due.map((d) => d.paid)], [1960, [true, false]]);
  const all = balanceOf(contract, 2800);
  assert.deepEqual([all.balance, all.due.map((d) => d.paid)], [0, [true, true]]);
  assert.equal(balanceOf(contract, 3000).balance, 0, 'si se cobra de más, el saldo no es negativo');
});

test('organizers · ofertas: ingresos por oferta, asistentes previstos, margen y punto de equilibrio', () => {
  const r = offersMargin([{ price: 450, expected: 10 }, { price: '600', expected: '4' }, { price: 300, expected: null }], 4000, 500);
  assert.equal(r.revenue, 6900);
  assert.equal(r.attendees, 14);
  assert.equal(r.cost, 4500);
  assert.equal(r.margin, 2400);
  assert.equal(r.breakEven, 10, 'precio medio 492,86 €: 10 asistentes cubren 4500 €');
  assert.equal(offersMargin([], 1000, 0).breakEven, null);
});

test('organizers · «¿Cuánto ganas?»: precio para cubrir costes, precio para ganar un % y % ganado (adenda)', () => {
  // 7810 € entre 24 asistentes: 325,42 € → 326 € (al euro hacia arriba).
  assert.equal(breakEvenPrice({ ikisai: 7810, otherCosts: 0, attendees: 24 }), 326);
  // 20 % sobre los costes: 7810 × 1,2 / 24 = 390,5 → 391 €.
  assert.equal(priceForMargin({ ikisai: 7810, otherCosts: 0, attendees: 24, pct: 20 }), 391);
  assert.equal(breakEvenPrice({ ikisai: 7810, otherCosts: 0, attendees: 0 }), null);
  assert.equal(priceForMargin({ ikisai: 7810, otherCosts: 0, attendees: 0, pct: 20 }), null);
  assert.equal(marginPct(marginOf({ price: 391, attendees: 24, ikisai: 7810, otherCosts: 0 })), 20);
  assert.equal(marginPct(marginOf({ price: 100, attendees: 0, ikisai: 0, otherCosts: 0 })), null, 'sin costes no hay %');
  // `round2` antes de `ceil`: 148 exactos no salen como 149.
  assert.equal(breakEvenPrice({ ikisai: 2950, otherCosts: 0, attendees: 20 }), 148);
  assert.equal(breakEvenPrice({ ikisai: 1480, otherCosts: 0, attendees: 10 }), 148);
});

test('organizers · «¿Cuánto ganas?»: punto de equilibrio con lo de Ikisai variando con las plazas', () => {
  // Mínimo por retiro de 2500 €; 120 € por plaza (2 noches × 60 €) y 400 € de sala.
  const ikisaiFor = (n: number) => { const q = quote(base({ persons: n, reservation: { ...base().reservation, expected_guests: n } })); return q.available ? q.payable : 0; };
  // Con 9 asistentes a 300 € (2700 €) se cubre el mínimo de 2500 €; con 8 (2400 €), no.
  assert.equal(breakEvenAttendees({ price: 300, collaborators: 0, otherCosts: 0, ikisaiFor }), 9);
  // Con 4 colaboradores aún se paga el mínimo (13 plazas): sigue en 9. Con 12 (21 plazas, 2920 €), sube a 11.
  assert.equal(breakEvenAttendees({ price: 300, collaborators: 4, otherCosts: 0, ikisaiFor }), 9);
  assert.equal(breakEvenAttendees({ price: 300, collaborators: 12, otherCosts: 0, ikisaiFor }), 11);
  // A 100 € por asistente nunca se cubren los 120 € por plaza.
  assert.equal(breakEvenAttendees({ price: 100, collaborators: 0, otherCosts: 0, ikisaiFor }), null);
  assert.equal(breakEvenAttendees({ price: 0, collaborators: 0, otherCosts: 0, ikisaiFor }), null);
});

test('organizers · precio medio por persona: el total entre N; sin personas, nada', () => {
  assert.equal(averagePrice(2950, 20), 147.5);
  assert.equal(averagePrice('2800', 20), 140);
  assert.equal(averagePrice(2800, null), null);
  assert.equal(averagePrice(2800, 0), null);
});
