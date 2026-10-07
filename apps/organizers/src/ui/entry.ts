/** Entrada sin sesión (API.md §9.1): enlace no válido o caducado, o nadie ha abierto todavía su enlace en este dispositivo. */
import { el, icon, replace } from '@ikisai/ui-kit';
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
  let title = 'Entra con tu enlace';
  let text = 'Para entrar, abre el enlace que te enviamos por correo o por WhatsApp.';
  if (code === 'LINK_EXPIRED') {
    title = 'Este enlace ha caducado';
    text = validUntil
      ? `Caducó el ${new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' }).format(new Date(validUntil))}. Si tu retiro sigue en marcha, pídenos uno nuevo.`
      : 'Si tu retiro sigue en marcha, pídenos uno nuevo.';
  } else if (code === 'LINK_INVALID') {
    title = 'Este enlace no funciona';
    text = 'No es válido o ya no está activo. Pídenos uno nuevo.';
  } else if (options.error) {
    title = 'No hemos podido abrir tu enlace';
    text = describeError(options.error);
  }

  replace(root, el('main', { class: 'login orgentry', id: 'entry', 'data-feedback-id': 'organizers.entrada', 'data-feedback-label': 'Entrada' },
    el('div', { class: 'login-card' },
      el('div', { class: 'login-brand' }, el('div', { class: 'mark', 'aria-hidden': 'true' }, icon('calendar', 22)), el('h1', null, 'Ikisai Organizers')),
      el('h2', { id: 'entryTitle', 'data-feedback-id': code ? 'organizers.entrada.enlace.error' : 'organizers.entrada.enlace.sin_sesion', 'data-feedback-label': title }, title),
      el('p', { id: 'entryText' }, text),
      el('p', { id: 'entryContact' }, code || options.error ? contactLine() : null),
      options.permanentAccount ? el('div', { class: 'btnrow', id: 'permanentAccess' },
        el('p', { class: 'muted small' }, '¿Ya guardaste tu acceso? Pronto podrás entrar aquí con tu cuenta de Google o con un código por correo.')) : null,
      el('p', { class: 'muted small orgentry-foot' }, 'Ikisai Organizers es el espacio de quienes organizan un retiro en Ikisai.'),
    )));
  return () => replace(root);
}
