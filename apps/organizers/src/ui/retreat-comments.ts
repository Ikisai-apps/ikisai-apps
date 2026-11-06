/**
 * «Comentarios de tus asistentes» en el resumen del retiro: lo que cuentan en Guests sobre el retiro, con el tema, quién y
 * cuándo. Los tres últimos a la vista y el resto plegados. Solo lectura. Necesita red; sin comentarios (o si la lectura
 * falla), no sale.
 * Leídos y sin leer (0706): lo que esta persona aún no ha visto lleva «Nuevo» y el título dice cuántos. Un comentario cuenta
 * como visto tras un segundo en pantalla (o al desplegar «N comentarios más» y verlo); se apunta en `comment_reads`.
 * Contestar (X6, núcleo 0121): «Responder» bajo cada comentario abre un campo y «Enviar»; la última respuesta queda a la vista
 * («Tu respuesta» o el nombre de quien contestó). El asistente la ve en Guests. Necesita red.
 */
import { el, fieldAttrs, replace, toast } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { L, t } from '../app/i18n.ts';
import type { PortalGuest } from '../app/api.ts';
import { dayLabel } from '../app/labels.ts';
import { loadGuestFeedback, REPLY_MAX, replyTo, retreatComments, type FeedbackItem } from '../app/retreat-comments.ts';
import { markRead, readIds, unreadOf } from '../app/comment-reads.ts';
import { needsNet } from './common.ts';
import type { ViewContext } from './shell.ts';

const SHOWN = 3;

/** Temas de «Cuéntanos qué tal» en Guests (`help.event.*`), por traducir con `t`. */
const COMMENT_TOPICS: Record<string, string> = {
  schedule: L('Horarios'), organization: L('Organización'), activities: L('Actividades'), communication: L('Comunicación'), food: L('La comida'), other: L('Otra cosa'),
};

const SEEN_MS = 1000;

/** La última respuesta: la propia, «Tu respuesta»; la de otra persona, con su firma. */
function replyLine(reply: NonNullable<FeedbackItem['reply']>, mine: boolean): HTMLElement {
  return el('div', { class: 'orgcomment-reply' },
    el('p', { class: 'small muted' }, `${mine ? t('Tu respuesta') : reply.from ?? t('Ikisai')} · ${dayLabel(reply.at)}`),
    el('p', { class: 'orgcomment-text', 'data-feedback-ignore': '' }, reply.text));
}

/** «Responder»: el campo y «Enviar» en el sitio; al enviar, la respuesta queda a la vista como la última. */
function replyBox(ctx: ViewContext, r: FeedbackItem): HTMLElement {
  const slot = el('div', { class: 'orgcomment-replyslot' });
  let mine = false;
  const paint = () => {
    const open = el('button', { type: 'button', class: 'ghost small', 'data-action': 'reply', 'data-feedback-id': 'organizers.retiro.resumen.comentarios.responder', 'data-feedback-label': 'Responder al asistente', onclick: () => edit() },
      r.reply ? t('Responder otra vez') : t('Responder'));
    replace(slot, r.reply ? replyLine(r.reply, mine) : null, open);
  };
  const edit = () => {
    const area = el('textarea', { ...fieldAttrs({ id: 'organizers.retiro.resumen.comentarios.respuesta', label: 'Tu respuesta al asistente', entity: 'core.feedback_replies', prop: 'message', type: 'text', sensitivity: 'personal' }),
      rows: '3', maxlength: String(REPLY_MAX), placeholder: t('Lo verá en su app, firmado con tu nombre.') }) as HTMLTextAreaElement;
    const send = el('button', { type: 'button', class: 'primary small', 'data-action': 'send-reply', 'data-feedback-id': 'organizers.retiro.resumen.comentarios.enviar', 'data-feedback-label': 'Enviar la respuesta', onclick: () => void submit() }, t('Enviar'));
    const cancel = el('button', { type: 'button', class: 'ghost small', onclick: () => { off(); paint(); } }, t('Cancelar'));
    const off = needsNet(ctx, send);
    async function submit(): Promise<void> {
      const text = area.value.trim();
      if (!text) { area.focus(); return; }
      send.setAttribute('disabled', '');
      try {
        const out = await ctx.usage.run('organizers.retiro.resumen.comentarios.enviar', () => replyTo(ctx.client, r.id, text));
        r.reply = { text, from: null, at: out.created_at, kind: 'organizer' };
        mine = true;
        off();
        paint();
        toast(t('Respuesta enviada'));
      } catch (error) {
        send.removeAttribute('disabled');
        toast(describeError(error));
      }
    }
    replace(slot, r.reply ? replyLine(r.reply, mine) : null, el('label', { class: 'field' }, el('span', null, t('Tu respuesta')), area), el('div', { class: 'choices' }, cancel, send));
    area.focus();
  };
  paint();
  return slot;
}

function comment(r: FeedbackItem, names: Map<string, string>, isNew: boolean, ctx?: ViewContext): HTMLElement {
  const who = (r.scope?.guest_id && names.get(r.scope.guest_id.toLowerCase())) || t('Un asistente');
  const topic = r.category && COMMENT_TOPICS[r.category] ? t(COMMENT_TOPICS[r.category]!) : null;
  return el('li', { class: `orgcomment${isNew ? ' orgcomment-new' : ''}`, dataset: { report: r.id } },
    el('p', { class: 'small' }, isNew ? el('span', { class: 'chip warn orgcomment-newchip' }, t('Nuevo')) : null, isNew ? ' ' : null,
      topic ? el('span', { class: 'chip' }, topic) : null, ' ', el('strong', null, who), ` · ${dayLabel(r.createdAt)}`),
    el('p', { class: 'orgcomment-text' }, r.message),
    ctx && r.canReply ? replyBox(ctx, r) : r.reply ? replyLine(r.reply, false) : null);
}

export function renderRetreatComments(ctx: ViewContext, reservationId: string, guests: readonly PortalGuest[]): HTMLElement {
  const host = el('section', { class: 'card orgcard', id: 'retreatComments', 'data-feedback-id': 'organizers.retiro.resumen.comentarios', 'data-feedback-label': 'Comentarios de tus asistentes', hidden: '' });
  const names = new Map(guests.map((g) => [g.id.toLowerCase(), g.display_name]));
  void Promise.all([loadGuestFeedback(ctx.client), readIds(ctx.client, reservationId, ctx.userId).catch(() => new Set<string>())]).then(([items, read]) => {
    const list = retreatComments(items, reservationId);
    if (!list.length) return;
    const rest = list.slice(SHOWN);
    const fresh = new Set(unreadOf(list.map((r) => r.id), read));
    const row = (r: FeedbackItem) => comment(r, names, fresh.has(r.id), ctx);
    host.hidden = false;
    replace(host,
      el('h3', null, t('Comentarios de tus asistentes'),
        fresh.size ? el('span', { class: 'chip warn orgcomments-new', id: 'retreatCommentsNew' }, fresh.size === 1 ? t('1 nuevo') : t('{n} nuevos', { n: fresh.size })) : null),
      el('p', { class: 'muted small' }, t('Lo que te cuentan desde su app sobre el retiro. Puedes contestarles; si algo es del lugar, lo atiende Ikisai.')),
      el('ul', { class: 'plainlist orgcomments' }, ...list.slice(0, SHOWN).map(row)),
      rest.length ? el('details', { class: 'orgfold', 'data-feedback-id': 'organizers.retiro.resumen.comentarios.mas', 'data-feedback-label': 'Más comentarios' },
        el('summary', null, rest.length === 1 ? t('1 comentario más') : t('{n} comentarios más', { n: rest.length })),
        el('ul', { class: 'plainlist orgcomments' }, ...rest.map(row))) : null);
    watchSeen(ctx, reservationId, host, fresh);
  }).catch(() => undefined);
  return host;
}

/** Apunta como visto cada comentario nuevo que pasa un segundo en pantalla. La marca se queda hasta la próxima vez. */
function watchSeen(ctx: ViewContext, reservationId: string, host: HTMLElement, fresh: Set<string>): void {
  if (!fresh.size || typeof IntersectionObserver === 'undefined') return;
  const timers = new Map<Element, ReturnType<typeof setTimeout>>();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const id = (entry.target as HTMLElement).dataset.report ?? '';
      if (entry.isIntersecting && fresh.has(id) && !timers.has(entry.target)) {
        timers.set(entry.target, setTimeout(() => {
          observer.unobserve(entry.target);
          fresh.delete(id);
          void markRead(ctx.client, reservationId, ctx.userId, [id]).catch(() => undefined);
        }, SEEN_MS));
      } else if (!entry.isIntersecting && timers.has(entry.target)) {
        clearTimeout(timers.get(entry.target)!);
        timers.delete(entry.target);
      }
    }
  }, { threshold: 0.6 });
  for (const li of host.querySelectorAll<HTMLElement>('li.orgcomment-new')) observer.observe(li);
}
