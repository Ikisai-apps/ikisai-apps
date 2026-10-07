/**
 * Compartir el enlace personal de un asistente (API.md §9.4 y §9.6): Web Share si el dispositivo lo ofrece; WhatsApp
 * (a su número si lo escribió quien organiza) y Copiar siempre. La URL se ve una sola vez: para otra, se reenvía.
 */
import { el, openSheet } from '@ikisai/ui-kit';
import { whatsappUrl } from '../app/texts.ts';
import { copyText, fbIgnore } from './common.ts';

export interface ShareOptions { name: string; text: string; phone?: string | null; onShared?: (how: 'share' | 'whatsapp' | 'copy') => void }

export function openShareSheet(options: ShareOptions): void {
  const { name, text } = options;
  const canShare = typeof navigator.share === 'function';
  openSheet({
    title: `Enlace de ${name}`,
    body: el('div', { id: 'shareSheet' },
      el('p', { class: 'banner info' }, `Este enlace es personal: envíaselo solo a ${name}.`),
      fbIgnore(el('label', { class: 'field' }, el('span', null, 'Mensaje'), el('textarea', { id: 'shareText', readonly: '', rows: '6' }, text))),
      el('p', { class: 'muted small' }, 'Por seguridad, el enlace solo se muestra ahora. Si se pierde, podrás enviar uno nuevo y el anterior dejará de funcionar.')),
    foot: el('div', { class: 'btnrow' },
      canShare ? el('button', {
        type: 'button', class: 'primary', id: 'shareNative', 'data-feedback-id': 'organizers.asistente.enlace.compartir', 'data-feedback-label': 'Compartir',
        onclick: async () => {
          try { await navigator.share({ title: 'Tu enlace para el retiro', text }); options.onShared?.('share'); } catch { /* cancelado */ }
        },
      }, 'Compartir') : null,
      el('a', {
        class: canShare ? 'ghost' : 'primary', id: 'shareWhatsapp', href: whatsappUrl(text, options.phone), target: '_blank', rel: 'noopener',
        'data-feedback-id': 'organizers.asistente.enlace.whatsapp', 'data-feedback-label': 'Enviar por WhatsApp',
        onclick: () => options.onShared?.('whatsapp'),
      }, 'WhatsApp'),
      el('button', {
        type: 'button', class: 'ghost', id: 'shareCopy', 'data-feedback-id': 'organizers.asistente.enlace.copiar', 'data-feedback-label': 'Copiar enlace',
        onclick: async () => { await copyText(text, 'Mensaje copiado con el enlace.'); options.onShared?.('copy'); },
      }, 'Copiar')),
  });
}
