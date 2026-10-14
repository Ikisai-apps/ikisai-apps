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
