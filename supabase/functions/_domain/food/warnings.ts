/**
 * Ikisai Food · avisos del menú frente a las restricciones del evento (docs/food/API.md §4.3).
 * Función pura: pinta la cabecera del menú en el cliente y vuelve a ejecutarse en la Edge al validar.
 * Los avisos nunca impiden editar un borrador; los que requieren aceptación impiden validar sin aceptarlos.
 *
 * Cruce de alérgenos (tanda 27, regla aprobada por VG el 19-10-2026): una sola función, `crossRestriction`, para el
 * menú, Cocina, el Organizador y el Recetario. Solo suma avisos a los de antes, nunca quita ninguno
 * (`tests/food/warnings-cruce.test.ts` lo comprueba contra una copia congelada de la función anterior):
 * - un alérgeno declarado avisa siempre, esté revisada o no la receta;
 * - además del ingrediente por su nombre, cuenta el texto del plato (nombre, nombre público y descripción) y los
 *   ingredientes que nombran el alérgeno («almendra molida» para «frutos secos»);
 * - las preferencias se cruzan plato a plato, como información;
 * - lo que no se puede comprobar lo dice («revisar a mano»), y con alergias en el grupo, el plato sin revisar lo dice;
 * - nunca afirma «apto» ni «no contiene».
 */
import type { Allergen, Equipment, Ingredient, Recipe, RecipeEquipment, RecipeIngredient } from './catalog.ts';
import { restrictionKey, type DietaryRestriction, type FoodEvent, type MenuItem, type MenuService } from './menus.ts';

export type WarningKind = 'alergia' | 'no_verificable' | 'alergenos_sin_revisar' | 'dieta' | 'preferencia' | 'fuera_de_fechas' | 'receta_no_validada' | 'maquinaria';

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
  /**
   * La maquinaria y lo que pide cada receta (hallazgo F-MAQ-2): solo en el cliente, que los tiene en su espejo. Sin ellos
   * (la Edge al validar) no hay aviso de máquinas; por eso ese aviso no pide aceptación y no cambia la validación.
   */
  equipment?: Array<Pick<Equipment, 'id' | 'name' | 'status'> & { deleted_at?: string | null }>;
  recipe_equipment?: Array<Pick<RecipeEquipment, 'recipe_id' | 'equipment_id'> & { deleted_at?: string | null }>;
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

/** Nombre de cada alérgeno para los textos de los avisos. */
const ALLERGEN_NAMES: Record<Allergen, string> = {
  gluten: 'gluten', crustaceos: 'crustáceos', huevos: 'huevos', pescado: 'pescado', cacahuetes: 'cacahuetes', soja: 'soja', lacteos: 'lácteos',
  frutos_de_cascara: 'frutos de cáscara', apio: 'apio', mostaza: 'mostaza', sesamo: 'sésamo', sulfitos: 'sulfitos', altramuces: 'altramuces', moluscos: 'moluscos',
};

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

/** Texto normalizado del plato: nombre interno, nombre público y descripción pública. */
function dishText(recipe: Pick<Recipe, 'name' | 'public_name' | 'public_description'>): string {
  return normalizeTerm([recipe.name, recipe.public_name, recipe.public_description].filter(Boolean).join(' '));
}

/** Por qué un plato coincide con una restricción. */
export interface Crossing {
  /** El alérgeno que la receta declara (revisada o no). */
  declared: Allergen | null;
  /** Un ingrediente lleva el texto de la restricción en su nombre (la regla de antes de la tanda 27). */
  ingredient: boolean;
  /** Un ingrediente nombra uno de los alérgenos de la restricción («almendra molida» → frutos de cáscara). */
  ingredientAllergen: boolean;
  /** El nombre o la descripción del plato lo nombra. */
  text: boolean;
}

/** Lo que el cruce necesita del grafo, calculado una vez. */
export interface CrossContext {
  ingredientNames: string[];
  recipeIngredientNames: Map<string, string[]>;
}

export function crossContext(graph: Pick<MenuGraph, 'recipe_ingredients' | 'ingredients'>): CrossContext {
  const names = new Map(graph.ingredients.map((g) => [g.id, normalizeTerm(g.name)]));
  const byRecipe = new Map<string, string[]>();
  for (const line of graph.recipe_ingredients) {
    if (line.deleted_at) continue;
    const name = names.get(line.ingredient_id);
    if (name) byRecipe.set(line.recipe_id, [...(byRecipe.get(line.recipe_id) ?? []), name]);
  }
  return { ingredientNames: [...names.values()], recipeIngredientNames: byRecipe };
}

/** La única función de cruce entre una restricción (texto libre de Booking) y un plato. `null` si no coincide. */
export function crossRestriction(subject: string, recipe: Recipe, context: CrossContext): Crossing | null {
  const term = normalizeTerm(subject);
  const allergens = allergensForSubject(subject);
  const words = allergens.flatMap((a) => ALLERGEN_TERMS[a]);
  const ingredients = context.recipeIngredientNames.get(recipe.id) ?? [];
  const text = dishText(recipe);
  const found: Crossing = {
    declared: allergens.find((a) => recipe.allergens.includes(a)) ?? null,
    ingredient: term !== '' && ingredients.some((name) => name.includes(term)),
    ingredientAllergen: ingredients.some((name) => words.some((w) => name.includes(w))),
    text: (term !== '' && text.includes(term)) || words.some((w) => text.includes(w)),
  };
  return found.declared || found.ingredient || found.ingredientAllergen || found.text ? found : null;
}

/** ¿Se puede comprobar automáticamente? Como antes de la tanda 27: un alérgeno conocido o un ingrediente que lo nombra. */
export function verifiableSubject(subject: string, context: CrossContext): boolean {
  const term = normalizeTerm(subject);
  return allergensForSubject(subject).length > 0 || (term !== '' && context.ingredientNames.some((name) => name.includes(term)));
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
  const context = crossContext(graph);
  const usedRecipes = [...new Set(items.map((i) => i.recipe_id))].map((id) => recipes.get(id)).filter((r): r is Recipe => !!r);
  const restrictions = event.dietary_restrictions ?? [];
  const hasAllergy = restrictions.some((r) => r.type === 'alergia' || r.type === 'intolerancia');

  for (const restriction of restrictions) {
    const rKey = restrictionKey(restriction);
    const count = people(restriction);
    if (restriction.type === 'alergia' || restriction.type === 'intolerancia') {
      const subject = (restriction.subject ?? '').trim();
      // Lo que no se sabe cruzar se revisa a mano; aun así, se avisa del plato que lo nombra.
      if (!verifiableSubject(subject, context)) {
        warnings.push({ key: `no_verificable|${rKey}`, kind: 'no_verificable', requiresAck: true,
          text: `${count} ${restriction.type} a «${subject || 'sin especificar'}»: no se puede comprobar automáticamente, revisar a mano.` });
      }
      for (const item of items) {
        const recipe = recipes.get(item.recipe_id);
        if (!recipe) continue;
        const hit = crossRestriction(subject, recipe, context);
        if (!hit) continue;
        // Los textos de antes no cambian («declara» y «lleva»); lo nuevo dice de dónde sale.
        const why = hit.declared ? `declara ${ALLERGEN_NAMES[hit.declared]}`
          : hit.ingredient ? `lleva ${subject}`
          : hit.ingredientAllergen ? `lleva un ingrediente con ${subject}`
          : `nombra ${subject} en su nombre o descripción`;
        warnings.push({ key: `alergia|${rKey}|${item.id}`, kind: 'alergia', requiresAck: true,
          text: `«${recipe.name}» ${why}: ${count} ${restriction.type} a ${subject}.` });
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
      // Plato a plato, solo como información: «lleva cilantro».
      const subject = (restriction.subject ?? '').trim();
      if (normalizeTerm(subject)) {
        for (const item of items) {
          const recipe = recipes.get(item.recipe_id);
          if (recipe && crossRestriction(subject, recipe, context)) {
            warnings.push({ key: `preferencia|${rKey}|${item.id}`, kind: 'preferencia', requiresAck: false,
              text: `«${recipe.name}» lleva ${subject}: ${count} ${restriction.type}.` });
          }
        }
      }
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
  // Una receta del menú necesita una máquina averiada o fuera de servicio (F-MAQ-2): informa, no pide aceptación.
  if (graph.equipment && graph.recipe_equipment) {
    const machines = new Map(graph.equipment.filter((m) => !m.deleted_at).map((m) => [m.id, m]));
    for (const recipe of usedRecipes) {
      for (const need of graph.recipe_equipment.filter((n) => !n.deleted_at && n.recipe_id === recipe.id)) {
        const machine = machines.get(need.equipment_id);
        if (machine && (machine.status === 'averiado' || machine.status === 'fuera_de_servicio')) {
          warnings.push({ key: `maquinaria|${recipe.id}|${machine.id}`, kind: 'maquinaria', requiresAck: false,
            text: `«${recipe.name}» necesita ${machine.name} (${machine.status === 'averiado' ? 'averiado' : 'fuera de servicio'}).` });
        }
      }
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Tanda 27: el mismo cruce para Cocina, el Organizador y el Recetario
// ---------------------------------------------------------------------------

/** Palabras con las que Booking suele decir que una alergia es grave. `severity` es texto libre y puede no venir. */
const SEVERE_WORDS = new Set(['grave', 'severa', 'severo', 'anafilaxia', 'anafilactica', 'anafilactico', 'critica', 'critico', 'epipen', 'adrenalina']);

/** ¿Dice el texto libre de Booking que es grave? Sin texto, no se sabe: `false` (no se destaca, pero se ve igual). */
export function isSevere(severity: string | null | undefined): boolean {
  const words = (severity ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z]+/);
  return words.some((w) => SEVERE_WORDS.has(w) || SEVERE_WORDS.has(w.replace(/s$/, '')));
}

export interface RestrictionLine {
  key: string;
  type: 'alergia' | 'intolerancia';
  subject: string;
  people: number;
  severe: boolean;
  severity: string | null;
}

/**
 * Las alergias e intolerancias del grupo, todas, con su número de personas: lo que la línea plegada de Cocina enseña
 * siempre (regla de VG del 19-10-2026). Las graves primero, para destacarlas; ninguna se oculta.
 */
export function restrictionLines(restrictions: DietaryRestriction[] | null | undefined): RestrictionLine[] {
  return (restrictions ?? [])
    .filter((r) => r.type === 'alergia' || r.type === 'intolerancia')
    .map((r) => ({ key: restrictionKey(r), type: r.type as 'alergia' | 'intolerancia', subject: (r.subject ?? '').trim() || 'sin especificar',
      people: people(r), severe: isSevere(r.severity), severity: r.severity?.trim() || null }))
    .sort((a, b) => Number(b.severe) - Number(a.severe));
}

export interface DishMatch {
  restriction: RestrictionLine | { key: string; type: string; subject: string; people: number; severe: false; severity: null };
  crossing: Crossing;
}

/** Lo que un plato dice frente al grupo, para Cocina y la hoja del Organizador. */
export interface DishNotes {
  itemId: string;
  recipeId: string;
  /** Alergias e intolerancias que coinciden: «⚠ lleva…». */
  allergies: DishMatch[];
  /** Preferencias que coinciden: «lleva cilantro», solo información. */
  preferences: DishMatch[];
  /** Hay alergias o intolerancias en el grupo y la receta no tiene los alérgenos revisados: «Alérgenos sin revisar». */
  unreviewed: boolean;
}

/**
 * Plato a plato, con `crossRestriction`. Nunca dice «apto» ni «no contiene»: un plato sin nada es solo un plato sin
 * coincidencias, y si no está revisado y hay alergias en el grupo, lo dice.
 */
export function dishNotes(event: Pick<FoodEvent, 'dietary_restrictions'>, graph: MenuGraph): DishNotes[] {
  const context = crossContext(graph);
  const recipes = new Map(graph.recipes.map((r) => [r.id, r]));
  const services = new Set(graph.services.filter((s) => !s.deleted_at).map((s) => s.id));
  const restrictions = event.dietary_restrictions ?? [];
  const allergies = restrictionLines(restrictions);
  const others = restrictions.filter((r) => !(r.type === 'alergia' || r.type === 'intolerancia') && !(r.type in DIET_LABEL) && normalizeTerm(r.subject ?? ''))
    .map((r) => ({ key: restrictionKey(r), type: r.type, subject: (r.subject ?? '').trim(), people: people(r), severe: false as const, severity: null }));
  const out: DishNotes[] = [];
  for (const item of graph.items) {
    if (item.deleted_at || !services.has(item.service_id)) continue;
    const recipe = recipes.get(item.recipe_id);
    if (!recipe) continue;
    const match = <T extends { subject: string }>(list: T[]) => list.flatMap((r) => {
      const crossing = r.subject === 'sin especificar' ? null : crossRestriction(r.subject, recipe, context);
      return crossing ? [{ restriction: r, crossing }] : [];
    });
    out.push({ itemId: item.id, recipeId: recipe.id, allergies: match(allergies), preferences: match(others),
      unreviewed: allergies.length > 0 && !recipe.allergens_checked });
  }
  return out;
}

/**
 * Filtro «Lleva X / Sin X» del Recetario (tanda 27; sustituye a «Apto para…», que choca con la regla común):
 * - `lleva`: la declara, o la nombran sus ingredientes o su texto;
 * - `sin_revisar`: no la declara ni la nombra, pero la receta no tiene los alérgenos revisados (va marcada en «Sin X»);
 * - `no_declara`: revisada y sin rastro. Nunca se rotula «apto» ni «no contiene».
 */
export function allergenPresence(recipe: Recipe, allergen: Allergen, context: CrossContext): 'lleva' | 'sin_revisar' | 'no_declara' {
  const words = ALLERGEN_TERMS[allergen];
  const named = (text: string) => words.some((w) => text.includes(w));
  if (recipe.allergens.includes(allergen) || named(dishText(recipe)) || (context.recipeIngredientNames.get(recipe.id) ?? []).some(named)) return 'lleva';
  return recipe.allergens_checked ? 'no_declara' : 'sin_revisar';
}

/** Un alérgeno que nombran los ingredientes o el texto del plato y la receta no declara. */
export interface UndeclaredAllergen {
  allergen: Allergen;
  /** El primer ingrediente que lo nombra («almendra molida»), o `null` si solo lo nombra el texto del plato. */
  ingredient: string | null;
  /** El nombre, el nombre público o la descripción del plato lo nombran. */
  inText: boolean;
}

/**
 * Alérgenos que el plato nombra y la receta no declara: «almendra molida» entre los ingredientes, o «Tarta de almendra»
 * en el nombre o la descripción. Decisión de Core Sevilla (20-10-2026), con MUELA-086 (tanda 30): aviso en la ficha de
 * receta y comprobación en rojo del Organizador; la hoja impresa dice lo que **declara** y marca el plato.
 * Sale de la única función de cruce, `crossRestriction`, con el nombre de cada alérgeno como restricción: mira lo mismo
 * que el resto (ingredientes y texto del plato), y lo que no sabe mirar no lo afirma.
 */
export function undeclaredAllergens(recipe: Recipe, context: CrossContext): UndeclaredAllergen[] {
  const out: UndeclaredAllergen[] = [];
  for (const allergen of Object.keys(ALLERGEN_NAMES) as Allergen[]) {
    if (recipe.allergens.includes(allergen)) continue;
    const hit = crossRestriction(ALLERGEN_NAMES[allergen], recipe, context);
    if (!hit || !(hit.ingredient || hit.ingredientAllergen || hit.text)) continue;
    const words = ALLERGEN_TERMS[allergen];
    const ingredient = (context.recipeIngredientNames.get(recipe.id) ?? []).find((name) => words.some((w) => name.includes(w))) ?? null;
    out.push({ allergen, ingredient, inText: hit.text });
  }
  return out;
}

/** «El ingrediente «almendra molida» nombra frutos de cáscara…» / «El nombre o la descripción del plato nombran…». */
export function undeclaredText(u: UndeclaredAllergen): string {
  const what = ALLERGEN_NAMES[u.allergen];
  return u.ingredient
    ? `El ingrediente «${u.ingredient}» nombra ${what}, que la receta no declara: revisa los alérgenos.`
    : `El nombre o la descripción del plato nombran ${what}, que la receta no declara: revisa los alérgenos.`;
}

/** Claves que hay que aceptar una a una para poder validar. */
export function requiredAcknowledgements(warnings: MenuWarning[]): string[] {
  return warnings.filter((w) => w.requiresAck).map((w) => w.key);
}
