/**
 * «Guarda tu acceso» (API.md §9.8): botón flotante para quien entró por enlace. La cuenta permanente (Google y código por
 * correo) la prepara Core con Workspace; hasta entonces, la hoja explica que guarde el enlace.
 */
import { el, icon, openSheet } from '@ikisai/ui-kit';
import { t } from '../app/i18n.ts';
import type { PortalApi } from '../app/api.ts';
import { contactLine } from '../app/common-texts.ts';

export function mountAccessButton(root: HTMLElement, api: PortalApi): { setVisible(on: boolean): void; destroy(): void } {
  let permanent = false;
  void api.permanentAccount().then((on) => { permanent = on; });
  const button = el('button', {
    type: 'button', class: 'fab orgaccess', id: 'saveAccess', 'aria-label': t('Guarda tu acceso'),
    'data-feedback-id': 'organizers.acceso.guardar.abrir', 'data-feedback-label': 'Guarda tu acceso',
    onclick: () => openSheet({
      title: t('Guarda tu acceso'),
      body: el('div', { id: 'accessSheet' },
        el('p', null, permanent
          ? t('Muy pronto podrás guardar tu acceso aquí con tu cuenta de Google o con un código por correo.')
          : t('Pronto podrás guardar tu acceso con tu cuenta de Google o con un código por correo, sin depender del enlace.')),
        el('p', null, t('Mientras tanto, guarda el enlace que te enviamos: es tu llave para entrar. Si lo pierdes, pídenos uno nuevo.')), el('p', { class: 'muted' }, contactLine())),
    }),
  }, icon('lock', 18), el('span', null, t('Guarda tu acceso')));
  root.append(button);
  return { setVisible: (on) => { button.hidden = !on; }, destroy: () => button.remove() };
}
