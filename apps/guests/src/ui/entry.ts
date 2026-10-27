/**
 * Entrada sin sesión (API.md §9.1; MUELA-060, tanda 31): «bienvenida con salidas». Arriba, la bienvenida de Ikisai, la
 * marca y el idioma; qué ha pasado (sin enlace, caducado el…, no válido o sin red, con «Reintentar»); el marco
 * «Encuentra tu enlace» paso a paso (mira en tu correo, mira en WhatsApp); y siempre las salidas para hablar con Ikisai
 * (correo y teléfono; WhatsApp cuando Central publique `contact.whatsapp`), que salen de Central, nunca fijas en el código.
 * El tercer paso («con tu código», reenviar el enlace sin sesión con el localizador de la reserva) llegará cuando el
 * núcleo publique ese reenvío (petición de la tanda 31); hasta entonces no se ofrece. La cuenta permanente (Google y
 * código por correo) solo sale cuando el núcleo la active; nunca un «pronto». Sin enlace (sin error), antes del marco, los
 * eventos abiertos al público: la puerta de ven.ikisai.com sin invitación ni QR.
 */
import { el, icon, replace } from '@ikisai/ui-kit';
import { describeError, errorCode, isNetworkError } from '../app/client.ts';
import { contactEmail, contactPhone } from '../app/common-texts.ts';
import { formatDate, t } from '../app/i18n.ts';
import { languageSelect } from './language.ts';
import { openEvents } from './visitor.ts';

export interface EntryOptions {
  /** Error del canje del enlace, si se llegó por `/i/<token>`. */
  error?: unknown;
  /** Muestra los accesos de la cuenta permanente (Google y código por correo) cuando el núcleo los active. */
  permanentAccount?: boolean;
  /** Volver a intentar abrir el enlace (sin red). */
  retry?: () => void;
}

export function renderEntry(root: HTMLElement, options: EntryOptions): () => void {
  const code = options.error ? errorCode(options.error) : '';
  const validUntil = (options.error as { details?: { validUntil?: string | null } } | undefined)?.details?.validUntil;
  const offline = Boolean(options.error) && isNetworkError(options.error);
  let title = t('entry.title');
  let text = t('entry.text');
  if (code === 'LINK_EXPIRED') {
    title = t('entry.expiredTitle');
    text = validUntil ? t('entry.expiredOn', { date: formatDate(validUntil) }) : t('entry.expiredText');
  } else if (code === 'LINK_INVALID') {
    title = t('entry.invalidTitle');
    text = t('entry.invalidText');
  } else if (offline) {
    title = t('entry.failedTitle');
    text = t('error.offline');
  } else if (options.error) {
    title = t('entry.failedTitle');
    text = describeError(options.error);
  }
  const email = contactEmail();
  const phone = contactPhone();
  const subject = encodeURIComponent(t('entry.newLinkSubject'));
  const exit = (href: string, ic: 'edit' | 'help' | 'info', label: string, sub: string, id: string, extra: Record<string, string> = {}) =>
    el('a', { class: 'gentry-exit', href, id, ...extra }, el('span', { class: 'gentry-exit-ico', 'aria-hidden': 'true' }, icon(ic, 20)),
      el('span', { class: 'gentry-exit-text' }, el('strong', null, label), el('span', { class: 'small' }, sub)), icon('chevronRight', 16));
  const step = (n: number, ic: 'edit' | 'info', head: string, body: string) => el('li', { class: 'gentry-step' },
    el('span', { class: 'gentry-step-n', 'aria-hidden': 'true' }, String(n)),
    el('div', null, el('p', { class: 'gentry-step-h' }, icon(ic, 18), ' ', head), el('p', { class: 'small' }, body)));

  replace(root, el('main', { class: 'login gentry', id: 'entry', 'data-feedback-id': 'guests.entrada', 'data-feedback-label': 'Entrada' },
    el('div', { class: 'login-card gentry-card' },
      el('div', { class: 'gentry-hero', role: 'img', 'aria-label': t('entry.heroLabel') }, el('span', null, t('entry.hero'))),
      el('div', { class: 'gentry-top' },
        el('div', { class: 'login-brand' }, el('div', { class: 'mark', 'aria-hidden': 'true' }, icon('guest', 22)), el('h1', null, 'Ikisai Guests')),
        languageSelect()),
      el('h2', { id: 'entryTitle', 'data-feedback-id': 'guests.entrada.enlace.error', 'data-feedback-label': 'Mensaje de entrada' }, title),
      el('p', { id: 'entryText' }, text),
      offline && options.retry ? el('button', { type: 'button', class: 'primary wide', id: 'entryRetry', 'data-feedback-id': 'guests.entrada.enlace.reintentar', 'data-feedback-label': 'Reintentar', onclick: () => options.retry!() }, icon('sync', 18), t('common.retry')) : null,
      // Sin invitación ni QR (ENTRADA_PUBLICA.md): los eventos abiertos, para entrar como visitante.
      options.error ? null : openEvents(),
      el('section', { class: 'gentry-frame', 'aria-labelledby': 'findTitle' },
        el('p', { class: 'gentry-frame-h', id: 'findTitle' }, icon('search', 20), ' ', t('entry.findTitle')),
        el('ol', { class: 'gentry-steps' },
          step(1, 'edit', t('entry.step1'), t('entry.step1Text')),
          step(2, 'info', t('entry.step2'), t('entry.step2Text')))),
      email || phone ? el('p', { class: 'glabel gentry-exits' }, t('entry.exits')) : null,
      el('div', { class: 'gentry-acts', id: 'entryContact' },
        email ? exit(`mailto:${email}?subject=${subject}`, 'edit', t('entry.write'), email, 'entryMail', { 'data-feedback-id': 'guests.entrada.contacto.escribir', 'data-feedback-label': 'Escribir a Ikisai' }) : null,
        phone ? exit(`tel:${phone.replace(/\s+/g, '')}`, 'help', t('entry.call'), phone, 'entryCall', { 'data-feedback-id': 'guests.entrada.contacto.llamar', 'data-feedback-label': 'Llamar a Ikisai' }) : null),
      el('p', { class: 'small gentry-foot' }, t('entry.foot')),
    )));
  return () => replace(root);
}
