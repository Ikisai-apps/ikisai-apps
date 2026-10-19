/**
 * Bandeja por áreas (MUELA-075, pieza 8 / K20: Booking «Por resolver» y SES, Central, Food y Finance): las cosas
 * agrupadas por área con su recuento; una línea por cosa que se resuelve de un toque. No sabe de conflictos: la usan
 * `renderConflicts({ layout: 'tray' })` y cualquier bandeja de la app (SES agrupa por estado de la comunicación).
 * Reglas de la línea (044-ADENDA):
 * - Solo el título va al lado del medallón (44 px, decorativo), con sangría colgante.
 * - Debajo, a todo el ancho: quién y cuándo (la fecha en su propia línea), lo que choca, los chips y las acciones.
 * - Variante «rechazado», con icono. Acciones de al menos 46 px.
 * Prefijo de clases: `tray-`.
 */
import { el, type Child } from '../dom.ts';
import { icon } from '../icons.ts';
import { kt } from '../i18n/i18n.ts';
import { renderMedal, type MedalOptions } from './medal.ts';

export interface TrayAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
  /** Atributos extra (p. ej. `data-choice`, marcas de feedback). */
  attrs?: Record<string, string>;
  disabled?: boolean;
}

export interface TrayRow {
  id: string;
  title: Child;
  medal?: MedalOptions | Node | null;
  /** Quién («Lo cambió Laura»). */
  who?: string | null;
  /** Cuándo, en su propia línea. */
  when?: string | null;
  /** Lo que choca, una línea cada cosa. */
  clash?: Child[];
  chips?: Child[];
  actions?: (TrayAction | Node)[];
  /** Lo que sale debajo (estado tras elegir, «Deshacer»…). */
  extra?: Child;
  rejected?: boolean;
  attrs?: Record<string, string>;
}

export interface TrayGroup {
  key: string;
  label: string;
  rows: TrayRow[];
  /** Plegado al empezar (no). */
  collapsed?: boolean;
}

export interface TrayOptions {
  label: string;
  groups: TrayGroup[];
  emptyTitle?: string;
  emptyText?: string;
}

export function renderTrayRow(row: TrayRow): HTMLElement {
  const medal = row.medal ? (row.medal instanceof Node ? row.medal : renderMedal({ size: 44, ...row.medal })) : null;
  return el('li', { class: `tray-row${row.rejected ? ' tray-rejected' : ''}${medal ? ' tray-has-medal' : ''}`, dataset: { id: row.id }, ...(row.attrs ?? {}) },
    el('div', { class: 'tray-head' },
      medal ?? (row.rejected ? el('span', { class: 'tray-rejicon', 'aria-hidden': 'true' }, icon('warn', 20)) : null),
      el('h3', { class: 'tray-title' }, row.rejected ? el('span', { class: 'vh' }, kt('Rechazado: ')) : null, row.title)),
    el('div', { class: 'tray-body' },
      row.who || row.when ? el('p', { class: 'tray-who' }, row.who ? el('span', null, row.who) : null, row.when ? el('span', { class: 'tray-when' }, row.when) : null) : null,
      row.clash?.length ? el('ul', { class: 'tray-clash' }, ...row.clash.map((c) => el('li', null, c))) : null,
      row.chips?.length ? el('div', { class: 'chips tray-chips' }, ...row.chips) : null,
      row.actions?.length ? el('div', { class: 'tray-actions' }, ...row.actions.map((a) => (a instanceof Node ? a
        : el('button', { type: 'button', class: a.primary ? 'primary' : 'ghost', disabled: !!a.disabled, ...(a.attrs ?? {}), onclick: () => a.onClick() }, a.label)))) : null,
      row.extra ?? null));
}

export function renderTray(options: TrayOptions): HTMLElement {
  const groups = options.groups.filter((g) => g.rows.length);
  if (!groups.length) {
    return el('div', { class: 'empty tray-empty' }, el('strong', null, options.emptyTitle ?? kt('Nada por resolver')), options.emptyText ?? '');
  }
  return el('section', { class: 'tray-box', 'aria-label': options.label },
    ...groups.map((g) => el('details', { class: 'tray-area', open: !g.collapsed, dataset: { area: g.key } },
      el('summary', { class: 'tray-areahead' }, el('span', { class: 'tray-arealabel' }, g.label), el('span', { class: 'tray-count', 'aria-label': g.rows.length === 1 ? kt('1 por resolver') : kt('{n} por resolver', { n: String(g.rows.length) }) }, String(g.rows.length))),
      el('ul', { class: 'tray-rows' }, ...g.rows.map(renderTrayRow)))));
}
