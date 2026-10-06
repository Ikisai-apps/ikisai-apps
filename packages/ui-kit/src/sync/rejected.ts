import type { RejectedBatch } from '@ikisai/sync-client';
import { el, formatDate, plural } from '../dom.ts';
import { icon } from '../icons.ts';

export interface RejectedOptions {
  /** Texto del error del servidor; por defecto `error.message`. */
  describeError?: (error: RejectedBatch['error']) => string;
  /** Nombre legible de una fila a partir de `baseRows` (por defecto `name`/`title` o el id). */
  rowName?: (batch: RejectedBatch, key: string) => string;
  onRetry: (batch: RejectedBatch) => void | Promise<void>;
  onDiscard: (batch: RejectedBatch) => void | Promise<void>;
}

function summary(batch: RejectedBatch, options: RejectedOptions): string {
  const ops = batch.operations;
  const verbs = { insert: 'crear', update: 'editar', delete: 'borrar', restore: 'restaurar', call: 'ejecutar' } as const;
  const parts = ops.slice(0, 3).map((op) => {
    if (op.op === 'call') return `${verbs.call} «${op.procedure}»`;
    const key = `${op.table}|${op.id}`;
    const name = options.rowName ? options.rowName(batch, key) : String(batch.baseRows[key]?.name ?? batch.baseRows[key]?.title ?? ('fields' in op && op.fields ? op.fields.name ?? op.fields.title : null) ?? op.id);
    return `${verbs[op.op]} «${name}»`;
  });
  if (ops.length > 3) parts.push(`y ${ops.length - 3} más`);
  return parts.join(', ');
}

/** Tarjeta de lote rechazado por el servidor (4xx definitivo): qué se intentó, por qué se rechazó, reintentar o descartar. */
export function renderRejected(batch: RejectedBatch, options: RejectedOptions): HTMLElement {
  const message = options.describeError ? options.describeError(batch.error) : batch.error.message;
  return el('article', { class: 'conflict rejected', dataset: { requestId: batch.requestId } },
    el('h3', null, 'El servidor rechazó ', plural(batch.operations.length, 'cambio', 'cambios')),
    el('p', { class: 'meta' }, `${summary(batch, options)} · ${formatDate(batch.rejectedAt)}`),
    el('div', { class: 'banner alert' }, icon('warn', 18), el('span', null, message), el('code', { class: 'small' }, batch.error.code)),
    el('div', { class: 'choices' },
      el('button', { class: 'primary', type: 'button', 'data-choice': 'retry', onclick: () => void options.onRetry(batch) }, 'Reintentar'),
      el('button', { class: 'ghost', type: 'button', 'data-choice': 'discard', onclick: () => void options.onDiscard(batch) }, 'Descartar'),
    ),
  );
}

export function renderRejectedList(batches: RejectedBatch[], options: RejectedOptions): HTMLElement[] {
  if (batches.length === 0) return [el('div', { class: 'empty' }, el('strong', null, 'Nada rechazado'), 'El servidor ha aceptado todos tus cambios.')];
  return batches.map((batch) => renderRejected(batch, options));
}
