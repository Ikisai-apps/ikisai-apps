/**
 * La estantería (K22, MUELA-062 y 094): baldosas en filas («una estantería por tienda», «por sitio») con arrastre **entre
 * filas**. `createSortableList` ordena dentro de una lista; esta pieza cambia de fila y no ordena.
 *
 * - Cada fila: cabecera con medallón, nombre, resumen (`sub`) y, con `onAdd`, «+» (46 px); dentro, las baldosas que pinta
 *   la app (`tile`, normalmente `renderTile` con sus mandos).
 * - **Arrastre:** con el ratón, desde cualquier punto de la baldosa (a partir de 8 px); con el dedo, tras la pulsación
 *   larga (si se suelta sin moverla, la pulsación larga de la baldosa: su «⋯»). Se suelta en otra fila: `onMove(item,
 *   fromRow, toRow)`. La pieza lo mueve en pantalla al momento; la app escribe, avisa con «Deshacer» y llama a `setRows`.
 * - **Teclado:** «Mover a…» (`moveSheet(item)`, para el «⋯» de la baldosa) con una lista de las demás filas, y Alt+↑ /
 *   Alt+↓ desde cualquier mando de la baldosa, a la fila de arriba o de abajo. Lo anuncia una región viva.
 * - `canMove(item, row)` dice qué se puede mover (Tasks: lo comprado o lo que está en un plan, no).
 * Prefijo de clases: `shelf-`.
 */
import { el, replace } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';
import { openSheet, type Sheet } from '../overlay/sheet.ts';
import { renderMedal, type MedalOptions } from './medal.ts';

export interface ShelfRow<T> {
  key: string;
  label: string;
  /** Resumen de la cabecera («18 · 153,35 €»). */
  sub?: string | null;
  medal?: MedalOptions | null;
  items: T[];
  /** Texto con la fila vacía. */
  empty?: string | null;
}

export interface ShelvesOptions<T> {
  rows: ShelfRow<T>[];
  key: (item: T) => string;
  /** Nombre del artículo, para los anuncios y «Mover … a». */
  name: (item: T) => string;
  /** La baldosa (la pinta la app). */
  tile: (item: T, row: ShelfRow<T>) => HTMLElement;
  /** Sin `onMove`, no se arrastra. */
  onMove?: (item: T, fromRow: ShelfRow<T>, toRow: ShelfRow<T>) => void | Promise<void>;
  canMove?: (item: T, row: ShelfRow<T>) => boolean;
  /** «+» en la cabecera de cada fila. */
  onAdd?: ((row: ShelfRow<T>) => void) | null;
  /** Nombre accesible del conjunto («Estanterías por tienda»). */
  label: string;
  /** Nombre de una fila en «Mover a otra …» («tienda», «sitio»). Por defecto «estantería». */
  noun?: string;
  feedbackId?: string;
}

export interface Shelves<T> {
  element: HTMLElement;
  setRows(rows: ShelfRow<T>[]): void;
  getRows(): ShelfRow<T>[];
  /** Las filas a las que se puede mover (todas menos la suya; ninguna si no se puede mover). */
  moveTargets(item: T): ShelfRow<T>[];
  /** Mueve sin arrastrar (lo que hacen «Mover a…» y Alt+↑/↓). Devuelve si se movió. */
  moveTo(item: T, rowKey: string): boolean;
  /** La hoja «Mover … a»: la alternativa al arrastre, para el «⋯» de la baldosa. */
  moveSheet(item: T): Sheet | null;
  destroy(): void;
}

const LONG_MS = 480;

export function createShelves<T>(options: ShelvesOptions<T>): Shelves<T> {
  let rows = options.rows.slice();
  const base = options.feedbackId ?? null;
  const mark = (suffix: string, label: string) => (base ? { 'data-feedback-id': `${base}.${suffix}`, 'data-feedback-label': label } : {});
  const live = el('p', { class: 'vh', role: 'status', 'aria-live': 'polite' });
  const list = el('div', { class: 'shelf-list' });
  const element = el('div', { class: 'shelf-root', role: 'region', 'aria-label': options.label, ...(base ? { 'data-feedback-id': base, 'data-feedback-label': options.label } : {}) }, list, live);
  const noun = options.noun ?? kt('estantería');

  const rowOf = (item: T) => rows.find((r) => r.items.some((x) => options.key(x) === options.key(item))) ?? null;
  const findItem = (key: string) => {
    for (const r of rows) for (const x of r.items) if (options.key(x) === key) return { item: x, row: r };
    return null;
  };
  const movable = (item: T, row: ShelfRow<T>) => !!options.onMove && rows.length > 1 && (options.canMove ? options.canMove(item, row) : true);

  function paint(): void {
    replace(list, ...rows.map((row) => {
      const head = el('header', { class: 'shelf-head' },
        row.medal ? renderMedal({ size: 40, name: row.label, ...row.medal }) : null,
        el('span', { class: 'shelf-title' }, el('h3', null, row.label), row.sub ? el('small', null, row.sub) : null),
        options.onAdd ? el('button', { type: 'button', class: 'shelf-add', 'aria-label': kt('Añadir en {row}', { row: row.label }), ...mark('anadir', 'Añadir en la estantería'), onclick: () => options.onAdd!(row) }, '+') : null);
      const cells = row.items.map((item) => el('div', {
        class: 'shelf-cell', role: 'listitem',
        dataset: { shelfKey: options.key(item), shelfDrag: movable(item, row) ? '1' : '0' },
        'aria-keyshortcuts': movable(item, row) ? 'Alt+ArrowUp Alt+ArrowDown' : null,
      }, options.tile(item, row)));
      return el('section', { class: 'shelf-row', 'aria-label': row.label, dataset: { shelfRow: row.key } }, head,
        el('div', { class: 'shelf-grid', role: 'list' }, ...(cells.length ? cells : [el('p', { class: 'shelf-empty' }, row.empty ?? kt('Vacía. Arrastra aquí.'))])));
    }));
  }

  function moveTo(item: T, rowKey: string): boolean {
    const from = rowOf(item);
    const to = rows.find((r) => r.key === rowKey) ?? null;
    if (!from || !to || from === to || !movable(item, from)) return false;
    const k = options.key(item);
    const nextFrom = { ...from, items: from.items.filter((x) => options.key(x) !== k) };
    const nextTo = { ...to, items: [...to.items, item] };
    rows = rows.map((r) => (r === from ? nextFrom : r === to ? nextTo : r));
    paint();
    live.textContent = kt('{name}: movido a {row}.', { name: options.name(item), row: to.label });
    void options.onMove!(item, from, to);
    return true;
  }

  function moveTargets(item: T): ShelfRow<T>[] {
    const from = rowOf(item);
    return from && movable(item, from) ? rows.filter((r) => r !== from) : [];
  }

  function moveSheet(item: T): Sheet | null {
    const targets = moveTargets(item);
    if (!targets.length) return null;
    const sheet = openSheet({
      title: kt('Mover {name} a otra {noun}', { name: options.name(item), noun }),
      body: el('div', { class: 'shelf-menu', role: 'group', 'aria-label': kt('Mover a') }, ...targets.map((r) => el('button', {
        type: 'button', class: 'ghost shelf-target', ...mark('mover', 'Mover a otra estantería'),
        onclick: () => { void sheet.close(true).then(() => { if (moveTo(item, r.key)) refocus(options.key(item), null); }); },
      }, r.label))),
    });
    return sheet;
  }

  /** Tras mover, el foco sigue en la baldosa (en su nueva fila), en el mismo mando si lo hay. */
  function refocus(key: string, cls: string | null): void {
    const cell = [...list.querySelectorAll<HTMLElement>('.shelf-cell')].find((c) => c.dataset.shelfKey === key);
    if (!cell) return;
    const target = (cls ? cell.querySelector<HTMLElement>(`.${cls}`) : null) ?? cell.querySelector<HTMLElement>('button:not([disabled]), [tabindex="0"]');
    target?.focus({ preventScroll: false });
  }

  // Teclado: Alt+↑ / Alt+↓ a la fila de al lado.
  element.addEventListener('keydown', (e) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const cell = (e.target as HTMLElement).closest<HTMLElement>('.shelf-cell');
    if (!cell || cell.dataset.shelfDrag !== '1') return;
    const found = findItem(cell.dataset.shelfKey!);
    if (!found) return;
    const at = rows.indexOf(found.row) + (e.key === 'ArrowUp' ? -1 : 1);
    e.preventDefault();
    if (at < 0 || at >= rows.length) { live.textContent = kt('{name} ya está en la primera o la última.', { name: options.name(found.item) }); return; }
    const cls = (e.target as HTMLElement).classList[0] ?? null;
    if (moveTo(found.item, rows[at]!.key)) refocus(cell.dataset.shelfKey!, cls);
  });

  // Puntero: arrastre entre filas.
  interface Grab { cell: HTMLElement; key: string; x: number; y: number; id: number; type: string; timer: number; drag: boolean; moved: boolean; ghost: HTMLElement | null; off: { x: number; y: number }; auto: number; vy: number }
  let g: Grab | null = null;
  let swallow = false;
  const blockTouch = (e: TouchEvent) => { if (g?.drag) e.preventDefault(); };
  const targetRow = (x: number, y: number) => {
    const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>('.shelf-row');
    return hit && element.contains(hit) ? hit : null;
  };
  function lift(): void {
    if (!g) return;
    const r = g.cell.getBoundingClientRect();
    const ghost = g.cell.cloneNode(true) as HTMLElement;
    ghost.classList.add('shelf-ghost');
    ghost.removeAttribute('role');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    Object.assign(ghost.style, { width: `${r.width}px`, height: `${r.height}px`, left: `${r.left}px`, top: `${r.top}px` });
    g.off = { x: g.x - r.left, y: g.y - r.top };
    element.appendChild(ghost);
    g.ghost = ghost;
    g.drag = true;
    g.cell.classList.add('shelf-lifted');
    element.classList.add('shelf-dragging');
    try { g.cell.setPointerCapture(g.id); } catch { /* sin captura, sigue con los eventos del documento */ }
    document.addEventListener('touchmove', blockTouch, { passive: false, capture: true });
    navigator.vibrate?.(15);
  }
  function end(e: PointerEvent | null, cancel: boolean): void {
    if (!g || (e && e.pointerId !== g.id)) return;
    const d = g;
    g = null;
    clearTimeout(d.timer);
    clearInterval(d.auto);
    document.removeEventListener('touchmove', blockTouch, { capture: true } as EventListenerOptions);
    element.classList.remove('shelf-dragging');
    element.querySelectorAll('.shelf-over').forEach((x) => x.classList.remove('shelf-over'));
    d.cell.classList.remove('shelf-lifted');
    d.ghost?.remove();
    if (cancel || !d.drag || !e) return;
    if (d.moved) {
      // La baldosa no hace su pulsación larga ni su clic tras un arrastre.
      d.cell.dataset.shelfMoved = '1';
      setTimeout(() => { delete d.cell.dataset.shelfMoved; }, 0);
      swallow = true;
      setTimeout(() => { swallow = false; }, 400);
      const t = targetRow(e.clientX, e.clientY);
      const found = findItem(d.key);
      if (t && found && t.dataset.shelfRow !== found.row.key) moveTo(found.item, t.dataset.shelfRow!);
    }
  }
  element.addEventListener('pointerdown', (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('.shelf-cell');
    if (!cell || cell.dataset.shelfDrag !== '1' || e.button > 0 || !e.isPrimary) return;
    g = { cell, key: cell.dataset.shelfKey!, x: e.clientX, y: e.clientY, id: e.pointerId, type: e.pointerType, timer: 0, drag: false, moved: false, ghost: null, off: { x: 0, y: 0 }, auto: 0, vy: 0 };
    if (e.pointerType !== 'mouse') g.timer = window.setTimeout(() => { if (g && !g.drag) lift(); }, LONG_MS);
  }, true);
  const onMove = (e: PointerEvent) => {
    if (!g || e.pointerId !== g.id) return;
    const dist = Math.hypot(e.clientX - g.x, e.clientY - g.y);
    if (!g.drag) {
      if (dist < 8) return;
      // Con el dedo, moverse antes de la pulsación larga es desplazar la página.
      if (g.type !== 'mouse') { clearTimeout(g.timer); g = null; return; }
      lift();
    }
    e.preventDefault();
    if (dist >= 8) g.moved = true;
    if (g.ghost) { g.ghost.style.left = `${e.clientX - g.off.x}px`; g.ghost.style.top = `${e.clientY - g.off.y}px`; }
    const t = targetRow(e.clientX, e.clientY);
    const from = g.cell.closest<HTMLElement>('.shelf-row');
    element.querySelectorAll('.shelf-over').forEach((x) => { if (x !== t) x.classList.remove('shelf-over'); });
    if (t && t !== from) t.classList.add('shelf-over');
    g.vy = e.clientY < 70 ? -12 : e.clientY > innerHeight - 110 ? 12 : 0;
    if (g.vy && !g.auto) g.auto = window.setInterval(() => { if (g?.vy) scrollBy(0, g.vy); }, 16);
  };
  const onUp = (e: PointerEvent) => end(e, false);
  const onCancel = (e: PointerEvent) => end(e, true);
  document.addEventListener('pointermove', onMove, { capture: true, passive: false });
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', onCancel, true);
  element.addEventListener('click', (e) => { if (swallow) { swallow = false; e.preventDefault(); e.stopPropagation(); } }, true);

  paint();
  return {
    element,
    setRows(next) { rows = next.slice(); paint(); },
    getRows: () => rows.slice(),
    moveTargets,
    moveTo,
    moveSheet,
    destroy() {
      end(null, true);
      document.removeEventListener('pointermove', onMove, { capture: true } as EventListenerOptions);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onCancel, true);
      element.remove();
    },
  };
}
