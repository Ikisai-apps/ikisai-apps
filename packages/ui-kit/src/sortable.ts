/**
 * Lista reordenable: arrastre con el asa (ratón o pulsación mantenida en táctil), botones «Subir»/«Bajar» y teclado
 * (flechas, Inicio y Fin sobre el asa), con anuncio para lectores de pantalla. Pensada para platos, servicios y pasos de
 * preparación de Food, y para tareas y proyectos de Tasks. El componente solo reordena en pantalla y avisa; la app
 * guarda `position` (contrato §2.1, `numeric`) con `positionBetween`. Se puede anidar (platos dentro de servicios):
 * cada lista solo mira sus filas y asas hijas directas (`:scope > …`).
 *
 * Si la app repinta la lista desde su espejo tras cada `onReorder`, conviene pasar las filas nuevas con `setItems`
 * en vez de crear otra lista: así los movimientos seguidos (teclado, botones) usan siempre filas al día (revisiones).
 */
import { el, replace } from './dom.ts';
import { icon } from './icons.ts';

export interface SortableOptions<T> {
  items: T[];
  key: (item: T) => string;
  /** Contenido de la fila (sin el asa ni los botones, que pone el componente). */
  render: (item: T, index: number) => Node | string;
  /** Nombre que se anuncia y se usa en las etiquetas accesibles. */
  name?: (item: T) => string;
  /** Se llama con el nuevo orden tras cada movimiento. */
  onReorder: (items: T[], move: { item: T; from: number; to: number }) => void | Promise<void>;
  /** Nombre accesible de la lista. */
  label: string;
  /** Botones subir/bajar visibles; por defecto sí. */
  buttons?: boolean;
  disabled?: boolean;
  id?: string;
  /** Clase extra para cada fila. */
  rowClass?: string;
}

export interface Sortable<T> {
  element: HTMLElement;
  setItems(items: T[]): void;
  getItems(): T[];
  setDisabled(disabled: boolean): void;
  destroy(): void;
}

/** Valor de `position` para colocar una fila entre `prev` y `next` (cualquiera puede faltar). */
export function positionBetween(prev: number | null | undefined, next: number | null | undefined, step = 1024): number {
  if (prev == null && next == null) return step;
  if (prev == null) return next! - step;
  if (next == null) return prev + step;
  return (prev + next) / 2;
}

/** Posiciones nuevas para toda la lista (renumeración con paso fijo), por si las intermedias se agotan. */
export function renumber(count: number, step = 1024): number[] {
  return Array.from({ length: count }, (_, i) => (i + 1) * step);
}

function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

export function createSortableList<T>(options: SortableOptions<T>): Sortable<T> {
  let items = options.items.slice();
  let disabled = !!options.disabled;
  const name = options.name ?? ((item: T) => String(options.key(item)));
  const live = el('div', { class: 'vh', 'aria-live': 'polite' });
  const list = el('ul', { class: 'list sortable', id: options.id ?? null, 'aria-label': options.label, role: 'list' });
  const element = el('div', { class: 'sortable-wrap' }, list, live);
  let busy = false;

  async function commit(from: number, to: number): Promise<void> {
    if (from === to || to < 0 || to >= items.length || busy) return;
    busy = true;
    const item = items[from]!;
    items = moveItem(items, from, to);
    paint();
    live.textContent = `${name(item)}, posición ${to + 1} de ${items.length}.`;
    focusHandle(to);
    try {
      await options.onReorder(items.slice(), { item, from, to });
    } finally {
      busy = false;
    }
  }

  function focusHandle(index: number): void {
    const handle = list.querySelectorAll<HTMLElement>(':scope > .sortable-row > .sortable-handle')[index];
    handle?.focus({ preventScroll: true });
  }

  function row(item: T, index: number): HTMLElement {
    const label = name(item);
    const handle = el('button', {
      class: 'sortable-handle', type: 'button', disabled, 'aria-label': `Mover ${label}. Posición ${index + 1} de ${items.length}. Flechas para mover, arrastrar con el ratón.`,
      title: 'Arrastrar o usar las flechas',
      onkeydown: (e: Event) => onKey(e as KeyboardEvent, index),
      onpointerdown: (e: Event) => onPointerDown(e as PointerEvent, index),
    }, icon('grip', 18));
    const up = options.buttons === false ? null : el('button', { class: 'iconbtn small sortable-move', type: 'button', disabled: disabled || index === 0, 'aria-label': `Subir ${label}`, onclick: () => void commit(index, index - 1) }, icon('chevronUp', 16));
    const down = options.buttons === false ? null : el('button', { class: 'iconbtn small sortable-move', type: 'button', disabled: disabled || index === items.length - 1, 'aria-label': `Bajar ${label}`, onclick: () => void commit(index, index + 1) }, icon('chevronDown', 16));
    return el('li', { class: `row sortable-row${options.rowClass ? ' ' + options.rowClass : ''}`, dataset: { key: options.key(item), index: String(index) } },
      handle,
      el('div', { class: 'sortable-body' }, options.render(item, index)),
      up || down ? el('div', { class: 'sortable-moves' }, up, down) : null,
    );
  }

  function paint(): void {
    // Si el foco estaba en un asa (teclado), se conserva en la misma posición tras repintar.
    const active = document.activeElement as HTMLElement | null;
    const focused = active?.classList.contains('sortable-handle') && active.parentElement?.parentElement === list ? Number(active.closest<HTMLElement>('.sortable-row')?.dataset.index ?? -1) : -1;
    replace(list, ...items.map(row));
    if (focused >= 0) focusHandle(Math.min(focused, items.length - 1));
  }

  function onKey(e: KeyboardEvent, index: number): void {
    if (disabled) return;
    const moves: Record<string, number> = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: items.length - 1 };
    if (!(e.key in moves)) return;
    e.preventDefault();
    void commit(index, Math.max(0, Math.min(items.length - 1, moves[e.key]!)));
  }

  // --- Arrastre ---------------------------------------------------------------
  function onPointerDown(e: PointerEvent, index: number): void {
    if (disabled || e.button !== 0) return;
    const handle = e.currentTarget as HTMLElement;
    const rowEl = handle.closest<HTMLElement>('.sortable-row')!;
    const touchy = e.pointerType === 'touch';
    const d = { x: e.clientX, y: e.clientY, started: false, hold: !touchy, target: index, after: false, ghost: null as HTMLElement | null, timer: null as ReturnType<typeof setTimeout> | null };
    const start = () => {
      if (d.started) return;
      d.started = true;
      handle.setPointerCapture(e.pointerId);
      rowEl.classList.add('lifting');
      const g = rowEl.cloneNode(true) as HTMLElement;
      g.classList.add('sortable-ghost');
      g.classList.remove('lifting');
      g.style.width = `${rowEl.offsetWidth}px`;
      g.style.left = `${rowEl.getBoundingClientRect().left}px`;
      g.style.top = `${d.y - 20}px`;
      document.body.append(g);
      d.ghost = g;
      document.body.classList.add('dragging');
    };
    if (touchy) d.timer = setTimeout(() => { d.hold = true; start(); }, 320);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - d.x, dy = ev.clientY - d.y;
      if (!d.started) {
        if (!d.hold) { if (Math.hypot(dx, dy) > 8) { cleanup(); } return; }
        if (Math.hypot(dx, dy) > 6) start();
        if (!d.started) return;
      }
      ev.preventDefault();
      if (d.ghost) d.ghost.style.top = `${ev.clientY - 20}px`;
      const rows = Array.from(list.querySelectorAll<HTMLElement>(':scope > .sortable-row'));
      let target = index, after = false;
      for (let i = 0; i < rows.length; i += 1) {
        const r = rows[i]!.getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) { target = i; after = false; break; }
        target = i; after = true;
      }
      rows.forEach((r, i) => { r.classList.toggle('drop-before', i === target && !after && i !== index); r.classList.toggle('drop-after', i === target && after && i !== index); });
      d.target = target; d.after = after;
      const margin = 48;
      if (ev.clientY < margin) window.scrollBy(0, -10);
      else if (ev.clientY > window.innerHeight - margin) window.scrollBy(0, 10);
    };
    const cleanup = () => {
      if (d.timer) clearTimeout(d.timer);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      rowEl.classList.remove('lifting');
      d.ghost?.remove();
      document.body.classList.remove('dragging');
      list.querySelectorAll(':scope > .sortable-row').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
    };
    const end = () => {
      const started = d.started;
      let to = d.after ? d.target + 1 : d.target;
      cleanup();
      if (!started) return;
      if (to > index) to -= 1;
      void commit(index, to);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  paint();
  return {
    element,
    setItems(next) { items = next.slice(); paint(); },
    getItems: () => items.slice(),
    setDisabled(next) { disabled = next; paint(); },
    destroy() { element.remove(); },
  };
}
