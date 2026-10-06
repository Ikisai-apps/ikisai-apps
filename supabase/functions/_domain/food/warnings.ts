/**
 * Ikisai Food · avisos del menú frente a las restricciones del evento (docs/food/API.md §4.3).
 * Función pura: pinta la cabecera del menú en el cliente y vuelve a ejecutarse en la Edge al validar.
 * Los avisos nunca impiden editar un borrador; los que requieren aceptación impiden validar sin aceptarlos.
 */
import type { Allergen, Ingredient, Recipe, RecipeIngredient } from './catalog.ts';
import { restrictionKey, type DietaryRestriction, type FoodEvent, type MenuItem, type MenuService } from './menus.ts';

export type WarningKind = 'alergia' | 'no_verificable' | 'alergenos_sin_revisar' | 'dieta' | 'preferencia' | 'fuera_de_fechas' | 'receta_no_validada';

export interface MenuWarning {
  key: string;
  kind: WarningKind;
  requiresAck: boolean;
  text: string;
}

export interface MenuGraph {
  services: MenuService[];
  items: MenuItem[];
  recipes: Recipe[];
  recipe_ingredients: RecipeIngredient[];
  ingredients: Ingredient[];
}

/** Sin tildes, en minúsculas y sin plural simple, para comparar «Pistachos» con «pistacho». */
export function normalizeTerm(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim()
    .split(/\s+/).map((w) => (w.length > 4 && w.endsWith('es') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)).join(' ');
}

/** Palabras con las que suele nombrarse cada alérgeno. Se comparan ya normalizadas. */
const ALLERGEN_TERMS: Record<Allergen, string[]> = {
  gluten: ['gluten', 'trigo', 'cebada', 'centeno', 'avena', 'espelta', 'harina', 'celiaco', 'celiaquia'],
  crustaceos: ['crustaceo', 'gamba', 'langostino', 'cangrejo', 'marisco'],
  huevos: ['huevo', 'clara', 'yema'],
  pescado: ['pescado', 'atun', 'merluza', 'salmon', 'anchoa', 'bacalao'],
  cacahuetes: ['cacahuete', 'mani'],
  soja: ['soja', 'soya', 'tofu', 'tempeh'],
  lacteos: ['lacteo', 'leche', 'lactosa', 'queso', 'yogur', 'nata', 'mantequilla', 'caseina'],
  frutos_de_cascara: ['fruto de cascara', 'fruto seco', 'nuez', 'nuec', 'almendra', 'avellana', 'pistacho', 'anacardo', 'pinon', 'pecana', 'macadamia'],
  apio: ['apio'],
  mostaza: ['mostaza'],
  sesamo: ['sesamo', 'ajonjoli', 'tahini', 'tahin'],
  sulfitos: ['sulfito', 'vino', 'vinagre'],
  altramuces: ['altramuz', 'altramuc', 'lupino'],
  moluscos: ['molusco', 'mejillon', 'almeja', 'calamar', 'sepia', 'pulpo'],
};

/** Alérgenos que corresponden a un texto libre de Booking («pistacho» → frutos de cáscara). */
export function allergensForSubject(subject: string): Allergen[] {
  const term = normalizeTerm(subject);
  if (!term) return [];
  return (Object.keys(ALLERGEN_TERMS) as Allergen[]).filter((allergen) =>
    ALLERGEN_TERMS[allergen].some((word) => term.includes(word)) || normalizeTerm(allergen.replace(/_/g, ' ')) === term);
}

const DIET_LABEL: Record<string, string> = { vegano: 'vegana', vegetariano: 'vegetariana', sin_gluten: 'sin gluten', sin_lactosa: 'sin lactosa' };

function compatibleWithDiet(recipe: Recipe, type: string): boolean {
  switch (type) {
    case 'vegano': return recipe.diet_tags.includes('vegano');
    case 'vegetariano': return recipe.diet_tags.includes('vegetariano') || recipe.diet_tags.includes('vegano');
    case 'sin_gluten': return recipe.allergens_checked && !recipe.allergens.includes('gluten');
    case 'sin_lactosa': return recipe.allergens_checked && !recipe.allergens.includes('lacteos');
    default: return true;
  }
}

function people(r: DietaryRestriction): number {
  return r.servings && r.servings > 0 ? r.servings : 1;
}

function serviceLabel(service: MenuService): string {
  return `${service.service_type} del ${service.service_date}`;
}

export function menuWarnings(event: Pick<FoodEvent, 'start_date' | 'end_date' | 'dietary_restrictions'>, graph: MenuGraph): MenuWarning[] {
  const warnings: MenuWarning[] = [];
  const services = graph.services.filter((s) => !s.deleted_at);
  const serviceIds = new Set(services.map((s) => s.id));
  const items = graph.items.filter((i) => !i.deleted_at && serviceIds.has(i.service_id));
  const recipes = new Map(graph.recipes.map((r) => [r.id, r]));
  const ingredientNames = new Map(graph.ingredients.map((g) => [g.id, normalizeTerm(g.name)]));
  const recipeIngredientNames = new Map<string, string[]>();
  for (const line of graph.recipe_ingredients) {
    if (line.deleted_at) continue;
    const name = ingredientNames.get(line.ingredient_id);
    if (name) recipeIngredientNames.set(line.recipe_id, [...(recipeIngredientNames.get(line.recipe_id) ?? []), name]);
  }
  const usedRecipes = [...new Set(items.map((i) => i.recipe_id))].map((id) => recipes.get(id)).filter((r): r is Recipe => !!r);
  const restrictions = event.dietary_restrictions ?? [];
  const hasAllergy = restrictions.some((r) => r.type === 'alergia' || r.type === 'intolerancia');

  for (const restriction of restrictions) {
    const rKey = restrictionKey(restriction);
    const count = people(restriction);
    if (restriction.type === 'alergia' || restriction.type === 'intolerancia') {
      const subject = (restriction.subject ?? '').trim();
      const term = normalizeTerm(subject);
      const allergens = allergensForSubject(subject);
      const known = allergens.length > 0 || (term !== '' && [...ingredientNames.values()].some((name) => name.includes(term)));
      if (!known) {
        warnings.push({ key: `no_verificable|${rKey}`, kind: 'no_verificable', requiresAck: true,
          text: `${count} ${restriction.type} a «${subject || 'sin especificar'}»: no se puede comprobar automáticamente, revisar a mano.` });
        continue;
      }
      for (const item of items) {
        const recipe = recipes.get(item.recipe_id);
        if (!recipe) continue;
        const byAllergen = allergens.find((a) => recipe.allergens.includes(a));
        const byIngredient = term !== '' && (recipeIngredientNames.get(recipe.id) ?? []).some((name) => name.includes(term));
        if (byAllergen || byIngredient) {
          warnings.push({ key: `alergia|${rKey}|${item.id}`, kind: 'alergia', requiresAck: true,
            text: `«${recipe.name}» ${byAllergen ? `declara ${byAllergen.replace(/_/g, ' ')}` : `lleva ${subject}`}: ${count} ${restriction.type} a ${subject}.` });
        }
      }
    } else if (restriction.type in DIET_LABEL) {
      for (const service of services) {
        const dishes = items.filter((i) => i.service_id === service.id).map((i) => recipes.get(i.recipe_id)).filter((r): r is Recipe => !!r);
        if (dishes.length > 0 && !dishes.some((recipe) => compatibleWithDiet(recipe, restriction.type))) {
          warnings.push({ key: `dieta|${restriction.type}|${service.id}`, kind: 'dieta', requiresAck: true,
            text: `Sin opción ${DIET_LABEL[restriction.type]} en ${serviceLabel(service)} (${count} ${count === 1 ? 'persona' : 'personas'}).` });
        }
      }
    } else {
      warnings.push({ key: `preferencia|${rKey}`, kind: 'preferencia', requiresAck: false,
        text: `${count} ${restriction.type}${restriction.subject ? `: ${restriction.subject}` : ''}.` });
    }
  }

  if (hasAllergy) {
    for (const recipe of usedRecipes) {
      if (!recipe.allergens_checked) {
        warnings.push({ key: `alergenos_sin_revisar|${recipe.id}`, kind: 'alergenos_sin_revisar', requiresAck: true,
          text: `«${recipe.name}» no tiene los alérgenos revisados y hay alergias o intolerancias en el grupo.` });
      }
    }
  }
  for (const service of services) {
    if (service.service_date < event.start_date || service.service_date > event.end_date) {
      warnings.push({ key: `fuera_de_fechas|${service.id}`, kind: 'fuera_de_fechas', requiresAck: false, text: `El servicio ${serviceLabel(service)} queda fuera de las fechas del evento.` });
    }
  }
  for (const recipe of usedRecipes) {
    if (recipe.status !== 'validada') {
      warnings.push({ key: `receta_no_validada|${recipe.id}`, kind: 'receta_no_validada', requiresAck: false, text: `«${recipe.name}» está ${recipe.status === 'archivada' ? 'archivada' : 'en prueba'}.` });
    }
  }
  return warnings;
}

/** Claves que hay que aceptar una a una para poder validar. */
export function requiredAcknowledgements(warnings: MenuWarning[]): string[] {
  return warnings.filter((w) => w.requiresAck).map((w) => w.key);
}
