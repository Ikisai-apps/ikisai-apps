/**
 * «Unir este móvil a mi ficha» (ENTRADA_PUBLICA.md, tarjeta 4; núcleo 0106): si este móvil entró también como visitante
 * (QR, carta o «Alójate aquí»), el huésped puede unir esa identidad a su ficha, con su consentimiento y deshaciéndolo
 * cuando quiera (`POST/DELETE /api/v1/visitor-link`, con su sesión y el `X-Visitor` de este mismo móvil). Nunca se casa a
 * nadie por el nombre. «Ahora no» lo esconde en este móvil para esa ficha. Sin identidad de visitante, nada.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { el, replace, toast } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { t } from '../app/i18n.ts';
import { visitorToken } from '../app/visitor.ts';

const KEY = (guestId: string) => `ikisai-visitor-link:${guestId}`;
const read = (guestId: string) => { try { return localStorage.getItem(KEY(guestId)); } catch { return null; } };
const write = (guestId: string, value: 'linked' | 'dismissed' | null) => {
  try { if (value) localStorage.setItem(KEY(guestId), value); else localStorage.removeItem(KEY(guestId)); } catch { /* solo esta visita */ }
};

export function visitorLinkCard(client: SyncClient, guestId: string): HTMLElement | null {
  const token = visitorToken();
  if (!token || read(guestId) === 'dismissed') return null;
  const box = el('section', { class: 'card gcard gvlink', id: 'visitorLink', 'data-feedback-id': 'guests.inicio.visitante.unir', 'data-feedback-label': 'Unir este móvil a mi ficha' });

  const paint = () => {
    if (read(guestId) === 'linked') {
      replace(box, el('p', { id: 'visitorLinked' }, t('vlink.linked')),
        el('button', { type: 'button', class: 'ghost small', id: 'visitorUnlink', onclick: async () => {
          try { await client.api(`/visitor-link/${guestId}`, { method: 'DELETE' }); write(guestId, null); toast(t('vlink.unlinked')); paint(); }
          catch (error) { toast(describeError(error)); }
        } }, t('vlink.undo')));
      return;
    }
    replace(box,
      el('h3', null, t('vlink.title')),
      el('p', { class: 'small' }, t('vlink.text')),
      el('div', { class: 'btnrow' },
        el('button', { type: 'button', class: 'primary', id: 'visitorLinkGo', onclick: async () => {
          try {
            await client.api('/visitor-link', { json: { guestId }, headers: { 'X-Visitor': token } });
            write(guestId, 'linked');
            toast(t('vlink.done'));
            paint();
          } catch (error) { toast(describeError(error)); }
        } }, t('vlink.go')),
        el('button', { type: 'button', class: 'ghost', id: 'visitorLinkLater', onclick: () => { write(guestId, 'dismissed'); box.remove(); } }, t('vlink.later'))));
  };
  paint();
  return box;
}
