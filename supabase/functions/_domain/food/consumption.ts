/**
 * Ikisai Food · R5c: consumo al acabar el servicio (RECURSOS.md §6 «Food»; decisión del usuario del 14-10-2026;
 * docs/food/API.md §2.8).
 *
 * - A las 2 h de la hora del servicio (sin hora, al final del día) su consumo queda **por confirmar**: «Confirmar
 *   consumo» trae lo que piden sus platos, escalado a sus raciones, para corregir cantidades o marcar «No se hizo».
 * - Si nadie lo confirma, **a las 24 h se descuenta solo** con lo previsto.
 * - Se descuenta en Recursos con `resources.consume` (primero lo que caduca antes), con `source_ref = 'menu_item:<id>'`,
 *   y queda anotado en `food.consumptions`. Solo cuenta desde `CONSUMPTION_SINCE`: lo anterior no se descuenta.
 */
import type { SyncedColumns } from './catalog.ts';
import type { MenuService } from './menus.ts';
import type { MenuGraph } from './warnings.ts';
import { scaledIngredients } from './planning.ts';
import { itemUnitFactor, type ItemConversion, type MovementLike, type ResourceItem } from './resources.ts';
import type { Unit } from './units.ts';

export interface Consumption extends SyncedColumns {
  menu_item_id: string;
  status: 'confirmado' | 'omitido';
  automatic: boolean;
  notes: string | null;
}

/** Primer día con consumo: el de la publicación de R5c. Los servicios anteriores no se descuentan nunca. */
export const CONSUMPTION_SINCE = '2026-10-15';
/** Minutos tras la hora del servicio en que su consumo queda por confirmar. */
export const CONSUMPTION_DUE_MINUTES = 120;
/** Horas tras quedar por confirmar en que se descuenta solo (lo hace el worker de Food en el servidor). */
export const CONSUMPTION_AUTO_HOURS = 24;
/**
 * Respaldo en la app: si a las 26 h el worker no lo ha hecho (sin cuenta de servicio, por ejemplo), lo descuenta la app
 * de un editor. Las 2 h de margen evitan que los dos lo hagan a la vez.
 */
export const CONSUMPTION_FALLBACK_HOURS = 26;

export const menuItemRef = (id: string) => `menu_item:${id}`;

/** Cuándo queda por confirmar: la hora del servicio + 2 h, o el final del día si no tiene hora (hora local). */
export function consumptionDue(service: Pick<MenuService, 'service_date' | 'service_time'>): Date {
  if (!service.service_time) return new Date(`${service.service_date}T23:59:00`);
  const at = new Date(`${service.service_date}T${service.service_time.slice(0, 5)}:00`);
  return new Date(at.getTime() + CONSUMPTION_DUE_MINUTES * 60_000);
}

export type ConsumptionState = 'antes' | 'por_confirmar' | 'automatico' | 'hecho' | 'no_aplica';

/**
 * Estado del consumo de un servicio. `pending` son sus platos sin consumo anotado ni movimientos en Recursos.
 * `no_aplica`: anterior a `CONSUMPTION_SINCE`, borrado o sin platos.
 */
export function serviceConsumption(
  service: Pick<MenuService, 'id' | 'service_date' | 'service_time' | 'deleted_at'>,
  graph: Pick<MenuGraph, 'items'>,
  consumptions: Array<Pick<Consumption, 'menu_item_id' | 'deleted_at'>>,
  movements: Array<Pick<MovementLike, 'source_ref' | 'deleted_at'>>,
  now: Date,
): { state: ConsumptionState; pending: string[]; due: Date } {
  const due = consumptionDue(service);
  const items = graph.items.filter((i) => i.service_id === service.id && !i.deleted_at);
  if (service.deleted_at || service.service_date < CONSUMPTION_SINCE || !items.length) return { state: 'no_aplica', pending: [], due };
  const noted = new Set(consumptions.filter((c) => !c.deleted_at).map((c) => c.menu_item_id));
  const moved = new Set(movements.filter((m) => !m.deleted_at && m.source_ref).map((m) => m.source_ref));
  const pending = items.filter((i) => !noted.has(i.id) && !moved.has(menuItemRef(i.id))).map((i) => i.id);
  if (!pending.length) return { state: 'hecho', pending, due };
  if (now < due) return { state: 'antes', pending, due };
  return { state: now.getTime() >= due.getTime() + CONSUMPTION_AUTO_HOURS * 3_600_000 ? 'automatico' : 'por_confirmar', pending, due };
}

export interface ConsumptionLine {
  ingredientId: string;
  name: string;
  quantity: number;
  unit: Unit;
  /** Artículo de Recursos y su unidad base; `null` si no se puede descontar (`reason`). */
  itemId: string | null;
  baseUnit: string | null;
  /** Unidades base en una unidad de la línea (`itemUnitFactor`). */
  factor: number | null;
  reason: 'sin_articulo' | 'sin_conversion' | null;
}

/** Lo que gasta un plato: sus ingredientes escalados a sus raciones, con su artículo y si se puede descontar. */
export function consumptionLines(
  graph: MenuGraph,
  itemId: string,
  items: Array<Pick<ResourceItem, 'id' | 'base_unit' | 'deleted_at'>>,
  conversions: ItemConversion[] = [],
): ConsumptionLine[] {
  const ingredients = new Map(graph.ingredients.map((g) => [g.id, g as typeof g & { item_id?: string | null }]));
  return scaledIngredients(graph, itemId).map((line) => {
    const ingredient = ingredients.get(line.ingredient_id);
    const article = ingredient?.item_id ? items.find((i) => i.id === ingredient.item_id && !i.deleted_at) : undefined;
    const factor = article ? itemUnitFactor(line.unit, article.base_unit, article.id, conversions) : null;
    return {
      ingredientId: line.ingredient_id, name: ingredient?.name ?? '—', quantity: line.quantity, unit: line.unit,
      itemId: article?.id ?? null, baseUnit: article?.base_unit ?? null, factor,
      reason: !article ? 'sin_articulo' : factor !== null ? null : 'sin_conversion',
    };
  });
}

/**
 * La llamada a `resources.consume` de una línea (en su unidad, ya corregida), o `null` si no hay nada que descontar.
 * `spaceIds`: los sitios de cocina; `fallbackSpaceId`: dónde apuntar lo que falte si el stock no alcanza.
 */
export function consumeCall(args: { line: ConsumptionLine; quantity: number; menuItemId: string; spaceIds: string[]; fallbackSpaceId: string | null; note: string }):
  { op: 'call'; procedure: 'resources.consume'; args: Record<string, unknown> } | null {
  if (!args.line.itemId || args.line.factor === null || !(args.quantity > 0)) return null;
  const base = Math.round(args.quantity * args.line.factor * 1e6) / 1e6;
  if (!(base > 0)) return null;
  return {
    op: 'call', procedure: 'resources.consume',
    args: {
      // `once` (Recursos, 0806): si ese plato ya descontó este artículo (el worker, otro dispositivo), no hace nada. El origen
      // (`source_app`) lo pone Recursos con la app del lote (FO4, 0820): desde el navegador no se manda.
      item_id: args.line.itemId, quantity: base, kind: 'consumo_servicio', source_ref: menuItemRef(args.menuItemId), note: args.note, once: true,
      ...(args.spaceIds.length ? { space_ids: args.spaceIds } : {}), ...(args.fallbackSpaceId ? { default_space_id: args.fallbackSpaceId } : {}),
    },
  };
}
