/**
 * Propuesta de Ikisai (fase 2 y 3, API.md §13.3; Booking B12). Decisión del usuario: el organizador **no acepta** desde el
 * portal. Ve la propuesta enviada (o la aceptada) con sus líneas, condiciones y tramos de cancelación, y puede pulsar
 * «Quiero confirmar» o enviar un comentario: las dos cosas avisan al comercial y quedan con su estado.
 */
import { confirmDialog, el, openSheet, replace, toast } from '@ikisai/ui-kit';
import type { PortalProposal, PortalRequest } from '../app/api.ts';
import { describeError } from '../app/client.ts';
import { i18n, L, t } from '../app/i18n.ts';
import { textParagraphs } from '../app/common-texts.ts';
import { dateRange, dayLabel } from '../app/labels.ts';
import { failure, fbMark, loading, section, staleNote } from './common.ts';
import type { ViewContext } from './shell.ts';

const REQUEST_STATUS: Record<string, string> = { enviada: L('Enviada'), vista: L('Vista por Ikisai'), respondida: L('Respondida') };
const REQUEST_KIND: Record<string, string> = { quiere_confirmar: L('Quiero confirmar'), comentario: L('Comentario') };

export function renderProposal(ctx: ViewContext, reservationId: string): HTMLElement {
  const host = el('div', { id: 'proposal', 'data-feedback-id': 'organizers.propuesta', 'data-feedback-label': 'Propuesta' }, loading());
  let alive = true;
  const money = (n: number | string) => i18n.formatMoney(Number(n));

  async function load(): Promise<void> {
    try {
      const [proposals, requests] = await Promise.all([ctx.api.proposals(reservationId), ctx.api.myRequests(reservationId)]);
      if (!alive) return;
      paint(proposals.value.items, requests.value.items, (proposals.stale && proposals.at) || (requests.stale && requests.at) || null);
    } catch (error) {
      if (alive) replace(host, failure(error, () => void load()));
    }
  }

  async function send(kind: 'quiere_confirmar' | 'comentario', proposalId: string | null, message: string | null): Promise<boolean> {
    try {
      const ask = () => ctx.api.request(reservationId, { kind, proposal_id: proposalId, message });
      if (kind === 'quiere_confirmar') await ctx.usage.run('organizers.propuesta.quiero_confirmar', ask);
      else await ctx.usage.run('organizers.propuesta.comentario', ask);
      toast(kind === 'quiere_confirmar' ? t('Hecho. El equipo de Ikisai te contactará para confirmar.') : t('Comentario enviado a Ikisai.'));
      void load();
      return true;
    } catch (error) {
      toast(describeError(error));
      return false;
    }
  }

  function commentSheet(proposalId: string | null): void {
    const area = el('textarea', { id: 'commentText', rows: '5', maxlength: '2000', placeholder: t('Escribe tu comentario o tu pregunta sobre la propuesta.') }) as HTMLTextAreaElement;
    const sheet = openSheet({
      title: t('Comentario sobre la propuesta'),
      body: el('label', { class: 'field' }, el('span', null, t('Tu comentario')), area),
      foot: el('div', { class: 'btnrow' }, el('button', { type: 'button', class: 'primary', id: 'sendComment', onclick: async () => {
        const text = area.value.trim();
        if (!text) { area.focus(); return; }
        if (await send('comentario', proposalId, text)) void sheet.close(true);
      } }, t('Enviar'))),
    });
  }

  function proposalCard(p: PortalProposal): HTMLElement {
    const accepted = p.status === 'aceptada';
    const c = p.conditions;
    return section(accepted ? t('Propuesta aceptada') : t('Propuesta de Ikisai'), { id: `proposal-${p.version}`, class: 'card orgcard orgproposal' },
      el('p', { class: 'chips' },
        el('span', { class: `chip status ${accepted ? 'ok' : 'warn'}` }, accepted ? t('Aceptada') : t('Pendiente de confirmar')),
        el('span', { class: 'muted small' }, ` ${t('Versión {n}', { n: p.version })}`),
        p.nature === 'orientativa' ? el('span', { class: 'chip small' }, t('Orientativa')) : null),
      el('p', null, dateRange(p.start_date, p.end_date), p.persons ? ` · ${p.persons === 1 ? t('1 persona') : t('{n} personas', { n: p.persons })}` : ''),
      el('table', { class: 'orgquote' }, el('tbody', null, ...p.lines.map((l) => el('tr', null,
        el('td', null, l.description, el('span', { class: 'muted small' }, ` · ${i18n.formatNumber(Number(l.quantity))} × ${money(l.unit_amount)}${Number(l.discount_pct) ? ` · −${i18n.formatNumber(Number(l.discount_pct))} %` : ''}`)),
        el('td', { class: 'num' }, l.amount === null ? '' : money(l.amount)))))),
      el('dl', { class: 'kv orgtotals' },
        el('dt', null, c?.prices_include_vat === false ? t('Total') : t('Total con IVA incluido')), el('dd', { class: 'proposalTotal' }, money(p.total)),
        el('dt', null, t('de los que IVA ({n} %)', { n: i18n.formatNumber(Number(c?.vat_rate ?? 0)) })), el('dd', null, money(p.vat_amount)),
        el('dt', null, t('Señal para reservar')), el('dd', null, money(p.deposit_amount)),
        p.valid_until ? el('dt', null, t('Válida hasta')) : null, p.valid_until ? el('dd', null, dayLabel(`${p.valid_until}T12:00:00Z`)) : null),
      p.includes ? el('p', null, el('strong', null, t('Incluye: ')), p.includes) : null,
      p.excludes ? el('p', null, el('strong', null, t('No incluye: ')), p.excludes) : null,
      // El texto llega de Booking con las cifras ya resueltas (#358): se pinta tal cual. Los tramos, solo si no hay texto.
      c ? el('details', { class: 'orgconditions' }, el('summary', null, t('Condiciones y cancelación')),
        c.text ? el('div', { class: 'orgconditions-text' }, ...textParagraphs(c.text)) : null,
        !c.text && c.tiers.length ? el('ul', { class: 'plainlist small' }, ...c.tiers.map((tier) => el('li', null,
          tier.min_days_before === 0
            ? t('Menos días: se devuelve el {pct} % de la señal', { pct: i18n.formatNumber(Number(tier.deposit_refund_pct)) })
            : t('Con {dias} días o más de antelación: se devuelve el {pct} % de la señal', { dias: tier.min_days_before, pct: i18n.formatNumber(Number(tier.deposit_refund_pct)) })))) : null) : null,
      accepted ? null : el('div', { class: 'btnrow orgtools' },
        fbMark(el('button', { type: 'button', class: 'primary', id: 'wantConfirm', onclick: async () => {
          if (await confirmDialog({ title: t('¿Quieres confirmar el retiro?'), text: t('Avisaremos al equipo de Ikisai, que te contactará para cerrar la reserva y la señal. Aún no se cobra nada.'), confirmLabel: t('Quiero confirmar') })) {
            await send('quiere_confirmar', p.id, null);
          }
        } }, t('Quiero confirmar')), 'organizers.propuesta.quiero_confirmar', 'Quiero confirmar'),
        fbMark(el('button', { type: 'button', class: 'ghost', id: 'sendCommentOpen', onclick: () => commentSheet(p.id) }, t('Enviar un comentario')), 'organizers.propuesta.comentario', 'Enviar un comentario')));
  }

  function paint(proposals: PortalProposal[], requests: PortalRequest[], staleAt: string | null): void {
    const mine = requests.length ? section(t('Lo que has enviado a Ikisai'), { id: 'myRequests' },
      el('ul', { class: 'plainlist orgmine' }, ...requests.map((r) => el('li', null,
        el('span', { class: `chip small ${r.status === 'respondida' ? 'ok' : r.status === 'vista' ? '' : 'warn'}` }, t(REQUEST_STATUS[r.status] ?? r.status)), ' ',
        el('strong', null, t(REQUEST_KIND[r.kind] ?? r.kind)), ` · ${dayLabel(r.created_at)}`,
        r.message ? el('p', { class: 'small', 'data-feedback-ignore': '' }, r.message) : null)))) : null;
    if (!proposals.length) {
      replace(host, staleAt ? staleNote(staleAt) : null,
        el('div', { class: 'empty', id: 'noProposal' }, el('strong', null, t('Aún no tienes propuesta')),
          el('p', null, t('Cuando el equipo de Ikisai te envíe la propuesta, la verás aquí. Mientras, puedes escribirnos.')),
          el('button', { type: 'button', class: 'ghost', id: 'sendCommentOpen', onclick: () => commentSheet(null) }, t('Enviar un comentario'))),
        mine);
      return;
    }
    replace(host, staleAt ? staleNote(staleAt) : null,
      el('p', { class: 'muted' }, t('La aceptación la cierra el equipo de Ikisai contigo. Si te encaja, pulsa «Quiero confirmar».')),
      ...proposals.map(proposalCard), mine);
  }

  void load();
  (host as HTMLElement & { destroy?: () => void }).destroy = () => { alive = false; };
  return host;
}
