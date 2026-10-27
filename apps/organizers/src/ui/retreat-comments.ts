/**
 * «Comentarios de tus asistentes» en el resumen del retiro: lo que cuentan en Guests sobre el retiro, con el tema, quién y
 * cuándo. Los tres últimos a la vista y el resto plegados. Solo lectura. Necesita red; sin comentarios (o si la lectura
 * falla), no sale.
 */
import { el, replace } from '@ikisai/ui-kit';
import { t } from '../app/i18n.ts';
import type { PortalGuest } from '../app/api.ts';
import { dayLabel } from '../app/labels.ts';
import { COMMENT_TOPICS, loadGuestFeedback, retreatComments, type FeedbackItem } from '../app/retreat-comments.ts';
import type { ViewContext } from './shell.ts';

const SHOWN = 3;

function comment(r: FeedbackItem, names: Map<string, string>): HTMLElement {
  const who = (r.scope?.guest_id && names.get(r.scope.guest_id.toLowerCase())) || t('Un asistente');
  const topic = r.category && COMMENT_TOPICS[r.category] ? t(COMMENT_TOPICS[r.category]!) : null;
  return el('li', { class: 'orgcomment', dataset: { report: r.id } },
    el('p', { class: 'small' }, topic ? el('span', { class: 'chip' }, topic) : null, ' ', el('strong', null, who), ` · ${dayLabel(r.createdAt)}`),
    el('p', { class: 'orgcomment-text' }, r.message));
}

export function renderRetreatComments(ctx: ViewContext, reservationId: string, guests: readonly PortalGuest[]): HTMLElement {
  const host = el('section', { class: 'card orgcard', id: 'retreatComments', 'data-feedback-id': 'organizers.retiro.resumen.comentarios', 'data-feedback-label': 'Comentarios de tus asistentes', hidden: '' });
  const names = new Map(guests.map((g) => [g.id.toLowerCase(), g.display_name]));
  void loadGuestFeedback(ctx.client).then((items) => {
    const list = retreatComments(items, reservationId);
    if (!list.length) return;
    const rest = list.slice(SHOWN);
    host.hidden = false;
    replace(host,
      el('h3', null, t('Comentarios de tus asistentes')),
      el('p', { class: 'muted small' }, t('Lo que te cuentan desde su app sobre el retiro. Los lees tú; si algo es del lugar, lo atiende Ikisai.')),
      el('ul', { class: 'plainlist orgcomments' }, ...list.slice(0, SHOWN).map((r) => comment(r, names))),
      rest.length ? el('details', { class: 'orgfold', 'data-feedback-id': 'organizers.retiro.resumen.comentarios.mas', 'data-feedback-label': 'Más comentarios' },
        el('summary', null, rest.length === 1 ? t('1 comentario más') : t('{n} comentarios más', { n: rest.length })),
        el('ul', { class: 'plainlist orgcomments' }, ...rest.map((r) => comment(r, names)))) : null);
  }).catch(() => undefined);
  return host;
}
