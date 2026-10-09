import type { PendingConflict, SyncClient } from '@ikisai/sync-client';
import { el, formatDate, replace, type Child } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';

export type ConflictDecision = Parameters<SyncClient['resolveConflict']>[1];

/** Columnas del contrato §2.1 y marcas internas que no se muestran. */
export const SYSTEM_COLUMNS: ReadonlySet<string> = new Set(['id', 'revision', 'created_at', 'updated_at', 'updated_by', '_pending']);

export interface ConflictOptions {
  /** Etiquetas de campo: `{ name: 'Nombre', tax_id: 'NIF' }`. Sin etiqueta se muestra el nombre técnico. */
  fieldLabels?: Record<string, string>;
  /** Cómo mostrar un valor; por defecto texto plano, fechas en `deleted_at`, «—» si vacío. */
  show?: (field: string, value: unknown) => Child;
  /**
   * Nombre legible de la fila («FVR_2026_003 · Intermodalidad de Levante»). Si no se da, o devuelve vacío: `code`/`number`
   * y `name`/`title` de la fila; si no los tiene, el nombre de la tabla (`tableLabels`). Nunca el id.
   */
  rowName?: (conflict: PendingConflict) => string | null | undefined;
  /** Nombre de cada tabla para el título cuando la fila no tiene nombre: `{ 'invoices.invoices': 'facturas' }`. */
  tableLabels?: Record<string, string>;
  /**
   * Persona con la sesión abierta (`profile.userId` del arranque). Con ella, la tarjeta dice si el cambio del servidor es
   * de **otra persona** o **tuyo desde otra pestaña o dispositivo**.
   */
  currentUserId?: string | null;
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
  mine: ['mantener_mia', 'Reintentar con lo mío'],
  theirs: ['tomar_servidor', 'Quedarme con lo del servidor'],
  diff: ['diferencias', 'Ver diferencias'],
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

const text = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '');

/** Nombre de la fila según sus datos (`code`/`number` · `name`/`title`), o vacío si no tiene ninguno. */
export function conflictRowName(conflict: PendingConflict): string {
  const row = conflict.current ?? conflict.base;
  const code = text(row?.code) || text(row?.number);
  const name = text(row?.name) || text(row?.title);
  return code && name ? `${code} · ${name}` : code || name;
}

/** Quién hizo el cambio del servidor: tú (otra pestaña o dispositivo), otra persona, o no se sabe. */
export function conflictAuthor(conflict: PendingConflict, currentUserId: string | null | undefined): 'self' | 'other' | 'unknown' {
  const by = conflict.current?.updated_by;
  if (!currentUserId || !by) return 'unknown';
  return by === currentUserId ? 'self' : 'other';
}

/** Frase para la cabecera de la pantalla de conflictos, según quién hizo los cambios. */
export function conflictIntro(conflicts: PendingConflict[], currentUserId?: string | null): string {
  const authors = new Set(conflicts.map((c) => conflictAuthor(c, currentUserId)));
  if (authors.size === 1 && authors.has('self')) return kt('Lo cambiaste tú desde otra pestaña o dispositivo antes de que llegara este cambio. Nada se pierde hasta que decidas.');
  if (authors.size === 1 && authors.has('other')) return kt('Otra persona cambió lo mismo que tú. Nada se pierde hasta que decidas.');
  return kt('Lo que cambiaste se cambió también en el servidor. Nada se pierde hasta que decidas.');
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
  let showDiff = false;
  let busy = false;

  const name = text(options.rowName?.(conflict)) || conflictRowName(conflict);
  const tableName = options.tableLabels?.[op.table] ?? op.table.split('.').pop() ?? op.table;
  const title = name
    ? (op.op === 'delete' ? kt('Querías borrar «{name}»', { name }) : `«${name}»`)
    : (op.op === 'delete' ? kt('Querías borrar un registro de {table}', { table: tableName }) : kt('Un registro de {table}', { table: tableName }));
  const author = conflictAuthor(conflict, options.currentUserId);
  const who = author === 'self' ? kt('Lo cambiaste tú desde otra pestaña o dispositivo.')
    : author === 'other' ? kt('Lo cambió otra persona.')
    : kt('Se cambió también en el servidor.');
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
    return el('label', { class: 'pick' }, input, side === 'mine' ? kt('usar la mía') : kt('usar esta'));
  }

  function table(): HTMLElement {
    return el('table', null,
      el('thead', null, el('tr', null, el('th', null, kt('Campo')), el('th', null, kt('Tu versión')), el('th', null, kt('Servidor')))),
      el('tbody', null, ...fields.map((field) => {
        const overlap = conflict.overlapping.includes(field);
        const myValue = field in mine ? mine[field] : op.op === 'delete' && field === 'deleted_at' ? kt('borrar') : conflict.base?.[field];
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
        el('button', { class: 'primary', type: 'button', 'data-choice': 'theirs', title: kt('Descarta lo tuyo y deja lo que hay en el servidor.'), ...mark('theirs'), onclick: () => void resolve({ choice: 'theirs' }) }, kt(CONFLICT_MARKS.theirs[1])),
        el('button', { class: 'ghost', type: 'button', 'data-choice': 'mine', title: kt('Vuelve a enviar tu cambio sobre la versión del servidor.'), ...mark('mine'), onclick: () => void resolve({ choice: 'mine' }) }, kt(CONFLICT_MARKS.mine[1])),
        fields.length ? el('button', { class: 'ghost', type: 'button', 'data-choice': 'diff', 'aria-expanded': String(showDiff), ...mark('diff'), onclick: () => { showDiff = !showDiff; repaint(); } }, showDiff ? kt('Ocultar diferencias') : kt(CONFLICT_MARKS.diff[1])) : null,
        op.op === 'update' ? el('button', { class: 'ghost', type: 'button', 'data-choice': 'merge', ...mark('merge'), onclick: () => { merging = true; repaint(); } }, kt(CONFLICT_MARKS.merge[1])) : null,
      );
    }
    return el('div', { class: 'choices' },
      el('button', { class: 'primary', type: 'button', 'data-choice': 'save-merge', ...mark('save'), onclick: () => {
        const merged: Record<string, unknown> = {};
        for (const field of Object.keys(mine)) if ((picks.get(field) ?? 'mine') === 'mine') merged[field] = mine[field];
        void resolve({ choice: 'merge', fields: merged });
      } }, kt(CONFLICT_MARKS.save[1])),
      el('button', { class: 'ghost', type: 'button', 'data-choice': 'back', ...mark('back'), onclick: () => { merging = false; repaint(); } }, kt(CONFLICT_MARKS.back[1])),
    );
  }

  function repaint(): void {
    // Las decisiones van arriba: en móvil, con muchos campos, la tabla las dejaba fuera de la pantalla. Al combinar, la
    // tabla (con sus «usar la mía / usar esta») va antes de «Guardar combinación».
    const diff = fields.length ? table() : null;
    if (diff) diff.hidden = !showDiff && !merging;
    replace(article,
      el('h3', null, title),
      el('p', { class: 'who' }, who),
      el('p', { class: 'meta' }, kt('Detectado {date} · revisión del servidor {revision}', { date: formatDate(conflict.detectedAt), revision: String(conflict.current.revision) })),
      merging ? diff : choices(),
      merging ? choices() : diff,
    );
  }
  repaint();
  return article;
}

/** Lista de conflictos o estado vacío. */
export function renderConflicts(conflicts: PendingConflict[], options: ConflictOptions & { emptyTitle?: string; emptyText?: string }): HTMLElement[] {
  if (conflicts.length === 0) {
    return [el('div', { class: 'empty' }, el('strong', null, options.emptyTitle ?? kt('Sin conflictos')), options.emptyText ?? kt('Todo lo tuyo se ha podido aplicar sin pisar cambios de nadie.'))];
  }
  return conflicts.map((conflict) => renderConflict(conflict, options));
}
