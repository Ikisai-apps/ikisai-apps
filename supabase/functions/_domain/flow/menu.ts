/**
 * Carta de la barra (canon V1 §3 y §8): ámbitos, productos de la carta pública y cesta. Puro: lo usan `flow-api`
 * (forma de `GET public/menu`) y el frontend (carta y totales). El total que vale es el que calcula el servidor al cobrar.
 */

/** Ámbitos de la carta, en el orden en que se enseñan. Los códigos A–D y α–δ se repiten entre ámbitos (§8). */
export const SCOPES = ['clasico', 'gourmet', 'barra'] as const;
export type Scope = typeof SCOPES[number];

export const SCOPE_LABELS: Record<Scope, string> = { clasico: 'Clásicos', gourmet: 'Gourmet', barra: 'Barra' };

export const CODES = ['A', 'B', 'C', 'D', 'α', 'β', 'γ', 'δ'] as const;

/** Producto tal como lo publica `GET public/menu`. */
export interface MenuProduct {
  id: string;
  scope: Scope;
  code: string;
  name: string;
  description: string | null;
  priceCents: number;
  position: number;
  /** Clave de sus imágenes (`montaditos/serrano`), si las tiene; ver `productAssets`. */
  imageKey: string | null;
}

/** Las cuatro representaciones de un producto (decisión de VG del 26-10), en apps/flow/public/assets/<clave>/. */
export interface ProductAssets { icon: string; medal: string; thumb: string; zoom: string }

export function productAssets(imageKey: string | null | undefined): ProductAssets | null {
  if (!imageKey || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(imageKey)) return null;
  const base = `/assets/${imageKey}`;
  return { icon: `${base}/icono.svg`, medal: `${base}/medallon.svg`, thumb: `${base}/miniatura.webp`, zoom: `${base}/zoom.webp` };
}

export interface MenuGroup {
  scope: Scope;
  label: string;
  products: MenuProduct[];
}

/** Clave global de un producto en la carta: nunca la letra sola (§8). */
export function productKey(scope: Scope, code: string): string {
  return `${scope}:${code}`;
}

/** Agrupa por ámbito en el orden de la carta, y dentro de cada ámbito por `position` y código. Omite ámbitos vacíos. */
export function groupMenu(products: readonly MenuProduct[]): MenuGroup[] {
  return SCOPES.map((scope) => ({
    scope,
    label: SCOPE_LABELS[scope],
    products: products.filter((p) => p.scope === scope)
      .sort((a, b) => a.position - b.position || CODES.indexOf(a.code as never) - CODES.indexOf(b.code as never)),
  })).filter((g) => g.products.length > 0);
}

/** Cesta: cantidades por id de producto. Las cantidades no enteras o negativas cuentan como 0. */
export type Basket = Record<string, number>;

export function setQuantity(basket: Basket, id: string, quantity: number): Basket {
  const next = { ...basket };
  const q = Number.isInteger(quantity) && quantity > 0 ? Math.min(quantity, 99) : 0;
  if (q) next[id] = q; else delete next[id];
  return next;
}

export interface BasketLine { product: MenuProduct; quantity: number; subtotalCents: number }

/** Líneas de la cesta en el orden de la carta, solo con productos que siguen en ella. */
export function basketLines(basket: Basket, products: readonly MenuProduct[]): BasketLine[] {
  return groupMenu(products).flatMap((g) => g.products)
    .filter((p) => (basket[p.id] ?? 0) > 0)
    .map((product) => ({ product, quantity: basket[product.id]!, subtotalCents: basket[product.id]! * product.priceCents }));
}

export function basketTotal(lines: readonly BasketLine[]): { units: number; totalCents: number } {
  return lines.reduce((acc, l) => ({ units: acc.units + l.quantity, totalCents: acc.totalCents + l.subtotalCents }), { units: 0, totalCents: 0 });
}

/** «2,50 €». */
export function formatEuros(cents: number): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}
