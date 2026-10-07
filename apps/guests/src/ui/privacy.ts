/**
 * Aviso de protección de datos (API.md §9.2; decisión del usuario del 7-10-2026): es lo primero al abrir el enlace y
 * vuelve a salir si cambia el texto de Central. Es información, no consentimiento: un único «Entendido, continuar».
 * Sin él no se abren «Mis datos» ni «Alimentación» (sí la información práctica y la ayuda).
 */
import { el, replace } from '@ikisai/ui-kit';
import { commonText, textVersion, textVersions } from '../app/common-texts.ts';
import type { GuestContext } from '../app/context.ts';
import { t } from '../app/i18n.ts';
import { centralText } from './common.ts';

/** Versión vigente del aviso (la de Central; sin Central, la del texto de reserva). */
export function privacyVersion(): string {
  return textVersion('portal.privacy') ?? 'reserva-1';
}

export function needsPrivacy(ctx: GuestContext): boolean {
  const versions = textVersions('portal.privacy');
  return !(versions.length ? versions : [privacyVersion()]).some((v) => ctx.privacyAcked(v));
}

export function renderPrivacy(main: HTMLElement, ctx: GuestContext, onDone: () => void): void {
  const shown = commonText('portal.privacy')!;
  replace(main, el('section', { class: 'card gcard gprivacy', id: 'privacy', 'data-feedback-id': 'guests.aviso.privacidad', 'data-feedback-label': 'Aviso de protección de datos' },
    el('h2', null, shown.title ?? t('privacy.title')),
    el('p', { class: 'muted' }, t('privacy.intro')),
    centralText(shown.body, shown.spanishOnly, { id: 'privacyText' }),
    el('button', {
      type: 'button', class: 'primary wide', id: 'privacyOk',
      'data-feedback-id': 'guests.aviso.privacidad.entendido', 'data-feedback-label': 'Entendido, continuar',
      onclick: () => { ctx.ackPrivacy(privacyVersion()); onDone(); },
    }, t('privacy.ok'))));
}
