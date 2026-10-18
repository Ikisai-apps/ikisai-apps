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
 * - Lee el espejo (`items`, `item_units`, `item_kinds`, `movements`, `lots` y `movement_costs`), así que funciona sin red;
 *   el stock es la suma de movimientos del espejo, como permite la API, y el coste medio se calcula igual que `item_costs`.
 * - La ficha escribe con la revisión de la fila (`update`, `setActive`, `saveUnit`, `removeUnit`); los rechazos
 *   (`ITEM_IN_USE`, `INVALID_UNIT`…) se enseñan con el mensaje del servidor.
 * - Crear es un lote con una sola alta; sin red queda pendiente y se sube al volver.
 * - **Nombre repetido entre dos dispositivos sin red:** el servidor rechaza la segunda alta (`CONSTRAINT_VIOLATION`, índice
 *   único por nombre). La fuente descarta ese lote, busca el que ya existe en el espejo y avisa con `onDuplicate`;
 *   `createItemPicker` lo enseña como «Ya existe «X»: usar ese» y la app reapunta su línea.
 */
import type { RowOperation, SyncClient, SyncedRow, TableName } from '@ikisai/sync-client';
import { kt } from '../i18n/i18n.ts';
import { toast } from '../toast.ts';
import {
  DEFAULT_ITEM_KINDS, itemFromRow, itemKey, itemKindFromRow, itemToFields, itemUnitFromRow, lotFromRow, movementFromRow, stockFromMovements,
  type ItemDuplicate, type ItemSnapshot, type ItemSource,
} from './model.ts';

const ITEMS = 'resources.items' as TableName;
const UNITS = 'resources.item_units' as TableName;
const KINDS = 'resources.item_kinds' as TableName;
const MOVEMENTS = 'resources.movements' as TableName;
const LOTS = 'resources.lots' as TableName;
const COSTS = 'resources.movement_costs' as TableName;

export interface SyncItemSourceOptions {
  /** Nombre visible de un proveedor de Finance (`default_supplier_id`, `supplier_id`). */
  supplierName?: (id: string) => string | null;
  /** Otros rechazos de las altas de esta fuente, con el mensaje del servidor. Por defecto, un aviso del kit. */
  onError?: (message: string, code: string) => void;
}

export function createSyncItemSource(client: SyncClient, options: SyncItemSourceOptions = {}): ItemSource & { destroy(): void } {
  const tables: Record<string, SyncedRow[]> = { [ITEMS]: [], [UNITS]: [], [KINDS]: [], [MOVEMENTS]: [], [LOTS]: [], [COSTS]: [] };
  const listeners = new Set<(s: ItemSnapshot) => void>();
  const dupListeners = new Set<(d: ItemDuplicate) => void>();
  const mine = new Map<string, { draftId: string; name: string }>();
  const handled = new Set<string>();
  /** Lotes de la ficha (cambios, unidades, archivar): sus rechazos se enseñan tal cual. */
  const edits = new Set<string>();
  async function commitOwn(operations: RowOperation[]): Promise<void> {
    const { requestId } = await client.commit(operations);
    edits.add(requestId);
  }
  const report = options.onError ?? ((message: string) => toast(kt('No se ha guardado: {message}', { message })));

  const live = (rows: SyncedRow[]) => rows.filter((r) => !r.deleted_at);
  function snapshot(): ItemSnapshot {
    const kinds = live(tables[KINDS]!).filter((r) => r.active !== false).sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0)).map(itemKindFromRow);
    return {
      items: live(tables[ITEMS]!).map(itemFromRow),
      units: live(tables[UNITS]!).map(itemUnitFromRow),
      kinds: kinds.length ? kinds : DEFAULT_ITEM_KINDS,
      stock: stockFromMovements(tables[MOVEMENTS]!),
      lots: live(tables[LOTS]!).map(lotFromRow),
      movements: live(tables[MOVEMENTS]!).map(movementFromRow),
      movementCosts: live(tables[COSTS]!).map((r) => ({ movementId: String(r.movement_id), unitCost: Number(r.unit_cost ?? 0) })),
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
        if (edits.has(batch.requestId) && !handled.has(batch.requestId)) {
          handled.add(batch.requestId);
          report(batch.error?.message || batch.error?.code || kt('El servidor no lo ha aceptado.'), batch.error?.code ?? 'ERROR');
          continue;
        }
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
    async update(id, fields) {
      const row = tables[ITEMS]!.find((r) => r.id === id) ?? await client.get(ITEMS, id);
      const current = row ? itemFromRow(row) : null;
      await commitOwn([{ op: 'update', table: ITEMS, id, expectedRevision: row?.revision ?? 0, fields: itemToFields(fields, current) }]);
    },
    async setActive(id, active) {
      const row = tables[ITEMS]!.find((r) => r.id === id) ?? await client.get(ITEMS, id);
      await commitOwn([{ op: 'update', table: ITEMS, id, expectedRevision: row?.revision ?? 0, fields: { active } }]);
    },
    async saveUnit(unit, isNew) {
      const fields = { item_id: unit.itemId, unit: unit.unit.trim(), factor: unit.factor, supplier_id: unit.supplierId };
      if (isNew) await commitOwn([{ op: 'insert', table: UNITS, id: unit.id, fields }]);
      else {
        const row = tables[UNITS]!.find((r) => r.id === unit.id) ?? await client.get(UNITS, unit.id);
        await commitOwn([{ op: 'update', table: UNITS, id: unit.id, expectedRevision: row?.revision ?? 0, fields }]);
      }
    },
    async removeUnit(id) {
      const row = tables[UNITS]!.find((r) => r.id === id) ?? await client.get(UNITS, id);
      await commitOwn([{ op: 'delete', table: UNITS, id, expectedRevision: row?.revision ?? 0 }]);
    },
    destroy() { offTables.forEach((off) => off()); offStatus(); listeners.clear(); dupListeners.clear(); },
  };
}
