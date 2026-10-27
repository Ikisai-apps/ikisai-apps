/**
 * Organizers · «Comida que se ofrece» (food.portal_offers de Food, encargo de VG por Core, 27-10): qué se enseña, quién
 * paga, cuándo, el precio y las líneas de una carta.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { linesByScope, payerText, priceText, visibleOffers, whenText, type FoodOffer, type FoodOfferLine } from '../../apps/organizers/src/app/food-offers.ts';

const t = (s: string, vars?: Record<string, string | number>) => s.replace(/\{([a-z_]+)\}/gi, (m, k: string) => (vars && k in vars ? String(vars[k]) : m));
const offer = (over: Partial<FoodOffer>): FoodOffer => ({
  offer_id: 'o1', event_id: 'e1', name: 'Menú del retiro', kind: 'cerrado', audience: 'huespedes', meal_groups: [], days: null, services: null,
  place: null, payer: 'organizador', charge_when: null, provisional: false, lines: null, ...over,
});
const line = (over: Partial<FoodOfferLine>): FoodOfferLine => ({
  line_id: 'l1', code: 'A', scope: 'clasico', name: 'Tortilla', description: null, price_cents: 450, allergens: ['huevos'], allergens_checked: true, diet_tags: [], ...over,
});

test('organizers · ofertas de comida: sin lo interno, primero los menús cerrados y después las cartas', () => {
  const out = visibleOffers({ reservation_id: 'r', offers: [
    offer({ offer_id: 'c2', kind: 'carta', name: 'Zumos' }), offer({ offer_id: 'x', kind: 'carta', name: 'Personal', audience: 'interna' }),
    offer({ offer_id: 'c1', kind: 'carta', name: 'Barra' }), offer({ offer_id: 'm', kind: 'cerrado', name: 'Menú' }),
  ] });
  assert.deepEqual(out.map((o) => o.offer_id), ['m', 'c1', 'c2']);
  assert.deepEqual(visibleOffers(null), []);
});

test('organizers · ofertas de comida: quién paga, con los textos acordados con Food', () => {
  assert.equal(payerText({ payer: 'organizador', charge_when: null }, t), 'Lo pagas tú (incluido en tu retiro)');
  assert.equal(payerText({ payer: 'huesped', charge_when: 'barra' }, t), 'Lo paga cada asistente, en barra');
  assert.equal(payerText({ payer: 'huesped', charge_when: 'cuenta' }, t), 'Lo paga cada asistente, al final, en su cuenta');
  assert.equal(payerText({ payer: 'huesped', charge_when: null }, t), 'Lo paga cada asistente');
});

test('organizers · ofertas de comida: cuándo (días y servicios) y precio en euros con IVA', () => {
  const name = (s: string) => ({ comida: 'Comida', cena: 'Cena' }[s] ?? s);
  assert.equal(whenText({ days: null, services: null }, t, 'es-ES', name), 'Todos los días · todos los servicios');
  assert.match(whenText({ days: ['2026-10-31', '2026-10-30'], services: ['comida', 'cena'] }, t, 'es-ES', name), /^30 oct\.?, 31 oct\.? · Comida, Cena$/);
  assert.match(priceText(450, 'es-ES'), /^4,50\s€$/);
  assert.match(priceText(1200, 'en-GB'), /^€12\.00$/);
});

test('organizers · ofertas de comida: las líneas de una carta, por ámbito y por código', () => {
  const groups = linesByScope([line({ line_id: 'b', code: 'B' }), line({ line_id: 'g', code: 'α', scope: 'gourmet' }), line({ line_id: 'a', code: 'A' })]);
  assert.deepEqual(groups.map((g) => [g.scope, g.lines.map((l) => l.code)]), [['clasico', ['A', 'B']], ['gourmet', ['α']]]);
  assert.deepEqual(linesByScope(null), []);
});
