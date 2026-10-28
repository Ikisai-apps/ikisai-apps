/**
 * B22 (docs/organizers/PETICIONES.md; RESPUESTAS_CASA.md; núcleo 0117): en la ficha de la reserva, «Lo que te ha escrito
 * quien organiza». Son los informes de feedback de quien organiza sobre ese retiro (`GET feedback?app=organizers`, con
 * `scope.reservation_id`), cada uno con sus respuestas (`GET feedback/:id/replies`) y, para editor u owner, un campo y
 * «Responder» (`POST feedback/:id/replies {message}`, de 1 a 2000 caracteres). A quien organiza le llegan firmadas «Ikisai».
 * Necesita red: sin ella, lo dice.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { el, fieldAttrs, formatDate, replace, toast } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';

interface Report { id: string; code?: string; reporterKind: string; message: string; scope: { reservation_id?: string } | null; createdAt: string; status?: string }
interface Reply { id: string; message: string; created_at: string; author: string | null }

export function createOrganizerComments(o: { client: SyncClient; reservationId: string; editable: boolean }): { element: HTMLElement; refresh(): void } {
  const body = el('div', null, el('p', { class: 'hint' }, 'Cargando…'));
  const element = el('article', { class: 'card', id: 'blockOrganizerComments', 'data-feedback-id': 'booking.reserva.organizador', 'data-feedback-label': 'Lo que te ha escrito quien organiza' },
    el('div', { class: 'cardhead' }, el('h3', null, 'Lo que te ha escrito quien organiza')), body);
  let seq = 0;

  async function load(): Promise<void> {
    const mine = ++seq;
    if (!navigator.onLine) return void replace(body, el('p', { class: 'hint' }, 'Para ver y contestar lo que ha escrito quien organiza hace falta conexión.'));
    let reports: Report[];
    try {
      const out = await o.client.api<{ items?: Report[] }>('/feedback?app=organizers&status=all&limit=500');
      const id = o.reservationId.toLowerCase();
      reports = (out.items ?? []).filter((r) => r.reporterKind === 'organizer' && r.scope?.reservation_id?.toLowerCase() === id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch (error) {
      if (mine !== seq) return;
      return void replace(body, el('p', { class: 'hint' }, `No se ha podido cargar: ${describeError(error)} `,
        el('button', { class: 'linkbtn', type: 'button', 'data-feedback-id': 'booking.reserva.organizador.reintentar', 'data-feedback-label': 'Reintentar', onclick: () => void load() }, 'Reintentar')));
    }
    if (mine !== seq) return;
    if (!reports.length) return void replace(body, el('p', { class: 'hint', id: 'organizerCommentsEmpty' }, 'Quien organiza no ha escrito nada sobre este retiro.'));
    replace(body, el('ul', { class: 'list', id: 'organizerComments' }, reports.map(item)));
  }

  function item(r: Report): HTMLElement {
    const replies = el('div', { class: 'org-replies' }, el('p', { class: 'hint' }, 'Cargando respuestas…'));
    const paintReplies = async () => {
      try {
        const out = await o.client.api<{ items?: Reply[] }>(`/feedback/${encodeURIComponent(r.id)}/replies`);
        const list = out.items ?? [];
        replace(replies, list.length
          ? el('ul', { class: 'list org-reply-list' }, list.map((x) => el('li', { class: 'row', 'data-feedback-ignore': '' },
            el('div', { class: 'row-meta' }, `${x.author ?? 'Ikisai'} · ${formatDate(x.created_at)}`), el('p', null, x.message))))
          : el('p', { class: 'hint' }, 'Sin respuesta todavía.'));
      } catch (error) {
        replace(replies, el('p', { class: 'hint' }, `No se han podido cargar las respuestas: ${describeError(error)}`));
      }
    };
    void paintReplies();
    const text = el('textarea', { rows: 3, maxlength: 2000, 'aria-label': 'Tu respuesta',
      ...fieldAttrs({ id: 'booking.reserva.organizador.respuesta', entity: 'core.feedback_replies', prop: 'message', label: 'Tu respuesta', confirm: 'event' }) }) as HTMLTextAreaElement;
    const send = el('button', { class: 'primary small', type: 'button', 'data-feedback-id': 'booking.reserva.organizador.responder', 'data-feedback-label': 'Responder', onclick: async () => {
      const message = text.value.trim();
      if (!message) return void toast('Escribe la respuesta.');
      if (message.length > 2000) return void toast('Como mucho 2000 caracteres.');
      if (!navigator.onLine) return void toast('Para responder hace falta conexión.');
      send.disabled = true;
      try {
        await o.client.api(`/feedback/${encodeURIComponent(r.id)}/replies`, { method: 'POST', json: { message } });
        text.value = '';
        toast('Respuesta enviada. A quien organiza le llega firmada «Ikisai».');
        await paintReplies();
      } catch (error) {
        toast(describeError(error));
      } finally {
        send.disabled = false;
      }
    } }, 'Responder') as HTMLButtonElement;
    return el('li', { class: 'row org-comment', dataset: { report: r.id }, 'data-feedback-id': 'booking.reserva.organizador.comentario', 'data-feedback-label': 'Comentario de quien organiza' },
      el('div', { class: 'row-meta', 'data-feedback-ignore': '' }, `${formatDate(r.createdAt)}${r.code ? ` · ${r.code}` : ''}`),
      el('p', { 'data-feedback-ignore': '' }, r.message),
      replies,
      o.editable ? el('div', { class: 'org-reply-form' }, text, el('div', { class: 'btnrow' }, send)) : null);
  }

  void load();
  return { element, refresh: () => void load() };
}
