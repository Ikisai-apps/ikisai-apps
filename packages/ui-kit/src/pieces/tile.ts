/**
 * Baldosa con cifra y relleno (MUELA-075, pieza 6; la baldosa de K22 sin estanterías): icono o medallón, nombre, una
 * cifra grande y el relleno de su color hasta el nivel. La marca del mínimo es una raya; el tono (bien, justo, poco) lo
 * decide la app. **`levelText` es obligatorio**: el nivel siempre se dice con palabras («queda poco»), no solo con color.
 * Tocar abre o avanza (`onClick`); sin él, no es un botón.
 * Prefijo de clases: `tile-`.
 */
import { el } from '../dom.ts';
import { icon, type IconName } from '../icons.ts';
import { renderMedal, type MedalOptions } from './medal.ts';

export interface TileOptions {
  title: string;
  value: string | number;
  /** Lo que dice el nivel en palabras («queda poco», «va justo», «bien»). Obligatorio. */
  levelText: string;
  /** Relleno: porcentaje (0–100), el mínimo como marca y el tono. Sin `level`, la baldosa no se rellena. */
  level?: { pct: number; min?: number | null; tone?: 'alert' | 'warn' | 'ok' | null } | null;
  medal?: MedalOptions | null;
  icon?: IconName | Node | null;
  onClick?: () => void;
  feedbackId?: string;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));

export function renderTile(options: TileOptions): HTMLElement {
  const level = options.level ?? null;
  const pct = level ? clamp(level.pct) : null;
  const lead = options.medal ? renderMedal({ size: 40, name: options.title, ...options.medal })
    : options.icon ? el('span', { class: 'tile-icon', 'aria-hidden': 'true' }, typeof options.icon === 'string' ? icon(options.icon as IconName, 22) : options.icon) : null;
  const body = [
    pct !== null ? el('span', { class: 'tile-fill', 'aria-hidden': 'true', style: `height:${pct}%` }) : null,
    pct !== null && level?.min != null ? el('span', { class: 'tile-min', 'aria-hidden': 'true', style: `bottom:${clamp(level.min)}%` }) : null,
    el('span', { class: 'tile-top' }, lead, el('span', { class: 'tile-title' }, options.title)),
    el('strong', { class: 'tile-value' }, String(options.value)),
    el('span', { class: 'tile-level' }, options.levelText),
  ];
  const attrs = {
    class: 'tile-box', dataset: { tone: level?.tone ?? 'none' },
    ...(options.feedbackId ? { 'data-feedback-id': options.feedbackId, 'data-feedback-label': options.title } : {}),
  };
  return options.onClick ? el('button', { type: 'button', ...attrs, onclick: options.onClick }, ...body) : el('div', attrs, ...body);
}
