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

export interface LotRow {
  id: string;
  itemId: string;
  code: string | null;
  /** `YYYY-MM-DD`. */
  expiresOn: string | null;
}

/** Fila de `resources.movements` (solo se añaden). `quantity` con signo, en la unidad base. */
export interface MovementRow {
  id: string;
  itemId: string;
  spaceId: string;
  lotId: string | null;
  quantity: number;
  kind: string;
  reason: string | null;
  unitCost: number | null;
  transferId: string | null;
  countId: string | null;
  sourceApp: string | null;
  sourceRef: string | null;
  note: string | null;
  /** ISO. */
  at: string;
  createdBy: string | null;
  pending?: boolean;
}

/** Coste que llega después a una entrada que entró sin él (`resources.movement_costs`). */
export interface MovementCostRow {
  movementId: string;
  unitCost: number;
}

export interface ItemSnapshot {
  items: ItemRow[];
  units: ItemUnitRow[];
  kinds: ItemKind[];
  stock: StockLine[];
  /** Para la ficha y los avisos de caducidad (opcional en fuentes que solo sirven al selector). */
  lots?: LotRow[];
  movements?: MovementRow[];
  movementCosts?: MovementCostRow[];
  counts?: CountRow[];
  countLines?: CountLineRow[];
}

/** Recuento (`resources.counts`): `spaceId` null = todo; un sitio = ese y lo que cuelga de él. */
export interface CountRow {
  id: string;
  spaceId: string | null;
  status: 'abierto' | 'cerrado';
  note: string | null;
  createdAt: string;
  pending?: boolean;
}

/** Línea contada (`resources.count_lines`): una por recuento, artículo, sitio y lote. */
export interface CountLineRow {
  id: string;
  countId: string;
  itemId: string;
  spaceId: string;
  lotId: string | null;
  quantity: number;
  note: string | null;
  pending?: boolean;
}

/** Movimiento a mano que se va a escribir (sin los campos que pone el servidor). */
export type MovementDraft = Pick<MovementRow, 'id' | 'itemId' | 'spaceId' | 'lotId' | 'quantity' | 'kind' | 'reason' | 'unitCost' | 'transferId' | 'sourceApp' | 'sourceRef' | 'note'> & { at?: string };

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
  /** Cambios de la ficha (solo los campos que vienen). */
  update?(id: string, fields: Partial<ItemRow>): Promise<void>;
  /** Archivar (`false`) o recuperar (`true`): con movimientos no se borra (`ITEM_IN_USE`). */
  setActive?(id: string, active: boolean): Promise<void>;
  /** Alta o cambio de una conversión (`item_units`). */
  saveUnit?(unit: ItemUnitRow, isNew: boolean): Promise<void>;
  removeUnit?(id: string): Promise<void>;
  /** Movimientos a mano (y lotes nuevos de una entrada) en **un solo lote**: un traslado son dos filas juntas. */
  record?(draft: { movements: MovementDraft[]; lots?: LotRow[] }): Promise<void>;
  /** Abre un recuento (sin red también). */
  openCount?(count: { id: string; spaceId: string | null; note?: string | null }): Promise<void>;
  /** Guarda una línea contada (alta o cambio). */
  saveCountLine?(line: CountLineRow, isNew: boolean): Promise<void>;
  /** `resources.close_count`: se aplica al sincronizar, con el stock de ese momento. */
  closeCount?(countId: string): Promise<void>;
}

/** Tipos de movimiento en palabras (docs/resources/API.md §3). */
export const MOVEMENT_KIND_LABELS: Record<string, string> = {
  entrada_factura: 'Entrada por factura',
  entrada_manual: 'Entrada a mano',
  consumo_servicio: 'Consumo del servicio',
  consumo_tarea: 'Consumo de tarea',
  salida_manual: 'Salida a mano',
  traslado: 'Traslado',
  ajuste_recuento: 'Ajuste de recuento',
};

export const EXIT_REASON_LABELS: Record<string, string> = {
  uso: 'Uso', merma: 'Merma', rotura: 'Rotura', caducado: 'Caducado', regalo: 'Regalo', otro: 'Otro',
};

/** Estado de una máquina o herramienta (`attributes.status`). */
export const ITEM_STATUS_LABELS: Record<string, string> = {
  operativo: 'Operativo', limitado: 'Limitado', averiado: 'Averiado', fuera_de_servicio: 'Fuera de servicio',
};

/** Tipos que no se gastan y llevan marca, modelo, serie, estado y factura de compra. */
export const EQUIPMENT_KINDS = ['herramienta', 'maquina'];

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
  /** Ids que van primero entre los que coinciden (K4 de Tasks: los del kit del oficio). */
  boost?: readonly string[];
}

/** Rango de un texto ya normalizado frente a la búsqueda (frase y palabras); `-1` si no coincide. */
function matchRank(text: string, q: string, words: readonly string[]): number {
  if (text.startsWith(q)) return 0;
  if (text.includes(q)) return 1;
  if (words.length < 2) return -1;
  const tokens = text.split(/[\s\-_/.,;:()]+/).filter(Boolean);
  if (words.every((w) => tokens.some((t) => t.startsWith(w)))) return 2;
  if (words.every((w) => text.includes(w))) return 3;
  return -1;
}

/**
 * Busca por nombre y alias sin mayúsculas ni tildes, por la frase y por cada palabra en cualquier orden (K5 de Tasks:
 * «multicapa 20» encuentra «Tubo multicapa 20 mm»). Orden: empieza así, contiene la frase, todas las palabras al principio de
 * palabras del nombre, todas las palabras dentro del nombre; luego lo mismo en los alias, y por último las palabras repartidas
 * entre nombre y alias. Con `boost`, esos ids van delante y conservan el orden entre ellos.
 */
export function searchItems(items: readonly ItemRow[], query: string, options: ItemSearchOptions = {}): ItemRow[] {
  const q = normalizeName(query);
  if (!q) return [];
  const words = [...new Set(q.split(' ').filter(Boolean))];
  const rank = (i: ItemRow): number => {
    const name = normalizeName(i.name);
    const own = matchRank(name, q, words);
    if (own >= 0) return own;
    const extra = [...i.aliases, ...(options.aliases?.[i.id] ?? [])].map(normalizeName);
    const best = Math.min(...extra.map((a) => matchRank(a, q, words)).filter((r) => r >= 0));
    if (Number.isFinite(best)) return 4 + best;
    const all = [name, ...extra].join(' ');
    return words.length > 1 && words.every((w) => all.includes(w)) ? 8 : -1;
  };
  const boost = new Set(options.boost ?? []);
  return items
    .filter((i) => (options.includeArchived || i.active) && (!options.kinds || options.kinds.includes(i.kind)))
    .map((i) => [i, rank(i)] as const).filter(([, r]) => r >= 0)
    .sort((a, b) => Number(boost.has(b[0].id)) - Number(boost.has(a[0].id)) || a[1] - b[1] || a[0].name.localeCompare(b[0].name))
    .slice(0, options.limit ?? 30).map(([i]) => i);
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

/**
 * Coste medio ponderado con las entradas que tienen coste (el suyo o el que llegó después en `movement_costs`).
 * Los contrarios de factura (entradas negativas con coste) restan. Sin entradas con coste, `null`.
 */
export function averageCost(itemId: string, movements: readonly MovementRow[], costs: readonly MovementCostRow[] = []): { averageCost: number; costedQuantity: number } | null {
  const late = new Map(costs.map((c) => [c.movementId, c.unitCost]));
  let quantity = 0;
  let amount = 0;
  for (const m of movements) {
    if (m.itemId !== itemId || !m.kind.startsWith('entrada_')) continue;
    const cost = m.unitCost ?? late.get(m.id) ?? null;
    if (cost === null) continue;
    quantity += m.quantity;
    amount += m.quantity * cost;
  }
  if (quantity <= 0) return null;
  return { averageCost: Math.round((amount / quantity) * 10000) / 10000, costedQuantity: Math.round(quantity * 1e6) / 1e6 };
}

/** Lotes con stock de un artículo (en unos sitios, si se pide), con su caducidad; primero lo que caduca antes. */
export function lotsWithStock(itemId: string, stock: readonly StockLine[], lots: readonly LotRow[], spaceIds?: readonly string[] | null): Array<{ lot: LotRow | null; spaceId: string; quantity: number }> {
  const byId = new Map(lots.map((l) => [l.id, l]));
  return stock.filter((l) => l.itemId === itemId && l.quantity > 0 && (!spaceIds || spaceIds.includes(l.spaceId)))
    .map((l) => ({ lot: l.lotId ? byId.get(l.lotId) ?? null : null, spaceId: l.spaceId, quantity: l.quantity }))
    .sort((a, b) => (a.lot?.expiresOn ?? '9999').localeCompare(b.lot?.expiresOn ?? '9999'));
}

/** Primera caducidad con stock dentro de `days` días (incluye las ya pasadas), o `null`. */
export function nextExpiry(itemId: string, stock: readonly StockLine[], lots: readonly LotRow[], today: string, days: number, spaceIds?: readonly string[] | null): string | null {
  const limit = new Date(Date.parse(`${today}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const first = lotsWithStock(itemId, stock, lots, spaceIds).find((l) => l.lot?.expiresOn);
  const date = first?.lot?.expiresOn ?? null;
  return date && date <= limit ? date : null;
}

/** Campos del kit → columnas de `resources.items` (solo los que vienen; `aliases` va dentro de `attributes`). */
export function itemToFields(fields: Partial<ItemRow>, current?: ItemRow | null): Record<string, unknown> {
  const map: Record<string, string> = {
    name: 'name', kind: 'kind', category: 'category', baseUnit: 'base_unit', minQuantity: 'min_quantity', reorderQuantity: 'reorder_quantity',
    defaultSpaceId: 'default_space_id', defaultSupplierId: 'default_supplier_id', tracksLots: 'tracks_lots', tracksExpiry: 'tracks_expiry', active: 'active', notes: 'notes',
  };
  const out: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(map)) if (key in fields) out[column] = (fields as Record<string, unknown>)[key];
  if ('attributes' in fields || 'aliases' in fields) {
    const attributes: Record<string, unknown> = { ...(current?.attributes ?? {}), ...(fields.attributes ?? {}) };
    const aliases = fields.aliases ?? (Array.isArray(attributes.aliases) ? attributes.aliases as string[] : current?.aliases ?? []);
    if (aliases.length) attributes.aliases = aliases; else delete attributes.aliases;
    out.attributes = attributes;
  }
  return out;
}

export function lotFromRow(row: Record<string, unknown>): LotRow {
  return { id: String(row.id), itemId: String(row.item_id), code: (row.code as string | null) ?? null, expiresOn: (row.expires_on as string | null)?.slice(0, 10) ?? null };
}

export function movementFromRow(row: Record<string, unknown>): MovementRow {
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
  return {
    id: String(row.id), itemId: String(row.item_id), spaceId: String(row.space_id), lotId: (row.lot_id as string | null) ?? null,
    quantity: Number(row.quantity ?? 0), kind: String(row.kind ?? ''), reason: (row.reason as string | null) ?? null, unitCost: num(row.unit_cost),
    transferId: (row.transfer_id as string | null) ?? null, countId: (row.count_id as string | null) ?? null,
    sourceApp: (row.source_app as string | null) ?? null, sourceRef: (row.source_ref as string | null) ?? null, note: (row.note as string | null) ?? null,
    at: String(row.at ?? row.created_at ?? ''), createdBy: (row.created_by as string | null) ?? (row.updated_by as string | null) ?? null, pending: row._pending === true,
  };
}

/**
 * Reparto de una salida o un traslado entre los lotes de un sitio: primero lo que caduca antes, después lo que no
 * caduca. Lo que no alcanza va en `shortfall` (sin lote), como hace `resources.consume`.
 */
export function fefoPlan(itemId: string, spaceId: string, quantity: number, stock: readonly StockLine[], lots: readonly LotRow[]): { parts: Array<{ lotId: string | null; quantity: number }>; shortfall: number } {
  const byId = new Map(lots.map((l) => [l.id, l]));
  const here = stock.filter((l) => l.itemId === itemId && l.spaceId === spaceId && l.quantity > 0)
    .sort((a, b) => {
      const ea = a.lotId ? byId.get(a.lotId)?.expiresOn ?? '9999' : '9999z';
      const eb = b.lotId ? byId.get(b.lotId)?.expiresOn ?? '9999' : '9999z';
      return ea.localeCompare(eb);
    });
  const parts: Array<{ lotId: string | null; quantity: number }> = [];
  let left = Math.round(quantity * 1e6) / 1e6;
  for (const l of here) {
    if (left <= 0) break;
    const take = Math.min(left, l.quantity);
    parts.push({ lotId: l.lotId, quantity: Math.round(take * 1e6) / 1e6 });
    left = Math.round((left - take) * 1e6) / 1e6;
  }
  return { parts, shortfall: left > 0 ? left : 0 };
}

/** Stock de un artículo en un sitio y lote concretos (lo que el servidor llama «lo calculado»). */
export function stockAt(stock: readonly StockLine[], itemId: string, spaceId: string, lotId: string | null): number {
  return Math.round(stock.filter((l) => l.itemId === itemId && l.spaceId === spaceId && l.lotId === lotId).reduce((a, l) => a + l.quantity, 0) * 1e6) / 1e6;
}

export interface CountTarget {
  itemId: string;
  spaceId: string;
  lotId: string | null;
  /** Lo calculado ahora (puede cambiar antes de cerrar). */
  expected: number;
}

/**
 * Qué se espera encontrar en unos sitios: cada artículo activo con stock ahí (por lote) y los que se guardan ahí aunque
 * estén a cero. Con `itemIds`, solo esos (el «Recontar» de una fila).
 */
export function countTargets(snapshot: ItemSnapshot, spaceIds: readonly string[] | null, itemIds?: readonly string[] | null): CountTarget[] {
  const inScope = (sid: string) => !spaceIds || spaceIds.includes(sid);
  const wanted = (id: string) => !itemIds || itemIds.includes(id);
  const active = new Map(snapshot.items.filter((i) => i.active && wanted(i.id)).map((i) => [i.id, i]));
  const out = new Map<string, CountTarget>();
  for (const l of snapshot.stock) {
    if (!active.has(l.itemId) || !inScope(l.spaceId) || l.quantity <= 0) continue;
    out.set(`${l.itemId}|${l.spaceId}|${l.lotId ?? ''}`, { itemId: l.itemId, spaceId: l.spaceId, lotId: l.lotId, expected: stockAt(snapshot.stock, l.itemId, l.spaceId, l.lotId) });
  }
  for (const it of active.values()) {
    const home = it.defaultSpaceId;
    if (!home || !inScope(home) || [...out.values()].some((t) => t.itemId === it.id)) continue;
    out.set(`${it.id}|${home}|`, { itemId: it.id, spaceId: home, lotId: null, expected: 0 });
  }
  return [...out.values()];
}

export function countFromRow(row: Record<string, unknown>): CountRow {
  return { id: String(row.id), spaceId: (row.space_id as string | null) ?? null, status: row.status === 'cerrado' ? 'cerrado' : 'abierto', note: (row.note as string | null) ?? null, createdAt: String(row.created_at ?? ''), pending: row._pending === true };
}

export function countLineFromRow(row: Record<string, unknown>): CountLineRow {
  return { id: String(row.id), countId: String(row.count_id), itemId: String(row.item_id), spaceId: String(row.space_id), lotId: (row.lot_id as string | null) ?? null, quantity: Number(row.quantity ?? 0), note: (row.note as string | null) ?? null, pending: row._pending === true };
}

/** Borrador de movimiento → columnas de `resources.movements`. */
export function movementToFields(m: MovementDraft): Record<string, unknown> {
  return {
    item_id: m.itemId, space_id: m.spaceId, lot_id: m.lotId, quantity: m.quantity, kind: m.kind, reason: m.reason, unit_cost: m.unitCost,
    transfer_id: m.transferId, source_app: m.sourceApp, source_ref: m.sourceRef, note: m.note, ...(m.at ? { at: m.at } : {}),
  };
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
export function createMemoryItemSource(initial: ItemSnapshot, options: { delay?: number; server?: ItemRow[]; supplierNames?: Record<string, string>; failUpdate?: (id: string, fields: Partial<ItemRow>) => string | null; me?: string } = {}): ItemSource & { snapshot(): ItemSnapshot } {
  let snap: ItemSnapshot = { ...initial, items: initial.items.slice() };
  const listeners = new Set<(s: ItemSnapshot) => void>();
  const dupListeners = new Set<(d: ItemDuplicate) => void>();
  const server = (options.server ?? []).slice();
  const emit = () => { const s = { ...snap, items: snap.items.slice() }; listeners.forEach((l) => l(s)); };
  const wait = () => new Promise<void>((r) => setTimeout(r, options.delay ?? 0));
  const restock = (moves: readonly MovementRow[]) => stockFromMovements(moves.map((m) => ({ item_id: m.itemId, space_id: m.spaceId, lot_id: m.lotId, quantity: m.quantity })));
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
    async update(id, fields) {
      const refused = options.failUpdate?.(id, fields) ?? null;
      if (refused) throw new Error(refused);
      snap.items = snap.items.map((i) => (i.id === id ? { ...i, ...fields, pending: true } : i));
      emit();
      void wait().then(() => { snap.items = snap.items.map((i) => (i.id === id ? { ...i, pending: false } : i)); emit(); });
    },
    async setActive(id, active) {
      snap.items = snap.items.map((i) => (i.id === id ? { ...i, active, pending: true } : i));
      emit();
      void wait().then(() => { snap.items = snap.items.map((i) => (i.id === id ? { ...i, pending: false } : i)); emit(); });
    },
    async saveUnit(unit, isNew) {
      snap.units = isNew ? [...snap.units, unit] : snap.units.map((u) => (u.id === unit.id ? unit : u));
      emit();
    },
    async removeUnit(id) { snap.units = snap.units.filter((u) => u.id !== id); emit(); },
    async record({ movements, lots }) {
      const at = new Date().toISOString();
      const rows: MovementRow[] = movements.map((m) => ({ ...m, countId: null, at: m.at ?? at, createdBy: options.me ?? null, pending: true }));
      snap.lots = [...(snap.lots ?? []), ...(lots ?? [])];
      snap.movements = [...(snap.movements ?? []), ...rows];
      snap.stock = restock(snap.movements);
      emit();
      void wait().then(() => { const ids = new Set(rows.map((r) => r.id)); snap.movements = (snap.movements ?? []).map((m) => (ids.has(m.id) ? { ...m, pending: false } : m)); emit(); });
    },
    async openCount({ id, spaceId, note }) {
      snap.counts = [...(snap.counts ?? []), { id, spaceId, note: note ?? null, status: 'abierto', createdAt: new Date().toISOString(), pending: true }];
      emit();
    },
    async saveCountLine(line, isNew) {
      snap.countLines = isNew ? [...(snap.countLines ?? []), { ...line, pending: true }] : (snap.countLines ?? []).map((l) => (l.id === line.id ? { ...line, pending: true } : l));
      emit();
    },
    async closeCount(countId) {
      // Como el servidor: un ajuste por línea con la diferencia frente a lo calculado al llegar el lote.
      void wait().then(() => {
        const lines = (snap.countLines ?? []).filter((l) => l.countId === countId);
        const at = new Date().toISOString();
        const adjust: MovementRow[] = [];
        for (const l of lines) {
          const diff = Math.round((l.quantity - stockAt(snap.stock, l.itemId, l.spaceId, l.lotId)) * 1e6) / 1e6;
          if (diff !== 0) adjust.push({ id: newItemId(), itemId: l.itemId, spaceId: l.spaceId, lotId: l.lotId, quantity: diff, kind: 'ajuste_recuento', reason: null, unitCost: null, transferId: null, countId, sourceApp: null, sourceRef: null, note: null, at, createdBy: options.me ?? null });
        }
        snap.movements = [...(snap.movements ?? []), ...adjust];
        snap.stock = restock(snap.movements);
        snap.counts = (snap.counts ?? []).map((c) => (c.id === countId ? { ...c, status: 'cerrado', pending: false } : c));
        snap.countLines = (snap.countLines ?? []).map((l) => (l.countId === countId ? { ...l, pending: false } : l));
        emit();
      });
    },
    snapshot: () => snap,
  };
}
