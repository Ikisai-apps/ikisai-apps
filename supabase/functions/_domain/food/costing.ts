/**
 * Ikisai Food · coste estimado a partir de las compras reales de Invoices (`invoices.food_stock_projection`).
 * Precio medio por ingrediente = importe asignado ÷ cantidad asignada en la unidad base de su familia (g, ml o la propia
 * unidad). Manda la unidad normalizada por Invoices (`unit_normalized`: kg, l o ud, con `quantity_normalized`); si viene
 * vacía, se interpreta el texto de la factura. Solo cuentan las compras con unidad reconocida; nunca se convierte entre
 * familias (kg no es unidad).
 */
import type { MenuGraph } from './warnings.ts';
import { scaledIngredients } from './planning.ts';
import { toBase, unitFamily, type Unit, type UnitFamily } from './units.ts';

/** Fila de `invoices.food_stock_projection` (asignaciones de líneas de factura a Food). */
export interface FoodPurchase {
  allocation_id: string;
  target_kind: string;
  target_id: string;
  invoice_date: string | null;
  supplier_name: string | null;
  line_description: string | null;
  allocated_quantity: number | string | null;
  unit: string | null;
  allocated_amount: number | string | null;
  /** Unidad canónica de Invoices (migración 0203): `kg`, `l` o `ud`; null si no la reconoce. */
  unit_normalized?: string | null;
  /** Cantidad asignada en `unit_normalized`. */
  quantity_normalized?: number | string | null;
}

const NORMALIZED: Record<string, Unit> = { kg: 'kg', l: 'l', ud: 'unidad' };

/** Unidad y cantidad de una compra: la normalizada de Invoices si existe; si no, la del texto de la factura. */
export function purchaseQuantity(p: FoodPurchase): { unit: Unit; quantity: number } | null {
  const normalized = p.unit_normalized ? NORMALIZED[p.unit_normalized] : undefined;
  if (normalized && Number(p.quantity_normalized) > 0) return { unit: normalized, quantity: Number(p.quantity_normalized) };
  const unit = purchaseUnit(p.unit);
  const quantity = Number(p.allocated_quantity);
  return unit && quantity > 0 ? { unit, quantity } : null;
}

export interface IngredientPrice {
  ingredient_id: string;
  family: UnitFamily;
  /** Euros por unidad base (por gramo, por mililitro o por unidad). */
  perBase: number;
  /** Compras que entran en el precio. */
  purchases: number;
  lastDate: string | null;
  /** Sin compras en los últimos 3 meses: es el precio de la última compra (`lastDate`) y hay que avisarlo. */
  stale: boolean;
}

/** Ventana del precio medio (decisión del usuario del 6 de octubre de 2026). */
export const PRICE_WINDOW_MONTHS = 3;

const UNIT_WORDS: Record<string, Unit> = {
  g: 'g', gr: 'g', grs: 'g', gramo: 'g', gramos: 'g',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogramo: 'kg', kilogramos: 'kg',
  ml: 'ml', mililitro: 'ml', mililitros: 'ml',
  l: 'l', lt: 'l', lts: 'l', litro: 'l', litros: 'l',
  u: 'unidad', ud: 'unidad', uds: 'unidad', un: 'unidad', und: 'unidad', unidad: 'unidad', unidades: 'unidad', pieza: 'unidad', piezas: 'unidad',
  paquete: 'paquete', paquetes: 'paquete', paq: 'paquete', pack: 'paquete',
  manojo: 'manojo', manojos: 'manojo',
};

/** Unidad de Food que corresponde al texto de la factura («Kg», «litros», «ud.»), o `null` si no se reconoce. */
export function purchaseUnit(text: string | null | undefined): Unit | null {
  const key = (text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  return UNIT_WORDS[key] ?? null;
}

/** Fecha (AAAA-MM-DD) desde la que cuenta el precio medio: hoy menos tres meses. */
export function priceWindowStart(today: Date = new Date()): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - PRICE_WINDOW_MONTHS, today.getUTCDate()));
  return d.toISOString().slice(0, 10);
}

/**
 * Precio por ingrediente y familia de unidad (decisión del usuario): media ponderada de las compras de los últimos
 * tres meses; si no hay compras en ese periodo, el precio de la última compra, marcado `stale` para avisarlo.
 * Una compra sin fecha cuenta como antigua.
 */
export function ingredientPrices(purchases: FoodPurchase[], today: Date = new Date()): Map<string, IngredientPrice[]> {
  const since = priceWindowStart(today);
  const groups = new Map<string, Array<{ ingredient_id: string; family: UnitFamily; amount: number; base: number; date: string | null }>>();
  for (const p of purchases) {
    if (p.target_kind !== 'ingredient') continue;
    const read = purchaseQuantity(p);
    const amount = Number(p.allocated_amount);
    if (!read || !(amount >= 0)) continue;
    const family = unitFamily(read.unit);
    const key = `${p.target_id}|${family}`;
    const list = groups.get(key) ?? [];
    list.push({ ingredient_id: p.target_id, family, amount, base: toBase(read.quantity, read.unit), date: p.invoice_date });
    groups.set(key, list);
  }
  const out = new Map<string, IngredientPrice[]>();
  for (const list of groups.values()) {
    const first = list[0]!;
    const recent = list.filter((x) => x.date !== null && x.date >= since);
    const lastDate = list.reduce<string | null>((max, x) => (x.date && (!max || x.date > max) ? x.date : max), null);
    let price: IngredientPrice;
    if (recent.length) {
      const amount = recent.reduce((sum, x) => sum + x.amount, 0);
      const base = recent.reduce((sum, x) => sum + x.base, 0);
      price = { ingredient_id: first.ingredient_id, family: first.family, perBase: amount / base, purchases: recent.length, lastDate, stale: false };
    } else {
      // La más reciente; entre compras sin fecha, la última de la lista.
      const last = list.reduce((best, x) => ((x.date ?? '') >= (best.date ?? '') ? x : best), first);
      price = { ingredient_id: first.ingredient_id, family: first.family, perBase: last.amount / last.base, purchases: 1, lastDate: last.date, stale: true };
    }
    const prices = out.get(first.ingredient_id) ?? [];
    prices.push(price);
    out.set(first.ingredient_id, prices);
  }
  return out;
}

/** Precio que se aplica a un ingrediente en una unidad, si hay alguno compatible. */
export function priceFor(ingredientId: string, unit: Unit, prices: Map<string, IngredientPrice[]>): IngredientPrice | undefined {
  return prices.get(ingredientId)?.find((p) => p.family === unitFamily(unit));
}

export interface DishCost {
  /** Coste de lo que tiene precio. */
  amount: number;
  /** Ingredientes sin compra con unidad compatible: el coste real es mayor. */
  missing: string[];
  /** Ingredientes con el precio de su última compra, de hace más de tres meses: hay que avisarlo. */
  stale: string[];
}

/** Coste de un plato a sus raciones: cantidades escaladas × precio de cada ingrediente. */
export function dishCost(graph: MenuGraph, itemId: string, prices: Map<string, IngredientPrice[]>): DishCost {
  let amount = 0;
  const missing = new Set<string>();
  const stale = new Set<string>();
  for (const line of scaledIngredients(graph, itemId)) {
    const price = priceFor(line.ingredient_id, line.unit, prices);
    if (!price) { missing.add(line.ingredient_id); continue; }
    if (price.stale) stale.add(line.ingredient_id);
    amount += toBase(line.quantity, line.unit) * price.perBase;
  }
  return { amount: Math.round(amount * 100) / 100, missing: [...missing], stale: [...stale] };
}

export interface ServiceCost {
  service_id: string;
  amount: number;
  servings: number;
  missing: string[];
  stale: string[];
}

/** Coste por servicio: suma de sus platos vivos; `servings` es la mayor ración de un plato (las personas que comen). */
export function serviceCosts(graph: MenuGraph, prices: Map<string, IngredientPrice[]>): ServiceCost[] {
  return graph.services.filter((s) => !s.deleted_at).map((service) => {
    const items = graph.items.filter((i) => !i.deleted_at && i.service_id === service.id);
    const missing = new Set<string>();
    const stale = new Set<string>();
    let amount = 0;
    for (const item of items) {
      const cost = dishCost(graph, item.id, prices);
      amount += cost.amount;
      cost.missing.forEach((id) => missing.add(id));
      cost.stale.forEach((id) => stale.add(id));
    }
    return { service_id: service.id, amount: Math.round(amount * 100) / 100, servings: Math.max(0, ...items.map((i) => Number(i.servings))), missing: [...missing], stale: [...stale] };
  });
}

/** Coste de una cantidad de un ingrediente, o `null` si no hay precio con unidad compatible. */
export function lineCost(ingredientId: string, quantity: number, unit: Unit, prices: Map<string, IngredientPrice[]>): number | null {
  const price = priceFor(ingredientId, unit, prices);
  return price ? Math.round(toBase(quantity, unit) * price.perBase * 100) / 100 : null;
}

/** Coste total de varios menús de una vez, con cuántos ingredientes no tienen precio y cuántos lo tienen antiguo. */
export function menuTotals(graphs: Map<string, MenuGraph>, prices: Map<string, IngredientPrice[]>): Map<string, { total: number; missing: number; stale: number }> {
  const out = new Map<string, { total: number; missing: number; stale: number }>();
  for (const [menuId, graph] of graphs) {
    const costs = serviceCosts(graph, prices);
    out.set(menuId, {
      total: Math.round(costs.reduce((sum, c) => sum + c.amount, 0) * 100) / 100,
      missing: new Set(costs.flatMap((c) => c.missing)).size,
      stale: new Set(costs.flatMap((c) => c.stale)).size,
    });
  }
  return out;
}
