/**
 * Ikisai Food · la carta (decisión de VG del 26-10-2026; docs/food/API.md §2.10, migración 1109).
 *
 * - Un menú es «cerrado» (el de siempre: `kind` 'retiro' o 'casa') o una **carta** (`kind = 'carta'`), con nombre, con o
 *   sin evento. La carta no tiene servicios ni platos: tiene **líneas** (`food.carta_lines`), cada una una receta
 *   (montaditos) o un artículo de Recursos (bebidas, palomitas), con ámbito, código, precio de venta, activa o no e imagen.
 * - Las ventas de un día (`food.carta_sales`) las registra `food.record_carta_sales` (Flow, al cerrar el día). Después,
 *   food-api deja el stock de Recursos como dicen las ventas (`cartaStockOperations`), con la referencia del día.
 */
import type { SyncedColumns } from './catalog.ts';
import type { Menu } from './menus.ts';

export const CARTA_SCOPES = ['clasico', 'gourmet', 'barra'] as const;
export type CartaScope = (typeof CARTA_SCOPES)[number];
export const CARTA_SCOPE_LABELS: Record<CartaScope, string> = { clasico: 'Clásicos', gourmet: 'Gourmet', barra: 'Barra' };
/** Los códigos se repiten entre ámbitos (§8): la clave es siempre ámbito + código. */
export const CARTA_CODES = ['A', 'B', 'C', 'D', 'α', 'β', 'γ', 'δ'] as const;
export type CartaCode = (typeof CARTA_CODES)[number];
export const CARTA_PRICE_MAX_CENTS = 1_000_000;
/** `<categoria>/<slug>`, como `flow.products.image_key` (montaditos/serrano). */
export const IMAGE_KEY = /^[a-z0-9]+([_-][a-z0-9]+)*\/[a-z0-9]+([_-][a-z0-9]+)*$/;

export interface CartaLine extends SyncedColumns {
  menu_id: string;
  recipe_id: string | null;
  item_id: string | null;
  scope: CartaScope;
  code: CartaCode;
  name: string | null;
  description: string | null;
  sale_price_cents: number;
  active: boolean;
  position: number;
  image_key: string | null;
  /** Unidades que se esperan vender (previsión, 1110); null sin previsión. */
  expected_units?: number | null;
}

export interface CartaSale extends SyncedColumns {
  menu_id: string;
  line_id: string;
  day: string;
  quantity: number;
}

export function isCartaMenu(menu: Pick<Menu, 'kind'> | null | undefined): boolean {
  return menu?.kind === 'carta';
}

/** Los menús cerrados (retiros y el de casa): lo que enseñan las pantallas que no saben de cartas. */
export function closedMenus<T extends Pick<Menu, 'kind'>>(menus: T[]): T[] {
  return menus.filter((m) => !isCartaMenu(m));
}

/** Referencia de los movimientos de stock de las ventas de un día de una carta. No cambiarla. */
export const cartaStockRef = (menuId: string, day: string) => `carta:${menuId}:${day}`;

/** Margen de una línea: precio de venta − coste, y su parte del precio. Null sin coste o con precio 0. */
export function cartaMargin(priceCents: number, costCents: number | null): { cents: number; ratio: number } | null {
  if (costCents === null || !(priceCents > 0)) return null;
  return { cents: priceCents - costCents, ratio: (priceCents - costCents) / priceCents };
}

/** Lo que devuelve `food.carta_stock_plan`: por artículo, lo que deben restar las ventas y lo que ya restan. */
export interface CartaStockPlan {
  menu_id: string;
  day: string;
  source_ref: string;
  items: Array<{ item_id: string; target: number | string; current: number | string; default_space_id: string | null }>;
  /** Líneas vendidas que no se pueden pasar a stock (receta sin artículos o sin conversión). */
  unconverted: string[];
  kitchen: string[];
}

export type CartaStockOperation =
  | { kind: 'consume'; itemId: string; quantity: number }
  | { kind: 'return'; itemId: string; quantity: number; spaceId: string };

/**
 * Lo que falta para que el stock cuadre con las ventas: si las ventas restan más de lo que ya se restó, consumir la
 * diferencia; si restan menos (se corrigió a la baja), devolverla con una entrada a mano en el sitio del artículo (o la
 * cocina). Sin sitio para devolver, se queda en `skipped`.
 */
export function cartaStockOperations(plan: CartaStockPlan): { operations: CartaStockOperation[]; skipped: string[] } {
  const operations: CartaStockOperation[] = [];
  const skipped: string[] = [];
  for (const item of plan.items) {
    const delta = Math.round((Number(item.target) - Number(item.current)) * 1e6) / 1e6;
    if (delta === 0) continue;
    if (delta < 0) {
      operations.push({ kind: 'consume', itemId: item.item_id, quantity: -delta });
      continue;
    }
    const spaceId = item.default_space_id ?? plan.kitchen[0] ?? null;
    if (spaceId) operations.push({ kind: 'return', itemId: item.item_id, quantity: delta, spaceId });
    else skipped.push(item.item_id);
  }
  return { operations, skipped };
}

/** Las líneas vivas de una carta, en el orden de la carta: ámbito (clásicos, gourmet, barra), posición y código. */
export function cartaLinesInOrder<T extends Pick<CartaLine, 'menu_id' | 'scope' | 'position' | 'code' | 'deleted_at'>>(lines: T[], menuId: string): T[] {
  const scopeIndex = (s: CartaScope) => CARTA_SCOPES.indexOf(s);
  return lines.filter((l) => l.menu_id === menuId && !l.deleted_at)
    .sort((a, b) => scopeIndex(a.scope) - scopeIndex(b.scope) || Number(a.position) - Number(b.position) || CARTA_CODES.indexOf(a.code) - CARTA_CODES.indexOf(b.code));
}

/** Códigos libres de un ámbito en una carta, para añadir una línea. */
export function freeCartaCodes(lines: Array<Pick<CartaLine, 'menu_id' | 'scope' | 'code' | 'deleted_at'>>, menuId: string, scope: CartaScope): CartaCode[] {
  const used = new Set(lines.filter((l) => l.menu_id === menuId && l.scope === scope && !l.deleted_at).map((l) => l.code));
  return CARTA_CODES.filter((c) => !used.has(c));
}

/**
 * «Usar en otro evento»: una carta nueva con las mismas líneas (precio, disponibilidad, imagen…), ligada a `eventId` o
 * guardada sin evento. Las ventas no se copian: cada evento tiene las suyas.
 */
export function copyCartaOperations(args: {
  lines: CartaLine[]; sourceId: string; newId: string; name: string; eventId: string | null; newLineId: () => string;
  /** El reparto de la carta de origen (1110), si lo tiene. */
  prepSplit?: PrepSplit | null;
}): Array<{ op: 'insert'; table: string; id: string; fields: Record<string, unknown> }> {
  const ops: Array<{ op: 'insert'; table: string; id: string; fields: Record<string, unknown> }> = [
    { op: 'insert', table: 'food.menus', id: args.newId, fields: { kind: 'carta', name: args.name, ...(args.eventId ? { event_id: args.eventId } : {}), ...(args.prepSplit ? { prep_split: args.prepSplit } : {}) } },
  ];
  for (const l of cartaLinesInOrder(args.lines, args.sourceId)) {
    ops.push({ op: 'insert', table: 'food.carta_lines', id: args.newLineId(), fields: {
      menu_id: args.newId, ...(l.recipe_id ? { recipe_id: l.recipe_id } : { item_id: l.item_id }), scope: l.scope, code: l.code,
      // Lo que viene de la base puede llegar como texto (numeric): se pasa a número.
      name: l.name, description: l.description, sale_price_cents: Number(l.sale_price_cents), active: l.active, position: Number(l.position), image_key: l.image_key,
      ...(l.expected_units !== undefined && l.expected_units !== null ? { expected_units: Number(l.expected_units) } : {}),
    } });
  }
  return ops;
}

/** Euros a céntimos desde lo que se escribe («2,50», «2.5», «3»); null si no es un precio válido. */
export function parseEurosToCents(text: string): number | null {
  const clean = text.trim().replace(/\s|€/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const cents = Math.round(Number(clean) * 100);
  return cents <= CARTA_PRICE_MAX_CENTS ? cents : null;
}

/** Céntimos en euros a la española: 250 → «2,50 €». */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  return (cents / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

/** Reparto de lo que se prepara (1110): en bandeja en mesa, en bandeja en nevera y en fresco, en %, suma 100. */
export interface PrepSplit { mesa: number; nevera: number; fresco: number }
export const DEFAULT_PREP_SPLIT: PrepSplit = { mesa: 30, nevera: 20, fresco: 50 };
export const prepSplitOf = (value: unknown): PrepSplit => (prepSplitProblem(value) === null && value ? value as PrepSplit : DEFAULT_PREP_SPLIT);

/** Qué tiene de malo un reparto, o null si vale (o si es null: el de por defecto). */
export function prepSplitProblem(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'El reparto debe llevar mesa, nevera y fresco.';
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => !['mesa', 'nevera', 'fresco'].includes(k))) return 'El reparto solo lleva mesa, nevera y fresco.';
  const parts = [v.mesa, v.nevera, v.fresco];
  if (parts.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) return 'Cada parte del reparto es un porcentaje (0 o más).';
  return Math.abs((parts as number[]).reduce((a, b) => a + b, 0) - 100) < 1e-9 ? null : 'Mesa, nevera y fresco tienen que sumar 100 %.';
}

/** Fila de `food.carta_prep_projection` (1110): una por línea de carta y componente. */
export interface CartaPrepRow {
  menu_id: string; line_id: string; scope: CartaScope; code: CartaCode; ingredient_id: string | null; item_id: string | null; component_key: string;
  name: string; unit: string; per_unit: number | string | null; expected_units: number; need_total: number | string | null;
  mesa: number | string | null; nevera: number | string | null; fresco: number | string | null; station: number | null; convertible: boolean;
  line_revision: number; menu_revision: number;
}

/** Fila de `food.carta_prep_totals_projection` (1110): una por componente, sumando las líneas. */
export interface CartaPrepTotal {
  menu_id: string; component_key: string; item_id: string | null; ingredient_id: string | null; name: string; unit: string;
  need_total: number | string | null; mesa: number | string | null; nevera: number | string | null; fresco: number | string | null;
  convertible: boolean; station: number | null;
}

export const STATION_LABELS: Record<number, string> = { 1: 'Untar', 2: 'Colocar', 3: 'Dosificar', 4: 'Acabados' };
