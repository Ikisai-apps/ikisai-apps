/**
 * Cocina contra el menú (pasada única, zona 3): qué requisitos del grupo se pueden comprobar con lo que declara el menú y
 * qué platos declaran un alérgeno del grupo. Puro y sin navegador (`tests/organizers/kitchen-state.test.ts`).
 *
 * Reglas de seguridad alimentaria (decisión del usuario):
 * - Solo se compara con los 14 alérgenos de la lista europea que **declara** cada plato (`dish.allergens`, códigos de Food).
 * - Lo que no es de esa lista nunca se calla: es «no se puede comprobar: lo revisa cocina». El nombre o la descripción del
 *   plato solo dan una **pista**, siempre con ese texto al lado.
 * - Nunca hay «apto», ni ✓ por plato, ni «no contiene»: un plato sin aciertos queda neutro.
 * - La gravedad solo va junto a un nombre compartido (`named`); en lo anónimo, nunca.
 * El cruce de términos es el de Food (`_domain/food/warnings.ts`, funciones puras declaradas comunes para el Organizador).
 */
// Ruta directa al dominio de Food (no un alias de Vite) para que las pruebas de Node puedan importarlo tal cual.
import { allergensForSubject, normalizeTerm } from '../../../../supabase/functions/_domain/food/warnings.ts';
import type { Allergen } from '../../../../supabase/functions/_domain/food/catalog.ts';
import type { KitchenSummary } from './api.ts';

/** Plato del menú compartido con el portal (`food.portal_menu`). */
export interface Dish {
  menu_item_id: string; name: string; description: string | null; category: string | null; diet_tags: string[] | null;
  allergens: string[] | null; allergens_checked?: boolean; photo_thumb_file_id: string | null;
}
export interface MenuService { service_id: string; menu_id: string; date: string; type: string; time: string | null; dishes: Dish[] }
export interface PortalMenu { available: boolean; status: 'provisional' | 'confirmado'; services: MenuService[] }

export type KitchenTotal = KitchenSummary['totals'][number];
export type KitchenNamed = KitchenSummary['named'][number];

/** Un requisito del grupo que cocina vigila: sus alérgenos de la lista europea (si los hay) y quién lo comparte. */
export interface Watched {
  r: KitchenTotal;
  allergens: Allergen[];
  /** Se puede comprobar con lo que declara el menú (corresponde a un alérgeno de la lista europea). */
  verifiable: boolean;
  /** Los que lo llevan con nombre (de quien organiza o compartido). */
  named: KitchenNamed[];
  /** Raciones sin nombre: de asistentes que no lo han compartido. */
  anonymous: number;
}

export interface DishCheck {
  service: MenuService;
  dish: Dish;
  declared: string[];
  unchecked: boolean;
  /** Requisitos verificables cuyos alérgenos declara el plato. */
  hits: Watched[];
  /** Requisitos no verificables que el nombre o la descripción del plato mencionan: solo una pista. */
  hints: Watched[];
}

export interface KitchenState {
  watched: Watched[];
  dishes: DishCheck[];
  /** Raciones de alergia e intolerancia (son requisitos, no personas). */
  allergyCount: number;
  /** Raciones sin nombre de los requisitos vigilados. */
  anonymousTotal: number;
}

const WATCHED_TYPES: ReadonlySet<string> = new Set(['alergia', 'intolerancia', 'otra']);
const DIET_ALLERGENS: Record<string, Allergen[]> = { sin_gluten: ['gluten'], sin_lactosa: ['lacteos'] };

const keyOf = (type: string, subject: string | null) => `${type}|${normalizeTerm(subject ?? '')}`;

export function kitchenStateOf(k: KitchenSummary, menu: PortalMenu | null): KitchenState {
  const watched: Watched[] = k.totals
    .filter((r) => WATCHED_TYPES.has(r.restriction_type) || DIET_ALLERGENS[r.restriction_type])
    .map((r) => {
      const allergens = DIET_ALLERGENS[r.restriction_type] ?? (r.subject ? allergensForSubject(r.subject) : []);
      const named = k.named.filter((n) => keyOf(n.restriction_type, n.subject) === keyOf(r.restriction_type, r.subject));
      return { r, allergens, verifiable: allergens.length > 0, named, anonymous: Math.max(0, r.servings - named.length) };
    });
  const dishes: DishCheck[] = [];
  if (menu?.available) {
    for (const service of menu.services) {
      for (const dish of service.dishes) {
        const declared = dish.allergens ?? [];
        const text = normalizeTerm([dish.name, dish.description].filter(Boolean).join(' '));
        dishes.push({
          service, dish, declared, unchecked: dish.allergens_checked !== true,
          hits: watched.filter((w) => w.verifiable && w.allergens.some((a) => declared.includes(a))),
          hints: watched.filter((w) => {
            if (w.verifiable) return false;
            const term = normalizeTerm(w.r.subject ?? '');
            return term !== '' && text.includes(term);
          }),
        });
      }
    }
  }
  return {
    watched,
    dishes,
    allergyCount: k.totals.filter((r) => r.restriction_type === 'alergia' || r.restriction_type === 'intolerancia').reduce((n, r) => n + r.servings, 0),
    anonymousTotal: watched.reduce((n, w) => n + w.anonymous, 0),
  };
}

/** Alérgenos del plato que coinciden con un requisito, en el orden en que los declara el plato. */
export const sharedAllergens = (w: Watched, d: DishCheck): string[] => d.declared.filter((a) => (w.allergens as string[]).includes(a));
