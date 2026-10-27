/**
 * «Servicio de barra» en la ficha del evento (encargo de VG del 26-10-2026): el cierre de cada día que hace Flow, leído de
 * `flow.booking_service_projection` (Flow es el dueño; Booking no escribe nada). Por día: pedidos, ventas (efectivo y
 * Bizum), devoluciones pendientes, horas punta y lo más vendido. Solo para quien ve importes y con red.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { el, plural, replace } from '@ikisai/ui-kit';
import { describeError, fullDay } from '../app/client.ts';

export interface DayClosure {
  event_id: string;
  day: string;
  data: {
    orders?: number; sales_cents?: number; sales_by_method?: { cash?: number; bizum?: number };
    units_by_product?: Array<{ scope?: string; code?: string; name?: string; units?: number; amount_cents?: number }>;
    peak_hours?: Array<{ hour: number; orders: number }>; refunds_pending_cents?: number; closed_at?: string;
  };
  updated_at?: string;
}

const EUR = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
export const euros = (cents: number | undefined): string => EUR.format((Number(cents) || 0) / 100);

/** Las 3 horas con más pedidos, en orden de hora: «13 h (24) · 14 h (31)». */
export function peaks(rows: DayClosure['data']['peak_hours']): string | null {
  const top = [...(rows ?? [])].filter((r) => r.orders > 0).sort((a, b) => b.orders - a.orders || a.hour - b.hour).slice(0, 3).sort((a, b) => a.hour - b.hour);
  return top.length ? top.map((r) => `${r.hour} h (${r.orders})`).join(' · ') : null;
}

/** Lo más vendido: hasta 5 productos por unidades. */
export function topProducts(rows: DayClosure['data']['units_by_product']): string | null {
  const top = [...(rows ?? [])].filter((r) => (r.units ?? 0) > 0).sort((a, b) => (b.units ?? 0) - (a.units ?? 0)).slice(0, 5);
  return top.length ? top.map((r) => `${r.code ? `${r.code} ` : ''}${r.name ?? ''} × ${r.units}`.trim()).join(' · ') : null;
}

export function renderBarService(o: { client: SyncClient; eventId: string }): HTMLElement {
  const body = el('div', null, el('p', { class: 'hint' }, 'Cargando el servicio de barra…'));
  const card = el('article', { class: 'card', id: 'blockBarService', 'data-feedback-id': 'booking.reserva.barra', 'data-feedback-label': 'Servicio de barra' },
    el('div', { class: 'cardhead' }, el('h3', null, 'Servicio de barra')), body);

  async function load(): Promise<void> {
    if (!navigator.onLine) return void replace(body, el('p', { class: 'hint' }, 'El servicio de barra se lee de Flow con conexión.'));
    let rows: DayClosure[];
    try {
      rows = (await o.client.api<{ rows: DayClosure[] }>(`/read/flow.booking_service_projection?where[event_id]=${encodeURIComponent(o.eventId)}&limit=31`)).rows ?? [];
    } catch (error) {
      return void replace(body, el('p', { class: 'hint' }, `No se puede leer el servicio de barra: ${describeError(error)}`));
    }
    if (rows.length === 0) return void replace(body, el('p', { class: 'hint', id: 'barServiceEmpty' }, 'Flow todavía no ha cerrado ningún día de este evento.'));
    rows.sort((a, b) => a.day.localeCompare(b.day));
    const total = rows.reduce((s, r) => s + (Number(r.data.sales_cents) || 0), 0);
    const orders = rows.reduce((s, r) => s + (Number(r.data.orders) || 0), 0);
    replace(body,
      rows.length > 1 ? el('p', { id: 'barServiceTotal' }, el('strong', null, euros(total)), ` · ${plural(orders, 'pedido', 'pedidos')} en ${plural(rows.length, 'día', 'días')}`) : null,
      el('ul', { class: 'list', id: 'barServiceDays' }, rows.map((r) => {
        const d = r.data;
        const peak = peaks(d.peak_hours);
        const top = topProducts(d.units_by_product);
        return el('li', { class: 'row', dataset: { day: r.day }, 'data-feedback-id': 'booking.reserva.barra.dia', 'data-feedback-label': 'Día de barra' },
          el('div', { class: 'row-title' }, el('span', { class: 'name' }, fullDay(r.day)), el('span', { class: 'chip ok' }, euros(d.sales_cents))),
          el('div', { class: 'row-meta' }, [
            plural(Number(d.orders) || 0, 'pedido', 'pedidos'),
            `Efectivo ${euros(d.sales_by_method?.cash)} · Bizum ${euros(d.sales_by_method?.bizum)}`,
            d.refunds_pending_cents ? `Devoluciones pendientes ${euros(d.refunds_pending_cents)}` : null,
          ].filter(Boolean).join(' · ')),
          peak ? el('div', { class: 'row-meta' }, `Horas punta: ${peak}`) : null,
          top ? el('div', { class: 'row-meta' }, `Lo más vendido: ${top}`) : null);
      })),
      el('p', { class: 'hint' }, 'Lo cierra el encargado en Flow al acabar cada día; si se vuelve a cerrar, se sustituye.'));
  }

  void load();
  return card;
}
