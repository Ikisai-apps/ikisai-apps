/**
 * La lista de la compra única por evento (1117, API.md §2.15): suma las listas de los menús del evento y la pide a Tasks
 * como compras (`tasks.request_purchase`). Lógica pura: la Edge y la pantalla la comparten.
 */
import type { ShoppingItemStatus } from './planning.ts';

export interface EventShoppingLine { id: string; revision: number; menu_id: string; quantity: number | string; status: ShoppingItemStatus; purchase_ref: string | null }
export interface EventShoppingRow {
  key: string; ingredient_id: string; item_id: string | null; name: string; unit: string; supplier: string | null; aisle: string | null;
  pending: number | string; bought: number | string; requested: number | string; purchase_ref: string | null; purchase_project_id: string | null;
  status: 'pendiente' | 'pedida' | 'comprado'; menus: string[]; lines: EventShoppingLine[];
}
export interface EventShoppingMenu { menu_id: string; kind: 'retiro' | 'carta'; name: string; list_id: string | null; generated_at: string | null; lines: number }
export interface EventShopping { event_id: string; menus: EventShoppingMenu[]; rows: EventShoppingRow[] }

export const NO_SHOP_LABEL = 'Sin tienda';
export const NO_AISLE_LABEL = 'Otros';

/** Referencia de la petición en Tasks: una por evento, ingrediente, unidad y tienda. Repetir no duplica. */
export const eventPurchaseRef = (eventId: string, row: Pick<EventShoppingRow, 'key'>): string => `food:event:${eventId}:${row.key}`;

/** «Tomate · 3 kg (Barra · Evento de octubre)», hasta 300 caracteres. */
export function eventPurchaseTitle(row: Pick<EventShoppingRow, 'name' | 'unit'>, quantity: number, eventTitle: string): string {
  return `${row.name} · ${Number(quantity.toFixed(3)).toLocaleString('es-ES')} ${row.unit} (${eventTitle})`.slice(0, 300);
}

/** El día antes de una fecha AAAA-MM-DD (para `due`: la compra, antes del evento). */
export function dayBefore(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Estado de una compra de Tasks → estado de la línea de Food; null si aún no está comprada. */
export function itemStatusFromPurchase(status: string | null | undefined): ShoppingItemStatus | null {
  return status === 'purchased' ? 'comprado' : status === 'received' ? 'recibido' : null;
}

/** Lo que falta por pedir de una fila: lo pendiente que no se ha pedido a Tasks todavía. */
export function unrequestedQuantity(row: Pick<EventShoppingRow, 'lines'>): number {
  return row.lines.filter((l) => l.status === 'pendiente' && !l.purchase_ref).reduce((n, l) => n + Number(l.quantity), 0);
}

/** Por tienda y, dentro, por pasillo (la categoría del artículo); sin tienda y sin pasillo, al final. */
export function groupEventShopping(rows: EventShoppingRow[]): Array<{ shop: string; aisles: Array<{ aisle: string; rows: EventShoppingRow[] }> }> {
  const shops = new Map<string, Map<string, EventShoppingRow[]>>();
  for (const row of rows) {
    const shop = row.supplier?.trim() || NO_SHOP_LABEL;
    const aisle = row.aisle?.trim() || NO_AISLE_LABEL;
    const aisles = shops.get(shop) ?? new Map<string, EventShoppingRow[]>();
    aisles.set(aisle, [...(aisles.get(aisle) ?? []), row]);
    shops.set(shop, aisles);
  }
  const last = (a: string, b: string, tail: string) => (a === tail ? 1 : 0) - (b === tail ? 1 : 0) || a.localeCompare(b, 'es');
  return [...shops.keys()].sort((a, b) => last(a, b, NO_SHOP_LABEL)).map((shop) => ({
    shop,
    aisles: [...shops.get(shop)!.keys()].sort((a, b) => last(a, b, NO_AISLE_LABEL))
      .map((aisle) => ({ aisle, rows: shops.get(shop)!.get(aisle)!.sort((x, y) => x.name.localeCompare(y.name, 'es')) })),
  }));
}

/** Menús del evento sin lista generada: la del evento saldría corta sin decirlo. */
export const menusWithoutList = (data: Pick<EventShopping, 'menus'>): EventShoppingMenu[] => data.menus.filter((m) => !m.list_id);
