/**
 * Anclajes del Guiado (`MUELA/equipo/feedback/flow/GUIADO.md`, decisión de VG del 27-10: Guiado completo, empezando por el
 * campo señalado). Un anclaje es un id estable del inventario: `data-field-id` en los campos y `data-feedback-id` en botones
 * y secciones. Nada de selectores CSS.
 * - `findAnchor(id)`: el nodo con ese id, primero como campo y luego como feedback.
 * - `registerReveal(prefijo, fn)`: la app enseña lo que está escondido (una hoja cerrada, una pestaña). `revealAnchor(id)`
 *   llama a la del prefijo más largo y espera a que el anclaje aparezca.
 * - `announceSaved(id)` y `onSaved(fn)`: el aviso de que ese campo se guardó de verdad (`confirm: 'event'`). Para los que
 *   guardan con `createSaveState` usando el id del campo como clave, el aviso sale solo (`confirm: 'save'`).
 *   **Nunca lleva valores**: solo el id.
 * - `pointAt(nodo)`: lo trae a la vista, le da el foco si puede y lo resalta un momento.
 * Prefijo de clases: `guia-`.
 */

/** El mismo formato que los ids de campo y de feedback (`app.pantalla.campo`). */
export const ANCHOR_ID = /^[a-z][a-z0-9_]*(\.[a-z0-9_-]+){1,7}$/;
const SAVED = 'ikisai:field-saved';

/** El nodo del anclaje: primero como campo, luego como feedback. Se ignoran los que no se ven. */
export function findAnchor(id: string, root: ParentNode = document): HTMLElement | null {
  if (!ANCHOR_ID.test(id)) return null;
  const q = CSS.escape(id);
  const all = [...root.querySelectorAll<HTMLElement>(`[data-field-id="${q}"]`), ...root.querySelectorAll<HTMLElement>(`[data-feedback-id="${q}"]`)];
  return all.find(visible) ?? null;
}

function visible(node: HTMLElement): boolean {
  if (!node.isConnected || node.closest('[hidden], [inert]')) return false;
  // Sin cajas: no se pinta (`display: none`, dentro de un `<details>` cerrado…). Un input visualmente oculto (casilla
  // propia, archivo) sí tiene su caja de 1 px y cuenta.
  if (!node.getClientRects().length) return false;
  // `checkVisibility` también ve lo saltado por `content-visibility` (así esconde Chrome un `<details>` cerrado).
  const check = (node as HTMLElement & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (check && !check.call(node, { visibilityProperty: true, contentVisibilityAuto: false })) return false;
  return getComputedStyle(node).visibility !== 'hidden';
}

type Reveal = (id: string) => void | Promise<void>;
const reveals = new Map<string, Reveal>();

/** La app sabe enseñar los anclajes de `prefix` (`booking.ficha`): abre la hoja, cambia de pestaña… Devuelve cómo quitarlo. */
export function registerReveal(prefix: string, reveal: Reveal): () => void {
  reveals.set(prefix, reveal);
  return () => { if (reveals.get(prefix) === reveal) reveals.delete(prefix); };
}

/**
 * Busca el anclaje y, si no está a la vista, pide a la app que lo enseñe y espera a que aparezca (por defecto, 4 s).
 * `null` si no aparece: el que guía dice «No encuentro…» en vez de fallar en silencio.
 */
export async function revealAnchor(id: string, options: { timeoutMs?: number; root?: ParentNode } = {}): Promise<HTMLElement | null> {
  const found = findAnchor(id, options.root);
  if (found) return found;
  const prefix = [...reveals.keys()].filter((p) => id === p || id.startsWith(`${p}.`)).sort((a, b) => b.length - a.length)[0];
  if (prefix) { try { await reveals.get(prefix)!(id); } catch { /* la app no pudo; se sigue esperando por si aparece */ } }
  return waitForAnchor(id, options.timeoutMs ?? 4000, options.root);
}

/** Espera a que el anclaje aparezca (la pantalla llega tarde tras cargar datos). */
export function waitForAnchor(id: string, timeoutMs: number, root: ParentNode = document): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const now = findAnchor(id, root);
    if (now) { resolve(now); return; }
    let done = false;
    const finish = (node: HTMLElement | null) => { if (done) return; done = true; observer.disconnect(); clearTimeout(timer); clearInterval(poll); resolve(node); };
    const check = () => { const n = findAnchor(id, root); if (n) finish(n); };
    const observer = new MutationObserver(check);
    observer.observe(root instanceof Document ? root.documentElement : (root as Node), { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'style', 'open', 'data-field-id', 'data-feedback-id'] });
    // Lo que cambia sin mutaciones (animaciones, `display` por CSS).
    const poll = setInterval(check, 250);
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

/** Avisa de que el campo `id` se guardó (confirmado por el servidor o en la cola sin red). Solo el id, nunca el valor. */
export function announceSaved(id: string, detail: { pending?: boolean } = {}): void {
  if (!ANCHOR_ID.test(id) || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SAVED, { detail: { id, pending: !!detail.pending } }));
}

/** Escucha los avisos de guardado. Devuelve cómo dejar de escuchar. */
export function onSaved(listener: (id: string, info: { pending: boolean }) => void): () => void {
  const handler = (e: Event) => { const d = (e as CustomEvent<{ id: string; pending: boolean }>).detail; if (d && typeof d.id === 'string') listener(d.id, { pending: !!d.pending }); };
  window.addEventListener(SAVED, handler);
  return () => window.removeEventListener(SAVED, handler);
}

/** Trae el anclaje a la vista, le da el foco (al campo de dentro si es un contenedor) y lo resalta `ms` milisegundos. */
export function pointAt(node: HTMLElement, options: { ms?: number; focus?: boolean } = {}): void {
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  if (options.focus !== false) {
    const target = node.matches('input, select, textarea, button, a[href], [tabindex]') ? node
      : node.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea, button, [tabindex]:not([tabindex="-1"])');
    target?.focus({ preventScroll: true });
  }
  node.classList.remove('guia-pulse');
  // Reinicia la animación si ya estaba.
  void node.offsetWidth;
  node.classList.add('guia-pulse');
  setTimeout(() => node.classList.remove('guia-pulse'), options.ms ?? 3200);
}
