/**
 * Guiado mínimo del kit (0.68): lo que en Food puede estar escondido cuando el Guiado señala un anclaje (`?campo=`).
 * - Cualquier anclaje de Food dentro de un `<details>` cerrado (papeleras, «Ya hay en casa», coste por ingrediente…): se abre.
 * - Las pestañas Previsión y Compra de una carta son rutas: si se está en esa carta, se cambia a la pestaña.
 * Las hojas no se abren solas: el paso de Flow lleva antes al botón que la abre.
 */
import { registerReveal } from '@ikisai/ui-kit';
import { cartaHash, type CartaTab } from './carta.ts';

function openFolds(id: string): void {
  for (const node of document.querySelectorAll<HTMLElement>(`[data-field-id="${CSS.escape(id)}"], [data-feedback-id="${CSS.escape(id)}"]`)) {
    for (let fold = node.closest('details'); fold; fold = fold.parentElement?.closest('details') ?? null) fold.open = true;
  }
}

export function registerFoodReveals(navigate: (hash: string) => void): void {
  registerReveal('food', openFolds);
  for (const tab of ['prevision', 'compra'] as CartaTab[]) {
    registerReveal(`food.carta.${tab}`, (id) => {
      const [, cartaId] = location.hash.match(/^#\/cartas\/([0-9a-f-]{36})/i) ?? [];
      if (cartaId && !location.hash.endsWith(`/${tab}`)) navigate(cartaHash(cartaId, tab));
      openFolds(id);
    });
  }
}
