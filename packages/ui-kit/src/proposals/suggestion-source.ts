/**
 * Fuente real de la cola de propuestas: adaptador sobre las sugerencias de `sync-client` 0.7.0 (contrato §3.10).
 *
 * ```ts
 * const source = createSuggestionSource(client, { scope: 'all' });        // quien decide (editor u owner)
 * createProposalList({ mode: 'review', source, onApprove: source.approve, onReject: source.reject, renderDetail: source.renderPreview });
 *
 * const mine = createSuggestionSource(client, { scope: 'mine' });         // quien propone
 * createProposalList({ mode: 'mine', source: mine, onWithdraw: mine.withdraw });
 * ```
 *
 * - Las sugerencias **necesitan red** (no van por el espejo): sin conexión, se avisa en vez de fingir que se guardó.
 * - Aprobar aplica el lote en el servidor como un commit de quien aprueba; si ya no encaja, sigue pendiente y se
 *   enseña el motivo del servidor.
 * - Errores del contrato con texto claro: `SUGGESTION_NOT_ALLOWED`, `SUGGESTION_UNAVAILABLE`, `TOO_MANY_SUGGESTIONS`.
 */
import type { Suggestion, SyncClient } from '@ikisai/sync-client';
import { el } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';
import { renderChangeList, type ChangeField, type ChangeItem } from '../agents/agents.ts';
import type { ProposalItem, ProposalSource } from './list.ts';

export interface SuggestionSourceOptions {
  /** `mine` (por defecto): las propias. `pending` o `all`: las de la app, para quien decide (`all` llena también «Aprobadas» y «Descartadas»). */
  scope?: 'mine' | 'pending' | 'all';
  /** Otra app (las propias hechas desde Guests a Food, p. ej.). */
  app?: string;
  limit?: number;
  /** Nombres de tablas para la vista previa («food.menu_items» → «plato»). */
  tables?: Record<string, { one: string; many?: string }>;
  /** Nombres de campos para la vista previa (`name` → «Nombre»). */
  fields?: Record<string, string>;
}

export interface SuggestionSource extends ProposalSource {
  list(): Promise<ProposalItem[]>;
  pendingCount(): number | null;
  /** Para `onApprove`, `onReject` y `onWithdraw` de `createProposalList`. */
  approve(item: ProposalItem, comment: string | null): Promise<void>;
  reject(item: ProposalItem, comment: string | null): Promise<void>;
  withdraw(item: ProposalItem): Promise<void>;
  /** Antes y después del lote, sin escribir, como lista de cambios (para `renderDetail`). */
  renderPreview(item: ProposalItem): Promise<HTMLElement>;
}

/** Sugerencia de la API → propuesta del componente (misma forma, sin el lote). */
export function proposalFromSuggestion(s: Suggestion): ProposalItem {
  return {
    id: s.id, app: s.app, kind: s.kind, label: s.label, summary: s.summary, detail: s.detail, author: s.author,
    createdAt: s.createdAt, status: s.status, comment: s.comment, decidedBy: s.decidedBy, decidedAt: s.decidedAt, result: s.result,
  };
}

const SUGGESTION_ERRORS: Record<string, string> = {
  SUGGESTION_NOT_ALLOWED: 'No tienes permiso para hacer esto con esta propuesta.',
  SUGGESTION_UNAVAILABLE: 'Esta propuesta ya no está pendiente.',
  TOO_MANY_SUGGESTIONS: 'Hay demasiadas propuestas tuyas pendientes; espera a que se revisen.',
  NETWORK: 'Sin conexión: las propuestas necesitan red.',
};

/** Error de la API → texto para la persona (el del servidor si no es uno de los conocidos). */
export function suggestionErrorMessage(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  if (code && SUGGESTION_ERRORS[code]) return kt(SUGGESTION_ERRORS[code]!);
  return (error as Error | null)?.message || kt('El servidor no lo ha aceptado.');
}

const META = new Set(['id', 'revision', 'created_at', 'updated_at', 'updated_by', 'deleted_at', 'createdAt', 'updatedAt', 'updatedBy', 'deletedAt']);

function show(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value ? kt('Sí') : kt('No');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Cambios de `previewSuggestion` (`{ table, id, op, before, after }`) → `ChangeItem` de `renderChangeList`. */
export function changesFromPreview(changes: unknown[], options: Pick<SuggestionSourceOptions, 'tables' | 'fields'> = {}): ChangeItem[] {
  return changes.map((raw) => {
    const c = (raw ?? {}) as { table?: string; id?: string; op?: string; before?: Record<string, unknown> | null; after?: Record<string, unknown> | null };
    const table = String(c.table ?? '');
    const names = options.tables?.[table];
    const short = names?.one ?? (table.split('.').pop() || table);
    const before = c.before ?? null;
    const after = c.after ?? null;
    const row = after ?? before ?? {};
    const titled = row.name ?? row.title ?? row.summary ?? row.label;
    const fields: ChangeField[] = [];
    const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
    for (const key of keys) {
      if (META.has(key)) continue;
      const b = before ? show(before[key]) : undefined;
      const a = after ? show(after[key]) : undefined;
      if (c.op === 'delete' || b === a) continue;
      if (!before && a === null) continue;
      fields.push({ label: options.fields?.[key] ?? key, ...(before ? { before: b } : {}), ...(after ? { after: a } : {}) });
    }
    return {
      op: String(c.op ?? 'update'), table: short, ...(names?.many ? { tablePlural: names.many } : {}),
      title: titled !== undefined && titled !== null && titled !== '' ? String(titled) : kt('Un registro de {table}', { table: short }),
      ...(fields.length ? { fields } : {}), ...(c.id ? { id: String(c.id) } : {}),
    };
  });
}

export function createSuggestionSource(client: SyncClient, options: SuggestionSourceOptions = {}): SuggestionSource {
  let pending: number | null = null;
  const fail = (error: unknown): never => { throw new Error(suggestionErrorMessage(error)); };
  return {
    async list() {
      try {
        const res = await client.suggestions({ scope: options.scope ?? 'mine', ...(options.app ? { app: options.app } : {}), ...(options.limit ? { limit: options.limit } : {}) });
        pending = res.pendingCount;
        return res.items.map(proposalFromSuggestion);
      } catch (error) { return fail(error); }
    },
    pendingCount: () => pending,
    async approve(item, comment) {
      try { await client.decideSuggestion(item.id, 'approve', comment ? { comment } : {}); } catch (error) { fail(error); }
    },
    async reject(item, comment) {
      try { await client.decideSuggestion(item.id, 'reject', comment ? { comment } : {}); } catch (error) { fail(error); }
    },
    async withdraw(item) {
      try { await client.withdrawSuggestion(item.id, options.app ? { app: options.app } : {}); } catch (error) { fail(error); }
    },
    async renderPreview(item) {
      try {
        const res = await client.previewSuggestion(item.id);
        const changes = changesFromPreview(res.changes ?? [], options);
        return changes.length ? renderChangeList({ changes }) : el('p', { class: 'hint' }, kt('Sin cambios que enseñar.'));
      } catch (error) {
        return el('p', { class: 'hint' }, kt('No se ha podido ver el cambio: {message}', { message: suggestionErrorMessage(error) }));
      }
    },
  };
}
