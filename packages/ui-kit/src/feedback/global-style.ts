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
  'html.fb-reviewing #appLauncher::before{content:"";position:absolute;left:-2px;top:-2px;width:10px;height:10px;border-radius:50%;background:var(--accent,#56663f);border:2px solid var(--bg,#f6f1e7)}',
  /* Un diálogo abierto desde la tarjeta del revisor va por encima de ella. */
  'html.fb-reviewing .dialogback{z-index:97}',
].join('\n');

export function ensureFeedbackGlobalStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}
