import type { PendingConflict, SyncClient } from '@ikisai/sync-client';
import { el, formatDate, replace, type Child } from '../dom.ts';

export type ConflictDecision = Parameters<SyncClient['resolveConflict']>[1];

/** Columnas del contrato §2.1 y marcas internas que no se muestran. */
export const SYSTEM_COLUMNS: ReadonlySet<string> = new Set(['id', 'revision', 'created_at', 'updated_at', 'updated_by', '_pending']);

export interface ConflictOptions {
  /** Etiquetas de campo: `{ name: 'Nombre', tax_id: 'NIF' }`. Sin etiqueta se muestra el nombre técnico. */
  fieldLabels?: Record<string, string>;
  /** Cómo mostrar un valor; por defecto texto plano, fechas en `deleted_at`, «—» si vacío. */
  show?: (field: string, value: unknown) => Child;
  /** Nombre legible de la fila (por defecto `name`, `title` o el id). */
  rowName?: (conflict: PendingConflict) => string;
  /** Resuelve el conflicto en el cliente; la app llama a `client.resolveConflict` y recarga. */
  onResolve: (conflict: PendingConflict, decision: ConflictDecision) => void | Promise<void>;
  /**
   * Base de las marcas de feedback y uso (p. ej. `'food.menu.conflicto'`): la tarjeta lleva la base y sus botones
   * `<base>.mantener_mia`, `.tomar_servidor`, `.combinar`, `.guardar_combinacion` y `.volver` (también al repintar).
   * Escrita como literal, el catálogo (`feature-catalog.mjs`) añade esos hijos solo.
   */
  feedbackId?: string;
}

/** Sufijos y etiquetas de los controles de la tarjeta de conflicto (los lee también el generador del catálogo). */
export const CONFLICT_MARKS = {
  mine: ['mantener_mia', 'Mantener la mía'],
  theirs: ['tomar_servidor', 'Tomar la del servidor'],
  merge: ['combinar', 'Combinar campo a campo'],
  save: ['guardar_combinacion', 'Guardar combinación'],
  back: ['volver', 'Volver'],
} as const;

function defaultShow(field: string, value: unknown): Child {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'deleted_at' || field.endsWith('_at')) return formatDate(String(value));
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function defaultRowName(conflict: PendingConflict): string {
  const row = conflict.current ?? conflict.base;
  const candidate = row?.name ?? row?.title ?? conflict.operation.id;
  return String(candidate);
}

/**
 * Tarjeta de conflicto (contrato §6.3): ambas versiones campo a campo y tres decisiones: mantener la mía, tomar la del
 * servidor o combinar campo a campo (solo en `update`).
 */
export function renderConflict(conflict: PendingConflict, options: ConflictOptions): HTMLElement {
  const show = options.show ?? defaultShow;
  const labels = options.fieldLabels ?? {};
  const op = conflict.operation;
  const mine: Record<string, unknown> = op.op === 'update' ? op.fields : {};
  const changedByServer = Object.keys(conflict.current).filter((k) => !SYSTEM_COLUMNS.has(k) && conflict.base && conflict.base[k] !== conflict.current[k]);
  const fields = Array.from(new Set([...Object.keys(mine), ...conflict.overlapping, ...changedByServer]));
  const picks = new Map<string, 'mine' | 'theirs'>();
  let merging = false;
  let busy = false;

  const name = (options.rowName ?? defaultRowName)(conflict);
  const title = op.op === 'delete' ? `Querías borrar «${name}»` : `«${name}»`;
  const article = el('article', { class: 'conflict', dataset: { requestId: conflict.requestId } });

  async function resolve(decision: ConflictDecision): Promise<void> {
    if (busy) return;
    busy = true;
    article.classList.add('busy');
    try {
      await options.onResolve(conflict, decision);
    } finally {
      busy = false;
      article.classList.remove('busy');
    }
  }

  function pick(field: string, side: 'mine' | 'theirs'): HTMLElement {
    const input = el('input', { type: 'radio', name: `pick-${conflict.requestId}-${field}`, value: side, checked: (picks.get(field) ?? 'mine') === side, onchange: () => picks.set(field, side) });
    return el('label', { class: 'pick' }, input, side === 'mine' ? 'usar la mía' : 'usar esta');
  }

  function table(): HTMLElement {
    return el('table', null,
      el('thead', null, el('tr', null, el('th', null, 'Campo'), el('th', null, 'Tu versión'), el('th', null, 'Servidor'))),
      el('tbody', null, ...fields.map((field) => {
        const overlap = conflict.overlapping.includes(field);
        const myValue = field in mine ? mine[field] : op.op === 'delete' && field === 'deleted_at' ? 'borrar' : conflict.base?.[field];
        const editable = merging && field in mine;
        return el('tr', { class: overlap ? 'overlap' : '' },
          el('th', { scope: 'row' }, labels[field] ?? field),
          el('td', null, show(field, myValue), editable ? el('div', null, pick(field, 'mine')) : null),
          el('td', null, show(field, conflict.current[field]), editable ? el('div', null, pick(field, 'theirs')) : null),
        );
      })),
    );
  }

  /** Marca de un control (si la app dio `feedbackId`). */
  const mark = (key: keyof typeof CONFLICT_MARKS): Record<string, string> => (options.feedbackId
    ? { 'data-feedback-id': `${options.feedbackId}.${CONFLICT_MARKS[key][0]}`, 'data-feedback-label': CONFLICT_MARKS[key][1] }
    : {});
  if (options.feedbackId) { article.setAttribute('data-feedback-id', options.feedbackId); article.setAttribute('data-feedback-label', 'Conflicto'); }

  function choices(): HTMLElement {
    if (!merging) {
      return el('div', { class: 'choices' },
        el('button', { class: 'primary', type: 'button', 'data-choice': 'mine', ...mark('mine'), onclick: () => void resolve({ choice: 'mine' }) }, 'Mantener la mía'),
        el('button', { class: 'ghost', type: 'button', 'data-choice': 'theirs', ...mark('theirs'), onclick: () => void resolve({ choice: 'theirs' }) }, 'Tomar la del servidor'),
        op.op === 'update' ? el('button', { class: 'ghost', type: 'button', 'data-choice': 'merge', ...mark('merge'), onclick: () => { merging = true; repaint(); } }, 'Combinar campo a campo') : null,
      );
    }
    return el('div', { class: 'choices' },
      el('button', { class: 'primary', type: 'button', 'data-choice': 'save-merge', ...mark('save'), onclick: () => {
        const merged: Record<string, unknown> = {};
        for (const field of Object.keys(mine)) if ((picks.get(field) ?? 'mine') === 'mine') merged[field] = mine[field];
        void resolve({ choice: 'merge', fields: merged });
      } }, 'Guardar combinación'),
      el('button', { class: 'ghost', type: 'button', 'data-choice': 'back', ...mark('back'), onclick: () => { merging = false; repaint(); } }, 'Volver'),
    );
  }

  function repaint(): void {
    replace(article,
      el('h3', null, title),
      el('p', { class: 'meta' }, `Detectado ${formatDate(conflict.detectedAt)} · revisión del servidor ${conflict.current.revision}`),
      table(),
      choices(),
    );
  }
  repaint();
  return article;
}

/** Lista de conflictos o estado vacío. */
export function renderConflicts(conflicts: PendingConflict[], options: ConflictOptions & { emptyTitle?: string; emptyText?: string }): HTMLElement[] {
  if (conflicts.length === 0) {
    return [el('div', { class: 'empty' }, el('strong', null, options.emptyTitle ?? 'Sin conflictos'), options.emptyText ?? 'Todo lo tuyo se ha podido aplicar sin pisar cambios de nadie.')];
  }
  return conflicts.map((conflict) => renderConflict(conflict, options));
}
