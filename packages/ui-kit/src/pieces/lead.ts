/**
 * Lo primero en grande (MUELA-075, pieza 25: Tasks, Booking y Food): las tres más urgentes en tarjetas grandes
 * (número, dónde, título, plazo, quién y acciones) y el resto en una cola numerada desde el 4 con su barra de urgencia.
 * La urgencia y el orden los calcula la app (`priorityOf`, plazos…); aquí solo se pintan, ya ordenados.
 * - Móvil: las tarjetas en un carril que se pasa con el dedo (encaje). Desde 900 px, tres columnas.
 * - La cola enseña `max` filas y «Ver N más» / «Ver menos».
 * Prefijo de clases: `lead-`.
 */
import { el, replace, type Child } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';
import { itemColorStyle } from '../theme.ts';
import { renderMedal, type MedalOptions } from './medal.ts';

export interface LeadItem {
  id: string;
  title: string;
  /** Dónde («Huerta · Exterior»). */
  where?: string | null;
  /** Plazo ya escrito («Vencida hace 2 días», «Hoy, 19:00»). */
  due?: string | null;
  tone?: 'alert' | 'warn' | null;
  image?: string | null;
  color?: string | null;
  who?: (MedalOptions & { name: string }) | null;
  /** Medallón de la fila en la cola (p. ej. el del proyecto). */
  medal?: MedalOptions | null;
  /** Urgencia relativa (0–1) para la barra de la cola. */
  weight?: number | null;
}

export interface LeadOptions {
  /** Título del bloque («Lo primero»). */
  title?: string;
  items: LeadItem[];
  /** Cuántas en grande (3). */
  top?: number;
  /** Filas visibles de la cola antes de «Ver N más» (5). */
  max?: number;
  onDone?: (item: LeadItem) => void;
  onOpen?: (item: LeadItem) => void;
  /** Acciones extra de cada una (p. ej. «⋯» para mover de día). */
  extra?: (item: LeadItem) => Child[];
  emptyText?: string;
  feedbackId?: string;
}

export function renderLead(options: LeadOptions): HTMLElement {
  const top = options.top ?? 3;
  const max = options.max ?? 5;
  const base = options.feedbackId;
  const mark = (suffix: string, label: string) => (base ? { 'data-feedback-id': `${base}.${suffix}`, 'data-feedback-label': label } : {});
  const first = options.items.slice(0, top);
  const rest = options.items.slice(top);
  const title = options.title ?? kt('Lo primero');
  let open = false;

  const actions = (item: LeadItem): Child[] => [
    options.onDone ? el('button', { type: 'button', class: 'primary lead-btn', role: 'checkbox', 'aria-checked': 'false', 'aria-label': kt('Marcar hecha: {title}', { title: item.title }), ...mark('hecha', 'Marcar hecha'), onclick: () => options.onDone!(item) }, kt('✓ Hecha')) : null,
    options.onOpen ? el('button', { type: 'button', class: 'ghost lead-btn', 'aria-label': kt('Abrir {title}', { title: item.title }), ...mark('abrir', 'Abrir'), onclick: () => options.onOpen!(item) }, kt('Abrir')) : null,
    ...(options.extra?.(item) ?? []),
  ];

  const card = (item: LeadItem, rank: number) => el('article', {
    class: `lead-card${item.image ? ' lead-has-image' : ''}`, dataset: { id: item.id, tone: item.tone ?? 'none' },
    style: [item.image ? `--lead-image:url("${String(item.image).replace(/["\\]/g, '')}")` : '', itemColorStyle(item.color ?? null)].filter(Boolean).join(';'),
  },
  el('span', { class: 'lead-rank', 'aria-hidden': 'true' }, String(rank)),
  item.where ? el('span', { class: 'lead-where' }, item.where) : null,
  el('h3', { class: 'lead-title' }, el('span', { class: 'vh' }, `${rank}. `), item.title),
  item.due ? el('span', { class: 'lead-due' }, item.due) : null,
  el('div', { class: 'lead-actions' }, item.who ? el('span', { class: 'lead-who', title: item.who.name }, renderMedal({ size: 30, ...item.who, label: item.who.name })) : null, ...actions(item)));

  const line = (item: LeadItem, rank: number) => el('li', { class: 'lead-line', dataset: { id: item.id, tone: item.tone ?? 'none' }, style: `--lead-weight:${Math.max(0.04, Math.min(1, item.weight ?? 0))}` },
    el('span', { class: 'lead-num', 'aria-hidden': 'true' }, String(rank)),
    item.medal ? renderMedal({ size: 32, name: item.title, ...item.medal }) : null,
    el('span', { class: 'lead-line-text' }, el('strong', null, el('span', { class: 'vh' }, `${rank}. `), item.title),
      [item.where, item.due].some(Boolean) ? el('span', { class: 'lead-line-meta' }, [item.where, item.due].filter(Boolean).join(' · ')) : null),
    el('span', { class: 'lead-line-actions' }, ...actions(item)));

  const queue = el('ol', { class: 'lead-queue', start: String(top + 1) });
  const more = el('button', { type: 'button', class: 'linkbtn lead-more', ...mark('ver_mas', 'Ver más de la cola'), onclick: () => { open = !open; paintQueue(); } });
  function paintQueue(): void {
    const shown = open ? rest : rest.slice(0, max);
    replace(queue, ...shown.map((item, i) => line(item, top + 1 + i)));
    more.hidden = rest.length <= max;
    more.textContent = open ? kt('Ver menos') : kt('Ver {n} más', { n: String(rest.length - max) });
    more.setAttribute('aria-expanded', String(open));
  }
  paintQueue();

  const count = options.items.length;
  return el('section', { class: 'lead-box', 'aria-label': title, ...(base ? { 'data-feedback-id': base, 'data-feedback-label': title } : {}) },
    el('h2', { class: 'lead-head' }, title, count ? el('span', { class: 'lead-head-count' }, ` · ${count === 1 ? kt('1 pide atención') : kt('{n} piden atención', { n: String(count) })}`) : null),
    count ? el('div', { class: 'lead-rail' }, ...first.map((item, i) => card(item, i + 1))) : el('p', { class: 'hint lead-empty' }, options.emptyText ?? kt('Nada urgente.')),
    rest.length ? queue : null,
    rest.length ? more : null);
}
