/**
 * Solicitudes para apuntarse (Booking O2, «Apuntarme», API de Booking §26.3). Una persona pide apuntarse al retiro desde
 * su portal de huésped; Ikisai se la pasa al organizador, que la acepta o la descarta con un mensaje opcional:
 * - `booking.portal_join_requests({reservation_id})` → `{items: [{id, revision, persons: [nombres], message, status, comment, created_at}]}`;
 * - `booking.portal_join_request_decide({reservation_id, id, decision, comment?})`. Aceptar crea las fichas en el retiro y da
 *   a quien lo pidió su entrada en Guests, en el mismo paso; el mensaje lo ve la persona en su portal.
 * Necesita red: decidir no se encola.
 */
import { el, openSheet, toast } from '@ikisai/ui-kit';
import { describeError, errorCode, online } from '../app/client.ts';
import { t } from '../app/i18n.ts';
import { dayLabel } from '../app/labels.ts';
import { fbIgnore, needsNet, section } from './common.ts';
import type { RetreatData } from './retreat.ts';
import type { ViewContext } from './shell.ts';

export interface JoinRequest {
  id: string;
  revision: number;
  persons: string[];
  message: string | null;
  status: 'pendiente' | 'aceptada' | 'descartada';
  comment: string | null;
  created_at: string;
}

export const pendingJoins = (items: JoinRequest[]) => items.filter((j) => j.status === 'pendiente');

/** «Marta, Nico y Leo». */
function names(persons: string[]): string {
  const list = persons.filter(Boolean);
  if (list.length <= 1) return list[0] ?? '';
  return t('{lista} y {ultimo}', { lista: list.slice(0, -1).join(', '), ultimo: list[list.length - 1]! });
}

export function renderJoinRequests(ctx: ViewContext, reservationId: string, data: RetreatData, reload: () => void): HTMLElement | null {
  const items = data.joinRequests;
  if (!items.length) return null;
  const confirmed = data.guests.value.confirmed;
  const pending = pendingJoins(items);
  const decided = items.filter((j) => j.status !== 'pendiente').reverse();

  async function decide(j: JoinRequest, decision: 'aceptar' | 'descartar'): Promise<void> {
    const who = names(j.persons);
    const comment = el('textarea', { id: 'join-comment', rows: '3', maxlength: '1000' }) as HTMLTextAreaElement;
    const error = el('p', { class: 'error', role: 'alert', id: 'join-error' });
    const guests = data.guests.value.items.length;
    const seats = data.detail.value.final_guests ?? data.detail.value.expected_guests;
    // Decidir no se encola: sin red, el botón se apaga con su motivo (y `submit` lo vuelve a comprobar).
    const confirm = el('button', { type: 'submit', class: decision === 'aceptar' ? 'primary' : 'ghost danger', form: 'joinForm', id: 'join-confirm' },
      decision === 'aceptar' ? t('Aceptar') : t('Descartar'));
    const release = needsNet(ctx, confirm, t('Para decidir necesitas conexión.'));
    const sheet = openSheet({
      title: decision === 'aceptar' ? t('¿Aceptar a {nombres}?', { nombres: who }) : t('¿Descartar la solicitud de {nombres}?', { nombres: who }),
      panelAttrs: { id: 'joinSheet' },
      body: el('form', { id: 'joinForm', onsubmit: (e: Event) => { e.preventDefault(); void submit(); } },
        el('p', null, decision === 'aceptar'
          ? t('Se añadirán a tus asistentes y podrán completar sus datos desde su portal de huésped.')
          : t('No se añadirán a tu retiro.')),
        decision === 'aceptar' && seats
          ? el('p', { class: 'muted small', id: 'join-seats' }, t('Ahora tienes {n} asistentes de {plazas} plazas; con esta solicitud serían {total}.', { n: guests, plazas: seats, total: guests + j.persons.length }))
          : null,
        el('label', { class: 'field' }, el('span', null, t('Mensaje (opcional)')), comment),
        el('p', { class: 'muted small' }, t('Lo verá en su portal de huésped.')),
        error),
      foot: el('div', { class: 'choices' }, confirm),
      onClose: () => release(),
    });
    async function submit(): Promise<void> {
      if (!online()) { error.textContent = describeError({ code: 'OFFLINE' }); return; }
      try {
        const call = () => ctx.api.invokeAny('booking.portal_join_request_decide', {
          reservation_id: reservationId, id: j.id, decision, ...(comment.value.trim() ? { comment: comment.value.trim() } : {}),
        });
        await (decision === 'aceptar' ? ctx.usage.run('organizers.asistentes.solicitudes.aceptar', call) : ctx.usage.run('organizers.asistentes.solicitudes.descartar', call));
        await sheet.close(true);
        toast(decision === 'aceptar' ? t('Hecho: ya están en tus asistentes.') : t('Solicitud descartada.'));
        reload();
      } catch (e) {
        const messages: Record<string, string> = {
          JOIN_REQUEST_DECIDED: t('Esta solicitud ya estaba decidida.'),
          RESERVATION_NOT_CONFIRMED: t('Podrás aceptarla cuando la reserva esté confirmada.'),
          RESERVATION_NOT_OPEN: t('Este retiro ya no admite nuevas personas. Habla con Ikisai.'),
        };
        const code = errorCode(e);
        error.textContent = messages[code] ?? describeError(e);
        if (code === 'JOIN_REQUEST_DECIDED') reload();
      }
    }
  }

  const row = (j: JoinRequest) => el('div', { class: 'orgjoin', 'data-join': j.id },
    fbIgnore(el('div', null,
      el('strong', null, names(j.persons)),
      el('span', { class: 'muted small' }, ` · ${j.persons.length === 1 ? t('1 persona') : t('{n} personas', { n: j.persons.length })} · ${t('pedida el {fecha}', { fecha: dayLabel(j.created_at) })}`),
      j.message ? el('blockquote', { class: 'orgjoin-message' }, j.message) : null)),
    el('div', { class: 'btnrow' },
      el('button', { type: 'button', class: 'ghost', 'data-action': 'join-discard', onclick: () => void decide(j, 'descartar') }, t('Descartar')),
      el('button', { type: 'button', class: 'primary', 'data-action': 'join-accept', disabled: confirmed ? null : '', onclick: () => void decide(j, 'aceptar') }, t('Aceptar'))));

  const history = decided.length
    ? el('details', { class: 'orgjoin-history', id: 'joinHistory' },
      el('summary', null, t('Ya decididas ({n})', { n: decided.length })),
      fbIgnore(el('ul', { class: 'plainlist' }, ...decided.map((j) => el('li', { 'data-join': j.id },
        el('strong', null, names(j.persons)), ' · ',
        el('span', { class: `chip small ${j.status === 'aceptada' ? 'ok' : ''}` }, j.status === 'aceptada' ? t('Aceptada') : t('Descartada')),
        j.comment ? el('span', { class: 'muted small' }, ` · ${j.comment}`) : null)))))
    : null;

  return section(t('Solicitudes para apuntarse'), { id: 'joinRequests', 'data-feedback-id': 'organizers.asistentes.solicitudes', 'data-feedback-label': 'Solicitudes para apuntarse' },
    el('p', { class: 'muted small' }, t('Personas que han pedido apuntarse a tu retiro desde su portal de huésped. Ikisai te las pasa para que decidas tú.')),
    pending.length ? el('div', { class: 'orgjoins' }, ...pending.map(row)) : el('p', { class: 'muted', id: 'joinNone' }, t('No tienes solicitudes por decidir.')),
    pending.length && !confirmed ? el('p', { class: 'muted small', id: 'joinNotConfirmed' }, t('Podrás aceptarlas cuando la reserva esté confirmada; descartarlas, ya.')) : null,
    history);
}
