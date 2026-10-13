/**
 * Fuente de datos real de los espacios: adaptador sobre el `sync-client` del módulo `resources` (docs/resources/API.md).
 *
 * ```ts
 * const resources = createSyncClient({ app: 'resources', apiBase: '/api/v1/resources', sessionFrom: client, clearOnLogout: true });
 * await resources.start();
 * const source = createSyncSpaceSource(resources);
 * createSpaceTree({ source, permissions: { edit: role !== 'reader', structure: role === 'owner' } });
 * ```
 *
 * - Lee el espejo local (`list`, `onTable`), así que funciona sin red; las filas con cambios sin confirmar van marcadas.
 * - Cada operación es **un lote** (`commit`) con la revisión de la fila: archivar o recuperar con todo lo de dentro va junto,
 *   como exige `ORPHAN_CHILD`, y «Duplicar» con sus camas también.
 * - Los tipos salen de `resources.space_kinds` (`listKinds`, `subscribeKinds`).
 * - Si el servidor rechaza un lote de esta fuente (`FORBIDDEN`, `INVALID_SPACE_PARENT`, `ORPHAN_CHILD`…), se enseña su
 *   mensaje tal cual (`onError`, por defecto un aviso del kit).
 */
import type { RowOperation, SyncClient, SyncedRow, TableName } from '@ikisai/sync-client';
import { kt } from '../i18n/i18n.ts';
import { toast } from '../toast.ts';
import type { SpaceAttribute, SpaceKind, SpaceRow, SpaceSource } from './model.ts';

const SPACES = 'resources.spaces' as TableName;
const KINDS = 'resources.space_kinds' as TableName;

/** Cómo se edita cada clave de `attributes` (docs/resources/API.md §2.3). */
const ATTRIBUTES: Record<string, SpaceAttribute> = {
  bookable: { key: 'bookable', label: 'Reservable', type: 'boolean' },
  capacity: { key: 'capacity', label: 'Capacidad', type: 'number', min: 0 },
  accessible: { key: 'accessible', label: 'Accesible', type: 'boolean' },
  en_suite: { key: 'en_suite', label: 'Baño propio', type: 'boolean' },
  bed_kind: { key: 'bed_kind', label: 'Tipo de cama', type: 'choice', options: [{ value: 'individual', label: 'Individual' }, { value: 'doble', label: 'Doble' }, { value: 'litera', label: 'Litera' }, { value: 'sofa_cama', label: 'Sofá cama' }] },
  extra_capacity: { key: 'extra_capacity', label: 'Plazas supletorias', type: 'number', min: 0 },
  storage: { key: 'storage', label: 'Conservación', type: 'choice', options: [{ value: 'ambiente', label: 'Ambiente' }, { value: 'frio', label: 'Frío' }, { value: 'congelado', label: 'Congelado' }] },
};

/** Fila de `resources.spaces` → forma del kit. */
export function spaceFromRow(row: SyncedRow): SpaceRow {
  return {
    id: row.id,
    parentId: (row.parent_id as string | null) ?? null,
    kind: String(row.kind),
    name: String(row.name ?? ''),
    publicName: (row.public_name as string | null) ?? null,
    code: (row.code as string | null) ?? null,
    position: Number(row.position ?? 0),
    active: row.active !== false,
    notes: (row.notes as string | null) ?? null,
    attributes: (row.attributes as Record<string, unknown> | null) ?? {},
    pending: row._pending === true,
  };
}

/** Campos del kit → columnas de `resources.spaces` (solo los que vienen). */
export function spaceToFields(fields: Partial<SpaceRow>): Record<string, unknown> {
  const map: Record<string, string> = { parentId: 'parent_id', kind: 'kind', name: 'name', publicName: 'public_name', code: 'code', position: 'position', active: 'active', notes: 'notes', attributes: 'attributes' };
  const out: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(map)) if (key in fields) out[column] = (fields as Record<string, unknown>)[key];
  return out;
}

/** Fila de `resources.space_kinds` → tipo del kit (`root` en `parents` = puede ir en la raíz). */
export function kindFromRow(row: SyncedRow): SpaceKind {
  const parents = ((row.parents as string[] | null) ?? []).filter((p) => p !== 'root');
  const level = Math.min(4, Math.max(1, Number(row.level ?? 1))) as SpaceKind['level'];
  const attributes = ((row.attribute_keys as string[] | null) ?? []).map((key) => {
    const def = ATTRIBUTES[key] ?? { key, label: key, type: 'boolean' as const };
    return row.kind === 'cama' && key === 'capacity' ? { ...def, label: 'Plazas fijas' } : def;
  });
  return { kind: String(row.kind), label: String(row.label ?? row.kind), level, ...(parents.length && level > 1 ? { parents } : {}), attributes };
}

export interface SyncSpaceSourceOptions {
  /** Rechazo del servidor de un lote de esta fuente, con su mensaje tal cual. Por defecto, un aviso del kit. */
  onError?: (message: string, code: string) => void;
}

export function createSyncSpaceSource(client: SyncClient, options: SyncSpaceSourceOptions = {}): SpaceSource & {
  listKinds(): Promise<SpaceKind[]>;
  subscribeKinds(listener: (kinds: SpaceKind[]) => void): () => void;
  destroy(): void;
} {
  /** Última fila vista de cada espacio (para `expectedRevision`). */
  const latest = new Map<string, SyncedRow>();
  const mine = new Set<string>();
  const reported = new Set<string>();
  const report = options.onError ?? ((message: string) => toast(kt('No se ha guardado: {message}', { message })));

  const remember = (rows: SyncedRow[]) => { latest.clear(); rows.forEach((r) => latest.set(r.id, r)); };
  const read = async () => { const rows = await client.list(SPACES); remember(rows); return rows.map(spaceFromRow); };
  const revision = async (id: string) => (latest.get(id) ?? await client.get(SPACES, id))?.revision ?? 0;

  async function commit(operations: RowOperation[]): Promise<void> {
    if (!operations.length) return;
    const { requestId } = await client.commit(operations);
    mine.add(requestId);
  }

  async function setActive(ids: string[], active: boolean): Promise<void> {
    const ops: RowOperation[] = [];
    for (const id of ids) ops.push({ op: 'update', table: SPACES, id, expectedRevision: await revision(id), fields: { active } });
    await commit(ops);
  }

  // Rechazos de nuestros lotes: se enseñan una vez, con el mensaje del servidor.
  const offStatus = client.onStatus((status) => {
    if (!status.rejected) return;
    void client.rejected().then((batches) => {
      for (const batch of batches) {
        if (!mine.has(batch.requestId) || reported.has(batch.requestId)) continue;
        reported.add(batch.requestId);
        report(batch.error?.message || batch.error?.code || kt('El servidor no lo ha aceptado.'), batch.error?.code ?? 'ERROR');
      }
    });
  });

  return {
    list: read,
    subscribe(listener) {
      return client.onTable(SPACES, (rows) => { remember(rows.filter((r) => !r.deleted_at)); listener(rows.filter((r) => !r.deleted_at).map(spaceFromRow)); });
    },
    async create(row) { await commit([{ op: 'insert', table: SPACES, id: row.id, fields: spaceToFields(row) }]); },
    async createMany(rows) { await commit(rows.map((row) => ({ op: 'insert' as const, table: SPACES, id: row.id, fields: spaceToFields(row) }))); },
    async update(id, fields) { await commit([{ op: 'update', table: SPACES, id, expectedRevision: await revision(id), fields: spaceToFields(fields) }]); },
    archive: (ids) => setActive(ids, false),
    restore: (ids) => setActive(ids, true),
    async listKinds() { return (await client.list(KINDS)).filter((r) => r.active !== false).sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0)).map(kindFromRow); },
    subscribeKinds(listener) {
      return client.onTable(KINDS, (rows) => listener(rows.filter((r) => !r.deleted_at && r.active !== false).sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0)).map(kindFromRow)));
    },
    destroy() { offStatus(); },
  };
}
