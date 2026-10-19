/**
 * Paso a paso con lo siguiente en grande (MUELA-075, pieza 7: Guests, Organizers y Central): «Te quedan N cosas» con
 * su barra; la siguiente acción en grande, con su verbo y lo que tarda; el resto debajo con su estado escrito; y lo
 * hecho en una línea pequeña. Qué falta, el orden y los minutos los da la app.
 * - Cada paso es un enlace (`href`) o un botón (`onClick`) entero, de al menos 46 px.
 * - Sin pendientes: «¡Todo listo!» y, si se da, una línea más («Nos vemos el 20 de octubre»).
 * Prefijo de clases: `step-`.
 */
import { el, type Child } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';
import { icon, type IconName } from '../icons.ts';

export interface StepItem {
  id: string;
  title: string;
  done: boolean;
  /** Estado escrito («Falta la fecha de nacimiento», «Firmado»). */
  stateText?: string | null;
  /** Verbo del botón grande cuando es el siguiente («Completar tus datos»). */
  action?: string | null;
  /** «Unos 3 minutos». */
  minutes?: number | null;
  icon?: IconName | null;
  href?: string | null;
  onClick?: () => void;
  /** Id literal de feedback de este paso (entra en el catálogo). Sin él, el paso no se marca. */
  feedbackId?: string;
}

export interface StepsOptions {
  items: StepItem[];
  /** Título; por defecto «Te queda 1 cosa» / «Te quedan N cosas». */
  title?: string;
  /** Sin pendientes: la línea bajo «¡Todo listo!». */
  readyText?: string | null;
  feedbackId?: string;
}

function link(item: StepItem, cls: string, children: Child[], attrs: Record<string, string> = {}): HTMLElement {
  return item.href
    ? el('a', { class: cls, href: item.href, ...attrs }, ...children)
    : el('button', { type: 'button', class: cls, onclick: () => item.onClick?.(), ...attrs }, ...children);
}

export function renderSteps(options: StepsOptions): HTMLElement {
  const base = options.feedbackId;
  // Solo ids literales (los construidos en ejecución no entran en el catálogo de funciones).
  const byId = new Map(options.items.map((i) => [i.id, i]));
  const mark = (id: string): Record<string, string> => { const it = byId.get(id); return it?.feedbackId ? { 'data-feedback-id': it.feedbackId, 'data-feedback-label': it.title } : {}; };
  const todo = options.items.filter((i) => !i.done);
  const done = options.items.filter((i) => i.done);
  const total = options.items.length;
  const doneLine = done.length ? el('p', { class: 'step-doneline' }, el('span', { class: 'step-check', 'aria-hidden': 'true' }, '✓'), kt('Hecho:'), ' ',
    ...done.flatMap((item, i) => [i ? ' · ' : '', item.href || item.onClick ? link(item, 'step-mini', [item.title], mark(item.id)) : item.title])) : null;

  if (!todo.length) {
    return el('section', { class: 'step-box step-ready', 'aria-label': kt('¡Todo listo!') },
      el('p', { class: 'step-readytitle' }, el('span', { class: 'step-check', 'aria-hidden': 'true' }, '✓'), kt('¡Todo listo!')),
      options.readyText ? el('p', { class: 'step-readytext' }, options.readyText) : null, doneLine);
  }
  const [next, ...rest] = todo;
  const title = options.title ?? (todo.length === 1 ? kt('Te queda 1 cosa') : kt('Te quedan {n} cosas', { n: String(todo.length) }));
  const sub = [next!.stateText, next!.minutes ? (next!.minutes === 1 ? kt('Un minuto') : kt('Unos {n} minutos', { n: String(next!.minutes) })) : null].filter(Boolean).join(' · ');
  return el('section', { class: 'step-box', 'aria-label': title, ...(base ? { 'data-feedback-id': base, 'data-feedback-label': title } : {}) },
    el('div', { class: 'step-head' },
      el('h3', null, title),
      el('span', { class: 'chip step-count' }, kt('{n} de {m} listas', { n: String(done.length), m: String(total) }))),
    el('div', { class: 'step-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done.length), 'aria-label': kt('{n} de {m} listas', { n: String(done.length), m: String(total) }) },
      el('span', { style: `width:${total ? Math.round((done.length / total) * 100) : 0}%` })),
    link(next!, 'step-next', [
      el('span', { class: 'step-icon', 'aria-hidden': 'true' }, next!.icon ? icon(next!.icon, 22) : '→'),
      el('span', { class: 'step-nexttext' },
        el('span', { class: 'step-label' }, kt('Lo siguiente')),
        el('strong', null, next!.title),
        sub ? el('small', null, sub) : null),
      el('span', { class: 'step-go', 'aria-hidden': 'true' }, next!.action ?? kt('Empezar'), ' ›'),
    ], { ...mark(next!.id), 'aria-label': `${next!.action ?? next!.title}${sub ? `. ${sub}` : ''}` }),
    rest.length ? el('ul', { class: 'step-rest' }, ...rest.map((item) => el('li', null, link(item, 'step-row', [
      item.icon ? el('span', { class: 'step-icon small', 'aria-hidden': 'true' }, icon(item.icon, 18)) : null,
      el('span', { class: 'step-rowtext' }, el('strong', null, item.title), item.stateText ? el('small', null, item.stateText) : null),
      el('span', { class: 'step-chev', 'aria-hidden': 'true' }, '›'),
    ], mark(item.id))))) : null,
    doneLine);
}
