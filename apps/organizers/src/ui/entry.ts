/** Entrada sin sesión (API.md §9.1): enlace no válido o caducado, o nadie ha abierto todavía su enlace en este dispositivo. */
import { createLanguageSelect, el, icon, replace } from '@ikisai/ui-kit';
import { i18n, t } from '../app/i18n.ts';
import { describeError, errorCode } from '../app/client.ts';
import { contactLine } from '../app/common-texts.ts';

export interface EntryOptions {
  /** Error del canje del enlace, si se llegó por `/i/<token>`. */
  error?: unknown;
  /** Muestra los accesos de la cuenta permanente (Google y código por correo) cuando el núcleo los active. */
  permanentAccount?: boolean;
}

export function renderEntry(root: HTMLElement, options: EntryOptions = {}): () => void {
  const code = options.error ? errorCode(options.error) : '';
  const validUntil = (options.error as { details?: { validUntil?: string | null } } | undefined)?.details?.validUntil;
  let title = t('Entra con tu enlace');
  let text = t('Para entrar, abre el enlace que te enviamos por correo o por WhatsApp.');
  if (code === 'LINK_EXPIRED') {
    title = t('Este enlace ha caducado');
    text = validUntil
      ? t('Caducó el {fecha}. Si tu retiro sigue en marcha, pídenos uno nuevo.', { fecha: new Intl.DateTimeFormat(i18n.tag(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' }).format(new Date(validUntil)) })
      : t('Si tu retiro sigue en marcha, pídenos uno nuevo.');
  } else if (code === 'LINK_INVALID') {
    title = t('Este enlace no funciona');
    text = t('No es válido o ya no está activo. Pídenos uno nuevo.');
  } else if (options.error) {
    title = t('No hemos podido abrir tu enlace');
    text = describeError(options.error);
  }

  replace(root, el('main', { class: 'login orgentry', id: 'entry', 'data-feedback-id': 'organizers.entrada', 'data-feedback-label': 'Entrada' },
    el('div', { class: 'login-card' },
      el('div', { class: 'login-brand' }, el('div', { class: 'mark', 'aria-hidden': 'true' }, icon('organizer', 22)), el('h1', null, 'Ikisai Organizers')),
      el('h2', { id: 'entryTitle', 'data-feedback-id': code ? 'organizers.entrada.enlace.error' : 'organizers.entrada.enlace.sin_sesion', 'data-feedback-label': title }, title),
      el('p', { id: 'entryText' }, text),
      el('p', { id: 'entryContact' }, code || options.error ? contactLine() : null),
      options.permanentAccount ? el('div', { class: 'btnrow', id: 'permanentAccess' },
        el('p', { class: 'muted small' }, t('¿Ya guardaste tu acceso? Pronto podrás entrar aquí con tu cuenta de Google o con un código por correo.'))) : null,
      createLanguageSelect(i18n, { attrs: { id: 'langSelect' } }),
      el('p', { class: 'muted small orgentry-foot' }, t('Ikisai Organizers es el espacio de quienes organizan un retiro en Ikisai.')),
    )));
  return () => replace(root);
}
