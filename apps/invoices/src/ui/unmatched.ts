/**
 * «Cobros sin casar» (`#/cobros-sin-casar`; cola de Core para Dirección, API.md §19.7): lo que la pasarela cobró o devolvió
 * y Finance no pudo casar sola con una factura. Cada uno dice qué pasó y qué hacer, abre su factura y se marca
 * «revisado» con una nota. Necesita red (los avisos no se sincronizan al dispositivo).
 */
import { el, replace, toast } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { eur, shortDate } from '../app/data.ts';
import { explainUnmatched } from '../app/unmatched.ts';
import type { ViewMount } from './shell.ts';

interface Unmatched {
  id: string; at: string; provider: string; kind: 'paid' | 'refunded' | 'failed' | 'expired' | 'ignored'; outcome: 'mismatch' | 'unknown' | 'applied' | 'duplicate' | 'ignored';
  detail: string | null; amount: number | null; issued_invoice_id: string | null; invoice_number: string | null; invoice_total: number | null;
  invoice_status: string | null; payment_status: string | null; reviewed_at: string | null; review_note: string | null;
}

const PROVIDER: Record<string, string> = { stripe: 'Stripe', redsys: 'Redsys' };

export const mountUnmatched: ViewMount = (ctx) => {
  const { main, client, navigate } = ctx;
  const role = client.bootstrap()?.membership.role ?? null;
  const canEdit = role === 'editor' || role === 'owner';
  let all = false;
  let alive = true;
  const list = el('div', { id: 'unmatchedList' });
  const toggle = el('label', { class: 'inv-check' }, el('input', { type: 'checkbox', id: 'unmatchedAll', onchange: (e: Event) => { all = (e.target as HTMLInputElement).checked; void load(); } }), ' Ver también los revisados');
  replace(main, el('section', { class: 'inv-page', 'data-feedback-id': 'invoices.cobros_sin_casar', 'data-feedback-label': 'Cobros sin casar' },
    el('h1', null, 'Cobros sin casar'),
    el('p', { class: 'hint' }, 'Lo que la pasarela de pago cobró o devolvió y Finance no pudo casar sola con una factura. Revisa cada uno y anota qué hiciste.'),
    toggle, list));

  function row(u: Unmatched): HTMLElement {
    const { title, todo } = explainUnmatched(u);
    const note = el('input', { type: 'text', maxlength: '500', placeholder: 'Qué hiciste (p. ej. «devuelto en la pasarela»)', 'aria-label': 'Nota de revisión', value: u.review_note ?? '' }) as HTMLInputElement;
    const resolve = async () => {
      if (!note.value.trim()) { toast('Escribe qué hiciste.'); note.focus(); return; }
      try {
        await client.commit([{ op: 'call', procedure: 'invoices.payment_event_resolve', args: { id: u.id, note: note.value.trim() } }]);
        toast('Marcado como revisado.');
        void load();
      } catch (error) { toast(describeError(error)); }
    };
    return el('li', { class: 'inv-card', dataset: { unmatched: u.id }, 'data-feedback-id': 'invoices.cobros_sin_casar.cobro', 'data-feedback-label': 'Cobro sin casar' },
      el('div', { class: 'inv-card-head' }, el('strong', null, title), el('span', { class: `chip ${u.reviewed_at ? 'ok' : 'warn'}` }, u.reviewed_at ? 'Revisado' : 'Por revisar')),
      el('p', { class: 'meta' }, [shortDate(u.at.slice(0, 10)), PROVIDER[u.provider] ?? u.provider, u.amount !== null ? eur(Number(u.amount)) : null,
        u.invoice_number ? `Factura ${u.invoice_number}${u.invoice_total !== null ? ` (${eur(Number(u.invoice_total))})` : ''}` : 'Sin factura'].filter(Boolean).join(' · ')),
      u.detail ? el('p', { class: 'hint' }, u.detail) : null,
      el('p', null, todo),
      u.reviewed_at ? el('p', { class: 'hint' }, `Revisado el ${shortDate(u.reviewed_at.slice(0, 10))}: ${u.review_note ?? ''}`) : null,
      el('div', { class: 'inv-actions' },
        u.issued_invoice_id ? el('button', { type: 'button', class: 'btn', onclick: () => navigate(`#/facturas?vista=emitidas&abrir=${u.issued_invoice_id}`) }, 'Abrir la factura') : null,
        canEdit ? note : null,
        canEdit ? el('button', { type: 'button', class: 'btn primary', onclick: () => void resolve() }, u.reviewed_at ? 'Cambiar la nota' : 'Marcar revisado') : null));
  }

  async function load(): Promise<void> {
    if (!navigator.onLine) { replace(list, el('p', { class: 'hint' }, 'Necesita conexión: los avisos de la pasarela no se guardan en el dispositivo.')); return; }
    try {
      const out = await client.api<{ items: Unmatched[]; pending: number }>('/read/invoices.payment_events_review', { json: { all } });
      if (!alive) return;
      replace(list, out.items.length
        ? el('ul', { class: 'inv-list', id: 'unmatchedItems' }, ...out.items.map(row))
        : el('p', { class: 'hint', id: 'unmatchedEmpty' }, all ? 'No hay cobros sin casar.' : 'Nada por revisar: todos los cobros de la pasarela casan con su factura.'));
    } catch (error) {
      if (alive) replace(list, el('p', { class: 'hint' }, describeError(error)));
    }
  }
  void load();
  return () => { alive = false; };
};
