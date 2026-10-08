/**
 * Teclado virtual (fallo del usuario en Android, todas las apps): con el teclado abierto, los campos de abajo de una hoja
 * o panel quedaban tapados y no se podía desplazar hasta ellos. Solución estándar del kit, que se instala sola:
 * 1. Pide a Chrome Android que **encoja el contenido** al abrir el teclado (`interactive-widget=resizes-content` en la
 *    meta `viewport`), así `100dvh` y los elementos fijos (hojas, diálogos) se quedan por encima del teclado.
 * 2. Red de seguridad para navegadores que solo encogen la vista visual (o si la app fija otra meta): publica en `<html>`
 *    `--kb` (alto del teclado) y `--vvh` (alto visible) a partir de `visualViewport`; las hojas y diálogos las usan.
 * 3. Al enfocar un campo (y al abrirse el teclado), lo **desplaza a la vista** dentro de su contenedor, centrado.
 */
const STYLE_ID = 'ikisai-kit-keyboard';
const EDITABLE = 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="range"]):not([type="color"]):not([type="file"]), textarea, select, [contenteditable="true"]';
let installed = false;

function ensureViewportMeta(): void {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'viewport';
    meta.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
    document.head.appendChild(meta);
  }
  if (!/interactive-widget/.test(meta.content)) meta.content = `${meta.content.replace(/\s*,?\s*$/, '')}, interactive-widget=resizes-content`;
}

/** Instala el ajuste al teclado (una vez por página). Lo llama el kit al abrir hojas y diálogos; las apps pueden llamarlo al arrancar. */
export function installKeyboardInsets(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  ensureViewportMeta();
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    // Global (no se acota a `.ikisai-kit`): las hojas y diálogos se apoyan encima del teclado y caben en lo visible.
    style.textContent = [
      '.sheetback,.dialogback{bottom:var(--kb,0px)!important}',
      '@media(max-width:1023px){.sheet{max-height:min(92dvh,calc(var(--vvh,100dvh) - 8px))}}',
      '.dialog{max-height:calc(var(--vvh,100dvh) - 32px);overflow:auto}',
    ].join('\n');
    document.head.appendChild(style);
  }
  const html = document.documentElement;
  const vv = window.visualViewport;
  let lastKb = 0;
  const update = () => {
    if (!vv) return;
    // Alto del teclado: lo que falta entre el borde inferior de lo visible y el de la vista de diseño.
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    html.style.setProperty('--kb', `${kb > 60 ? kb : 0}px`);
    html.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    if (kb > 60 && lastKb <= 60) revealFocused();
    lastKb = kb;
  };
  vv?.addEventListener('resize', update);
  vv?.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  update();

  /** Desplaza el campo enfocado a la vista (centrado) tras abrirse el teclado. */
  function revealFocused(): void {
    const field = document.activeElement;
    if (!(field instanceof HTMLElement) || !field.matches(EDITABLE)) return;
    setTimeout(() => field.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }), 60);
  }
  document.addEventListener('focusin', (e) => {
    const field = e.target;
    if (!(field instanceof HTMLElement) || !field.matches(EDITABLE)) return;
    // El teclado tarda en abrirse: se revisa al momento y otra vez cuando ya ha cambiado lo visible.
    setTimeout(() => {
      const r = field.getBoundingClientRect();
      const visibleBottom = vv ? vv.height + vv.offsetTop : window.innerHeight;
      if (r.bottom > visibleBottom - 12 || r.top < 0) field.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    }, 320);
  });
}
