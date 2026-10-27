/**
 * K4 (KIT_PETICIONES, abierta por Core el 27-10): pista de desplazamiento en las filas que se desplazan en horizontal.
 * Sin ella, una fila de chips de 1 024 px en 343 no dice que hay más. Se marca cada borde que tiene contenido detrás
 * (`data-more-start`, `data-more-end`) y el CSS lo difumina. Solo pasa cuando la fila desborda.
 * - `.scrollrow`: fila de chips o botones en una línea, con desplazamiento horizontal y su pista.
 * - `installScrollHints(root)`: vigila `.scrollrow` y las tiras del kit (pestañas de carriles, días, vistas…), también las
 *   que aparezcan después. La cáscara (`createAppShell`) lo instala sola: las apps no tienen que hacer nada.
 * - `watchScrollHint(nodo)`: para una fila suelta; devuelve cómo dejar de vigilarla.
 */

/** Filas que se vigilan: `.scrollrow` de las apps y las tiras del kit con desplazamiento horizontal. */
export const SCROLL_HINT_SELECTOR = '.scrollrow, .viewstrip, .daytabs, .lanes-tabs, .stk-tabs, .pl-tabs, .fb-tabs';

const watched = new WeakMap<HTMLElement, () => void>();

function paint(node: HTMLElement): void {
  const max = node.scrollWidth - node.clientWidth;
  // En RTL scrollLeft va de 0 a -max; se compara en valor absoluto.
  const at = Math.abs(node.scrollLeft);
  const overflow = max > 1;
  node.toggleAttribute('data-more-start', overflow && at > 1);
  node.toggleAttribute('data-more-end', overflow && at < max - 1);
}

export function watchScrollHint(node: HTMLElement): () => void {
  const existing = watched.get(node);
  if (existing) return existing;
  let frame = 0;
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => paint(node)); };
  node.addEventListener('scroll', schedule, { passive: true });
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  resize?.observe(node);
  // Los hijos cambian el ancho del contenido sin cambiar el de la fila.
  const children = new MutationObserver(schedule);
  children.observe(node, { childList: true, subtree: true, characterData: true });
  paint(node);
  const stop = () => {
    cancelAnimationFrame(frame);
    node.removeEventListener('scroll', schedule);
    resize?.disconnect();
    children.disconnect();
    node.removeAttribute('data-more-start');
    node.removeAttribute('data-more-end');
    watched.delete(node);
  };
  watched.set(node, stop);
  return stop;
}

/** Vigila las filas de `root` y las que aparezcan después. Devuelve cómo dejar de vigilar. */
export function installScrollHints(root: ParentNode & Node = document): () => void {
  const stops = new Set<() => void>();
  const scan = (scope: ParentNode) => {
    if (scope instanceof HTMLElement && scope.matches(SCROLL_HINT_SELECTOR)) stops.add(watchScrollHint(scope));
    for (const n of scope.querySelectorAll<HTMLElement>(SCROLL_HINT_SELECTOR)) stops.add(watchScrollHint(n));
  };
  scan(root);
  let pending = false;
  const added: Node[] = [];
  const observer = new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n instanceof HTMLElement) added.push(n);
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; for (const n of added.splice(0)) if (n.isConnected) scan(n as HTMLElement); });
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => { observer.disconnect(); for (const s of stops) s(); stops.clear(); };
}
