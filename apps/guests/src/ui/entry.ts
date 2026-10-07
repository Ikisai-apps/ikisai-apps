/** Entrada sin sesión (API.md §9.1): enlace no válido o caducado, o nadie ha abierto todavía su enlace en este dispositivo. */
import { el, icon, replace } from '@ikisai/ui-kit';
import { describeError, errorCode } from '../app/client.ts';
import { contactEmail, contactPhone } from '../app/common-texts.ts';
import { formatDate, t } from '../app/i18n.ts';
import { languageSelect } from './language.ts';

export interface EntryOptions {
  /** Error del canje del enlace, si se llegó por `/i/<token>`. */
  error?: unknown;
  /** Muestra los accesos de la cuenta permanente (Google y código por correo) cuando el núcleo los active. */
  permanentAccount?: boolean;
}

export function renderEntry(root: HTMLElement, options: EntryOptions): () => void {
  const code = options.error ? errorCode(options.error) : '';
  const validUntil = (options.error as { details?: { validUntil?: string | null } } | undefined)?.details?.validUntil;
  let title = t('entry.title');
  let text = t('entry.text');
  if (code === 'LINK_EXPIRED') {
    title = t('entry.expiredTitle');
    text = validUntil ? t('entry.expiredOn', { date: formatDate(validUntil) }) : t('entry.expiredText');
  } else if (code === 'LINK_INVALID') {
    title = t('entry.invalidTitle');
    text = t('entry.invalidText');
  } else if (options.error) {
    title = t('entry.failedTitle');
    text = describeError(options.error);
  }

  replace(root, el('main', { class: 'login gentry', id: 'entry', 'data-feedback-id': 'guests.entrada', 'data-feedback-label': 'Entrada' },
    el('div', { class: 'login-card' },
      el('div', { class: 'gentry-top' },
        el('div', { class: 'login-brand' }, el('div', { class: 'mark', 'aria-hidden': 'true' }, icon('home', 22)), el('h1', null, 'Ikisai Guests')),
        languageSelect()),
      el('h2', { id: 'entryTitle', 'data-feedback-id': 'guests.entrada.enlace.error', 'data-feedback-label': 'Mensaje de entrada' }, title),
      el('p', { id: 'entryText' }, text),
      code || options.error ? el('p', { id: 'entryContact' }, t('entry.contact', { email: contactEmail(), phone: contactPhone() })) : null,
      options.permanentAccount ? el('p', { class: 'muted small', id: 'permanentAccess' }, t('entry.permanentSoon')) : null,
      el('p', { class: 'muted small gentry-foot' }, t('entry.foot')),
    )));
  return () => replace(root);
}
