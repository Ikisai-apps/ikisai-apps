/**
 * Veredicto y comprobaciones ✓ / ! (MUELA-075, pieza 18): «4 cosas por resolver · la primera vence hoy» o «Todo en
 * regla», y debajo la lista. Qué se comprueba lo decide la app; aquí solo se presenta. Generaliza el `.imp-verdict` de
 * la importación: mismo aspecto, con `role="status"`.
 * - Cada comprobación lleva símbolo y texto, y «bien» o «falta» para lectores de pantalla.
 * - `action` en una comprobación: botón de 46 px para resolverla («Completar»).
 * Prefijo de clases: `check-`.
 */
import { el } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';

export interface CheckItem {
  ok: boolean;
  text: string;
  detail?: string | null;
  action?: { label: string; onClick: () => void; feedbackId?: string } | null;
}

export interface ChecksOptions {
  items: CheckItem[];
  /** Veredicto; por defecto «Todo en regla» o «{n} cosas por resolver». */
  verdict?: string | null;
  /** Ocultar las que están bien (solo el veredicto las cuenta). */
  onlyPending?: boolean;
  label?: string;
}

export function renderChecks(options: ChecksOptions): HTMLElement {
  const pending = options.items.filter((i) => !i.ok).length;
  const ok = pending === 0;
  const verdict = options.verdict ?? (ok ? kt('Todo en regla') : pending === 1 ? kt('1 cosa por resolver') : kt('{n} cosas por resolver', { n: String(pending) }));
  const shown = options.onlyPending ? options.items.filter((i) => !i.ok) : options.items;
  return el('section', { class: 'check-box', ...(options.label ? { 'aria-label': options.label } : {}) },
    el('p', { class: `imp-verdict check-verdict ${ok ? 'ok' : 'bad'}`, role: 'status', dataset: { verdict: ok ? 'ok' : 'bad' } },
      el('span', { class: 'check-mark', 'aria-hidden': 'true' }, ok ? '✓' : '!'), verdict),
    shown.length ? el('ul', { class: 'check-list' }, ...shown.map((item) => el('li', { class: 'check-item', dataset: { ok: String(item.ok) } },
      el('span', { class: 'check-mark', 'aria-hidden': 'true' }, item.ok ? '✓' : '!'),
      el('span', { class: 'check-text' }, el('span', { class: 'vh' }, item.ok ? kt('Bien: ') : kt('Falta: ')), item.text,
        item.detail ? el('span', { class: 'check-detail' }, item.detail) : null),
      item.action ? el('button', { type: 'button', class: 'ghost small check-action', ...(item.action.feedbackId ? { 'data-feedback-id': item.action.feedbackId, 'data-feedback-label': item.action.label } : {}), onclick: item.action.onClick }, item.action.label) : null))) : null);
}
