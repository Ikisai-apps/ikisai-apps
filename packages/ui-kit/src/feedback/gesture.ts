/**
 * Gesto de señalamiento (FEEDBACK.md §2.3 y §6): pulsación mantenida con Pointer Events (táctil, ratón y lápiz).
 * - Desde el `pointerdown` se suprimen la selección, el menú contextual y el arrastre nativos (Android los dispara antes
 *   de los 600 ms); se restauran al soltar, cancelar o mover.
 * - Se cancela al moverse más de 8 px o con `pointercancel` (el navegador empezó a desplazar).
 * - Al dispararse, se anula el clic que vendría al soltar (captura en `window`, una vez, con caducidad).
 * - No se dispara en campos editables ni en zonas de arrastre o marcadas con `data-feedback-ignore`.
 * - Teclado: Mayúsculas+F10 o la tecla de menú sobre el elemento con foco.
 */
import { ensureFeedbackGlobalStyles } from './global-style.ts';
import { FEEDBACK_EDITABLE_SELECTOR, FEEDBACK_IGNORE_SELECTOR, FEEDBACK_LONG_PRESS_MS, FEEDBACK_MOVE_TOLERANCE_PX } from './constants.ts';

export interface FeedbackGestureOptions {
  /** Dónde escuchar; por defecto `document`. */
  root?: Document | HTMLElement;
  /** Se llama con el elemento señalado (el más profundo bajo el puntero o el que tiene el foco). */
  onSignal: (target: Element, via: 'press' | 'keyboard') => void;
  /** Permite apagarlo (sin sesión, con un overlay propio abierto…). */
  enabled?: () => boolean;
  delay?: number;
  tolerance?: number;
}

export interface FeedbackGesture {
  destroy(): void;
}

const PRESSING_CLASS = 'fb-pressing';

export function isFeedbackExcluded(target: Element | null): boolean {
  if (!target) return true;
  return !!target.closest(FEEDBACK_IGNORE_SELECTOR) || !!target.closest(FEEDBACK_EDITABLE_SELECTOR);
}

export function installFeedbackGesture(options: FeedbackGestureOptions): FeedbackGesture {
  ensureFeedbackGlobalStyles();
  const root = options.root ?? document;
  const delay = options.delay ?? FEEDBACK_LONG_PRESS_MS;
  const tolerance = options.tolerance ?? FEEDBACK_MOVE_TOLERANCE_PX;
  const html = document.documentElement;
  let press: { id: number; x: number; y: number; target: Element; timer: ReturnType<typeof setTimeout> } | null = null;

  const blockNative = (e: Event) => { if (press) e.preventDefault(); };

  function release(): void {
    if (!press) return;
    clearTimeout(press.timer);
    press = null;
    html.classList.remove(PRESSING_CLASS);
  }

  /** Anula el clic que llega al soltar tras disparar el gesto (y el `contextmenu` de Android si llega tarde). */
  function swallowNextClick(): void {
    const swallow = (e: Event) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
    const off = () => { window.removeEventListener('click', swallow, true); window.removeEventListener('contextmenu', swallow, true); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    window.addEventListener('contextmenu', swallow, { capture: true, once: true });
    setTimeout(off, 800);
  }

  function fire(): void {
    if (!press) return;
    const target = press.target;
    release();
    swallowNextClick();
    try { (navigator as Navigator & { vibrate?: (ms: number) => boolean }).vibrate?.(10); } catch { /* sin vibración */ }
    options.onSignal(target, 'press');
  }

  const onDown = (event: Event) => {
    const e = event as PointerEvent;
    if (press || (options.enabled && !options.enabled())) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target || isFeedbackExcluded(target)) return;
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, target, timer: setTimeout(fire, delay) };
    html.classList.add(PRESSING_CLASS);
  };
  const onMove = (event: Event) => {
    const e = event as PointerEvent;
    if (!press || e.pointerId !== press.id) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > tolerance) release();
  };
  const onEnd = (event: Event) => {
    const e = event as PointerEvent;
    if (press && e.pointerId === press.id) release();
  };
  const onKey = (event: Event) => {
    const e = event as KeyboardEvent;
    if (!((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu')) return;
    if (options.enabled && !options.enabled()) return;
    const target = document.activeElement;
    if (!target || target === document.body || isFeedbackExcluded(target)) return;
    e.preventDefault();
    options.onSignal(target, 'keyboard');
  };
  const onScroll = () => release();

  root.addEventListener('pointerdown', onDown, true);
  root.addEventListener('pointermove', onMove, true);
  root.addEventListener('pointerup', onEnd, true);
  root.addEventListener('pointercancel', onEnd, true);
  root.addEventListener('contextmenu', blockNative, true);
  root.addEventListener('selectstart', blockNative, true);
  root.addEventListener('dragstart', blockNative, true);
  root.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });

  return {
    destroy() {
      release();
      root.removeEventListener('pointerdown', onDown, true);
      root.removeEventListener('pointermove', onMove, true);
      root.removeEventListener('pointerup', onEnd, true);
      root.removeEventListener('pointercancel', onEnd, true);
      root.removeEventListener('contextmenu', blockNative, true);
      root.removeEventListener('selectstart', blockNative, true);
      root.removeEventListener('dragstart', blockNative, true);
      root.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
    },
  };
}
