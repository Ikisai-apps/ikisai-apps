/** Foco atrapado dentro de una capa modal y devolución del foco al cerrar. */

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => !node.hidden && node.offsetParent !== null && !node.closest('[hidden]'));
}

/** Mantiene Tab y Mayús+Tab dentro de `root`. Llamar desde un `keydown` con `e.key === 'Tab'`. */
export function trapFocus(event: KeyboardEvent, root: HTMLElement): void {
  const items = focusables(root);
  if (items.length === 0) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = items[0]!, last = items[items.length - 1]!;
  const active = document.activeElement as HTMLElement | null;
  if (event.shiftKey && (active === first || !root.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !root.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

/** Enfoca el primer control útil (o el propio panel). */
export function focusFirst(root: HTMLElement, preferred?: HTMLElement | null): void {
  const target = preferred ?? focusables(root).find((node) => !node.classList.contains('iconbtn')) ?? focusables(root)[0] ?? root;
  target.focus({ preventScroll: true });
}

let locks = 0;
/** Bloquea el scroll del documento mientras haya capas abiertas. */
export function lockScroll(): () => void {
  locks += 1;
  document.body.style.overflow = 'hidden';
  let released = false;
  return () => {
    if (released) return;
    released = true;
    locks = Math.max(0, locks - 1);
    if (locks === 0) document.body.style.overflow = '';
  };
}
