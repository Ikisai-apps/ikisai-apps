/**
 * Organizers · Cocina contra el menú (pasada única, zona 3): solo se compara con los alérgenos de la lista europea que
 * declara cada plato; lo demás no se puede comprobar y el nombre del plato solo da una pista. Nunca «apto».
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { KitchenSummary } from '../../apps/organizers/src/app/api.ts';
import { kitchenStateOf, sharedAllergens, type Dish, type PortalMenu } from '../../apps/organizers/src/app/kitchen-state.ts';

const dish = (name: string, allergens: string[], extra: Partial<Dish> = {}): Dish => ({
  menu_item_id: name, name, description: null, category: null, diet_tags: null, allergens, allergens_checked: true, photo_thumb_file_id: null, ...extra,
});
const menuOf = (...dishes: Dish[]): PortalMenu => ({
  available: true, status: 'provisional',
  services: [{ service_id: 's1', menu_id: 'm1', date: '2027-05-15', type: 'comida', time: '14:00', dishes }],
});

const summary: KitchenSummary = {
  totals: [
    { restriction_type: 'alergia', subject: 'Pistachos', servings: 3 },
    { restriction_type: 'alergia', subject: 'kiwi', servings: 1 },
    { restriction_type: 'intolerancia', subject: 'lactosa', servings: 2 },
    { restriction_type: 'vegetariano', subject: null, servings: 4 },
    { restriction_type: 'sin_gluten', subject: null, servings: 1 },
  ],
  named: [
    { guest: 'Marcos L.', restriction_type: 'alergia', subject: 'pistacho', severity: 'grave' },
    { guest: 'Eva R.', restriction_type: 'intolerancia', subject: 'lactosa', severity: null },
  ],
};

test('organizers · «pistacho» casa con frutos de cáscara declarado', () => {
  const s = kitchenStateOf(summary, menuOf(dish('Helado de pistacho', ['frutos_de_cascara', 'lacteos']), dish('Arroz blanco', [])));
  const pistacho = s.watched.find((w) => w.r.subject === 'Pistachos')!;
  assert.deepEqual(pistacho.allergens, ['frutos_de_cascara']);
  assert.equal(pistacho.verifiable, true);
  const [helado, arroz] = s.dishes;
  assert.ok(helado!.hits.includes(pistacho));
  assert.deepEqual(sharedAllergens(pistacho, helado!), ['frutos_de_cascara']);
  // La intolerancia a la lactosa casa con lácteos; «sin gluten», con gluten.
  assert.ok(helado!.hits.some((w) => w.r.subject === 'lactosa'));
  assert.equal(s.watched.find((w) => w.r.restriction_type === 'sin_gluten')!.allergens[0], 'gluten');
  // Un plato sin aciertos queda neutro: sin aciertos ni pistas, y nada que diga «apto».
  assert.deepEqual(arroz!.hits, []);
  assert.deepEqual(arroz!.hints, []);
  assert.equal(JSON.stringify(s).includes('apto'), false);
});

test('organizers · «kiwi» no se puede comprobar y no da aciertos', () => {
  const s = kitchenStateOf(summary, menuOf(dish('Macedonia', ['sulfitos']), dish('Tarta de queso', ['lacteos'])));
  const kiwi = s.watched.find((w) => w.r.subject === 'kiwi')!;
  assert.equal(kiwi.verifiable, false);
  assert.deepEqual(kiwi.allergens, []);
  for (const d of s.dishes) {
    assert.equal(d.hits.includes(kiwi), false);
    assert.equal(d.hints.includes(kiwi), false);
  }
  // Los vegetarianos no son un alérgeno vigilado.
  assert.equal(s.watched.some((w) => w.r.restriction_type === 'vegetariano'), false);
});

test('organizers · «kiwi» en «Fruta y kiwi» da solo una pista', () => {
  const s = kitchenStateOf(summary, menuOf(dish('Postre del día', [], { description: 'Fruta y kiwi' })));
  const kiwi = s.watched.find((w) => w.r.subject === 'kiwi')!;
  assert.deepEqual(s.dishes[0]!.hints, [kiwi]);
  assert.equal(s.dishes[0]!.hits.includes(kiwi), false);
});

test('organizers · lo anónimo cuadra con las raciones y nunca lleva gravedad', () => {
  const s = kitchenStateOf(summary, null);
  const byKey = new Map(s.watched.map((w) => [`${w.r.restriction_type}:${w.r.subject}`, w]));
  // 3 raciones de pistacho, 1 con nombre: 2 sin nombre.
  assert.equal(byKey.get('alergia:Pistachos')!.anonymous, 2);
  assert.equal(byKey.get('alergia:Pistachos')!.named.length, 1);
  assert.equal(byKey.get('alergia:kiwi')!.anonymous, 1);
  assert.equal(byKey.get('intolerancia:lactosa')!.anonymous, 1);
  assert.equal(byKey.get('sin_gluten:null')!.anonymous, 1);
  for (const w of s.watched) assert.equal(w.anonymous + w.named.length, w.r.servings);
  assert.equal(s.anonymousTotal, 2 + 1 + 1 + 1);
  // Alergias e intolerancias: 3 + 1 + 2 raciones.
  assert.equal(s.allergyCount, 6);
  // La gravedad solo viaja con el nombre; los recuentos no la tienen.
  for (const w of s.watched) assert.equal('severity' in w.r, false);
  assert.deepEqual(s.dishes, []);
});
