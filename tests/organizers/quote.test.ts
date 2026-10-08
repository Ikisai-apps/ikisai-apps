/**
 * Organizers · calculadora del precio con Ikisai (fase 2, API.md §13.2): el mismo dominio que Booking (`suggestLines`,
 * `proposalTotals`, `applyMinimum`), IVA incluido sin sumarlo dos veces, mínimo comercial, señal y extras; y la
 * calculadora privada de margen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { marginOf, quote, type QuoteInput } from '../../apps/organizers/src/app/quote.ts';
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
  // 20 personas × 2 noches × 60 € + 3 días de sala × 200 €
  assert.equal(q.total, 2400 + 600);
  assert.equal(q.payable, 3000);
  assert.equal(q.minimumApplied, false);
  assert.equal(q.vatAmount, 272.73, 'IVA incluido: no se suma encima');
  assert.equal(q.deposit, 900, '30 % de 3000');
});

test('organizers · calculadora: el mínimo por retiro se aplica y la señal sale de lo que se paga', () => {
  const q = quote(base({ persons: 5, reservation: { ...base().reservation, expected_guests: 5 } }));
  assert.equal(q.available, true);
  if (!q.available) return;
  assert.equal(q.total, 600 + 600);
  assert.equal(q.minimumApplied, true);
  assert.equal(q.payable, 2500);
  assert.equal(q.deposit, 750);
});

test('organizers · calculadora: los extras pedidos se suman con su cantidad; sin tarifas, sin fechas o sin personas no calcula', () => {
  const q = quote(base({ extras: [{ rate_id: 'x1', quantity: 2 }] }));
  assert.equal(q.available && q.total, 3000 + 300);
  assert.deepEqual(quote(base({ rates: [] })), { available: false, reason: 'no_rates' });
  assert.deepEqual(quote(base({ reservation: { ...base().reservation, start_date: null, end_date: null } })), { available: false, reason: 'no_dates' });
  assert.deepEqual(quote(base({ persons: 0 })), { available: false, reason: 'no_persons' });
});

test('organizers · calculadora privada: ingresos, gastos, margen y punto de equilibrio', () => {
  assert.deepEqual(marginOf({ price: 300, attendees: 20, ikisai: 3000, otherCosts: 500 }), { revenue: 6000, cost: 3500, margin: 2500, breakEven: 12 });
  assert.deepEqual(marginOf({ price: 0, attendees: 20, ikisai: 3000, otherCosts: 0 }), { revenue: 0, cost: 3000, margin: -3000, breakEven: null });
});
