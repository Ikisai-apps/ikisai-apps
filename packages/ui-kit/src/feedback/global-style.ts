/**
 * Reglas del feedback que dependen de clases en `<html>` (`fb-pressing`, `fb-mode`, `fb-reviewing`). Las apps que acotan
 * el CSS del kit a `.ikisai-kit` (Tasks, Finance) las pierden al compilar (`html` no está dentro del contenedor), así que
 * el kit las inyecta una vez en una hoja global mínima en tiempo de ejecución. Los colores llevan valor de reserva porque
 * los tokens pueden estar acotados al contenedor.
 */
const STYLE_ID = 'ikisai-kit-feedback-global';

const CSS = [
  'html.fb-pressing,html.fb-pressing *{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}',
  'html.fb-mode #appLauncher,html.fb-reviewing #appLauncher{position:relative}',
  'html.fb-mode #appLauncher::after{content:"";position:absolute;right:-2px;top:-2px;width:10px;height:10px;border-radius:50%;background:var(--warn,#d99a2b);border:2px solid var(--bg,#f6f1e7)}',
  'html.fb-reviewing #appLauncher::before{content:"";position:absolute;left:-2px;top:-2px;width:10px;height:10px;border-radius:50%;background:var(--ok,#4f7a4a);border:2px solid var(--bg,#f6f1e7)}',
  /* Un diálogo abierto desde la tarjeta del revisor va por encima de ella. */
  'html.fb-reviewing .dialogback{z-index:97}',
  /* Señalar una vez (portales): las hojas se apartan para ver la pantalla y vuelven al terminar. */
  'html.fb-capturing .sheetback,html.fb-capturing .dialogback{visibility:hidden;pointer-events:none}',
].join('\n');

export function ensureFeedbackGlobalStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

const MARK_HINTS: Record<'fb-mode' | 'fb-reviewing', string> = {
  'fb-mode': 'Señalar para comentar: activo (punto amarillo)',
  'fb-reviewing': 'Revisor de QA: activo (punto verde)',
};

/**
 * Explica los puntos de la marca (`#appLauncher`) con `title` y `aria-label` según los modos activos (FB_2026_003: el
 * usuario no sabía qué era el punto amarillo). Guarda la etiqueta original de la app en `data-fb-label`.
 */
export function syncMarkHint(): void {
  const html = document.documentElement.classList;
  const active = (Object.keys(MARK_HINTS) as (keyof typeof MARK_HINTS)[]).filter((c) => html.contains(c)).map((c) => MARK_HINTS[c]);
  for (const mark of document.querySelectorAll<HTMLElement>('#appLauncher')) {
    if (mark.dataset.fbLabel === undefined) mark.dataset.fbLabel = mark.getAttribute('aria-label') ?? '';
    const base = mark.dataset.fbLabel || 'Abrir otra app de Ikisai';
    if (active.length) { mark.title = active.join(' · '); mark.setAttribute('aria-label', `${base}. ${active.join('. ')}`); }
    else { mark.removeAttribute('title'); mark.setAttribute('aria-label', base); }
  }
}
