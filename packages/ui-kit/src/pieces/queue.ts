/**
 * Una cosa cada vez (MUELA-075, pieza 10: Central y Finance; «Una propuesta cada vez» es la misma mecánica): «1 de N»
 * con una barra de un segmento por cosa, coloreado por gravedad; una tarjeta grande con franja y etiqueta de gravedad,
 * medallón, una cifra grande y 2–4 datos; la acción «… y siguiente» y «Saltar»; debajo «n más · Ver todo»; al acabar,
 * «Has pasado por todo». La cola ya viene ordenada por la app (`centralAttention`, `computeDue`…: suyos).
 * - La acción principal mide 54 px; «Abrir la ficha», «Saltar» y «Ver todo», 46 px.
 * - Al hacer la acción, la app decide y llama a `done()`; «Deshacer» (con `toastWithAction`) llama a `undo()`.
 * - Sin acción principal (lector), solo se pasa y se abre; `readOnlyText` dice por qué.
 * - La tarjeta sale de lado al pasar, salvo con movimiento reducido.
 * Prefijo de clases: `queue-`.
 */
import { el, replace, type Child } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';
import { renderMedal, type MedalOptions } from './medal.ts';

export interface QueueItem {
  id: string;
  title: string;
  /** Gravedad: franja, segmento de la barra y etiqueta. */
  tone?: 'alert' | 'warn' | 'ok' | null;
  /** Etiqueta escrita de la gravedad («Vence hoy», «Lista para confirmar»). */
  toneText?: string | null;
  medal?: MedalOptions | null;
  /** Cifra grande («1.240,00 €», «3 días»). */
  value?: string | null;
  /** 2–4 datos cortos. */
  facts?: string[];
  /** Lo demás (documento, explicación, chips). */
  body?: Child;
}

export interface QueueAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export interface QueueOptions {
  label: string;
  items: QueueItem[];
  /** Acción principal de cada cosa («Confirmar y siguiente»). Sin ella, es de solo lectura. */
  primary?: (item: QueueItem) => QueueAction | null;
  /** Otra acción menor («Ver el desglose»). */
  secondary?: (item: QueueItem) => QueueAction | null;
  onOpen?: (item: QueueItem) => void;
  /** «Ver todo»: la lista completa. */
  onAll?: () => void;
  readOnlyText?: string;
  doneTitle?: string;
  doneText?: string;
  /** Lo que se ofrece al acabar (botones de la app). */
  doneActions?: Child[];
  feedbackId?: string;
}

export interface Queue {
  element: HTMLElement;
  /** La actual ya está hecha: pasa a la siguiente (sale a la derecha). */
  done(): void;
  /** Saltar sin hacerla (sale a la izquierda; vuelve al final). */
  skip(): void;
  /** Deshace el último `done()`: la vuelve a poner delante. */
  undo(): void;
  setItems(items: QueueItem[]): void;
  current(): QueueItem | null;
}

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createQueue(options: QueueOptions): Queue {
  let items = options.items.slice();
  let pos = 0;
  const history: { item: QueueItem; at: number }[] = [];
  const doneIds = new Set<string>();
  let total = items.length;
  const base = options.feedbackId;
  const mark = (suffix: string, label: string) => (base ? { 'data-feedback-id': `${base}.${suffix}`, 'data-feedback-label': label } : {});
  const live = el('p', { class: 'vh', 'aria-live': 'polite' });
  const element = el('section', { class: 'queue-box', 'aria-label': options.label, ...(base ? { 'data-feedback-id': base, 'data-feedback-label': options.label } : {}) });

  const pending = () => items.filter((i) => !doneIds.has(i.id));

  function card(item: QueueItem, index: number): HTMLElement {
    const primary = options.primary?.(item) ?? null;
    const secondary = options.secondary?.(item) ?? null;
    return el('article', { class: 'queue-card', dataset: { id: item.id, tone: item.tone ?? 'none' }, 'aria-label': [item.toneText, item.title, item.value].filter(Boolean).join(' · ') },
      // La posición ya está arriba («2 de 5»); en la tarjeta solo se lee.
      el('div', { class: 'queue-top' },
        item.toneText ? el('span', { class: 'queue-tone' }, item.toneText) : null,
        el('span', { class: 'vh' }, kt('{n} de {m}', { n: String(index + 1), m: String(total) }))),
      el('div', { class: 'queue-id' },
        item.medal ? renderMedal({ size: 44, name: item.title, ...item.medal }) : null,
        el('div', null, el('h3', { class: 'queue-title' }, item.title), item.value ? el('p', { class: 'queue-value' }, item.value) : null)),
      item.facts?.length ? el('ul', { class: 'queue-facts' }, ...item.facts.slice(0, 4).map((f) => el('li', null, f))) : null,
      item.body ?? null,
      el('div', { class: 'queue-actions' },
        primary ? el('button', { type: 'button', class: 'primary queue-main', disabled: !!primary.disabled, ...mark('principal', 'Acción principal'), onclick: () => primary.onClick() }, primary.label)
          : options.readOnlyText ? el('p', { class: 'hint queue-readonly' }, options.readOnlyText) : null,
        el('div', { class: 'queue-minor' },
          secondary ? el('button', { type: 'button', class: 'ghost', disabled: !!secondary.disabled, ...mark('secundaria', 'Acción secundaria'), onclick: () => secondary.onClick() }, secondary.label) : null,
          pending().length > 1 ? el('button', { type: 'button', class: 'ghost queue-skip', ...mark('saltar', 'Saltar'), onclick: () => api.skip() }, primary ? kt('Saltar') : kt('Siguiente')) : null,
          options.onOpen ? el('button', { type: 'button', class: 'ghost', ...mark('ficha', 'Abrir la ficha'), onclick: () => options.onOpen!(item) }, kt('Abrir la ficha')) : null)));
  }

  function paint(): void {
    const left = pending();
    const bar = el('div', { class: 'queue-bar', 'aria-hidden': 'true' }, ...items.map((i) => el('span', { dataset: { tone: i.tone ?? 'none', state: doneIds.has(i.id) ? 'done' : i === left[pos] ? 'here' : 'todo' } })));
    if (!left.length) {
      replace(element, bar, el('div', { class: 'queue-done' },
        el('p', { class: 'queue-donetitle' }, el('span', { class: 'step-check', 'aria-hidden': 'true' }, '✓'), options.doneTitle ?? kt('Has pasado por todo')),
        options.doneText ? el('p', { class: 'hint' }, options.doneText) : null,
        options.doneActions?.length ? el('div', { class: 'queue-minor' }, ...options.doneActions) : null), live);
      return;
    }
    pos = Math.min(pos, left.length - 1);
    const done = total - left.length;
    const more = left.length - 1;
    replace(element,
      el('div', { class: 'queue-progress' }, el('strong', null, kt('{n} de {m}', { n: String(done + 1), m: String(total) })), bar),
      card(left[pos]!, done),
      more || options.onAll ? el('p', { class: 'queue-more' },
        more ? (more === 1 ? kt('1 más') : kt('{n} más', { n: String(more) })) : '',
        options.onAll ? el('button', { type: 'button', class: 'linkbtn queue-all', ...mark('ver_todo', 'Ver todo'), onclick: () => options.onAll!() }, kt('Ver todo')) : null) : null,
      live);
  }

  function leave(dir: 'right' | 'left', then: () => void): void {
    const cardEl = element.querySelector<HTMLElement>('.queue-card');
    if (!cardEl || reduced()) { then(); return; }
    // La tarjeta que sale ya no recibe toques: un segundo toque rápido actuaba sobre ella (invisible) y se perdía.
    cardEl.inert = true;
    cardEl.querySelectorAll<HTMLButtonElement>('button').forEach((b) => { b.disabled = true; });
    cardEl.classList.add(dir === 'right' ? 'queue-gone-right' : 'queue-gone-left');
    setTimeout(then, 300);
  }

  function announce(): void {
    const left = pending();
    live.textContent = left.length ? `${kt('{n} de {m}', { n: String(total - left.length + 1), m: String(total) })}: ${left[pos]?.title ?? ''}` : (options.doneTitle ?? kt('Has pasado por todo'));
    element.querySelector<HTMLElement>('.queue-main:not([disabled]), .queue-skip, .queue-all')?.focus({ preventScroll: true });
  }

  const api: Queue = {
    element,
    done() {
      const left = pending();
      pos = Math.min(pos, Math.max(0, left.length - 1));
      const item = left[pos];
      if (!item) return;
      history.push({ item, at: pos });
      doneIds.add(item.id);
      leave('right', () => { paint(); announce(); });
    },
    skip() {
      const left = pending();
      if (left.length < 2) return;
      pos = Math.min(pos, left.length - 1);
      leave('left', () => { pos = (pos + 1) % left.length; paint(); announce(); });
    },
    undo() {
      const last = history.pop();
      if (!last) return;
      doneIds.delete(last.item.id);
      pos = pending().findIndex((i) => i.id === last.item.id);
      paint();
      announce();
    },
    setItems(next) {
      const keep = pending()[pos]?.id;
      items = next.slice();
      for (const id of [...doneIds]) if (!items.some((i) => i.id === id)) doneIds.delete(id);
      total = items.length;
      const at = keep ? pending().findIndex((i) => i.id === keep) : -1;
      pos = at >= 0 ? at : 0;
      paint();
    },
    current: () => pending()[pos] ?? null,
  };
  paint();
  return api;
}
