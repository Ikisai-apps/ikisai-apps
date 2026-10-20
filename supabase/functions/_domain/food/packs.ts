/**
 * Ikisai Food · el envase en la Compra (tanda 40, MUELA-093; `resources.item_units` con `usual` y `price`, 0810).
 *
 * - Un envase es una fila de `item_units`: `unit` es su nombre («bolsa de 200 g»), `factor` su tamaño en la unidad base
 *   del artículo. Para la lista solo cuentan los de la misma familia que la unidad de la línea (g/kg, ml/l, unidades),
 *   como `food.usual_pack` en SQL.
 * - Guardar un envase desde la Compra **nunca cambia el factor de una fila que ya existe**: usa la que tiene el mismo
 *   nombre y tamaño o crea una nueva, sin proveedor (Food solo convierte con esas), y la deja como habitual; la anterior
 *   se desmarca en el mismo commit (un habitual por artículo, comprobado al final del commit).
 * - El precio del envase: el suyo (`price`); si no, el de la última compra de Invoices; si no, el coste medio del
 *   artículo en Recursos. Sin ninguno, `null`: la pantalla dice «sin precio» y nunca suma 0 €.
 */
import { purchaseQuantity, type FoodPurchase } from './costing.ts';
import { fromItemBase, type ItemConversion } from './resources.ts';
import { toBase, unitFamily, type Unit } from './units.ts';

/** Fila de `resources.item_units` con lo que usa la Compra. */
export interface PackUnitRow extends ItemConversion {
  id: string;
  revision?: number;
  usual?: boolean | null;
  price?: number | string | null;
  updated_at?: string | null;
}

/** Un envase en la unidad de la línea, listo para la pieza `Envase` del kit. */
export interface LinePack {
  label: string;
  size: number;
  price: number | null;
  usual: boolean;
  row: PackUnitRow;
}

const live = (rows: PackUnitRow[], itemId: string) => rows.filter((r) => !r.deleted_at && r.item_id === itemId);
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Los envases del artículo en la unidad de la línea (los de otra familia no cuentan), el habitual primero. */
export function linePacks(itemId: string, base: string, unit: Unit, rows: PackUnitRow[]): LinePack[] {
  return live(rows, itemId)
    .map((row) => {
      const size = fromItemBase(Number(row.factor), base, unit);
      const price = num(row.price);
      return size && size > 0 ? { label: row.unit.trim(), size, price: price !== null && price > 0 ? price : null, usual: row.usual === true, row } : null;
    })
    .filter((p): p is LinePack => p !== null)
    .sort((a, b) => Number(b.usual) - Number(a.usual) || a.label.localeCompare(b.label, 'es'));
}

/** Tamaño del envase habitual en la unidad de la línea; `null` sin habitual o de otra familia (como `food.usual_pack`). */
export function usualPackSize(itemId: string, base: string, unit: Unit, rows: PackUnitRow[]): number | null {
  return linePacks(itemId, base, unit, rows).find((p) => p.usual)?.size ?? null;
}

/** El nombre del envase cabe en `item_units.unit` (20 caracteres): «bandeja de 30 unidades» → «bandeja de 30 uds». */
export function packUnitLabel(label: string): string {
  let out = label.trim().replace(/\s+/g, ' ');
  if (out.length > 20) out = out.replace(/ unidades$/, ' uds').replace(/ unidad$/, ' ud');
  return out.slice(0, 20).trim();
}

type Op = { op: 'insert' | 'update'; table: 'resources.item_units'; id: string; expectedRevision?: number; fields: Record<string, unknown> };

/**
 * Las operaciones de Recursos para guardar el envase elegido como habitual (tamaño en la unidad de la línea). Si ya hay
 * uno con ese nombre y otro tamaño, no se toca: devuelve el motivo.
 */
export function savePackOperations(args: { itemId: string; base: string; unit: Unit; label: string; size: number; price: number | null; rows: PackUnitRow[]; newId?: () => string }): { ops: Op[] } | { error: string } {
  const perBase = fromItemBase(1, args.base, args.unit);
  if (!perBase || !(args.size > 0)) return { error: 'Ese envase no se puede pasar a la unidad del artículo.' };
  const factor = Math.round((args.size / perBase) * 1e6) / 1e6;
  const label = packUnitLabel(args.label);
  if (!label || sameName(label, args.base) || (sameName(args.base, 'ud') && sameName(label, 'unidad'))) return { error: 'Ponle al envase un nombre distinto de la unidad del artículo.' };
  const rows = live(args.rows, args.itemId);
  const existing = rows.find((r) => !r.supplier_id && sameName(r.unit, label));
  if (existing && Math.abs(Number(existing.factor) - factor) > 1e-6 * Math.max(1, factor)) return { error: `Ya hay un envase «${existing.unit}» con otro tamaño en la ficha del artículo.` };
  const price = args.price !== null && args.price > 0 ? Math.round(args.price * 100) / 100 : null;
  const ops: Op[] = [];
  if (existing) {
    const fields: Record<string, unknown> = {};
    if (existing.usual !== true) fields.usual = true;
    if (price !== null && num(existing.price) !== price) fields.price = price;
    if (Object.keys(fields).length) ops.push({ op: 'update', table: 'resources.item_units', id: existing.id, expectedRevision: existing.revision ?? 1, fields });
  } else {
    ops.push({ op: 'insert', table: 'resources.item_units', id: (args.newId ?? (() => crypto.randomUUID()))(), fields: { item_id: args.itemId, unit: label, factor, usual: true, ...(price !== null ? { price } : {}) } });
  }
  for (const r of rows) if (r.usual && r !== existing) ops.push({ op: 'update', table: 'resources.item_units', id: r.id, expectedRevision: r.revision ?? 1, fields: { usual: false } });
  return { ops };
}

/** Movimiento de Recursos con lo que hace falta para el coste medio (como `resources.item_costs`, 0804). */
export interface CostMovement { id: string; item_id: string; quantity: number | string; kind: string; unit_cost?: number | string | null; deleted_at?: string | null }
export interface MovementCost { movement_id: string; unit_cost: number | string; deleted_at?: string | null }

/** Coste medio del artículo por unidad base, con las entradas que tienen coste; `null` sin ninguna. */
export function itemAverageCost(itemId: string, movements: CostMovement[], costs: MovementCost[] = []): number | null {
  const late = new Map(costs.filter((c) => !c.deleted_at).map((c) => [c.movement_id, Number(c.unit_cost)]));
  let quantity = 0;
  let amount = 0;
  for (const m of movements) {
    if (m.deleted_at || m.item_id !== itemId) continue;
    const q = Number(m.quantity);
    if (!((q > 0 && (m.kind === 'entrada_factura' || m.kind === 'entrada_manual')) || (q < 0 && m.kind === 'entrada_factura'))) continue;
    const cost = num(m.unit_cost) ?? late.get(m.id) ?? null;
    if (cost === null) continue;
    quantity += q;
    amount += q * cost;
  }
  return quantity > 0 ? amount / quantity : null;
}

/** La última compra de Invoices de un ingrediente (la más reciente con cantidad e importe). */
export function lastPurchase(ingredientId: string, purchases: FoodPurchase[]): FoodPurchase | null {
  return purchases
    .filter((p) => p.target_kind === 'ingredient' && p.target_id === ingredientId && purchaseQuantity(p) && Number(p.allocated_amount) >= 0)
    .sort((a, b) => (b.invoice_date ?? '').localeCompare(a.invoice_date ?? ''))[0] ?? null;
}

/**
 * € por unidad de la línea cuando el envase no tiene precio: la última compra (importe ÷ cantidad) y, sin ella, el coste
 * medio del artículo. `null` si no hay ninguno.
 */
export function linePerUnit(args: { ingredientId: string; unit: Unit; itemId?: string | null; base?: string | null; purchases: FoodPurchase[]; average?: number | null }): number | null {
  const last = lastPurchase(args.ingredientId, args.purchases);
  const read = last ? purchaseQuantity(last) : null;
  if (last && read && unitFamily(read.unit) === unitFamily(args.unit)) {
    const perFoodBase = Number(last.allocated_amount) / toBase(read.quantity, read.unit);
    if (Number.isFinite(perFoodBase)) return perFoodBase * toBase(1, args.unit);
  }
  if (args.average !== null && args.average !== undefined && args.base) {
    const perBase = fromItemBase(1, args.base, args.unit);
    if (perBase) return args.average / perBase;
  }
  return null;
}

/**
 * «Como en el último ticket»: la última línea de factura enlazada con el artículo (`item_id` e `item_factor` de
 * `invoices.food_stock_projection`, 0243) cuya unidad es un envase (`item_factor` no nulo y de la misma familia que la
 * línea). Su nombre es el del envase con ese tamaño que ya tenga el artículo, o «<unidad> de <tamaño>»; el precio, el
 * importe entre la cantidad; con el proveedor y la fecha.
 */
export function lastTicket(args: { itemId: string; base: string; unit: Unit; rows: PackUnitRow[]; purchases: FoodPurchase[] }): { label: string; size: number; price: number | null; supplier: string | null; date: string | null } | null {
  const last = args.purchases
    .filter((p) => p.item_id === args.itemId && num(p.item_factor) !== null && Number(p.item_factor) > 0 && p.unit?.trim())
    .sort((a, b) => (b.invoice_date ?? '').localeCompare(a.invoice_date ?? '') || String(b.allocation_id).localeCompare(String(a.allocation_id)))[0];
  if (!last) return null;
  const factor = Number(last.item_factor);
  const size = fromItemBase(factor, args.base, args.unit);
  if (!size || size <= 0) return null;
  const known = live(args.rows, args.itemId).find((r) => Math.abs(Number(r.factor) - factor) < 1e-6 * Math.max(1, factor) && (!r.supplier_id || sameName(r.unit, String(last.unit))));
  const unitName = String(last.unit).trim().toLowerCase();
  const label = known?.unit.trim() ?? (/\d/.test(unitName) ? unitName : `${unitName} de ${amountText(factor, args.base)}`);
  const quantity = Number(last.allocated_quantity);
  const amount = Number(last.allocated_amount);
  const price = quantity > 0 && amount >= 0 ? Math.round((amount / quantity) * 100) / 100 : null;
  return { label, size, price, supplier: last.supplier_name, date: last.invoice_date };
}

/** «200 g», «1 kg», «1,5 l», «12 ud»: el tamaño en la unidad base, en corto. */
function amountText(quantity: number, base: string): string {
  const b = base.trim().toLowerCase();
  const n = (v: number) => String(Math.round(v * 1000) / 1000).replace('.', ',');
  if (b === 'g' && quantity >= 1000) return `${n(quantity / 1000)} kg`;
  if (b === 'ml' && quantity >= 1000) return `${n(quantity / 1000)} l`;
  if (b === 'kg' && quantity < 1) return `${n(quantity * 1000)} g`;
  if (b === 'l' && quantity < 1) return `${n(quantity * 1000)} ml`;
  return `${n(quantity)} ${b === 'unidad' || b === 'uds' ? 'ud' : b}`;
}

/** Color de la tienda (S4), derivado de su nombre: siempre el mismo para el mismo nombre. */
const SHOP_HUES = [8, 32, 88, 140, 178, 205, 232, 262, 298, 332];
export function shopColor(name: string): string {
  let h = 2166136261;
  for (const ch of name.trim().toLowerCase()) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
  return `hsl(${SHOP_HUES[h % SHOP_HUES.length]} 55% 36%)`;
}
