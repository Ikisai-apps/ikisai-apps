/**
 * Food · lo que hace falta y lo que hay en casa (Bloque 2, MUELA-077 §2, con `PERDIDAS_food_bloque2.md` §1 y §2;
 * aprobado por VG el 20-10-2026).
 *
 * - La ficha de receta compara con las raciones del **próximo servicio** en que sale la receta; si no sale en ninguno,
 *   con las de la receta, y lo dice. Solo cuenta esta receta.
 * - «Hay bastante» es un veredicto: solo se dice si nada lo pone en duda. Lo ponen en duda otra receta del mismo
 *   servicio que usa el ingrediente y un consumo que aún no se ha descontado (por confirmar o descontándose solo).
 * - «No hay en casa» (stock 0) no es «Sin seguimiento en Recursos» (sin artículo o sin movimientos).
 * - Las cantidades, en la unidad legible y con plural: «1,5 l», «8 unidades», «500 g».
 */
import { serviceConsumption, type Consumption } from './consumption.ts';
import { localAt, localDayKey, SERVICE_NOW_MINUTES } from './kitchen.ts';
import type { MenuGraph } from './warnings.ts';
import type { Menu, MenuItem, MenuService } from './menus.ts';
import type { RecipeIngredient } from './catalog.ts';
import { fromItemBase, kitchenStock, type LotLike, type MovementLike } from './resources.ts';
import type { Unit } from './units.ts';

const PLURAL: Record<string, [string, string]> = {
  unidad: ['unidad', 'unidades'], ud: ['unidad', 'unidades'], paquete: ['paquete', 'paquetes'], manojo: ['manojo', 'manojos'],
};
const number = (n: number) => n.toLocaleString('es-ES', { maximumFractionDigits: 3 });

/** «1,5 l», «500 g», «1 unidad», «8 unidades»: de g y ml a kg y l desde 1000; el plural, en palabras. */
export function readableQuantity(quantity: number, unit: string): string {
  const q = Math.round(quantity * 1000) / 1000;
  if ((unit === 'g' || unit === 'ml') && Math.abs(q) >= 1000) return `${number(q / 1000)} ${unit === 'g' ? 'kg' : 'l'}`;
  const words = PLURAL[unit];
  if (words) return `${number(q)} ${q === 1 ? words[0] : words[1]}`;
  return `${number(q)} ${unit}`;
}

const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const LONG_WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
/** «sáb 17». */
export function weekdayShort(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}`;
}
/** «el sábado 17». */
export function weekdayLong(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return `${LONG_WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}`;
}

/** El servicio ya pasó: con hora, 90 minutos después; sin hora, al acabar el día. */
function serviceOver(service: Pick<MenuService, 'service_date' | 'service_time'>, now: Date): boolean {
  const today = localDayKey(now);
  if (service.service_date !== today) return service.service_date < today;
  const at = localAt(service.service_date, service.service_time);
  return !!at && now.getTime() > at.getTime() + SERVICE_NOW_MINUTES * 60_000;
}

export interface RecipeService {
  service: MenuService;
  /** Las raciones de la receta en ese servicio (si sale dos veces, la suma). */
  servings: number;
}

/** El próximo servicio (de un menú vivo y no cerrado) en el que sale la receta; `null` si no sale en ninguno. */
export function nextRecipeService(
  recipeId: string,
  data: { menus: Array<Pick<Menu, 'id' | 'status' | 'deleted_at'>>; services: MenuService[]; items: MenuItem[] },
  now: Date,
): RecipeService | null {
  const live = new Set(data.menus.filter((m) => !m.deleted_at && m.status !== 'cerrado').map((m) => m.id));
  const withRecipe = new Set(data.items.filter((i) => !i.deleted_at && i.recipe_id === recipeId).map((i) => i.service_id));
  const next = data.services
    .filter((s) => !s.deleted_at && live.has(s.menu_id) && withRecipe.has(s.id) && !serviceOver(s, now))
    .sort((a, b) => a.service_date.localeCompare(b.service_date) || (a.service_time ?? '99').localeCompare(b.service_time ?? '99') || Number(a.position) - Number(b.position))[0];
  if (!next) return null;
  const servings = data.items.filter((i) => !i.deleted_at && i.service_id === next.id && i.recipe_id === recipeId).reduce((sum, i) => sum + Number(i.servings), 0);
  return { service: next, servings };
}

/** Por ingrediente, las otras recetas del mismo servicio que también lo usan (por nombre). */
export function serviceShares(serviceId: string, recipeId: string, graph: Pick<MenuGraph, 'items' | 'recipes' | 'recipe_ingredients'>): Map<string, string[]> {
  const others = new Set(graph.items.filter((i) => !i.deleted_at && i.service_id === serviceId && i.recipe_id !== recipeId).map((i) => i.recipe_id));
  const out = new Map<string, string[]>();
  for (const line of graph.recipe_ingredients) {
    if (line.deleted_at || !others.has(line.recipe_id)) continue;
    const name = graph.recipes.find((r) => r.id === line.recipe_id)?.name;
    if (!name) continue;
    const names = out.get(line.ingredient_id) ?? [];
    if (!names.includes(name)) out.set(line.ingredient_id, [...names, name]);
  }
  return out;
}

/**
 * Por ingrediente, los días de los servicios cuyo consumo aún no ha bajado el stock: «Consumo por confirmar» o «Se está
 * descontando solo». Durante ese rato el stock dice más de lo que hay.
 */
export function pendingConsumption(
  graph: MenuGraph,
  consumptions: Array<Pick<Consumption, 'menu_item_id' | 'deleted_at'>>,
  movements: Array<Pick<MovementLike, 'source_ref' | 'deleted_at'>>,
  now: Date,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const service of graph.services) {
    const { state, pending } = serviceConsumption(service, graph, consumptions, movements, now);
    if (state !== 'por_confirmar' && state !== 'automatico') continue;
    const recipes = new Set(graph.items.filter((i) => pending.includes(i.id)).map((i) => i.recipe_id));
    for (const line of graph.recipe_ingredients) {
      if (line.deleted_at || !recipes.has(line.recipe_id)) continue;
      const days = out.get(line.ingredient_id) ?? [];
      if (!days.includes(service.service_date)) out.set(line.ingredient_id, [...days, service.service_date].sort());
    }
  }
  return out;
}

export type NeedState = 'bastante' | 'en_duda' | 'faltan' | 'no_hay' | 'sin_seguimiento' | 'sin_conversion';

export interface IngredientNeed {
  ingredientId: string;
  name: string;
  /** Lo que hace falta, en la unidad de la línea (a las raciones del servicio o a las de la receta). */
  need: number;
  unit: Unit;
  /** Lo que dice la receta escrita, a sus raciones base. */
  recipeQuantity: number;
  itemId: string | null;
  /** Lo que hay en casa en la unidad de la línea; `null` sin seguimiento o sin conversión. */
  stock: number | null;
  /** Lo que hay en casa en la unidad del artículo (para «sin conversión»). */
  stockBase: number | null;
  baseUnit: string | null;
  /** Bajo el mínimo del artículo. */
  low: boolean;
  state: NeedState;
  sharedWith: string[];
  pendingDays: string[];
}

export interface StockView {
  items: Array<{ id: string; base_unit: string; min_quantity?: number | string | null; deleted_at?: string | null }>;
  movements: MovementLike[];
  lots: LotLike[];
  kitchen: Set<string>;
}

/** Lo que hace falta de cada ingrediente de la receta y lo que hay en casa, con su estado. */
export function ingredientNeeds(args: {
  lines: RecipeIngredient[];
  ingredients: Array<{ id: string; name: string; item_id?: string | null }>;
  baseServings: number;
  servings: number;
  stock: StockView | null;
  today: string;
  shares?: Map<string, string[]>;
  pending?: Map<string, string[]>;
}): IngredientNeed[] {
  const factor = args.baseServings > 0 ? args.servings / args.baseServings : 1;
  return args.lines.filter((l) => !l.deleted_at).sort((a, b) => Number(a.position) - Number(b.position)).map((line) => {
    const ingredient = args.ingredients.find((g) => g.id === line.ingredient_id);
    const need = Math.round(Number(line.quantity) * factor * 1000) / 1000;
    const article = ingredient?.item_id && args.stock?.kitchen.size ? args.stock.items.find((i) => i.id === ingredient.item_id && !i.deleted_at) : undefined;
    const base = article && args.stock ? kitchenStock(article.id, args.stock.movements, args.stock.lots, args.stock.kitchen, args.today) : null;
    const stock = base === null || !article ? null : fromItemBase(base, article.base_unit, line.unit);
    const min = Number(article?.min_quantity) || 0;
    const sharedWith = args.shares?.get(line.ingredient_id) ?? [];
    const pendingDays = args.pending?.get(line.ingredient_id) ?? [];
    const state: NeedState = !article || base === null ? 'sin_seguimiento'
      : base <= 0 ? 'no_hay'
        : stock === null ? 'sin_conversion'
          : stock < need ? 'faltan'
            : sharedWith.length || pendingDays.length ? 'en_duda' : 'bastante';
    return {
      ingredientId: line.ingredient_id, name: ingredient?.name ?? '—', need, unit: line.unit, recipeQuantity: Number(line.quantity),
      itemId: article?.id ?? null, stock, stockBase: base, baseUnit: article?.base_unit ?? null,
      low: base !== null && min > 0 && base < min, state, sharedWith, pendingDays,
    };
  });
}

/** «En casa 1,5 l» (o en la unidad del artículo si no se puede pasar a la de la receta). */
export function stockText(n: IngredientNeed): string | null {
  if (n.stock !== null) return readableQuantity(n.stock, n.unit);
  if (n.stockBase !== null && n.baseUnit) return readableQuantity(n.stockBase, n.baseUnit);
  return null;
}

/** El estado en palabras: «Hay bastante», «Faltan 4 unidades», «No hay en casa», «Sin seguimiento en Recursos»… */
export function needText(n: IngredientNeed): string {
  const doubts = [
    n.sharedWith.length ? `también lo usa ${n.sharedWith.map((x) => x.toLowerCase()).join(' y ')} del mismo servicio` : null,
    n.pendingDays.length ? `falta descontar lo gastado el ${n.pendingDays.map(weekdayShort).join(' y el ')}` : null,
  ].filter(Boolean).join(' · ');
  switch (n.state) {
    case 'sin_seguimiento': return 'Sin seguimiento en Recursos';
    case 'no_hay': return 'No hay en casa';
    case 'sin_conversion': return `En casa ${stockText(n)} · no se puede comparar con ${n.unit}`;
    case 'faltan': return [`Faltan ${readableQuantity(n.need - (n.stock ?? 0), n.unit)}`, doubts].filter(Boolean).join(' · ');
    case 'en_duda': return `En casa ${stockText(n)} · ${doubts}`;
    default: return 'Hay bastante';
  }
}

export type PantryAlertKind = 'caducado' | 'caduca_pronto' | 'bajo_minimo' | 'caduca_semana';

export interface PantryAlert {
  kind: PantryAlertKind;
  itemId: string;
  name: string;
  /** Texto de la fila: «caduca el lun 19 (en 2 días) · 30 unidades», «Bajo mínimo · quedan 1,5 l (mínimo 5 l)». */
  text: string;
}

const ALERT_ORDER: Record<PantryAlertKind, number> = { caducado: 0, caduca_pronto: 1, bajo_minimo: 2, caduca_semana: 3 };
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

/**
 * Lo urgente de la despensa para Inicio (Bloque 2, Inicio C, con `PERDIDAS_food_bloque2.md` §1 y §2): primero lo ya
 * caducado que sigue en la cocina, después lo que caduca en dos días, lo bajo mínimo y lo que caduca esa semana. Un
 * artículo sale una vez, por lo más urgente.
 */
export function pantryAlerts(
  inventory: {
    items: Array<{ id: string; name: string; kind: string; active?: boolean; base_unit: string; min_quantity?: number | string | null; deleted_at?: string | null }>;
    movements: MovementLike[];
    lots: LotLike[];
    kitchen: Set<string>;
  },
  today: string,
): PantryAlert[] {
  const items = new Map(inventory.items.filter((i) => !i.deleted_at && i.active !== false && ['ingrediente', 'bebida'].includes(i.kind)).map((i) => [i.id, i]));
  const best = new Map<string, PantryAlert & { order: number; day: string }>();
  const keep = (alert: PantryAlert, day: string) => {
    const order = ALERT_ORDER[alert.kind];
    const had = best.get(alert.itemId);
    if (!had || order < had.order || (order === had.order && day < had.day)) best.set(alert.itemId, { ...alert, order, day });
  };
  for (const lot of inventory.lots) {
    if (!lot.expires_on) continue;
    const rows = inventory.movements.filter((m) => !m.deleted_at && m.lot_id === lot.id && inventory.kitchen.has(m.space_id));
    const item = rows[0] ? items.get(rows[0].item_id) : undefined;
    const quantity = Math.round(rows.reduce((sum, m) => sum + Number(m.quantity), 0) * 1000) / 1000;
    if (!item || quantity <= 0) continue;
    const days = daysBetween(today, lot.expires_on);
    if (days > 7) continue;
    const amount = readableQuantity(quantity, item.base_unit);
    const when = days === 0 ? 'caduca hoy' : days === 1 ? 'caduca mañana' : `caduca el ${weekdayShort(lot.expires_on)} (en ${days} días)`;
    keep({
      kind: days < 0 ? 'caducado' : days <= 2 ? 'caduca_pronto' : 'caduca_semana', itemId: item.id, name: item.name,
      text: days < 0 ? `Caducado el ${weekdayShort(lot.expires_on)} · ${amount} en la cocina` : `${when} · ${amount}`,
    }, lot.expires_on);
  }
  for (const item of items.values()) {
    const min = Number(item.min_quantity) || 0;
    if (!min) continue;
    const stock = kitchenStock(item.id, inventory.movements, inventory.lots, inventory.kitchen, today) ?? 0;
    if (stock >= min) continue;
    keep({ kind: 'bajo_minimo', itemId: item.id, name: item.name, text: `Bajo mínimo · quedan ${readableQuantity(stock, item.base_unit)} (mínimo ${readableQuantity(min, item.base_unit)})` }, today);
  }
  return [...best.values()].sort((a, b) => a.order - b.order || a.day.localeCompare(b.day) || a.name.localeCompare(b.name, 'es'))
    .map(({ order: _o, day: _d, ...alert }) => alert);
}
