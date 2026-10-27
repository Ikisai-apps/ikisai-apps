/**
 * Guests · «Tus ofertas de hoy» (API.md §9.18): la respuesta de `food.portal_offers` (FD3) cruzada con una ficha. Solo las
 * ofertas de su grupo de comida (o sin grupos); las internas, solo a fichas de equipo asignadas (`staff`, `direccion`); el
 * modo según quién paga y cuándo se cobra.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { modeOf, offerFor, offersForGuest, priceText, safeUrl } from '../../apps/guests/src/app/offers.ts';

const line = (name: string, price: number | null) => ({ line_id: `l-${name}`, code: 'A', scope: 'barra', name, description: null, price_cents: price, allergens: [], allergens_checked: true, diet_tags: [] });
const RAW = {
  reservation_id: 'r1',
  offers: [
    { offer_id: 'menu', name: 'Menú del retiro', kind: 'cerrado', meal_groups: [], payer: 'organizador', charge_when: null, place: 'Comedor', lines: [] },
    { offer_id: 'veg', name: 'Menú vegano', kind: 'cerrado', meal_groups: ['veganos'], payer: 'organizador', charge_when: null, place: 'Comedor', lines: [] },
    { offer_id: 'barra', name: 'Barra', kind: 'carta', meal_groups: [], payer: 'huesped', charge_when: 'barra', place: 'Porche', lines: [line('Vino tinto', 350), line('', 100)] },
    { offer_id: 'sabado', name: 'Carta del sábado', kind: 'carta', meal_groups: [], payer: 'huesped', charge_when: 'cuenta', place: null, lines: [line('Montadito', 250)] },
    { offer_id: 'equipo', name: 'Comida del equipo', kind: 'cerrado', meal_groups: [], audience: 'interna', payer: 'organizador', place: 'Cocina', lines: [] },
  ],
  days: [
    { date: '2027-03-13', services: [
      { type: 'cena', time: '21:00', included: [{ offer_id: 'menu', options: [{ name: 'Crema de calabaza', allergens: [], allergens_checked: true }, { name: '' }] }, { offer_id: 'veg', options: [{ name: 'Tofu' }] }] },
      { type: 'comida', time: '14:00', included: [{ offer_id: 'equipo', options: [{ name: 'Lentejas' }] }] },
    ], cartas: ['barra', 'sabado', 'equipo'] },
    { date: '2027-03-12', services: [{ type: 'comida', time: '14:00', included: [{ offer_id: 'menu', options: [{ name: 'Paella', allergens: ['crustaceos'], allergens_checked: false }] }] }], cartas: [] },
    { date: 'mañana', services: [{ type: 'cena', included: [{ offer_id: 'menu', options: [{ name: 'X' }] }] }], cartas: [] },
  ],
};

test('guests · ofertas: lo de su grupo y lo de todos, por fecha y hora; nunca lo interno a un huésped', () => {
  const out = offersForGuest(RAW, null);
  assert.deepEqual(out.days.map((d) => d.date), ['2027-03-12', '2027-03-13']);
  const sab = out.days[1]!;
  assert.deepEqual(sab.services.map((s) => s.type), ['cena']); // la comida interna no sale
  assert.deepEqual(sab.services[0]!.included.map((i) => [i.name, i.options.map((o) => o.name)]), [['Menú del retiro', ['Crema de calabaza']]]);
  assert.deepEqual(sab.cartas.map((c) => [c.name, c.mode]), [['Barra', 'de_pago'], ['Carta del sábado', 'a_cuenta']]);
  assert.deepEqual(sab.cartas[0]!.lines.map((l) => [l.name, l.price_cents]), [['Vino tinto', 350]]);
  // Del grupo «veganos», también su menú.
  assert.deepEqual(offersForGuest(RAW, 'veganos').days[1]!.services[0]!.included.map((i) => i.name), ['Menú del retiro', 'Menú vegano']);
  // El organizador tampoco ve lo interno.
  assert.equal(offersForGuest(RAW, null, 'organizer').days[1]!.services.length, 1);
});

test('guests · ofertas: las internas, solo a fichas de equipo asignadas', () => {
  const staff = offersForGuest(RAW, null, 'staff');
  assert.deepEqual(staff.days[1]!.services.map((s) => [s.type, s.included[0]!.internal]), [['comida', true], ['cena', false]]);
  assert.equal(offersForGuest(RAW, null, 'direccion').days[1]!.services.length, 2);
  assert.deepEqual(offersForGuest(null, null), { days: [] });
});

test('guests · ofertas: modo, grupo, precio y enlace', () => {
  assert.equal(modeOf('organizador', 'barra'), 'incluido');
  assert.equal(modeOf('huesped', 'barra'), 'de_pago');
  assert.equal(modeOf('huesped', 'cuenta'), 'a_cuenta');
  assert.equal(offerFor([], null), true);
  assert.equal(offerFor(['veganos'], null), false);
  assert.equal(priceText(350, 'es-ES'), '3,50 €');
  assert.equal(priceText(null, 'es-ES'), null);
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('https://flow.example.invalid/x'), 'https://flow.example.invalid/x');
});
