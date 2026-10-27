/**
 * «Guarda tu acceso» (API.md §9.8): botón flotante y compacto (54 × 54, solo el candado) para quien entró por enlace. Con la
 * entrada por código (0108, `auth/config.emailCode`), la hoja explica que ya puede entrar con un código a su correo; sin ella,
 * que guarde el enlace. Google llegará con Workspace.
 */
import { el, icon, openSheet } from '@ikisai/ui-kit';
import { t } from '../app/i18n.ts';
import type { PortalApi } from '../app/api.ts';
import { contactLine } from '../app/common-texts.ts';

export function mountAccessButton(root: HTMLElement, api: PortalApi): { setVisible(on: boolean): void; destroy(): void } {
  let permanent = false;
  let emailCode = false;
  void api.authConfig().then((config) => { permanent = config.permanentAccount; emailCode = config.emailCode; });
  const button = el('button', {
    type: 'button', class: 'fab orgaccess', id: 'saveAccess', 'aria-label': t('Guarda tu acceso'),
    'data-feedback-id': 'organizers.acceso.guardar.abrir', 'data-feedback-label': 'Guarda tu acceso',
    onclick: () => openSheet({
      title: t('Guarda tu acceso'),
      body: el('div', { id: 'accessSheet' },
        ...(emailCode ? [
          el('p', null, t('Tu acceso ya está guardado: si cambias de móvil, cierras la sesión o pierdes el enlace, entra con un código que te mandamos al correo con el que te escribimos.')),
          el('p', null, t('En la pantalla de entrada, escribe tu correo y pulsa «Enviarme un código».')),
        ] : [
          el('p', null, permanent
            ? t('Muy pronto podrás guardar tu acceso aquí con tu cuenta de Google o con un código por correo.')
            : t('Pronto podrás guardar tu acceso con tu cuenta de Google o con un código por correo, sin depender del enlace.')),
          el('p', null, t('Mientras tanto, guarda el enlace que te enviamos: es tu llave para entrar. Si lo pierdes, pídenos uno nuevo.')),
        ]), el('p', { class: 'muted' }, contactLine())),
    }),
  }, icon('lock', 18), el('span', { class: 'orgaccess-text' }, t('Guarda tu acceso')));
  root.append(button);
  // Botón compacto (solo el candado; el nombre va en `aria-label`). Mientras se ve, la página deja sitio debajo.
  return {
    setVisible: (on) => { button.hidden = !on; root.classList.toggle('orgaccess-on', on); },
    destroy: () => { button.remove(); root.classList.remove('orgaccess-on'); },
  };
}
