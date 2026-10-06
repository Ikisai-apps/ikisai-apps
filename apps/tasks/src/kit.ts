/**
 * Ikisai Tasks · el kit de interfaz común (`@ikisai/ui-kit`) empaquetado como script clásico `/kit.js` con su hoja
 * `/kit.css`, para que la interfaz heredada (scripts en `public/`) lo adopte módulo a módulo a través de `window.IkisaiKit`.
 * index.html carga `/kit.js` justo después de `/sync-core.js`. La hoja va acotada a `.ikisai-kit` (vite.config.ts): cada trozo
 * pintado con el kit se envuelve en un elemento con esa clase y el CSS heredado no se ve afectado.
 */
import '@ikisai/ui-kit/ui-kit.css';
import * as kit from '@ikisai/ui-kit';

declare global {
  interface Window { IkisaiKit: typeof kit }
}
window.IkisaiKit = kit;
