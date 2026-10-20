/**
 * Food · lo que hace falta y lo que hay en casa (Bloque 2, MUELA-077 §2 con `PERDIDAS_food_bloque2.md`; VG, 20-10-2026):
 * cantidades legibles, el próximo servicio de la receta, «Hay bastante» solo sin dudas y lo urgente de la despensa.
 *
 * Cómo correrlo:   npx tsx --test tests/food/stock-need.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ingredientNeeds, needText, nextRecipeService, pantryAlerts, pendingConsumption, readableQuantity, serviceShares,
} from '../../supabase/functions/_domain/food/stock-need.ts';
import type { MenuGraph } from '../../supabase/functions/_domain/food/warnings.ts';

const row = <T extends object>(fields: T) => ({ revision: 1, created_at: '', updated_at: '', updated_by: null, deleted_at: null, ...fields });

test('cantidades legibles: kg y l desde 1000, plural en palabras', () => {
  assert.equal(readableQuantity(1500, 'ml'), '1,5 l');
  assert.equal(readableQuantity(500, 'g'), '500 g');
  assert.equal(readableQuantity(12, 'unidad'), '12 unidades');
  assert.equal(readableQuantity(1, 'ud'), '1 unidad');
  assert.equal(readableQuantity(3, 'kg'), '3 kg');
  assert.equal(readableQuantity(2, 'manojo'), '2 manojos');
});

const menus = [row({ id: 'm1', status: 'borrador' }), row({ id: 'm2', status: 'cerrado' })];
const services = [
  row({ id: 'pasado', menu_id: 'm1', service_date: '2026-10-17', service_type: 'comida', service_time: '14:00', position: 0, notes: null }),
  row({ id: 'hoy', menu_id: 'm1', service_date: '2026-10-20', service_type: 'comida', service_time: '14:00', position: 0, notes: null }),
  row({ id: 'sabado', menu_id: 'm1', service_date: '2026-10-24', service_type: 'comida', service_time: '14:00', position: 0, notes: null }),
  row({ id: 'cerrado', menu_id: 'm2', service_date: '2026-10-21', service_type: 'cena', service_time: '21:00', position: 0, notes: null }),
];
const items = [
  row({ id: 'i1', service_id: 'pasado', recipe_id: 'crema', servings: 10, position: 0, notes: null }),
  row({ id: 'i2', service_id: 'sabado', recipe_id: 'crema', servings: 24, position: 0, notes: null }),
  row({ id: 'i3', service_id: 'sabado', recipe_id: 'pure', servings: 24, position: 1, notes: null }),
  row({ id: 'i4', service_id: 'cerrado', recipe_id: 'crema', servings: 50, position: 0, notes: null }),
  row({ id: 'i5', service_id: 'hoy', recipe_id: 'pure', servings: 8, position: 0, notes: null }),
];

test('el próximo servicio de la receta: ni los pasados ni los de un menú cerrado; con hora, hasta 90 min después', () => {
  const at = (iso: string) => new Date(iso);
  assert.equal(nextRecipeService('crema', { menus, services, items } as never, at('2026-10-20T10:00:00'))?.service.id, 'sabado');
  assert.equal(nextRecipeService('crema', { menus, services, items } as never, at('2026-10-20T10:00:00'))?.servings, 24);
  assert.equal(nextRecipeService('pure', { menus, services, items } as never, at('2026-10-20T15:00:00'))?.service.id, 'hoy');
  assert.equal(nextRecipeService('pure', { menus, services, items } as never, at('2026-10-20T16:00:00'))?.service.id, 'sabado');
  assert.equal(nextRecipeService('otra', { menus, services, items } as never, at('2026-10-20T10:00:00')), null);
});

const graph = {
  services, items,
  recipes: [row({ id: 'crema', name: 'Crema de calabaza', base_servings: 10 }), row({ id: 'pure', name: 'Puré de patata', base_servings: 10 })],
  recipe_ingredients: [
    row({ id: 'l1', recipe_id: 'crema', ingredient_id: 'aceite', quantity: 50, unit: 'ml', position: 0, notes: null }),
    row({ id: 'l2', recipe_id: 'crema', ingredient_id: 'calabaza', quantity: 2, unit: 'kg', position: 1, notes: null }),
    row({ id: 'l3', recipe_id: 'crema', ingredient_id: 'sal', quantity: 5, unit: 'g', position: 2, notes: null }),
    row({ id: 'l4', recipe_id: 'crema', ingredient_id: 'huevo', quantity: 4, unit: 'unidad', position: 3, notes: null }),
    row({ id: 'l5', recipe_id: 'crema', ingredient_id: 'pimienta', quantity: 1, unit: 'g', position: 4, notes: null }),
    row({ id: 'l6', recipe_id: 'pure', ingredient_id: 'aceite', quantity: 30, unit: 'ml', position: 0, notes: null }),
  ],
  ingredients: [
    row({ id: 'aceite', name: 'Aceite de oliva', item_id: 'a-aceite' }), row({ id: 'calabaza', name: 'Calabaza', item_id: 'a-calabaza' }),
    row({ id: 'sal', name: 'Sal', item_id: 'a-sal' }), row({ id: 'huevo', name: 'Huevos', item_id: 'a-huevo' }), row({ id: 'pimienta', name: 'Pimienta', item_id: null }),
  ],
} as unknown as MenuGraph;

const kitchen = new Set(['cocina']);
const move = (item_id: string, quantity: number, extra: object = {}) => ({ item_id, space_id: 'cocina', lot_id: null, quantity, deleted_at: null, ...extra });
const stock = {
  items: [
    { id: 'a-aceite', base_unit: 'ml', min_quantity: 5000, name: 'Aceite de oliva', kind: 'ingrediente', active: true },
    { id: 'a-calabaza', base_unit: 'kg', min_quantity: null, name: 'Calabaza', kind: 'ingrediente', active: true },
    { id: 'a-sal', base_unit: 'g', min_quantity: null, name: 'Sal', kind: 'ingrediente', active: true },
    { id: 'a-huevo', base_unit: 'ud', min_quantity: null, name: 'Huevos', kind: 'ingrediente', active: true },
  ],
  movements: [move('a-aceite', 1500), move('a-calabaza', 10), move('a-sal', 5), move('a-sal', -5), move('a-huevo', 6)],
  lots: [],
  kitchen,
};

test('«Hace falta» a las raciones del servicio; los cinco estados, y «Hay bastante» solo sin dudas', () => {
  const needs = ingredientNeeds({
    lines: graph.recipe_ingredients.filter((l) => l.recipe_id === 'crema'), ingredients: graph.ingredients as never, baseServings: 10, servings: 24,
    stock: stock as never, today: '2026-10-20', shares: serviceShares('sabado', 'crema', graph),
  });
  const by = (id: string) => needs.find((n) => n.ingredientId === id)!;
  assert.equal(by('aceite').need, 120);
  assert.equal(by('aceite').recipeQuantity, 50);
  assert.equal(by('aceite').state, 'en_duda');
  assert.equal(by('aceite').low, true);
  assert.equal(needText(by('aceite')), 'En casa 1,5 l · también lo usa puré de patata del mismo servicio');
  assert.equal(by('calabaza').state, 'bastante');
  assert.equal(needText(by('calabaza')), 'Hay bastante');
  assert.equal(needText(by('sal')), 'No hay en casa');
  assert.equal(needText(by('huevo')), 'Faltan 3,6 unidades');
  assert.equal(needText(by('pimienta')), 'Sin seguimiento en Recursos');
});

test('un consumo sin descontar pone en duda «Hay bastante»', () => {
  // La comida del sábado 17 pasó hace más de 2 h y nadie la confirmó: su calabaza aún no ha bajado del stock.
  const pending = pendingConsumption(graph, [], [], new Date('2026-10-18T10:00:00'));
  assert.deepEqual(pending.get('calabaza'), ['2026-10-17']);
  const needs = ingredientNeeds({
    lines: graph.recipe_ingredients.filter((l) => l.id === 'l2'), ingredients: graph.ingredients as never, baseServings: 10, servings: 10,
    stock: stock as never, today: '2026-10-18', pending,
  });
  assert.equal(needText(needs[0]!), 'En casa 10 kg · falta descontar lo gastado el sáb 17');
});

test('lo urgente de la despensa: caducado, en dos días, bajo mínimo y esa semana; un artículo, una vez', () => {
  const lots = [
    { id: 'lot-yogur-viejo', expires_on: '2026-10-18' }, { id: 'lot-yogur', expires_on: '2026-10-22' },
    { id: 'lot-leche', expires_on: '2026-10-25' }, { id: 'lot-nata', expires_on: '2026-10-30' },
  ];
  const items = [
    { id: 'yogur', name: 'Yogur natural', kind: 'ingrediente', active: true, base_unit: 'ud', min_quantity: null },
    { id: 'leche', name: 'Leche', kind: 'ingrediente', active: true, base_unit: 'ml', min_quantity: null },
    { id: 'nata', name: 'Nata', kind: 'ingrediente', active: true, base_unit: 'ml', min_quantity: null },
    { id: 'aceite', name: 'Aceite de oliva', kind: 'ingrediente', active: true, base_unit: 'ml', min_quantity: 5000 },
    { id: 'cemento', name: 'Cemento', kind: 'material', active: true, base_unit: 'kg', min_quantity: 10 },
  ];
  const movements = [
    move('yogur', 4, { lot_id: 'lot-yogur-viejo' }), move('yogur', 30, { lot_id: 'lot-yogur' }), move('leche', 2000, { lot_id: 'lot-leche' }),
    move('nata', 500, { lot_id: 'lot-nata' }), move('aceite', 1500), move('cemento', 1),
  ];
  const alerts = pantryAlerts({ items, movements, lots, kitchen }, '2026-10-20');
  assert.deepEqual(alerts.map((a) => [a.kind, a.name, a.text]), [
    ['caducado', 'Yogur natural', 'Caducado el dom 18 · 4 unidades en la cocina'],
    ['bajo_minimo', 'Aceite de oliva', 'Bajo mínimo · quedan 1,5 l (mínimo 5 l)'],
    ['caduca_semana', 'Leche', 'caduca el dom 25 (en 5 días) · 2 l'],
  ]);
  // Al día siguiente del caducado, el lote de dos días sale en su sitio.
  const later = pantryAlerts({ items, movements: movements.filter((m) => m.lot_id !== 'lot-yogur-viejo'), lots, kitchen }, '2026-10-20');
  assert.deepEqual(later.map((a) => a.text)[0], 'caduca el jue 22 (en 2 días) · 30 unidades');
});
