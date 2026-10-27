/**
 * Guiado mínimo del kit: lo que en Food puede estar escondido cuando el Guiado señala un anclaje (`?campo=`).
 * Los `<details>` cerrados ya los abre el kit (`revealAnchor`, 0.69.3). Aquí, las pestañas Previsión y Compra de una carta,
 * que son rutas: si se está en esa carta, se cambia a la pestaña.
 * Las hojas no se abren solas: el paso de Flow lleva antes al botón que la abre.
 */
import { registerReveal } from '@ikisai/ui-kit';
import { cartaHash, type CartaTab } from './carta.ts';

export function registerFoodReveals(navigate: (hash: string) => void): void {
  // Ids literales: el catálogo de «Uso» no admite partes dinámicas.
  const tabs: Array<[string, CartaTab]> = [['food.carta.prevision', 'prevision'], ['food.carta.compra', 'compra']];
  for (const [prefix, tab] of tabs) {
    registerReveal(prefix, () => {
      const [, cartaId] = location.hash.match(/^#\/cartas\/([0-9a-f-]{36})/i) ?? [];
      if (cartaId && !location.hash.endsWith(`/${tab}`)) navigate(cartaHash(cartaId, tab));
    });
  }
}
