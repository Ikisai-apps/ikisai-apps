/**
 * Lo de ahora abierto, el resto plegado (MUELA-075, pieza 22: Guests y Food): lo que está pasando en grande, con su
 * barra y «Quedan 1 h 30 min»; lo siguiente en una tarjeta; y el resto del día plegado en `<details>`, con lo hecho
 * escondido tras «Ver lo ya hecho (N)». Qué está «ahora», el avance y los textos de tiempo los calcula la app (la
 * regla de «sin hora de fin» es suya); aquí solo se pintan.
 * Prefijo de clases: `now-`.
 */
import { el, replace, type Child } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';
import { renderMedal, type MedalOptions } from './medal.ts';

export interface NowBlock {
  /** Encima del título («Ahora · 12:00–13:30», «Lo siguiente · en 2 h»). */
  label: string;
  title: string;
  image?: string | null;
  medal?: MedalOptions | null;
  /** Avance de 0 a 1 (solo en lo de ahora). */
  progress?: number | null;
  /** «Quedan 1 h 30 min». */
  left?: string | null;
  /** Lo demás (lugar, enlaces, nota). */
  body?: Child;
}

export interface NowRow {
  id: string;
  /** Hora ya escrita («17:00»). */
  time: string;
  title: string;
  medal?: MedalOptions | null;
  /** `done` va a «lo ya hecho». */
  state: 'later' | 'done';
  /** Lo que se lee al lado («Más tarde», «Hecho»); por defecto esas dos. */
  stateText?: string;
  /** Al abrir la fila. */
  body?: () => Child;
}

export interface NowOptions {
  now?: NowBlock | null;
  next?: NowBlock | null;
  /** Título de la lista («Hoy, más tarde»). */
  restTitle?: string;
  rest: NowRow[];
  /** Enseñar lo hecho al empezar (no). */
  showDone?: boolean;
  emptyText?: string;
  feedbackId?: string;
}

const pct = (n: number | null | undefined) => Math.round(Math.max(0, Math.min(1, n ?? 0)) * 100);
const bg = (image: string | null | undefined) => (image ? `--now-image:url("${String(image).replace(/["\\]/g, '')}")` : null);

export function renderNow(options: NowOptions): HTMLElement {
  const base = options.feedbackId;
  let showDone = !!options.showDone;
  const block = (b: NowBlock, kind: 'now' | 'next') => el('section', {
    class: `now-${kind === 'now' ? 'hero' : 'next'}${b.image ? ' now-has-image' : ''}`, style: bg(b.image), 'aria-label': kind === 'now' ? kt('Ahora') : kt('Lo siguiente'),
  },
  el('p', { class: 'now-label' }, b.label),
  el('div', { class: 'now-titlerow' }, b.medal && !b.image ? renderMedal({ size: kind === 'now' ? 56 : 44, name: b.title, ...b.medal }) : null, el(kind === 'now' ? 'h2' : 'h3', { class: 'now-title' }, b.title)),
  kind === 'now' && b.progress != null ? el('div', { class: 'now-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct(b.progress)), 'aria-label': kt('Avance') }, el('span', { style: `width:${pct(b.progress)}%` })) : null,
  b.left ? el('p', { class: 'now-left' }, b.left) : null,
  b.body ?? null);

  const later = options.rest.filter((r) => r.state !== 'done');
  const done = options.rest.filter((r) => r.state === 'done');
  const list = el('ol', { class: 'now-board' });
  const toggle = el('button', { type: 'button', class: 'linkbtn now-toggle', ...(base ? { 'data-feedback-id': `${base}.hecho`, 'data-feedback-label': 'Ver lo ya hecho' } : {}), onclick: () => { showDone = !showDone; paint(); } });
  const row = (r: NowRow) => {
    const body = el('div', { class: 'now-fold-body' });
    const fold = el('details', { class: 'now-fold', dataset: { id: r.id, state: r.state } },
      el('summary', null,
        el('span', { class: 'now-time' }, r.time),
        r.medal ? renderMedal({ size: 40, name: r.title, ...r.medal }) : null,
        el('span', { class: 'now-fold-title' }, r.title),
        el('span', { class: 'now-state' }, r.stateText ?? (r.state === 'done' ? kt('Hecho') : kt('Más tarde')))),
      body);
    // Lo de dentro se pinta al abrir (puede llevar un plano o una imagen).
    if (r.body) fold.addEventListener('toggle', () => { if (fold.open && !body.childNodes.length) replace(body, r.body!()); });
    return el('li', { class: 'now-slot' }, fold);
  };
  function paint(): void {
    replace(list, ...(showDone ? [...done, ...later] : later).map(row));
    toggle.hidden = !done.length;
    toggle.textContent = showDone ? kt('Ocultar lo ya hecho') : kt('Ver lo ya hecho ({n})', { n: String(done.length) });
    toggle.setAttribute('aria-expanded', String(showDone));
  }
  paint();
  const nothing = !options.now && !options.next && !options.rest.length;
  return el('div', { class: 'now-box', ...(base ? { 'data-feedback-id': base, 'data-feedback-label': 'Lo de ahora' } : {}) },
    options.now ? block(options.now, 'now') : null,
    options.next ? block(options.next, 'next') : null,
    options.rest.length ? el('div', { class: 'now-boardhead' }, el('h3', null, options.restTitle ?? kt('Más tarde')), toggle) : null,
    options.rest.length ? list : null,
    nothing ? el('p', { class: 'hint now-empty' }, options.emptyText ?? kt('Nada programado.')) : null);
}
