/**
 * «Arqueo del día» (`#/arqueo?dia=AAAA-MM-DD`; encargo de VG por Core, 27-10): lo cobrado por medio de cobro en la barra
 * y en recepción, las devoluciones aparte y el total a cuadrar en caja. Imprimible como el ticket (página del kit,
 * «Imprimir / Guardar PDF»). Funciona sin red con el espejo del dispositivo; el emisor de Central necesita red.
 */
import { createPrintView, el, fieldAttrs, replace } from '@ikisai/ui-kit';
import { APP_ENTRIES, type LocalAppEntry } from '../app/client.ts';
import { eur, onAnyTable, shortDate } from '../app/data.ts';
import { dayCashCount, type CashEntry } from '../app/cash-count.ts';
import { MISSING_ENTITY, fetchEntity } from './issued.ts';
import type { ViewMount } from './shell.ts';

const fromCents = (c: number) => eur(c / 100);
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });

export const mountCashCount: ViewMount = (ctx) => {
  const { main, client, navigate } = ctx;
  const asked = new URLSearchParams(location.hash.split('?')[1] ?? '').get('dia');
  const day = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : today();
  const host = el('div', { id: 'cashCountPage', 'data-feedback-id': 'invoices.arqueo', 'data-feedback-label': 'Arqueo del día' });
  const picker = el('input', { ...fieldAttrs({ id: 'invoices.arqueo.dia', storage: 'none', label: 'Día', type: 'date', sensitivity: 'internal', confirm: 'none' }), type: 'date', id: 'cashCountDay', value: day, 'aria-label': 'Día del arqueo',
    onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value; if (v) navigate(`#/arqueo?dia=${v}`); } }) as HTMLInputElement;
  replace(main, host);

  async function load(): Promise<void> {
    const entries = (await client.list(APP_ENTRIES)) as unknown as LocalAppEntry[];
    const c = dayCashCount(entries as unknown as CashEntry[], day);
    const { entity } = await fetchEntity(client);
    const body = el('div', { class: 'issued-print', id: 'cashCount' },
      c.entries ? null : el('p', { class: 'hint', id: 'cashCountEmpty' }, 'No hay cobros de la barra ni de recepción en este día (o aún no han llegado a este dispositivo).'),
      c.methods.length ? el('table', { class: 'inv-table', id: 'cashCountMethods' },
        el('thead', null, el('tr', null, el('th', null, 'Medio'), el('th', { class: 'num' }, 'Cobrado'), el('th', { class: 'num' }, 'Devuelto'), el('th', { class: 'num' }, 'A cuadrar'))),
        el('tbody', null, ...c.methods.map((m) => el('tr', null, el('td', null, m.label), el('td', { class: 'num' }, fromCents(m.collectedCents)),
          el('td', { class: 'num' }, m.refundedCents ? `−${fromCents(m.refundedCents)}` : '—'), el('td', { class: 'num' }, el('strong', null, fromCents(m.netCents))))))) : null,
      c.sources.length ? el('table', { class: 'inv-table', id: 'cashCountSources' },
        el('thead', null, el('tr', null, el('th', null, 'De dónde'), el('th', { class: 'num' }, 'Cobros'), el('th', { class: 'num' }, 'Importe'))),
        el('tbody', null, ...c.sources.map((s) => el('tr', null, el('td', null, s.label), el('td', { class: 'num' }, String(s.count)), el('td', { class: 'num' }, fromCents(s.netCents)))))) : null,
      el('div', { class: 'inv-totals', 'data-feedback-ignore': '' },
        el('div', null, el('span', null, 'Cobrado'), el('strong', null, fromCents(c.collectedCents))),
        c.refundedCents ? el('div', null, el('span', null, 'Devoluciones'), el('strong', null, `−${fromCents(c.refundedCents)}`)) : null,
        el('div', null, el('span', null, 'Efectivo que tiene que haber'), el('strong', { id: 'cashCountCash' }, fromCents(c.cashCents))),
        c.pendingRefundsCents ? el('div', null, el('span', null, 'Devoluciones pendientes (aún en caja)'), el('strong', null, fromCents(c.pendingRefundsCents))) : null,
        el('div', { class: 'total' }, el('span', null, 'TOTAL A CUADRAR'), el('strong', { id: 'cashCountTotal' }, fromCents(c.netCents)))));
    const view = createPrintView({
      brand: { appName: 'Finance', markIcon: 'invoice', line: entity?.legal_name ?? MISSING_ENTITY },
      title: 'Arqueo del día',
      subtitle: shortDate(day),
      meta: [`${c.entries} cobro${c.entries === 1 ? '' : 's'}`, 'Barra y alojamiento de recepción'],
      draft: false,
      intro: body,
      sections: [],
      notes: 'Arqueo de caja: no es una factura ni un ticket. Las devoluciones van aparte; las pendientes aún no han salido de caja.',
      runningFoot: `Ikisai Finance · Arqueo del día · ${day}`,
      // El día se elige en la barra de acciones (no sale al imprimir)
    }, { printLabel: 'Imprimir / Guardar PDF', actions: [picker], onBack: () => navigate('#/apuntes'), backLabel: 'Volver' });
    replace(host, view.element);
  }
  void load();
  return onAnyTable(client, () => void load());
};
