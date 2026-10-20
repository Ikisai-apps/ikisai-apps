/**
 * «Deshacer» de Finance (tanda 27): el cambio sale al momento y «Deshacer» envía el contrario, con los campos tal como
 * estaban y la revisión que haya entonces en el dispositivo. Nada queda retenido: si se cierra la app, lo hecho ya está
 * guardado (y en la cola si no hay red). El aviso es el `toastWithAction` del kit, que otro aviso no pisa.
 */
import type { SyncClient, TableName } from '@ikisai/sync-client';
import { toast, toastWithAction } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';

/** Mientras dura un «Deshacer», el rebase de la propia fila no es «cambios de otra persona» (lo mira `shell.ts`). */
let quietUntil = 0;
export function mergesAreOwn(): boolean {
  return Date.now() < quietUntil;
}
/** Para un «Deshacer» que no pasa por `commitWithUndo` (p. ej. devolver una validada a revisión desde Inicio). */
export function quietOwnMerges(ms = 8000): void {
  quietUntil = Math.max(quietUntil, Date.now() + ms);
}
const UNDO_MS = 6000;

export interface UndoableChange {
  table: TableName;
  id: string;
  /** Revisión de la fila al hacer el cambio. */
  revision: number;
  /** Lo que se cambia. */
  fields: Record<string, unknown>;
  /** Lo que había: lo que vuelve a poner «Deshacer» (las mismas claves). */
  before: Record<string, unknown>;
}

/** Copia de los campos de `row` que va a tocar el cambio (para `before`). */
export function pick(row: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
}

/**
 * Guarda el cambio y ofrece «Deshacer». Devuelve false si no se pudo guardar (el motivo ya se ha dicho).
 * `undoneMessage` es lo que se dice al deshacer («Vuelve a estar sin confirmar.»).
 */
export async function commitWithUndo(client: SyncClient, change: UndoableChange, message: string, undoneMessage: string, onUndone?: () => void): Promise<boolean> {
  try {
    await client.commit([{ op: 'update', table: change.table, id: change.id, expectedRevision: change.revision, fields: change.fields }]);
  } catch (error) {
    toast(describeError(error));
    return false;
  }
  offerUndo(client, change, message, undoneMessage, onUndone);
  return true;
}

/**
 * Solo el aviso con «Deshacer», para un cambio que ya se ha guardado por otro camino (p. ej. el enlace de un artículo).
 * `beforeUndo` hace lo propio antes (quitar un enlace aplazado); si devuelve true, no hace falta enviar nada.
 */
export function offerUndo(client: SyncClient, change: Pick<UndoableChange, 'table' | 'id' | 'before'>, message: string, undoneMessage: string, onUndone?: () => void, beforeUndo?: () => boolean): void {
  const offline = client.status().network === 'offline';
  quietUntil = Date.now() + UNDO_MS + 4000;
  toastWithAction(offline ? `${message} Se sincronizará cuando haya red.` : message, {
    label: 'Deshacer',
    onClick: () => {
      if (beforeUndo?.()) { toast(undoneMessage); onUndone?.(); return; }
      void undo(client, change, undoneMessage).then((ok) => { if (ok) onUndone?.(); });
    },
  }, UNDO_MS);
}

async function undo(client: SyncClient, change: Pick<UndoableChange, 'table' | 'id' | 'before'>, undoneMessage: string): Promise<boolean> {
  quietUntil = Date.now() + 8000;
  try {
    const row = (await client.get(change.table, change.id)) as { revision: number } | null;
    if (!row) { toast('Ya no está en este dispositivo: no se puede deshacer.'); return false; }
    await client.commit([{ op: 'update', table: change.table, id: change.id, expectedRevision: row.revision, fields: change.before }]);
    toast(undoneMessage);
    return true;
  } catch (error) {
    toast(describeError(error));
    return false;
  }
}

/** «Deshacer» de filas recién creadas (p. ej. asignaciones desde Compras): las borra con la revisión del dispositivo. */
export function offerUndoInsert(client: SyncClient, table: TableName, ids: string[], message: string, undoneMessage: string, onUndone?: () => void): void {
  quietUntil = Date.now() + UNDO_MS + 4000;
  toastWithAction(client.status().network === 'offline' ? `${message} Se sincronizará cuando haya red.` : message, {
    label: 'Deshacer',
    onClick: () => void (async () => {
      quietUntil = Date.now() + 8000;
      try {
        const rows = (await Promise.all(ids.map((id) => client.get(table, id)))) as Array<{ id: string; revision: number } | null>;
        const ops = rows.filter((r): r is { id: string; revision: number } => !!r).map((r) => ({ op: 'delete' as const, table, id: r.id, expectedRevision: r.revision }));
        if (ops.length) await client.commit(ops);
        toast(undoneMessage);
        onUndone?.();
      } catch (error) { toast(describeError(error)); }
    })(),
  }, UNDO_MS);
}
