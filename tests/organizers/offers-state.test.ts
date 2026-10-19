/**
 * Organizers · cuentas de las ofertas (pasada única, zona 3): las caducadas siguen sumando (sin salir en el cartel), las
 * plazas que sobran y el punto de equilibrio con lo contratado.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isExpired, offersStateOf } from '../../apps/organizers/src/app/offers-state.ts';

const today = '2027-03-01';

test('organizers · una oferta caducada suma en los ingresos aunque no salga en el cartel', () => {
  const offers = [
    { id: 'a', price: 450, expected: 10, capacity: 12, on_poster: true },
    { id: 'b', price: 300, expected: 4, capacity: 4, on_poster: true, available_until: '2027-02-15' },
    { id: 'c', price: 500, expected: 2, on_poster: false, available_from: '2027-04-01' },
  ];
  const s = offersStateOf(offers, today, 2800, 20, 0);
  assert.equal(s.m.revenue, 450 * 10 + 300 * 4 + 500 * 2);
  assert.equal(s.m.attendees, 16);
  assert.deepEqual(s.expired.map((o) => o.id), ['b']);
  assert.deepEqual(s.upcoming.map((o) => o.id), ['c']);
  assert.deepEqual(s.posterOffers.map((o) => o.id), ['a']);
  assert.equal(isExpired({ available_until: today }, today), false);
});

test('organizers · plazas ofrecidas de más (sin contar las caducadas)', () => {
  const offers = [{ capacity: 15 }, { capacity: 10 }, { capacity: 30, available_until: '2027-01-01' }];
  assert.equal(offersStateOf(offers, today, null, 20, 0).offered, 25);
  assert.equal(offersStateOf(offers, today, null, 20, 0).over, 5);
  assert.equal(offersStateOf(offers, today, null, 30, 0).over, 0);
  assert.equal(offersStateOf(offers, today, null, null, 0).over, 0);
});

test('organizers · punto de equilibrio con y sin gastos', () => {
  const offers = [{ price: 450, expected: 10 }];
  const withCosts = offersStateOf(offers, today, 2800, null, 200);
  assert.equal(withCosts.m.cost, 3000);
  assert.equal(withCosts.m.margin, 1500);
  assert.equal(withCosts.m.breakEven, 7);
  // Sin nada contratado ni otros gastos, no hay gastos que cubrir.
  const noCosts = offersStateOf(offers, today, null, null, 0);
  assert.equal(noCosts.m.cost, 0);
  assert.equal(noCosts.m.breakEven, 0);
  assert.equal(offersStateOf([], today, 2800, null, 0).m.breakEven, null);
});
