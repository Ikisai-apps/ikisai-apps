import { confirmDialog, el, fieldAttrs, renderMedal } from '@ikisai/ui-kit';
import { productAssets, SCOPE_LABELS } from '@ikisai/domain-flow';
import type { Product } from '../app/data.ts';

/** Ayudantes de las fichas de pedido y de entrega. */

/** Medallón del producto: su `medallon.svg` si tiene imágenes (el kit cae a las iniciales si no carga), o el código. */
export const productMedal = (p: Product, size = 36) =>
  renderMedal({ image: productAssets(p.image_key)?.medal ?? null, initials: p.code, color: p.scope === 'gourmet' ? 'var(--warn, #b5652b)' : 'var(--accent)', size, label: `${SCOPE_LABELS[p.scope]} ${p.code}` });

/** Pide un motivo obligatorio (anular un cobro, reabrir una entrega). `null` si se cancela. */
export async function askReason(title: string, text: string, confirmLabel: string, danger = false): Promise<string | null> {
  const input = el('input', { ...fieldAttrs({ id: 'flow.hoja.motivo', type: 'text' }), type: 'text', maxlength: '200', 'aria-label': 'Motivo', placeholder: 'Motivo' });
  const ok = await confirmDialog({ title, text, body: input, confirmLabel, danger });
  const reason = input.value.trim();
  return ok && reason ? reason : null;
}

/** Botón con su propio estado «en curso»: no se puede pulsar dos veces mientras espera al servidor. */
export function busyButton(attrs: Record<string, string>, label: string, run: () => Promise<void>): HTMLButtonElement {
  const button = el('button', { type: 'button', ...attrs }, label) as HTMLButtonElement;
  button.addEventListener('click', async () => {
    if (button.dataset.busy) return;
    button.dataset.busy = '1';
    button.setAttribute('aria-busy', 'true');
    const wasDisabled = button.disabled;
    button.disabled = true;
    try { await run(); } finally { delete button.dataset.busy; button.removeAttribute('aria-busy'); button.disabled = wasDisabled; }
  });
  return button;
}
