import { el, replace, toast } from '@ikisai/ui-kit';
import { formatEuros, PROCEDURES, TABLES } from '@ikisai/domain-flow';
import { describeError } from '../app/client.ts';
import { callProcedure, isOnline } from '../app/actions.ts';
import { loadProjects, type Project } from '../app/data.ts';
import { busyButton } from './sheets-common.ts';
import type { ViewMount } from './shell.ts';

/**
 * Cierre del día (encargo de VG del 26-10; contratos con Food, Booking y Finance). Solo el owner.
 * - «Calcular cierre»: `flow.close_day` guarda el resumen del día (se puede repetir: sustituye).
 * - Resumen: total, por método, por producto, pedidos, anulaciones, devoluciones pendientes y horas punta.
 * - «Enviar a Food» (ventas por línea de su carta) y «Enviar a Finance» (apunte de ingresos; en modo pruebas no se envía),
 *   cada uno con su estado (enviado a las hh:mm, o el error). Reenviar es idempotente. Booking no necesita botón: lee el
 *   resumen en la ficha del evento.
 */
interface Closure {
  id: string; project_id: string; day: string; revision: number; deleted_at: string | null; closed_at: string; data: any;
  food_status: string | null; food_sent_at: string | null; food_result: any; finance_status: string | null; finance_sent_at: string | null; finance_result: any;
}

const madridToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const hhmm = (iso: string | null) => (iso ? new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' }).format(new Date(iso)) : '');

export const mountClosure: ViewMount = ({ main, client, projectId }) => {
  const isOwner = client.bootstrap()?.membership.role === 'owner';
  if (!isOwner || !projectId) { main.append(el('p', { class: 'muted' }, 'El cierre del día lo hace el encargado.')); return () => undefined; }
  let project: Project | null = null;
  let day = madridToday();
  const dayInput = el('input', { type: 'date', value: day, 'aria-label': 'Día', onchange: () => { day = dayInput.value || madridToday(); void paint(); } });
  const summary = el('section', { class: 'closure-summary', 'aria-live': 'polite' });
  const sends = el('section', { class: 'closure-sends' });
  main.append(
    el('h1', { class: 'col-title' }, 'Cierre del día'),
    el('div', { class: 'orders-tools' }, dayInput, busyButton({ class: 'primary' }, 'Calcular cierre', calculate)),
    summary, sends,
  );

  async function closureOfDay(): Promise<Closure | null> {
    const rows = (await client.list(TABLES.dayClosures)) as unknown as Closure[];
    return rows.find((c) => c.project_id === projectId && c.day === day && !c.deleted_at) ?? null;
  }

  async function calculate(): Promise<void> {
    if (!isOnline(client)) { toast('El cierre necesita conexión.'); return; }
    try {
      await callProcedure(client, PROCEDURES.closeDay, { project_id: projectId, day });
      await client.sync();
      toast('Cierre calculado.');
      await paint();
    } catch (error) { toast(describeError(error)); }
  }

  async function send(c: Closure, target: 'food' | 'finance'): Promise<void> {
    if (!isOnline(client)) { toast('Enviar necesita conexión.'); return; }
    // El resultado (enviado o error) lo anota flow-api en el cierre (FL9); aquí solo se avisa y se sincroniza.
    try {
      await client.api<{ status: string; result: unknown }>(`/closures/${c.id}/send/${target}`, { method: 'POST', json: {} });
      toast(target === 'food' ? 'Enviado a Food.' : 'Enviado a Finance como apunte de proceso.');
    } catch (error) { toast(describeError(error)); }
    try { await client.sync(); } catch { /* el pull periódico lo traerá */ }
    await paint();
  }

  function sendRow(label: string, c: Closure, target: 'food' | 'finance', blocked: string | null): HTMLElement {
    const st = target === 'food' ? c.food_status : c.finance_status;
    const at = target === 'food' ? c.food_sent_at : c.finance_sent_at;
    const res = target === 'food' ? c.food_result : c.finance_result;
    const stale = at && c.closed_at > at;
    const state = blocked ? blocked
      : st === 'sent' ? `Enviado a las ${hhmm(at)}${stale ? ' · el cierre ha cambiado: reenvía' : ''}`
      : st === 'skipped_test_mode' ? 'Modo pruebas: no se envía a Finance'
      : st === 'error' ? `Error: ${res?.message ?? 'no se pudo enviar'}` : 'Sin enviar';
    const button = busyButton({ class: st === 'sent' && !stale ? 'ghost' : 'primary' }, st ? `Reenviar a ${label}` : `Enviar a ${label}`, () => send(c, target));
    button.disabled = !!blocked;
    return el('div', { class: `closure-send is-${st ?? 'none'}` }, el('div', null, el('strong', null, label), el('small', { class: 'muted' }, ` · ${state}`)), button);
  }

  async function paint(): Promise<void> {
    project = (await loadProjects(client)).find((p) => p.id === projectId) ?? null;
    const c = await closureOfDay();
    if (!c) {
      replace(summary, el('p', { class: 'muted' }, 'Este día aún no se ha cerrado. «Calcular cierre» lo resume con lo cobrado hasta ahora; se puede repetir.'));
      replace(sends);
      return;
    }
    const d = c.data ?? {};
    replace(summary,
      el('p', { class: 'closure-total' }, el('span', null, 'Total del día'), el('strong', null, formatEuros(d.sales_cents ?? 0))),
      el('ul', { class: 'closure-figures' },
        el('li', null, `Efectivo: ${formatEuros(d.sales_by_method?.cash ?? 0)}`),
        el('li', null, `Bizum: ${formatEuros(d.sales_by_method?.bizum ?? 0)}`),
        el('li', null, `Pedidos cobrados: ${d.orders ?? 0}`),
        el('li', null, `Anulaciones: ${formatEuros(d.reversals_cents ?? 0)}`),
        el('li', null, `Devoluciones pendientes: ${formatEuros(d.refunds_pending_cents ?? 0)}`)),
      el('table', { class: 'closure-products' },
        el('thead', null, el('tr', null, el('th', null, 'Producto'), el('th', null, 'Unidades'), el('th', null, 'Importe'))),
        el('tbody', null, ...(d.units_by_product ?? []).map((u: any) => el('tr', null, el('td', null, `${u.code} · ${u.name}`), el('td', null, String(u.units)), el('td', null, formatEuros(u.amount_cents)))))),
      ...((d.peak_hours ?? []).length ? [el('p', { class: 'muted small' }, 'Horas punta: ' + (d.peak_hours as any[]).slice().sort((a, b) => b.orders - a.orders).slice(0, 3).map((h) => `${h.hour}:00 (${h.orders})`).join(' · '))] : []),
      el('p', { class: 'muted small' }, `Calculado a las ${hhmm(c.closed_at)}.`));
    replace(sends,
      sendRow('Food', c, 'food', project?.food_menu_id ? null : 'Sin carta de Food: actualiza la carta desde Food en Caja'),
      sendRow('Finance', c, 'finance', null),
      el('p', { class: 'muted small' }, 'A Finance va como apunte de proceso (informativo). Lo fiscal es la factura que se emite en la caja.'),
      el('p', { class: 'muted small' }, project?.booking_event_id ? 'Booking: lo ve solo en la ficha del evento.' : 'Booking: este flujo aún no está ligado a un evento.'));
  }

  const off = client.onTable(TABLES.dayClosures, () => void paint());
  void paint();
  return off;
};
