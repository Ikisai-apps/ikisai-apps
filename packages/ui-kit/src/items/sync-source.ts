/**
 * Fuente real de artículos: adaptador sobre el `sync-client` del módulo `resources` (docs/resources/API.md §3).
 *
 * ```ts
 * const resources = createSyncClient({ app: 'resources', apiBase: '/api/v1/resources', sessionFrom: client, clearOnLogout: true });
 * await resources.start();
 * const items = createSyncItemSource(resources, { supplierName: (id) => suppliers.get(id)?.name ?? null });
 * createItemPicker({ label: 'Ingrediente', source: items, kinds: ['ingrediente', 'bebida'], quantity: true });
 * ```
 *
 * - Lee el espejo (`items`, `item_units`, `item_kinds` y `movements`), así que funciona sin red; el stock es la suma de
 *   movimientos del espejo, como permite la API.
 * - Crear es un lote con una sola alta; sin red queda pendiente y se sube al volver.
 * - **Nombre repetido entre dos dispositivos sin red:** el servidor rechaza la segunda alta (`CONSTRAINT_VIOLATION`, índice
 *   único por nombre). La fuente descarta ese lote, busca el que ya existe en el espejo y avisa con `onDuplicate`;
 *   `createItemPicker` lo enseña como «Ya existe «X»: usar ese» y la app reapunta su línea.
 */
import type { RowOperation, SyncClient, SyncedRow, TableName } from '@ikisai/sync-client';
import { kt } from '../i18n/i18n.ts';
import { toast } from '../toast.ts';
import {
  DEFAULT_ITEM_KINDS, itemFromRow, itemKey, itemKindFromRow, itemUnitFromRow, stockFromMovements,
  type ItemDuplicate, type ItemSnapshot, type ItemSource,
} from './model.ts';

const ITEMS = 'resources.items' as TableName;
const UNITS = 'resources.item_units' as TableName;
const KINDS = 'resources.item_kinds' as TableName;
const MOVEMENTS = 'resources.movements' as TableName;

export interface SyncItemSourceOptions {
  /** Nombre visible de un proveedor de Finance (`default_supplier_id`, `supplier_id`). */
  supplierName?: (id: string) => string | null;
  /** Otros rechazos de las altas de esta fuente, con el mensaje del servidor. Por defecto, un aviso del kit. */
  onError?: (message: string, code: string) => void;
}

export function createSyncItemSource(client: SyncClient, options: SyncItemSourceOptions = {}): ItemSource & { destroy(): void } {
  const tables: Record<string, SyncedRow[]> = { [ITEMS]: [], [UNITS]: [], [KINDS]: [], [MOVEMENTS]: [] };
  const listeners = new Set<(s: ItemSnapshot) => void>();
  const dupListeners = new Set<(d: ItemDuplicate) => void>();
  const mine = new Map<string, { draftId: string; name: string }>();
  const handled = new Set<string>();
  const report = options.onError ?? ((message: string) => toast(kt('No se ha guardado: {message}', { message })));

  const live = (rows: SyncedRow[]) => rows.filter((r) => !r.deleted_at);
  function snapshot(): ItemSnapshot {
    const kinds = live(tables[KINDS]!).filter((r) => r.active !== false).sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0)).map(itemKindFromRow);
    return {
      items: live(tables[ITEMS]!).map(itemFromRow),
      units: live(tables[UNITS]!).map(itemUnitFromRow),
      kinds: kinds.length ? kinds : DEFAULT_ITEM_KINDS,
      stock: stockFromMovements(tables[MOVEMENTS]!),
    };
  }
  const emit = () => { const s = snapshot(); listeners.forEach((l) => l(s)); };
  async function load(): Promise<ItemSnapshot> {
    for (const table of Object.keys(tables)) tables[table] = await client.list(table as TableName);
    return snapshot();
  }

  const offTables = Object.keys(tables).map((table) => client.onTable(table as TableName, (rows) => { tables[table] = rows; emit(); }));

  // Rechazos de nuestras altas: el nombre repetido se resuelve con el existente; lo demás se enseña.
  const offStatus = client.onStatus((status) => {
    if (!status.rejected) return;
    void client.rejected().then(async (batches) => {
      for (const batch of batches) {
        const draft = mine.get(batch.requestId);
        if (!draft || handled.has(batch.requestId)) continue;
        handled.add(batch.requestId);
        if (batch.error?.code === 'CONSTRAINT_VIOLATION') {
          await client.discardRejected(batch.requestId);
          if (!tables[ITEMS]!.some((r) => itemKey(String(r.name ?? '')) === itemKey(draft.name) && r.id !== draft.draftId)) {
            try { await client.sync(); tables[ITEMS] = await client.list(ITEMS); } catch { /* sin red: se verá al volver */ }
          }
          const row = live(tables[ITEMS]!).find((r) => itemKey(String(r.name ?? '')) === itemKey(draft.name) && r.id !== draft.draftId);
          const dup: ItemDuplicate = { draftId: draft.draftId, name: draft.name, existing: row ? itemFromRow(row) : null };
          dupListeners.forEach((l) => l(dup));
        } else {
          report(batch.error?.message || batch.error?.code || kt('El servidor no lo ha aceptado.'), batch.error?.code ?? 'ERROR');
        }
      }
    });
  });

  return {
    list: load,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async create(draft) {
      const op: RowOperation = {
        op: 'insert', table: ITEMS, id: draft.id,
        fields: { name: draft.name.trim(), kind: draft.kind, base_unit: draft.baseUnit, ...(draft.defaultSpaceId ? { default_space_id: draft.defaultSpaceId } : {}) },
      };
      const { requestId } = await client.commit([op]);
      mine.set(requestId, { draftId: draft.id, name: draft.name });
    },
    onDuplicate(listener) { dupListeners.add(listener); return () => dupListeners.delete(listener); },
    supplierName: (id) => options.supplierName?.(id) ?? null,
    destroy() { offTables.forEach((off) => off()); offStatus(); listeners.clear(); dupListeners.clear(); },
  };
}
