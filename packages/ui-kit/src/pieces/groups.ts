/**
 * Grupos con resumen de lo peor (MUELA-075, piezas 3 y 24): un grupo por tipo, proveedor o etapa, con medallón, recuento
 * y el resumen escrito («1 vencida · 1 vence pronto»). El borde sigue a lo peor que contiene (alert > warn > ok).
 * - El tono de cada cosa y el orden de los grupos los da la app; `worstFirst` solo sube los que piden algo.
 * - Grupos por etapa con la acción en la fila (pieza 24): `open` en el grupo que toca y la fila la pinta la app
 *   (`listRow` con `actions`).
 * - `chips`: filtrar a un toque por lo peor de cada grupo.
 * Prefijo de clases: `worst-`.
 */
import { el, replace, type Child } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';
import { renderMedal, type MedalOptions } from './medal.ts';

export type Tone = 'alert' | 'warn' | 'ok';
const RANK: Record<Tone, number> = { alert: 3, warn: 2, ok: 1 };

/** Lo peor de una lista de tonos: `alert` > `warn` > `ok`; `null` si no hay ninguno. */
export function worstOf(tones: Iterable<Tone | null | undefined>): Tone | null {
  let worst: Tone | null = null;
  for (const t of tones) if (t && (!worst || RANK[t] > RANK[worst])) worst = t;
  return worst;
}

export interface Group<T> {
  key: string;
  title: string;
  medal?: MedalOptions | Node | null;
  items: T[];
  /** Resumen escrito; por defecto, cuántos hay de cada tono («1 con alerta · 2 con aviso» o «Todo en orden»). */
  summary?: string | null;
  /** Abierto al pintar; por defecto, los que tienen alerta o aviso. */
  open?: boolean;
  /** Botones en la cabecera del grupo (p. ej. «+»). */
  actions?: Child[];
}

export interface GroupsOptions<T> {
  label: string;
  groups: Group<T>[];
  /** Tono de cada cosa; lo calcula la app (vencida, vence pronto…). */
  toneOf?: (item: T) => Tone | null | undefined;
  /** La fila de cada cosa (la pinta la app, p. ej. con `listRow`). */
  row: (item: T) => Node;
  /** Primero los grupos con algo que pedir (por lo peor), sin cambiar el orden dentro de cada tono. */
  worstFirst?: boolean;
  /** Chips para filtrar los grupos por lo peor que tienen. */
  chips?: boolean;
  emptyText?: string;
  feedbackId?: string;
}

export interface GroupsView {
  element: HTMLElement;
  /** Filtro de los chips: `null` = todos. */
  setFilter(tone: Tone | null): void;
}

function defaultSummary(tones: (Tone | null | undefined)[]): string {
  const alert = tones.filter((t) => t === 'alert').length;
  const warn = tones.filter((t) => t === 'warn').length;
  const parts = [
    alert ? kt(alert === 1 ? '1 con alerta' : '{n} con alerta', { n: String(alert) }) : null,
    warn ? kt(warn === 1 ? '1 con aviso' : '{n} con aviso', { n: String(warn) }) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : kt('Todo en orden');
}

const TONE_WORD: Record<Tone, string> = { alert: 'Con alerta', warn: 'Con aviso', ok: 'En orden' };

export function renderGroups<T>(options: GroupsOptions<T>): GroupsView {
  const base = options.feedbackId;
  const mark = (suffix: string, label: string) => (base ? { 'data-feedback-id': `${base}.${suffix}`, 'data-feedback-label': label } : {});
  const info = options.groups.map((g, i) => {
    const tones = g.items.map((item) => options.toneOf?.(item) ?? null);
    return { g, i, tones, worst: worstOf(tones) };
  });
  const ordered = options.worstFirst ? [...info].sort((a, b) => (b.worst ? RANK[b.worst] : 0) - (a.worst ? RANK[a.worst] : 0) || a.i - b.i) : info;
  let filter: Tone | null = null;

  const list = el('ul', { class: 'worst-groups', 'aria-label': options.label, ...(base ? { 'data-feedback-id': base, 'data-feedback-label': options.label } : {}) },
    ...ordered.map(({ g, tones, worst }) => {
      const summary = g.summary ?? defaultSummary(tones);
      const medal = g.medal ? (g.medal instanceof Node ? g.medal : renderMedal({ size: 40, name: g.title, ...g.medal })) : null;
      const open = g.open ?? (worst === 'alert' || worst === 'warn');
      return el('li', { class: 'worst-group', dataset: { group: g.key, tone: worst ?? 'none' } }, el('details', { open },
        el('summary', { class: 'worst-head', ...mark('grupo', 'Abrir el grupo') },
          medal,
          el('span', { class: 'worst-title' }, el('strong', null, g.title), el('span', { class: 'worst-count' }, String(g.items.length))),
          el('span', { class: `worst-summary${worst ? ` worst-${worst}` : ''}` }, summary),
          ...(g.actions ?? [])),
        g.items.length
          ? el('ul', { class: 'list worst-items' }, ...g.items.map((item) => { const r = options.row(item); return r instanceof HTMLLIElement ? r : el('li', null, r); }))
          : el('p', { class: 'hint worst-empty' }, options.emptyText ?? kt('Nada en este grupo.'))));
    }));

  const counts = (tone: Tone) => info.filter((x) => x.worst === tone).length;
  const chips = options.chips ? el('div', { class: 'chips worst-chips', role: 'group', 'aria-label': kt('Filtrar {label}', { label: options.label.toLocaleLowerCase() }) }) : null;
  function paintChips(): void {
    if (!chips) return;
    const chip = (tone: Tone | null, text: string) => el('button', { type: 'button', class: 'filterchip', 'aria-pressed': String(filter === tone), ...mark('filtro', 'Filtro de grupos'), onclick: () => setFilter(filter === tone ? null : tone) }, text);
    replace(chips, chip(null, kt('Todos ({n})', { n: String(info.length) })),
      ...(['alert', 'warn'] as Tone[]).filter((t) => counts(t)).map((t) => chip(t, `${kt(TONE_WORD[t])} (${counts(t)})`)));
  }
  function setFilter(tone: Tone | null): void {
    filter = tone;
    for (const node of list.querySelectorAll<HTMLElement>('.worst-group')) node.hidden = !!tone && node.dataset.tone !== tone;
    paintChips();
  }
  paintChips();
  return { element: el('section', { class: 'worst-box' }, chips, list), setFilter };
}
