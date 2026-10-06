/**
 * Ikisai Food · coste estimado a partir de las compras reales de Invoices (`invoices.food_stock_projection`).
 * Precio medio por ingrediente = importe asignado ÷ cantidad asignada en la unidad base de su familia (g, ml o la propia
 * unidad). Solo cuentan las compras cuya unidad se reconoce; nunca se convierte entre familias (kg no es unidad).
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
}

export interface IngredientPrice {
  ingredient_id: string;
  family: UnitFamily;
  /** Euros por unidad base (por gramo, por mililitro o por unidad). */
  perBase: number;
  purchases: number;
  lastDate: string | null;
}

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

/** Precio medio ponderado por ingrediente y familia de unidad. */
export function ingredientPrices(purchases: FoodPurchase[]): Map<string, IngredientPrice[]> {
  const totals = new Map<string, { ingredient_id: string; family: UnitFamily; amount: number; base: number; purchases: number; lastDate: string | null }>();
  for (const p of purchases) {
    if (p.target_kind !== 'ingredient') continue;
    const unit = purchaseUnit(p.unit);
    const quantity = Number(p.allocated_quantity);
    const amount = Number(p.allocated_amount);
    if (!unit || !(quantity > 0) || !(amount >= 0)) continue;
    const family = unitFamily(unit);
    const key = `${p.target_id}|${family}`;
    const entry = totals.get(key) ?? { ingredient_id: p.target_id, family, amount: 0, base: 0, purchases: 0, lastDate: null };
    entry.amount += amount;
    entry.base += toBase(quantity, unit);
    entry.purchases += 1;
    if (p.invoice_date && (!entry.lastDate || p.invoice_date > entry.lastDate)) entry.lastDate = p.invoice_date;
    totals.set(key, entry);
  }
  const out = new Map<string, IngredientPrice[]>();
  for (const t of totals.values()) {
    const list = out.get(t.ingredient_id) ?? [];
    list.push({ ingredient_id: t.ingredient_id, family: t.family, perBase: t.amount / t.base, purchases: t.purchases, lastDate: t.lastDate });
    out.set(t.ingredient_id, list);
  }
  return out;
}

export interface DishCost {
  /** Coste de lo que tiene precio. */
  amount: number;
  /** Ingredientes sin compra con unidad compatible: el coste real es mayor. */
  missing: string[];
}

/** Coste de un plato a sus raciones: cantidades escaladas × precio medio de cada ingrediente. */
export function dishCost(graph: MenuGraph, itemId: string, prices: Map<string, IngredientPrice[]>): DishCost {
  let amount = 0;
  const missing = new Set<string>();
  for (const line of scaledIngredients(graph, itemId)) {
    const price = prices.get(line.ingredient_id)?.find((p) => p.family === unitFamily(line.unit));
    if (!price) { missing.add(line.ingredient_id); continue; }
    amount += toBase(line.quantity, line.unit) * price.perBase;
  }
  return { amount: Math.round(amount * 100) / 100, missing: [...missing] };
}

export interface ServiceCost {
  service_id: string;
  amount: number;
  servings: number;
  missing: string[];
}

/** Coste por servicio: suma de sus platos vivos; `servings` es la mayor ración de un plato (las personas que comen). */
export function serviceCosts(graph: MenuGraph, prices: Map<string, IngredientPrice[]>): ServiceCost[] {
  return graph.services.filter((s) => !s.deleted_at).map((service) => {
    const items = graph.items.filter((i) => !i.deleted_at && i.service_id === service.id);
    const missing = new Set<string>();
    let amount = 0;
    for (const item of items) {
      const cost = dishCost(graph, item.id, prices);
      amount += cost.amount;
      cost.missing.forEach((id) => missing.add(id));
    }
    return { service_id: service.id, amount: Math.round(amount * 100) / 100, servings: Math.max(0, ...items.map((i) => Number(i.servings))), missing: [...missing] };
  });
}
