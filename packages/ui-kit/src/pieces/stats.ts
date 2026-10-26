/**
 * Cifras de color (MUELA-075, pieza 21): pendientes, vencidas y % hecho en cifras grandes. La etiqueta va siempre junto
 * a la cifra: el color nunca es lo único que dice qué es. Con `onClick`, cada cifra es un botón de 46 px (filtrar).
 * Con `selected`, la cifra que filtra lleva `aria-pressed` y un borde grueso: se ve sin depender del color.
 * Prefijo de clases: `stat-` (nunca `.kpi`, que ya usan Invoices y Tasks).
 */
import { el } from '../dom.ts';

export interface Stat {
  value: string | number;
  label: string;
  tone?: 'alert' | 'warn' | 'ok' | null;
  /** Una línea pequeña debajo («de 12»). */
  hint?: string | null;
  onClick?: () => void;
  /** Con `onClick`: es la cifra que filtra ahora. Pinta `aria-pressed` (true o false en todas) y la marca de elegida. */
  selected?: boolean;
  feedbackId?: string;
}

export function renderStats(items: Stat[], options: { label?: string } = {}): HTMLElement {
  return el('ul', { class: 'stat-row', ...(options.label ? { 'aria-label': options.label } : {}) },
    ...items.map((s) => {
      const pressable = items.some((x) => x.selected !== undefined);
      const body = [
        el('strong', { class: 'stat-value' }, String(s.value)),
        el('span', { class: 'stat-label' }, s.label),
        s.hint ? el('span', { class: 'stat-hint' }, s.hint) : null,
      ];
      const attrs = { class: 'stat-item', dataset: { tone: s.tone ?? 'none' }, ...(s.feedbackId ? { 'data-feedback-id': s.feedbackId, 'data-feedback-label': s.label } : {}) };
      return el('li', null, s.onClick
        ? el('button', { type: 'button', ...attrs, class: s.selected ? 'stat-item stat-selected' : 'stat-item', 'aria-pressed': pressable ? String(!!s.selected) : null, onclick: s.onClick }, ...body)
        : el('span', attrs, ...body));
    }));
}
