/**
 * Ikisai Food · R5a: enlace de ingredientes y maquinaria con artículos de Recursos (docs/food/API.md §2.7;
 * docs/resources/API.md §3).
 *
 * Cada ingrediente y cada máquina de Food tiene su artículo (`item_id`). Si no lo tiene, la app lo busca por su
 * referencia de origen (`food.ingredient:<id>`), después por el nombre, y si no hay ninguno lo crea. Food sigue siendo
 * quien escribe nombre, unidad y estado durante R5; el artículo los copia (`linkPlan`).
 */
import type { EquipmentStatus } from './catalog.ts';
import type { Unit } from './units.ts';

/** Fila de `resources.items` que Food necesita. */
export interface ResourceItem {
  id: string;
  name: string;
  kind: string;
  category: string | null;
  base_unit: string;
  min_quantity: number | null;
  attributes: Record<string, unknown>;
  active: boolean;
  source_refs: string[];
  deleted_at: string | null;
}

export const ingredientRef = (id: string) => `food.ingredient:${id}`;
export const equipmentRef = (id: string) => `food.equipment:${id}`;

/** Tipos de artículo que Food enlaza: ingredientes con los que se gastan y máquinas con los que se cuentan. */
export const INGREDIENT_ITEM_KINDS = ['ingrediente', 'bebida'] as const;
export const EQUIPMENT_ITEM_KINDS = ['maquina', 'herramienta', 'menaje'] as const;

/** Unidad base del artículo a partir de la preferida del ingrediente («unidad» es «ud» en Recursos). */
export function itemBaseUnit(unit: Unit): string {
  return unit === 'unidad' ? 'ud' : unit;
}

const key = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

interface IngredientLike { id: string; name: string; preferred_unit: Unit; active: boolean; item_id?: string | null; deleted_at: string | null }
interface EquipmentLike { id: string; name: string; category: string | null; capacity: string | null; status: EquipmentStatus; item_id?: string | null; deleted_at: string | null }

export type LinkStep =
  | { kind: 'create'; source: 'ingredient' | 'equipment'; sourceId: string; itemId: string; fields: Record<string, unknown> }
  | { kind: 'adopt'; source: 'ingredient' | 'equipment'; sourceId: string; itemId: string; fields: Record<string, unknown> }
  | { kind: 'link'; source: 'ingredient' | 'equipment'; sourceId: string; itemId: string }
  | { kind: 'sync'; source: 'ingredient' | 'equipment'; sourceId: string; itemId: string; fields: Record<string, unknown> };

/** Lo que el artículo copia de Food (y se mantiene igual mientras Food sea quien lo escribe). */
export function ingredientItemFields(ingredient: IngredientLike): Record<string, unknown> {
  return { name: ingredient.name.trim().replace(/\s+/g, ' '), active: ingredient.active };
}
export function equipmentItemFields(machine: EquipmentLike, item?: Pick<ResourceItem, 'attributes'>): Record<string, unknown> {
  const attributes: Record<string, unknown> = { ...(item?.attributes ?? {}), status: machine.status };
  if (machine.capacity) attributes.capacity = machine.capacity; else delete attributes.capacity;
  return { name: machine.name.trim().replace(/\s+/g, ' '), category: machine.category, attributes };
}

/**
 * Plan para que todo ingrediente y máquina viva tenga su artículo, y para que el artículo diga lo mismo que Food.
 * `newId` da los ids de los artículos nuevos (en las pruebas, deterministas).
 */
export function linkPlan(
  ingredients: IngredientLike[],
  equipment: EquipmentLike[],
  items: ResourceItem[],
  newId: () => string = () => crypto.randomUUID(),
): LinkStep[] {
  const steps: LinkStep[] = [];
  const live = items.filter((i) => !i.deleted_at);
  const byId = new Map(live.map((i) => [i.id, i]));
  const taken = new Set<string>();
  for (const i of ingredients) if (!i.deleted_at && i.item_id) taken.add(i.item_id);
  for (const e of equipment) if (!e.deleted_at && e.item_id) taken.add(e.item_id);
  const names = new Set(live.map((i) => key(i.name)));

  const resolve = (source: 'ingredient' | 'equipment', row: IngredientLike | EquipmentLike, kinds: readonly string[], ref: string, create: () => Record<string, unknown>, sync: (item: ResourceItem) => Record<string, unknown>) => {
    // Lo que el artículo debe copiar de Food y aún no tiene. Un nombre que ya usa otro artículo no se copia (en Recursos
    // el nombre es único): se queda como está.
    const diffOf = (item: ResourceItem) => {
      const diff = Object.fromEntries(Object.entries(sync(item)).filter(([k, v]) => JSON.stringify((item as unknown as Record<string, unknown>)[k] ?? null) !== JSON.stringify(v ?? null)));
      if (diff.name && names.has(key(String(diff.name))) && key(String(diff.name)) !== key(item.name)) delete diff.name;
      return diff;
    };
    const current = row.item_id ? byId.get(row.item_id) : undefined;
    if (current) {
      // Enlazado (también si nació enlazado desde el recetario): el artículo lleva la referencia de Food.
      const diff = { ...diffOf(current), ...(current.source_refs.includes(ref) ? {} : { source_refs: [...current.source_refs, ref] }) };
      if (Object.keys(diff).length) steps.push({ kind: 'sync', source, sourceId: row.id, itemId: current.id, fields: diff });
      return;
    }
    const byRef = live.find((i) => i.source_refs.includes(ref) && !taken.has(i.id));
    const byName = byRef ?? live.find((i) => key(i.name) === key(row.name) && kinds.includes(i.kind) && !taken.has(i.id));
    if (byName) {
      taken.add(byName.id);
      const fields = { ...diffOf(byName), ...(byName.source_refs.includes(ref) ? {} : { source_refs: [...byName.source_refs, ref] }) };
      if (Object.keys(fields).length) steps.push({ kind: 'adopt', source, sourceId: row.id, itemId: byName.id, fields });
      steps.push({ kind: 'link', source, sourceId: row.id, itemId: byName.id });
      return;
    }
    // Un artículo de otro tipo con el mismo nombre: el nuevo lleva « (cocina)» para no chocar.
    const fields = create();
    if (names.has(key(String(fields.name)))) fields.name = `${String(fields.name)} (cocina)`.slice(0, 120);
    const itemId = newId();
    names.add(key(String(fields.name)));
    taken.add(itemId);
    steps.push({ kind: 'create', source, sourceId: row.id, itemId, fields: { ...fields, source_refs: [ref] } });
    steps.push({ kind: 'link', source, sourceId: row.id, itemId });
  };

  for (const ingredient of ingredients.filter((i) => !i.deleted_at)) {
    resolve('ingredient', ingredient, INGREDIENT_ITEM_KINDS, ingredientRef(ingredient.id),
      () => ({ ...ingredientItemFields(ingredient), kind: 'ingrediente', base_unit: itemBaseUnit(ingredient.preferred_unit) }),
      () => ingredientItemFields(ingredient));
  }
  for (const machine of equipment.filter((e) => !e.deleted_at)) {
    resolve('equipment', machine, EQUIPMENT_ITEM_KINDS, equipmentRef(machine.id),
      () => ({ ...equipmentItemFields(machine), kind: 'maquina', base_unit: 'ud' }),
      (item) => equipmentItemFields(machine, item));
  }
  return steps;
}

type Op = { op: 'insert' | 'update'; table: string; id: string; expectedRevision?: number; fields: Record<string, unknown> };

/**
 * Del plan a dos lotes: primero el de Recursos (crear, adoptar o copiar artículos) y después el de Food (enlazar). Si el
 * segundo falla, el siguiente plan encuentra el artículo por su referencia de origen y solo enlaza: nada se duplica.
 */
export function linkOperations(steps: LinkStep[], revisions: { items: Map<string, number>; ingredients: Map<string, number>; equipment: Map<string, number> }): { resources: Op[]; food: Op[] } {
  const resources: Op[] = [];
  const food: Op[] = [];
  const itemRevision = (id: string) => revisions.items.get(id) ?? 1;
  for (const step of steps) {
    if (step.kind === 'create') resources.push({ op: 'insert', table: 'resources.items', id: step.itemId, fields: step.fields });
    else if (step.kind === 'adopt' || step.kind === 'sync') resources.push({ op: 'update', table: 'resources.items', id: step.itemId, expectedRevision: itemRevision(step.itemId), fields: step.fields });
    else {
      const table = step.source === 'ingredient' ? 'food.ingredients' : 'food.equipment';
      const revision = (step.source === 'ingredient' ? revisions.ingredients : revisions.equipment).get(step.sourceId) ?? 1;
      food.push({ op: 'update', table, id: step.sourceId, expectedRevision: revision, fields: { item_id: step.itemId } });
    }
  }
  return { resources, food };
}

/** Unidad de Food para la unidad base de un artículo («ud» es «unidad»); `null` si Food no la tiene. */
export function foodUnitFromBase(base: string): Unit | null {
  const unit = base.trim().toLowerCase();
  if (unit === 'ud' || unit === 'uds' || unit === 'unidad') return 'unidad';
  return (['g', 'kg', 'ml', 'l', 'paquete', 'manojo', 'otro'] as const).find((u) => u === unit) ?? null;
}

/**
 * Ingredientes de Recursos que Food aún no usa (los creó Finance, Tasks o alguien a mano): se sugieren en el recetario
 * para usar el mismo artículo en vez de crear otro con el mismo nombre.
 */
export function sharedIngredientItems(items: ResourceItem[], ingredients: Array<{ name: string; item_id?: string | null; deleted_at: string | null }>): ResourceItem[] {
  const linked = new Set(ingredients.filter((i) => !i.deleted_at && i.item_id).map((i) => i.item_id));
  const names = new Set(ingredients.filter((i) => !i.deleted_at).map((i) => key(i.name)));
  return items
    .filter((i) => !i.deleted_at && i.active && (INGREDIENT_ITEM_KINDS as readonly string[]).includes(i.kind) && !linked.has(i.id) && !names.has(key(i.name)))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

// ---------------------------------------------------------------------------------------------------------------------
// Stock de cocina (R5b; mismas reglas que `food.kitchen_spaces` y `food.kitchen_stock` en SQL)
// ---------------------------------------------------------------------------------------------------------------------

export interface SpaceLike { id: string; parent_id: string | null; kind: string; name: string; active?: boolean; attributes?: Record<string, unknown> | null; deleted_at: string | null }
export interface MovementLike { item_id: string; space_id: string; lot_id: string | null; quantity: number | string; source_ref?: string | null; deleted_at: string | null }
export interface LotLike { id: string; expires_on: string | null }

const KITCHEN_NAME = /(despensa|c[aá]mara|nevera|frigor[ií]fico|congelador)/i;

/** Decisión del usuario (14-10-2026): el stock de la compra es el de la cocina, sus despensas y sus cámaras. */
export function kitchenSpaceIds(spaces: SpaceLike[]): Set<string> {
  const live = spaces.filter((s) => !s.deleted_at);
  const roots = live.filter((s) => s.active !== false && (s.kind === 'cocina'
    || ((s.kind === 'almacen' || s.kind === 'ubicacion') && (KITCHEN_NAME.test(s.name) || ['frio', 'congelado'].includes(String(s.attributes?.storage ?? ''))))));
  const ids = new Set(roots.map((s) => s.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of live) if (s.parent_id && ids.has(s.parent_id) && !ids.has(s.id)) { ids.add(s.id); grew = true; }
  }
  return ids;
}

/** Stock de cocina en la unidad base, sin lotes que caducan antes de `on`; `null` si nunca hubo movimientos allí. */
export function kitchenStock(itemId: string, movements: MovementLike[], lots: LotLike[], kitchen: Set<string>, on: string): number | null {
  const expired = new Set(lots.filter((l) => l.expires_on && l.expires_on < on).map((l) => l.id));
  const rows = movements.filter((m) => !m.deleted_at && m.item_id === itemId && kitchen.has(m.space_id));
  if (!rows.length) return null;
  const total = rows.filter((m) => !m.lot_id || !expired.has(m.lot_id)).reduce((sum, m) => sum + Number(m.quantity), 0);
  return Math.max(Math.round(total * 1000) / 1000, 0);
}

const FACTOR: Record<string, number> = { kg: 1000, l: 1000 };
const FAMILY: Record<string, string> = { g: 'masa', kg: 'masa', ml: 'volumen', l: 'volumen' };
const family = (unit: string) => FAMILY[unit] ?? unit;

/** Conversión de un artículo (`resources.item_units`): cuántas unidades base hay en una de `unit`. */
export interface ItemConversion { item_id: string; unit: string; factor: number | string; supplier_id?: string | null; deleted_at?: string | null }

/**
 * Unidades base del artículo que hay en una unidad de Food, con las reglas de `unitsFor` del kit (las mismas que Finance):
 * la base, sus métricas (g ↔ kg, ml ↔ l) y las conversiones del artículo sin proveedor («unidad» también vale como «ud»).
 * `null` si no se puede. El dominio no importa el kit (también lo usa la Edge): `resources-units.test.ts` comprueba que
 * da lo mismo que `baseQuantity` del kit.
 */
export function itemUnitFactor(unit: Unit, base: string, itemId?: string, conversions: ItemConversion[] = []): number | null {
  const own = foodUnitFromBase(base);
  if (own && family(own) === family(unit)) return (FACTOR[unit] ?? 1) / (FACTOR[own] ?? 1);
  const names = unit === 'unidad' ? ['unidad', 'ud'] : [unit];
  const hit = conversions.find((c) => !c.deleted_at && !c.supplier_id && (!itemId || c.item_id === itemId) && names.includes(c.unit.trim().toLowerCase()) && Number(c.factor) > 0);
  return hit ? Number(hit.factor) : null;
}

/** De la unidad base del artículo a una unidad de Food de la misma familia (y al revés); `null` si no se puede. */
export function fromItemBase(quantity: number, base: string, unit: Unit): number | null {
  const own = foodUnitFromBase(base);
  if (!own || family(own) !== family(unit)) return null;
  return Math.round((quantity * (FACTOR[own] ?? 1)) / (FACTOR[unit] ?? 1) * 1000) / 1000;
}
export function toItemBase(quantity: number, unit: Unit, base: string, itemId?: string, conversions: ItemConversion[] = []): number | null {
  const factor = itemUnitFactor(unit, base, itemId, conversions);
  return factor === null ? null : Math.round(quantity * factor * 1e6) / 1e6;
}

/** Referencia de la entrada al stock de una línea de compra: Finance (R4) le añade el coste con ella. No cambiarla. */
export const shoppingItemRef = (id: string) => `shopping_item:${id}`;

/**
 * «Comprado» entra al stock en ese momento, sin coste (decisión del usuario, 14-10-2026); desmarcarlo lo saca. Devuelve
 * el movimiento que deja el stock como debe estar (o `null` si ya lo está), mirando los que ya llevan la referencia.
 */
export function purchaseMovement(args: { itemId: string; lineId: string; bought: boolean; quantityBase: number; spaceId: string; supplier: string | null; movements: MovementLike[] }): Record<string, unknown> | null {
  const ref = shoppingItemRef(args.lineId);
  const already = args.movements.filter((m) => !m.deleted_at && m.source_ref === ref).reduce((sum, m) => sum + Number(m.quantity), 0);
  const delta = Math.round(((args.bought ? args.quantityBase : 0) - already) * 1000) / 1000;
  if (delta === 0) return null;
  return delta > 0
    ? { item_id: args.itemId, space_id: args.spaceId, quantity: delta, kind: 'entrada_manual', source_app: 'food', source_ref: ref, note: args.supplier ? `Compra · ${args.supplier}` : 'Compra' }
    : { item_id: args.itemId, space_id: args.spaceId, quantity: delta, kind: 'salida_manual', reason: 'otro', source_app: 'food', source_ref: ref, note: 'Desmarcado como comprado' };
}

/** Dónde entra lo comprado: el sitio habitual del artículo; si no tiene, una despensa o la cocina. */
export function purchaseSpace(item: Pick<ResourceItem, 'id'> & { default_space_id?: string | null }, spaces: SpaceLike[]): string | null {
  const live = spaces.filter((s) => !s.deleted_at && s.active !== false);
  if (item.default_space_id && live.some((s) => s.id === item.default_space_id)) return item.default_space_id;
  const kitchen = kitchenSpaceIds(spaces);
  const pick = (test: (s: SpaceLike) => boolean) => live.filter((s) => kitchen.has(s.id) && test(s)).sort((a, b) => a.name.localeCompare(b.name, 'es'))[0]?.id;
  return pick((s) => /despensa/i.test(s.name)) ?? pick((s) => s.kind === 'cocina') ?? pick(() => true) ?? null;
}

/**
 * Maquinaria (R5): «Cantidad» es el stock del artículo. Al cambiarla (o al darle un sitio por primera vez), el movimiento
 * que deja el stock total igual a la cantidad, en su sitio: entrada o salida a mano con motivo. `null` si ya cuadra.
 */
export function machineStockMovement(args: { itemId: string; spaceId: string; quantity: number; movements: MovementLike[] }): Record<string, unknown> | null {
  const stock = args.movements.filter((m) => !m.deleted_at && m.item_id === args.itemId).reduce((sum, m) => sum + Number(m.quantity), 0);
  const delta = Math.round((args.quantity - stock) * 1000) / 1000;
  if (delta === 0) return null;
  return delta > 0
    ? { item_id: args.itemId, space_id: args.spaceId, quantity: delta, kind: 'entrada_manual', source_app: 'food', note: 'Cantidad de Maquinaria' }
    : { item_id: args.itemId, space_id: args.spaceId, quantity: delta, kind: 'salida_manual', reason: 'otro', source_app: 'food', note: 'Cantidad de Maquinaria' };
}
