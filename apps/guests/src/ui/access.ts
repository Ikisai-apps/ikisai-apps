/**
 * «Guarda tu acceso» e instalación (API.md §9.9). La cuenta permanente (Google y código por correo) la activa Core con
 * Workspace; hasta entonces la hoja explica que guarde el enlace. Instalar: el aviso nativo donde existe
 * (`beforeinstallprompt`) y, en iOS, los dos pasos de «Añadir a pantalla de inicio». Nunca bloquea nada.
 */
import { el, openSheet, toast } from '@ikisai/ui-kit';
import type { GuestApi } from '../app/api.ts';
import { contactEmail, contactPhone } from '../app/common-texts.ts';
import { t } from '../app/i18n.ts';

interface InstallPrompt extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }
let deferred: InstallPrompt | null = null;
window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); deferred = event as InstallPrompt; });

export async function openAccess(api: GuestApi): Promise<void> {
  const permanent = await api.permanentAccount();
  openSheet({
    title: t('access.title'),
    body: el('div', { id: 'accessSheet' },
      el('p', null, permanent ? t('access.soonActive') : t('access.soon')),
      el('p', null, t('access.keepLink')),
      el('p', { class: 'muted' }, t('entry.contact', { email: contactEmail(), phone: contactPhone() }))),
  });
}

export async function openInstall(): Promise<void> {
  if (deferred) {
    const prompt = deferred;
    deferred = null;
    await prompt.prompt();
    const choice = await prompt.userChoice.catch(() => ({ outcome: 'dismissed' }));
    if (choice.outcome === 'accepted') toast(t('install.done'));
    return;
  }
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  openSheet({
    title: t('install.title'),
    body: el('div', { id: 'installSheet' },
      el('p', null, ios ? t('install.ios') : t('install.other')),
      el('p', { class: 'muted' }, t('install.optional'))),
  });
}
