/**
 * Food · tanda 27: el cruce de alérgenos nuevo no pierde ningún aviso de hoy (regla de VG del 19-10-2026, obligatoria
 * antes de integrar). `warnings-legacy.ts` es la función de antes, congelada: en miles de menús generados, cada aviso
 * suyo (clave, tipo, aceptación y texto) sigue saliendo igual con la nueva. Después, lo que se suma.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLERGENS, allergenPresence, crossContext, dishNotes, isSevere, menuWarnings, requiredAcknowledgements, restrictionLines,
  type MenuGraph, type MenuWarning,
} from '../../supabase/functions/_domain/food/mod.ts';
import { menuWarnings as legacyWarnings } from './warnings-legacy.ts';

/** Generador con semilla: el mismo menú en cada vuelta y en la CI. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const NAMES = ['Tarta de pistacho', 'Bizcocho', 'Arroz blanco', 'Crema de calabaza', 'Ensalada verde', 'Fruta y té', 'Curry de garbanzos',
  'Lentejas', 'Tortilla', 'Pan de espelta', 'Mejillones al vapor', 'Gazpacho', 'Hummus con tahini', 'Yogur con nueces', 'Kiwi con menta'];
const DESCRIPTIONS = [null, 'con almendra tostada', 'sin gluten', 'con un toque de cilantro', 'con salsa de soja', 'con kiwi y fresas', 'de la huerta', 'con queso fresco'];
const INGREDIENTS = ['Pistachos tostados', 'Almendra molida', 'Harina de trigo', 'Huevo', 'Leche', 'Arroz', 'Calabaza', 'Cilantro', 'Kiwi',
  'Soja', 'Mejillón', 'Garbanzos', 'Sésamo', 'Mostaza', 'Apio', 'Tomate', 'Nueces'];
const SUBJECTS = ['pistacho', 'frutos secos', 'gluten', 'huevo', 'lácteos', 'kiwi', 'cilantro', 'marisco', 'sésamo', 'fresa', '', 'Pistachos', 'celíaca', 'soja'];
const TYPES = ['alergia', 'intolerancia', 'preferencia', 'otra', 'vegano', 'vegetariano', 'sin_gluten', 'sin_lactosa'];
const SEVERITIES = [null, 'grave', 'leve', 'Grave (anafilaxia)', 'moderada'];

function scenario(seed: number) {
  const r = rng(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)]!;
  const ingredients = INGREDIENTS.map((name, i) => ({ id: `g${i}`, name, preferred_unit: 'kg', preferred_supplier: null, active: true, deleted_at: null }));
  const recipes = Array.from({ length: 1 + Math.floor(r() * 6) }, (_, i) => ({
    id: `r${i}`, name: pick(NAMES), public_name: r() < 0.3 ? pick(NAMES) : null, public_description: pick(DESCRIPTIONS),
    status: pick(['validada', 'en_prueba', 'archivada']), allergens_checked: r() < 0.5,
    allergens: ALLERGENS.filter(() => r() < 0.12), diet_tags: ['vegano', 'vegetariano'].filter(() => r() < 0.3), deleted_at: null,
  }));
  const recipe_ingredients = recipes.flatMap((recipe) => Array.from({ length: Math.floor(r() * 4) }, (_, j) => ({
    id: `${recipe.id}-l${j}`, recipe_id: recipe.id, ingredient_id: pick(ingredients).id, quantity: 1, unit: 'kg', position: j, notes: null,
    deleted_at: r() < 0.1 ? '2026-10-01T00:00:00Z' : null,
  })));
  const services = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => ({
    id: `s${i}`, menu_id: 'm', service_date: `2026-10-${String(20 + i).padStart(2, '0')}`, service_type: pick(['comida', 'cena']), service_time: null,
    position: i, notes: null, deleted_at: r() < 0.1 ? '2026-10-01T00:00:00Z' : null,
  }));
  const items = Array.from({ length: Math.floor(r() * 8) }, (_, i) => ({
    id: `i${i}`, service_id: pick(services).id, recipe_id: r() < 0.95 ? pick(recipes).id : 'perdida', servings: 10, position: i, notes: null,
    deleted_at: r() < 0.1 ? '2026-10-01T00:00:00Z' : null,
  }));
  const dietary_restrictions = Array.from({ length: Math.floor(r() * 5) }, () => ({
    type: pick(TYPES), subject: pick(SUBJECTS), severity: pick(SEVERITIES), servings: Math.floor(r() * 4),
  }));
  const graph = { services, items, recipes, recipe_ingredients, ingredients } as unknown as MenuGraph;
  return { event: { start_date: '2026-10-20', end_date: '2026-10-21', dietary_restrictions }, graph };
}

const keyOf = (w: MenuWarning) => JSON.stringify([w.key, w.kind, w.requiresAck, w.text]);

test('cruce · ningún aviso de hoy se pierde ni cambia, en 5000 menús generados', () => {
  let legacyTotal = 0; let added = 0;
  for (let seed = 1; seed <= 5000; seed++) {
    const { event, graph } = scenario(seed);
    const before = legacyWarnings(event, graph);
    const after = menuWarnings(event, graph);
    const now = new Set(after.map(keyOf));
    for (const w of before) assert.ok(now.has(keyOf(w)), `semilla ${seed}: se perdió ${keyOf(w)}`);
    // Lo que se acepta para validar también: lo de antes sigue siendo obligatorio.
    const required = new Set(requiredAcknowledgements(after));
    for (const key of requiredAcknowledgements(before)) assert.ok(required.has(key), `semilla ${seed}: ${key} ya no se acepta`);
    // Lo nuevo no reutiliza la clave de un aviso de antes: aceptar uno de antes no acepta uno nuevo.
    const old = new Set(before.map((w) => w.key));
    const kept = new Set(before.map(keyOf));
    for (const w of after) if (!kept.has(keyOf(w))) assert.ok(!old.has(w.key), `semilla ${seed}: ${w.key} cambia de texto`);
    legacyTotal += before.length; added += after.length - before.length;
  }
  assert.ok(legacyTotal > 10000, `pocos avisos de antes para comparar (${legacyTotal})`);
  assert.ok(added > 1000, `el cruce nuevo no suma nada (${added})`);
});

function oneDish(recipe: Record<string, unknown>, ingredients: string[] = []) {
  const ing = ingredients.map((name, i) => ({ id: `g${i}`, name, preferred_unit: 'kg', preferred_supplier: null, active: true, deleted_at: null }));
  return {
    services: [{ id: 's', menu_id: 'm', service_date: '2026-10-20', service_type: 'comida', service_time: null, position: 1, notes: null, deleted_at: null }],
    items: [{ id: 'i', service_id: 's', recipe_id: 'r', servings: 10, position: 1, notes: null, deleted_at: null }],
    recipes: [{ id: 'r', public_name: null, public_description: null, status: 'validada', allergens: [], allergens_checked: true, diet_tags: [], deleted_at: null, ...recipe }],
    recipe_ingredients: ing.map((g, i) => ({ id: `l${i}`, recipe_id: 'r', ingredient_id: g.id, quantity: 1, unit: 'kg', position: i, notes: null, deleted_at: null })),
    ingredients: ing,
  } as unknown as MenuGraph;
}
const group = (...list: Array<{ type: string; subject?: string; severity?: string | null; servings?: number }>) =>
  ({ start_date: '2026-10-20', end_date: '2026-10-21', dietary_restrictions: list });

test('cruce · lo que se suma: texto del plato, ingrediente que nombra el alérgeno y preferencias plato a plato', () => {
  // Un alérgeno declarado avisa aunque la receta no esté revisada (como hoy).
  const declared = menuWarnings(group({ type: 'alergia', subject: 'pistacho', servings: 1 }), oneDish({ name: 'Tarta', allergens: ['frutos_de_cascara'], allergens_checked: false }));
  assert.ok(declared.some((w) => w.kind === 'alergia' && w.text.includes('declara frutos de cáscara')));
  // Por el nombre o la descripción del plato.
  const byText = menuWarnings(group({ type: 'alergia', subject: 'pistacho', servings: 2 }), oneDish({ name: 'Tarta', public_description: 'con pistacho' }));
  assert.deepEqual(byText.filter((w) => w.kind === 'alergia').map((w) => [w.key.endsWith('|i'), w.requiresAck, w.text]),
    [[true, true, '«Tarta» nombra pistacho en su nombre o descripción: 2 alergia a pistacho.']]);
  // Un ingrediente que nombra el alérgeno («almendra» para «frutos secos»), aunque no diga «frutos secos».
  const byIngredient = menuWarnings(group({ type: 'alergia', subject: 'frutos secos' }), oneDish({ name: 'Bizcocho' }, ['Almendra molida']));
  assert.ok(byIngredient.some((w) => w.kind === 'alergia' && w.text.includes('lleva un ingrediente con frutos secos')));
  // Lo que no se sabe cruzar sigue pidiendo revisión a mano, y además avisa del plato que lo nombra.
  const kiwi = menuWarnings(group({ type: 'intolerancia', subject: 'kiwi', severity: 'leve' }), oneDish({ name: 'Fruta y té', public_description: 'con kiwi' }));
  assert.deepEqual(kiwi.map((w) => w.kind), ['no_verificable', 'alergia']);
  // Preferencias: la de siempre y, además, plato a plato; ninguna pide aceptación.
  const coriander = menuWarnings(group({ type: 'preferencia', subject: 'cilantro', servings: 3 }), oneDish({ name: 'Curry' }, ['Cilantro']));
  assert.deepEqual(coriander.map((w) => [w.kind, w.key.endsWith('|i'), w.requiresAck]), [['preferencia', false, false], ['preferencia', true, false]]);
  assert.equal(coriander[1]!.text, '«Curry» lleva cilantro: 3 preferencia.');
});

test('cruce · Cocina: todas las alergias e intolerancias con sus personas, la grave destacada; «Alérgenos sin revisar» por plato', () => {
  const lines = restrictionLines([
    { type: 'intolerancia', subject: 'kiwi', severity: 'leve', servings: 1 },
    { type: 'alergia', subject: 'huevo', severity: 'Grave (anafilaxia)', servings: 1 },
    { type: 'alergia', subject: 'pistacho', severity: null, servings: 2 },
    { type: 'vegano', servings: 4 },
    { type: 'preferencia', subject: 'cilantro', servings: 1 },
  ]);
  assert.deepEqual(lines.map((l) => [l.subject, l.people, l.severe]), [['huevo', 1, true], ['kiwi', 1, false], ['pistacho', 2, false]]);
  assert.deepEqual(['grave', 'GRAVES', 'severa', 'anafiláctica', 'leve', '', null, 'moderada'].map(isSevere), [true, true, true, true, false, false, false, false]);

  const event = group({ type: 'alergia', subject: 'pistacho', servings: 2 }, { type: 'preferencia', subject: 'cilantro' });
  const [unchecked] = dishNotes(event, oneDish({ name: 'Ensalada verde', allergens_checked: false }));
  assert.deepEqual([unchecked!.allergies.length, unchecked!.preferences.length, unchecked!.unreviewed], [0, 0, true]);
  const [hit] = dishNotes(event, oneDish({ name: 'Curry', public_description: 'con pistacho' }, ['Cilantro']));
  assert.deepEqual([hit!.allergies.map((m) => [m.restriction.subject, m.restriction.people, m.crossing.text]), hit!.preferences.map((m) => m.restriction.subject), hit!.unreviewed],
    [[['pistacho', 2, true]], ['cilantro'], false]);
  // Sin alergias en el grupo, nada que decir del plato sin revisar (como hoy en los avisos).
  assert.equal(dishNotes(group({ type: 'vegano' }), oneDish({ name: 'Ensalada verde', allergens_checked: false }))[0]!.unreviewed, false);
});

test('cruce · Recetario «Lleva X / Sin X»: lo sin revisar se marca y nunca sale como «sin»', () => {
  const graph = oneDish({ name: 'Bizcocho' }, ['Almendra molida']);
  const context = crossContext(graph);
  const recipe = (fields: Record<string, unknown>) => ({ ...graph.recipes[0]!, ...fields }) as MenuGraph['recipes'][number];
  assert.equal(allergenPresence(recipe({}), 'frutos_de_cascara', context), 'lleva'); // por el ingrediente, aunque no lo declare
  assert.equal(allergenPresence(recipe({ id: 'otra', name: 'Pan con nueces' }), 'frutos_de_cascara', context), 'lleva'); // por el nombre
  assert.equal(allergenPresence(recipe({ id: 'otra', name: 'Arroz', allergens: ['frutos_de_cascara'] }), 'frutos_de_cascara', context), 'lleva');
  assert.equal(allergenPresence(recipe({ id: 'otra', name: 'Arroz', allergens_checked: false }), 'frutos_de_cascara', context), 'sin_revisar');
  assert.equal(allergenPresence(recipe({ id: 'otra', name: 'Arroz' }), 'frutos_de_cascara', context), 'no_declara');
});
