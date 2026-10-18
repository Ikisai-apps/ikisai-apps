/**
 * Modelo de artículos del inventario (`resources.items`, `item_units`, `item_kinds`, `movements`; docs/resources/API.md §3)
 * en la forma del kit, con las funciones puras que usan `createItemPicker` y las apps (buscar, parecidos, unidades,
 * conversión a la unidad base y stock).
 */
import { normalizeName } from '../fields/suggest.ts';
import { formatQuantity } from '../fields/quantity.ts';
import { kt } from '../i18n/i18n.ts';

export interface ItemRow {
  id: string;
  name: string;
  kind: string;
  category: string | null;
  baseUnit: string;
  minQuantity: number | null;
  reorderQuantity: number | null;
  defaultSpaceId: string | null;
  defaultSupplierId: string | null;
  tracksLots: boolean;
  tracksExpiry: boolean;
  /** `attributes.aliases`: nombres anteriores o del proveedor; también se busca por ellos. */
  aliases: string[];
  attributes: Record<string, unknown>;
  active: boolean;
  notes: string | null;
  /** Alta o cambio local aún sin confirmar por el servidor. */
  pending?: boolean;
}

export interface ItemUnitRow {
  id: string;
  itemId: string;
  unit: string;
  /** Cuántas unidades base hay en una de esta (> 0). */
  factor: number;
  supplierId: string | null;
}

export interface ItemKind {
  kind: string;
  label: string;
  /** `false`: se cuenta, no se gasta (menaje, textil, herramienta, máquina). */
  consumable: boolean;
}

/** Suma de movimientos por artículo, sitio y lote. */
export interface StockLine {
  itemId: string;
  spaceId: string;
  lotId: string | null;
  quantity: number;
}

export interface ItemSnapshot {
  items: ItemRow[];
  units: ItemUnitRow[];
  kinds: ItemKind[];
  stock: StockLine[];
}

export interface ItemDraft {
  id: string;
  name: string;
  kind: string;
  baseUnit: string;
  defaultSpaceId?: string | null;
}

/** Alta rechazada porque el nombre ya existía en el servidor (dos dispositivos sin red). */
export interface ItemDuplicate {
  draftId: string;
  name: string;
  /** El que ya existe, si el espejo lo tiene. */
  existing: ItemRow | null;
}

export interface ItemSource {
  list(): Promise<ItemSnapshot> | ItemSnapshot;
  subscribe?(listener: (snapshot: ItemSnapshot) => void): () => void;
  /** Alta de un artículo (un lote). Sin red queda pendiente y se sube al volver. */
  create?(draft: ItemDraft): Promise<void>;
  onDuplicate?(listener: (dup: ItemDuplicate) => void): () => void;
  /** Nombre visible de un proveedor de Finance (para «caja (de Makro)»). */
  supplierName?(id: string): string | null;
}

/** Los 11 tipos de partida (RECURSOS.md §11.2); los reales salen de `resources.item_kinds`. */
export const DEFAULT_ITEM_KINDS: ItemKind[] = [
  { kind: 'ingrediente', label: 'Ingrediente', consumable: true },
  { kind: 'bebida', label: 'Bebida', consumable: true },
  { kind: 'material', label: 'Material', consumable: true },
  { kind: 'limpieza', label: 'Limpieza', consumable: true },
  { kind: 'higiene', label: 'Higiene', consumable: true },
  { kind: 'consumible', label: 'Consumible', consumable: true },
  { kind: 'menaje', label: 'Menaje', consumable: false },
  { kind: 'textil', label: 'Textil', consumable: false },
  { kind: 'herramienta', label: 'Herramienta', consumable: false },
  { kind: 'maquina', label: 'Máquina', consumable: false },
  { kind: 'otro', label: 'Otro', consumable: true },
];

/** Unidades base habituales para el alta rápida. */
export const BASE_UNITS = ['kg', 'g', 'l', 'ml', 'ud', 'm', 'm²'];

/** Conversiones métricas que no hace falta dar de alta: unidad → (otra → factor hacia la primera). */
const METRIC: Record<string, Record<string, number>> = {
  kg: { g: 0.001 }, g: { kg: 1000 },
  l: { ml: 0.001, cl: 0.01 }, ml: { l: 1000, cl: 10 },
  m: { cm: 0.01 },
};

/** Clave del índice único del servidor: sin mayúsculas ni espacios de los lados. */
export const itemKey = (name: string): string => name.trim().toLowerCase();

export const kindLabelOf = (kinds: readonly ItemKind[], kind: string): string => kinds.find((k) => k.kind === kind)?.label ?? kind;

/** El que choca con el índice único del servidor (mismo nombre sin mayúsculas ni espacios de los lados). */
export function sameNameItem(items: readonly ItemRow[], name: string): ItemRow | null {
  const key = itemKey(name);
  return key ? items.find((i) => itemKey(i.name) === key) ?? null : null;
}

/**
 * Parecidos a un nombre nuevo, para avisar antes de crear: mismo nombre sin tildes, uno contiene al otro, o comparten
 * la primera palabra (de 4 letras o más: «Harina de centeno» ~ «Harina de trigo»). Sin el idéntico.
 */
export function similarItems(items: readonly ItemRow[], name: string, limit = 3): ItemRow[] {
  const n = normalizeName(name);
  if (n.length < 3) return [];
  const first = n.split(' ')[0]!;
  const score = (i: ItemRow): number => {
    const names = [i.name, ...i.aliases].map(normalizeName);
    if (names.some((x) => x === n)) return 3;
    if (names.some((x) => x.includes(n) || n.includes(x))) return 2;
    if (first.length >= 4 && names.some((x) => x.split(' ')[0] === first)) return 1;
    return 0;
  };
  return items.filter((i) => i.active && itemKey(i.name) !== itemKey(name))
    .map((i) => [i, score(i)] as const).filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1] || a[0].name.localeCompare(b[0].name)).slice(0, limit).map(([i]) => i);
}

export interface ItemSearchOptions {
  kinds?: readonly string[];
  includeArchived?: boolean;
  /** Nombres extra que da la app (id → nombres), además de `attributes.aliases`. */
  aliases?: Record<string, readonly string[]>;
  limit?: number;
}

/** Busca por nombre y alias sin mayúsculas ni tildes: primero los que empiezan así, luego los que lo contienen, luego por alias. */
export function searchItems(items: readonly ItemRow[], query: string, options: ItemSearchOptions = {}): ItemRow[] {
  const q = normalizeName(query);
  if (!q) return [];
  const rank = (i: ItemRow): number => {
    const name = normalizeName(i.name);
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    const extra = [...i.aliases, ...(options.aliases?.[i.id] ?? [])].map(normalizeName);
    if (extra.some((a) => a.startsWith(q))) return 2;
    if (extra.some((a) => a.includes(q))) return 3;
    return -1;
  };
  return items
    .filter((i) => (options.includeArchived || i.active) && (!options.kinds || options.kinds.includes(i.kind)))
    .map((i) => [i, rank(i)] as const).filter(([, r]) => r >= 0)
    .sort((a, b) => a[1] - b[1] || a[0].name.localeCompare(b[0].name)).slice(0, options.limit ?? 30).map(([i]) => i);
}

export interface ItemUnitOption {
  /** `base`, `metric:g` o el id de `item_units`. */
  value: string;
  unit: string;
  /** Unidades base en una de esta. */
  factor: number;
  supplierId: string | null;
  label: string;
}

/**
 * Unidades en las que se puede dar una cantidad del artículo: la base, las métricas equivalentes (g ↔ kg, ml ↔ l) y
 * sus conversiones. Con `supplierId`, primero las de ese proveedor; las de otros, al final y con su nombre.
 */
export function unitsFor(item: ItemRow, units: readonly ItemUnitRow[], options: { supplierId?: string | null; supplierName?: (id: string) => string | null } = {}): ItemUnitOption[] {
  const own = units.filter((u) => u.itemId === item.id && u.factor > 0);
  const out: ItemUnitOption[] = [{ value: 'base', unit: item.baseUnit, factor: 1, supplierId: null, label: item.baseUnit }];
  for (const [unit, factor] of Object.entries(METRIC[item.baseUnit] ?? {})) {
    if (!own.some((u) => u.unit === unit)) out.push({ value: `metric:${unit}`, unit, factor, supplierId: null, label: unit });
  }
  const rank = (u: ItemUnitRow) => (options.supplierId && u.supplierId === options.supplierId ? 0 : u.supplierId === null ? 1 : 2);
  const sorted = own.slice().sort((a, b) => rank(a) - rank(b) || a.unit.localeCompare(b.unit));
  const repeated = (u: ItemUnitRow) => own.filter((o) => o.unit === u.unit).length > 1;
  for (const u of sorted) {
    const supplier = u.supplierId ? options.supplierName?.(u.supplierId) ?? null : null;
    const foreign = !!u.supplierId && u.supplierId !== options.supplierId;
    const label = supplier && (foreign || repeated(u)) ? kt('{unit} (de {supplier})', { unit: u.unit, supplier }) : u.unit;
    out.push({ value: u.id, unit: u.unit, factor: u.factor, supplierId: u.supplierId, label });
  }
  // Con proveedor, sus unidades van justo detrás de la base.
  if (options.supplierId) {
    const first = out.filter((o) => o.supplierId === options.supplierId);
    return [out[0]!, ...first, ...out.slice(1).filter((o) => o.supplierId !== options.supplierId)];
  }
  return out;
}

/** Cantidad en unidad base; `null` si la unidad no convierte o la cantidad no es un número. */
export function baseQuantity(quantity: number | null, unitValue: string | null, options: readonly ItemUnitOption[]): number | null {
  if (quantity === null || !Number.isFinite(quantity)) return null;
  const unit = options.find((o) => o.value === unitValue || (!unitValue && o.value === 'base'));
  if (!unit) return null;
  return Math.round(quantity * unit.factor * 1e6) / 1e6;
}

/** Suma de movimientos (`resources.movements`, solo se añaden) por artículo, sitio y lote, sin las que suman cero. */
export function stockFromMovements(rows: ReadonlyArray<{ item_id?: unknown; space_id?: unknown; lot_id?: unknown; quantity?: unknown; deleted_at?: unknown }>): StockLine[] {
  const sums = new Map<string, StockLine>();
  for (const r of rows) {
    if (r.deleted_at) continue;
    const key = `${r.item_id}|${r.space_id}|${r.lot_id ?? ''}`;
    const line = sums.get(key) ?? { itemId: String(r.item_id), spaceId: String(r.space_id), lotId: (r.lot_id as string | null) ?? null, quantity: 0 };
    line.quantity += Number(r.quantity ?? 0);
    sums.set(key, line);
  }
  return [...sums.values()].map((l) => ({ ...l, quantity: Math.round(l.quantity * 1e6) / 1e6 })).filter((l) => l.quantity !== 0);
}

/** Stock de un artículo por sitio (en unidad base), opcionalmente solo en unos sitios. */
export function stockBySpace(stock: readonly StockLine[], itemId: string, spaceIds?: readonly string[] | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of stock) {
    if (l.itemId !== itemId || (spaceIds && !spaceIds.includes(l.spaceId))) continue;
    out.set(l.spaceId, Math.round(((out.get(l.spaceId) ?? 0) + l.quantity) * 1e6) / 1e6);
  }
  return out;
}

/**
 * Texto corto del stock: «18,5 kg · Despensa», «4 ud en 3 sitios», «sin stock»; y si está bajo mínimo.
 * Los sitios los nombra la app (`spaceName`).
 */
export function stockSummary(item: ItemRow, stock: readonly StockLine[], options: { spaceIds?: readonly string[] | null; spaceName?: (id: string) => string | null } = {}): { text: string; low: boolean; total: number } {
  const by = stockBySpace(stock, item.id, options.spaceIds);
  const total = Math.round([...by.values()].reduce((a, b) => a + b, 0) * 1e6) / 1e6;
  const amount = `${formatQuantity(total, 3)} ${item.baseUnit}`;
  const low = item.minQuantity !== null && item.minQuantity > 0 && total < item.minQuantity;
  let text: string;
  if (!by.size || total === 0) text = kt('sin stock');
  else if (by.size === 1) {
    const where = options.spaceName?.([...by.keys()][0]!) ?? null;
    text = where ? `${amount} · ${where}` : amount;
  } else text = kt('{amount} en {n} sitios', { amount, n: String(by.size) });
  if (low) text += ` · ${kt('bajo mínimo ({min})', { min: `${formatQuantity(item.minQuantity, 3)} ${item.baseUnit}` })}`;
  return { text, low, total };
}

/** Fila de `resources.items` (espejo) → forma del kit. */
export function itemFromRow(row: Record<string, unknown>): ItemRow {
  const attributes = (row.attributes as Record<string, unknown> | null) ?? {};
  const aliases = Array.isArray(attributes.aliases) ? (attributes.aliases as unknown[]).filter((a): a is string => typeof a === 'string' && a.trim() !== '') : [];
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
  return {
    id: String(row.id), name: String(row.name ?? ''), kind: String(row.kind ?? 'otro'), category: (row.category as string | null) ?? null,
    baseUnit: String(row.base_unit ?? 'ud'), minQuantity: num(row.min_quantity), reorderQuantity: num(row.reorder_quantity),
    defaultSpaceId: (row.default_space_id as string | null) ?? null, defaultSupplierId: (row.default_supplier_id as string | null) ?? null,
    tracksLots: row.tracks_lots === true, tracksExpiry: row.tracks_expiry === true, aliases, attributes,
    active: row.active !== false, notes: (row.notes as string | null) ?? null, pending: row._pending === true,
  };
}

export function itemUnitFromRow(row: Record<string, unknown>): ItemUnitRow {
  return { id: String(row.id), itemId: String(row.item_id), unit: String(row.unit ?? ''), factor: Number(row.factor ?? 0), supplierId: (row.supplier_id as string | null) ?? null };
}

export function itemKindFromRow(row: Record<string, unknown>): ItemKind {
  return { kind: String(row.kind), label: String(row.label ?? row.kind), consumable: row.consumable !== false };
}

export function newItemId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `item-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Fuente en memoria (demo y pruebas). `server`: artículos que ya existen en el servidor pero aún no en este
 * dispositivo; crear uno con el mismo nombre se rechaza como haría el índice único (`onDuplicate`).
 */
export function createMemoryItemSource(initial: ItemSnapshot, options: { delay?: number; server?: ItemRow[]; supplierNames?: Record<string, string> } = {}): ItemSource & { snapshot(): ItemSnapshot } {
  let snap: ItemSnapshot = { ...initial, items: initial.items.slice() };
  const listeners = new Set<(s: ItemSnapshot) => void>();
  const dupListeners = new Set<(d: ItemDuplicate) => void>();
  const server = (options.server ?? []).slice();
  const emit = () => { const s = { ...snap, items: snap.items.slice() }; listeners.forEach((l) => l(s)); };
  const wait = () => new Promise<void>((r) => setTimeout(r, options.delay ?? 0));
  return {
    list: () => ({ ...snap, items: snap.items.slice() }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async create(draft) {
      const row: ItemRow = { id: draft.id, name: draft.name.trim(), kind: draft.kind, category: null, baseUnit: draft.baseUnit, minQuantity: null, reorderQuantity: null, defaultSpaceId: draft.defaultSpaceId ?? null, defaultSupplierId: null, tracksLots: false, tracksExpiry: false, aliases: [], attributes: {}, active: true, notes: null, pending: true };
      snap.items.push(row);
      emit();
      void wait().then(() => {
        const clash = server.find((s) => itemKey(s.name) === itemKey(row.name));
        snap.items = snap.items.filter((i) => i.id !== row.id);
        if (clash) {
          if (!snap.items.some((i) => i.id === clash.id)) snap.items.push(clash);
          emit();
          dupListeners.forEach((l) => l({ draftId: row.id, name: row.name, existing: clash }));
        } else {
          snap.items.push({ ...row, pending: false });
          emit();
        }
      });
    },
    onDuplicate(listener) { dupListeners.add(listener); return () => dupListeners.delete(listener); },
    supplierName: (id) => options.supplierNames?.[id] ?? null,
    snapshot: () => snap,
  };
}
