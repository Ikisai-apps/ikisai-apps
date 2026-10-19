import type { PendingConflict, SyncClient } from '@ikisai/sync-client';
import { el, formatDate, replace, type Child } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';
import { openSheet } from '../overlay/sheet.ts';
import { toastWithAction } from '../toast.ts';
import type { MedalOptions } from '../pieces/medal.ts';
import { renderTray, type TrayGroup, type TrayRow } from '../pieces/tray.ts';

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
  /**
   * `tray` (bandeja por áreas, K20 y pieza 12): una línea por conflicto con lo que choca escrito y dos botones al mismo
   * nivel («Lo mío» / «Lo de Laura»); «Ver diferencias» abre la tarjeta de siempre (con «Combinar»). Por defecto,
   * `cards`: igual que antes.
   */
  layout?: 'cards' | 'tray';
  /** Bandeja: área de cada conflicto (por defecto, la tabla con `tableLabels`). */
  groupBy?: (conflict: PendingConflict) => { key: string; label: string; order?: number };
  /** Bandeja: nombre de quien hizo el cambio del servidor («Laura»), para «Lo de Laura». */
  theirsName?: (conflict: PendingConflict) => string | null | undefined;
  /** Bandeja: medallón de cada línea. */
  medal?: (conflict: PendingConflict) => MedalOptions | null | undefined;
  /** Bandeja: nombres de los dos botones («Lo mío», «Lo de Laura»). */
  labels?: { mine?: string; theirs?: string; both?: string };
  /** Bandeja: «Los dos» cuando lo que choca son listas (une las dos sin repetir). Por defecto, sí. */
  both?: boolean;
  /**
   * Bandeja: tras elegir, cuánto se espera (ms) antes de llamar a `onResolve`, con «Deshacer» mientras tanto. Si se
   * cierra la app en ese rato, la decisión no se guarda y el conflicto sigue ahí. Por defecto, 0 (al momento).
   */
  undoMs?: number;
}

/** Sufijos y etiquetas de los controles de la tarjeta de conflicto (los lee también el generador del catálogo). */
export const CONFLICT_MARKS = {
  mine: ['mantener_mia', 'Reintentar con lo mío'],
  theirs: ['tomar_servidor', 'Quedarme con lo del servidor'],
  diff: ['diferencias', 'Ver diferencias'],
  merge: ['combinar', 'Combinar campo a campo'],
  save: ['guardar_combinacion', 'Guardar combinación'],
  back: ['volver', 'Volver'],
  both: ['los_dos', 'Los dos'],
  undo: ['deshacer', 'Deshacer'],
} as const;

function defaultShow(field: string, value: unknown): Child {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'deleted_at' || field.endsWith('_at')) return formatDate(String(value));
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Mismo valor por contenido: una lista o un objeto que llega del servidor es otro objeto aunque no haya cambiado. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) { const bb = b as unknown[]; return a.length === bb.length && a.every((v, i) => sameValue(v, bb[i])); }
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
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
  const changedByServer = Object.keys(conflict.current).filter((k) => !SYSTEM_COLUMNS.has(k) && conflict.base && !sameValue(conflict.base[k], conflict.current[k]));
  const fields = Array.from(new Set([...Object.keys(mine), ...conflict.overlapping, ...changedByServer]));
  const picks = new Map<string, 'mine' | 'theirs'>();
  let merging = false;
  let showDiff = false;
  let busy = false;

  const name = text(options.rowName?.(conflict)) || conflictRowName(conflict);
  // Un `call` aparcado (p. ej. validar una factura) no lleva tabla.
  const opTable = (op as { table?: string }).table;
  const tableName = opTable ? options.tableLabels?.[opTable] ?? opTable.split('.').pop() ?? opTable : '';
  const title = name
    ? (op.op === 'delete' ? kt('Querías borrar «{name}»', { name }) : `«${name}»`)
    : tableName
      ? (op.op === 'delete' ? kt('Querías borrar un registro de {table}', { table: tableName }) : kt('Un registro de {table}', { table: tableName }))
      : kt('Un cambio pendiente');
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
      // La principal no puede ser la que tira lo tuyo: primero «Reintentar con lo mío»; lo del servidor, al lado y sin destacar.
      return el('div', { class: 'choices' },
        el('button', { class: 'primary', type: 'button', 'data-choice': 'mine', title: kt('Vuelve a enviar tu cambio sobre la versión del servidor.'), ...mark('mine'), onclick: () => void resolve({ choice: 'mine' }) }, kt(CONFLICT_MARKS.mine[1])),
        el('button', { class: 'ghost', type: 'button', 'data-choice': 'theirs', title: kt('Descarta lo tuyo y deja lo que hay en el servidor.'), ...mark('theirs'), onclick: () => void resolve({ choice: 'theirs' }) }, kt(CONFLICT_MARKS.theirs[1])),
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

/** Texto plano de lo que pinta `show` (para decir qué choca en una línea). */
function plain(value: Child): string {
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(plain).join('');
  if (value instanceof Node) return value.textContent ?? '';
  return String(value);
}

/** Une dos listas sin repetir (por contenido), primero lo mío. */
function union(a: unknown[], b: unknown[]): unknown[] {
  const out = a.slice();
  for (const v of b) if (!out.some((x) => sameValue(x, v))) out.push(v);
  return out;
}

/** Bandeja de conflictos (`layout: 'tray'`): traduce cada `PendingConflict` a una línea de `renderTray`. */
function renderConflictTray(conflicts: PendingConflict[], options: ConflictOptions & { emptyTitle?: string; emptyText?: string }): HTMLElement {
  const show = options.show ?? defaultShow;
  const labels = options.fieldLabels ?? {};
  const mark = (key: keyof typeof CONFLICT_MARKS): Record<string, string> => (options.feedbackId
    ? { 'data-feedback-id': `${options.feedbackId}.${CONFLICT_MARKS[key][0]}`, 'data-feedback-label': CONFLICT_MARKS[key][1] }
    : {});
  const mineLabel = options.labels?.mine ?? kt('Lo mío');
  const bothLabel = options.labels?.both ?? kt('Los dos');
  // La bandeja, para que cada línea encuentre su sitio al elegir («Elegido…», «Deshacer»).
  let trayEl: HTMLElement | null = null;
  const groupOf: (c: PendingConflict) => { key: string; label: string; order?: number } = options.groupBy ?? ((c: PendingConflict) => {
    const table = (c.operation as { table?: string }).table ?? '';
    return { key: table || 'otros', label: table ? options.tableLabels?.[table] ?? table.split('.').pop() ?? table : kt('Otros cambios') };
  });

  const row = (conflict: PendingConflict): TrayRow => {
    const op = conflict.operation;
    const mine: Record<string, unknown> = op.op === 'update' ? op.fields : {};
    const name = text(options.rowName?.(conflict)) || conflictRowName(conflict);
    const table = (op as { table?: string }).table;
    const title = name || (table ? kt('Un registro de {table}', { table: options.tableLabels?.[table] ?? table.split('.').pop() ?? table }) : kt('Un cambio pendiente'));
    const author = conflictAuthor(conflict, options.currentUserId);
    const otherName = author === 'self' ? null : options.theirsName?.(conflict);
    const who = author === 'self' ? kt('Lo cambiaste tú desde otra pestaña o dispositivo.') : otherName ? kt('Lo cambió {name}.', { name: otherName }) : author === 'other' ? kt('Lo cambió otra persona.') : kt('Se cambió también en el servidor.');
    const fields = conflict.overlapping.length ? conflict.overlapping : Object.keys(mine).filter((k) => conflict.base && !sameValue(conflict.base[k], conflict.current[k]));
    const clash = op.op === 'delete'
      ? [kt('Querías borrarlo; en el servidor sigue y ha cambiado.')]
      : fields.slice(0, 3).map((f) => kt('{field}: «{mine}» frente a «{theirs}»', { field: labels[f] ?? f, mine: plain(show(f, mine[f])), theirs: plain(show(f, conflict.current[f])) }));
    if (fields.length > 3) clash.push(kt('y {n} cambios más', { n: String(fields.length - 3) }));
    // «Lo de Laura» (con `theirsName`), «Lo del otro dispositivo» si fuiste tú, o «Lo del servidor».
    const theirsLabel = options.labels?.theirs ?? (otherName ? kt('Lo de {name}', { name: otherName }) : author === 'self' ? kt('Lo del otro dispositivo') : kt('Lo del servidor'));
    const lists = fields.filter((f) => Array.isArray(mine[f]) && Array.isArray(conflict.current[f]));
    const canBoth = op.op === 'update' && options.both !== false && lists.length > 0;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const decide = (decision: ConflictDecision, said: string) => {
      const host = trayEl?.querySelector<HTMLElement>(`.tray-row[data-request-id="${CSS.escape(conflict.requestId)}"]`) ?? null;
      const run = () => { timer = null; void Promise.resolve(options.onResolve(conflict, decision)).catch(() => restore()); };
      const restore = () => { if (timer) clearTimeout(timer); timer = null; host?.classList.remove('tray-decided'); host?.querySelector('.tray-decision')?.remove(); host?.querySelectorAll<HTMLButtonElement>('.tray-actions button').forEach((b) => { b.disabled = false; }); };
      host?.querySelectorAll<HTMLButtonElement>('.tray-actions button').forEach((b) => { b.disabled = true; });
      const ms = options.undoMs ?? 0;
      if (!ms) { run(); return; }
      host?.classList.add('tray-decided');
      const undoBtn = el('button', { type: 'button', class: 'linkbtn tray-undo', ...mark('undo'), onclick: () => restore() }, kt('Deshacer'));
      host?.querySelector('.tray-body')?.append(el('p', { class: 'tray-decision', role: 'status' }, kt('Elegido: {choice}', { choice: said }), ' ', undoBtn));
      toastWithAction(`${title}: ${said}`, { label: kt('Deshacer'), onClick: restore }, ms);
      timer = setTimeout(run, ms);
    };

    const choice = (key: 'mine' | 'theirs' | 'both', label: string, decision: ConflictDecision) => ({
      label, onClick: () => decide(decision, label),
      attrs: { 'data-choice': key, ...mark(key), ...(key === 'theirs' ? { title: kt('Descarta lo tuyo y deja lo que hay en el servidor.') } : {}) },
    });
    // Un borrado se decide con «Borrar» (lo tuyo) o «Conservar» (lo del servidor).
    const actions = [
      choice('mine', op.op === 'delete' ? kt('Borrar') : mineLabel, { choice: 'mine' }),
      choice('theirs', op.op === 'delete' ? kt('Conservar') : theirsLabel, { choice: 'theirs' }),
      ...(canBoth ? [choice('both', bothLabel, { choice: 'merge', fields: { ...mine, ...Object.fromEntries(lists.map((f) => [f, union(mine[f] as unknown[], conflict.current[f] as unknown[])])) } })] : []),
      { label: kt(CONFLICT_MARKS.diff[1]), attrs: { 'data-choice': 'diff', ...mark('diff') }, onClick: () => {
        const sheet = openSheet({ title, body: renderConflict(conflict, { ...options, onResolve: async (c, d) => { await options.onResolve(c, d); void sheet.close(true); } }) });
      } },
    ];
    const r: TrayRow = {
      id: conflict.requestId, title, medal: options.medal?.(conflict) ?? null, who,
      when: kt('Detectado {date}', { date: formatDate(conflict.detectedAt) }), clash, actions,
      attrs: { 'data-request-id': conflict.requestId, ...(options.feedbackId ? { 'data-feedback-id': options.feedbackId, 'data-feedback-label': 'Conflicto' } : {}) },
    };
    return r;
  };

  const groups = new Map<string, TrayGroup & { order: number }>();
  for (const c of conflicts) {
    const g = groupOf(c);
    if (!groups.has(g.key)) groups.set(g.key, { key: g.key, label: g.label, order: g.order ?? 0, rows: [] });
    groups.get(g.key)!.rows.push(row(c));
  }
  trayEl = renderTray({ label: kt('Conflictos'), groups: [...groups.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label)) });
  return trayEl;
}

/** Lista de conflictos o estado vacío. */
export function renderConflicts(conflicts: PendingConflict[], options: ConflictOptions & { emptyTitle?: string; emptyText?: string }): HTMLElement[] {
  if (options.layout === 'tray' && conflicts.length) return [renderConflictTray(conflicts, options)];
  if (conflicts.length === 0) {
    return [el('div', { class: 'empty' }, el('strong', null, options.emptyTitle ?? kt('Sin conflictos')), options.emptyText ?? kt('Todo lo tuyo se ha podido aplicar sin pisar cambios de nadie.'))];
  }
  return conflicts.map((conflict) => renderConflict(conflict, options));
}
