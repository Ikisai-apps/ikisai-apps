/**
 * Finance · Recursos (R4; docs/invoices/API.md §16.16–§16.19; docs/resources/API.md §1 y §3).
 *
 * Con el interruptor `resources_links` encendido (`invoices.settings`), Finance abre un segundo `sync-client` contra
 * `/api/v1/resources` con su misma sesión: artículos, conversiones, tipos, movimientos y espacios en su propio espejo,
 * también sin red. Apagado, no se abre y la app se ve como antes.
 *
 * - **Nombres:** una línea enlazada se llama como su artículo en toda la app (`lineName`), y su conversión y su sitio se
 *   ven en la ficha.
 * - **Enlaces aplazados:** el servidor solo acepta el enlace con un artículo que ya tiene (`INVALID_RESOURCE_LINK`). Si el
 *   artículo o la conversión se acaban de crear sin red, el enlace se guarda en el dispositivo y sale cuando Recursos los
 *   ha subido (al volver la red o al sincronizar).
 */
import { createSyncClient, type RowOperation, type SyncClient, type SyncedRow, type TableName } from '@ikisai/sync-client';
import { INVOICE_LINES, SETTINGS } from './client.ts';

export const R = {
  items: 'resources.items',
  itemUnits: 'resources.item_units',
  itemKinds: 'resources.item_kinds',
  movements: 'resources.movements',
  spaces: 'resources.spaces',
  movementCosts: 'resources.movement_costs',
} as const satisfies Record<string, TableName>;

export interface LinkedItem { id: string; name: string; baseUnit: string; defaultSpaceId: string | null; pending: boolean }

let resources: SyncClient | null = null;
let enabled = false;
let items = new Map<string, LinkedItem>();
let spaces = new Map<string, string>();
let unitsPending = new Set<string>();
const listeners = new Set<() => void>();
const DEFERRED_KEY = 'ikisai-invoices-r4-deferred-links';

/** ¿Está encendido el enlace con Recursos? (lo último que se leyó de `invoices.settings`). */
export function linksEnabled(): boolean { return enabled; }
export function linkedItem(id: string | null | undefined): LinkedItem | null { return id ? items.get(id) ?? null : null; }
export function spaceName(id: string | null | undefined): string | null { return id ? spaces.get(id) ?? null : null; }
/** El cliente de Recursos (solo con el interruptor encendido). */
export function resourcesClient(): SyncClient | null { return enabled ? resources : null; }
/** Avisa cuando cambia el interruptor o el espejo de Recursos (para repintar). */
export function onResourcesChange(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
const notify = () => listeners.forEach((l) => l());

async function reloadMaps(r: SyncClient): Promise<void> {
  const [itemRows, spaceRows, unitRows] = await Promise.all([r.list(R.items), r.list(R.spaces), r.list(R.itemUnits)]);
  const pending = (row: SyncedRow) => (row as SyncedRow & { _pending?: boolean })._pending === true;
  items = new Map(itemRows.filter((x) => !x.deleted_at).map((x) => [x.id, { id: x.id, name: String(x.name), baseUnit: String(x.base_unit), defaultSpaceId: (x.default_space_id as string | null) ?? null, pending: pending(x) }]));
  spaces = new Map(spaceRows.filter((x) => !x.deleted_at).map((x) => [x.id, String(x.name)]));
  unitsPending = new Set(unitRows.filter(pending).map((x) => x.id));
}

/** Lee el interruptor y, encendido, arranca Recursos. Devuelve la función de baja. */
export function installResources(client: SyncClient): () => void {
  const offs: Array<() => void> = [];
  let started = false;
  const refresh = async () => {
    const rows = await client.list(SETTINGS);
    const on = rows.some((s) => !s.deleted_at && s.key === 'resources_links' && s.value === true);
    if (on === enabled && (started || !on)) return;
    enabled = on;
    if (on && !started) {
      started = true;
      resources ??= createSyncClient({ app: 'resources', apiBase: '/api/v1/resources', sessionFrom: client, clearOnLogout: true, tables: Object.values(R), pullIntervalMs: 30_000 });
      const r = resources;
      try { await r.start(); } catch (error) { console.warn('[invoices] Recursos sin red o sin acceso', error); }
      await reloadMaps(r);
      const changed = () => void reloadMaps(r).then(() => { notify(); void runDeferred(client); });
      for (const table of Object.values(R)) offs.push(r.onTable(table, changed));
    }
    notify();
    void runDeferred(client);
  };
  offs.push(client.onTable(SETTINGS, () => void refresh()));
  const online = () => void runDeferred(client);
  window.addEventListener('online', online);
  offs.push(() => window.removeEventListener('online', online));
  void refresh();
  return () => offs.forEach((off) => off());
}

interface DeferredLink { lineId: string; itemId: string; unitId: string | null; fields: Record<string, unknown> }

function readDeferred(): DeferredLink[] {
  try { return JSON.parse(localStorage.getItem(DEFERRED_KEY) ?? '[]') as DeferredLink[]; } catch { return []; }
}
function writeDeferred(list: DeferredLink[]): void {
  try { if (list.length) localStorage.setItem(DEFERRED_KEY, JSON.stringify(list)); else localStorage.removeItem(DEFERRED_KEY); } catch { /* sin almacenamiento: se pierde el aplazado */ }
}

/**
 * Enlaza la línea con el artículo. Si el artículo (o la conversión `unitId`) aún no está en el servidor, primero intenta
 * subir Recursos; sin red, guarda el enlace para después y devuelve `'deferred'`.
 */
export async function linkLine(client: SyncClient, lineId: string, itemId: string, unitId: string | null, fields: Record<string, unknown>): Promise<'saved' | 'deferred'> {
  const r = resources;
  if (r) await reloadMaps(r);
  // Un artículo que aún no está en el espejo (recién creado) cuenta como pendiente
  const waiting = () => (linkedItem(itemId)?.pending ?? true) || (unitId !== null && unitsPending.has(unitId));
  if (r && waiting() && navigator.onLine) {
    try { await r.sync(); await reloadMaps(r); } catch { /* se queda pendiente */ }
  }
  if (waiting()) {
    writeDeferred([...readDeferred().filter((d) => d.lineId !== lineId), { lineId, itemId, unitId, fields }]);
    return 'deferred';
  }
  await commitLine(client, lineId, fields);
  writeDeferred(readDeferred().filter((d) => d.lineId !== lineId));
  return 'saved';
}

async function commitLine(client: SyncClient, lineId: string, fields: Record<string, unknown>): Promise<void> {
  const line = (await client.list(INVOICE_LINES)).find((l) => l.id === lineId);
  if (!line) return;
  const op: RowOperation = { op: 'update', table: INVOICE_LINES, id: lineId, expectedRevision: line.revision, fields };
  await client.commit([op]);
}

let running = false;
/** Saca los enlaces aplazados cuyo artículo y conversión ya están en el servidor. */
export async function runDeferred(client: SyncClient): Promise<number> {
  if (running || !enabled) return 0;
  running = true;
  let done = 0;
  try {
    for (const d of readDeferred()) {
      if ((linkedItem(d.itemId)?.pending ?? true) || (d.unitId !== null && unitsPending.has(d.unitId))) continue;
      try {
        await commitLine(client, d.lineId, d.fields);
        writeDeferred(readDeferred().filter((x) => x.lineId !== d.lineId));
        done += 1;
      } catch (error) { console.warn('[invoices] enlace aplazado pendiente', error); }
    }
  } finally { running = false; }
  return done;
}

/** Entradas de Food de un artículo sin coste todavía («Ya entró desde la compra de Food»), las más recientes primero. */
export async function foodEntriesWithoutCost(itemId: string): Promise<Array<{ id: string; quantity: number; at: string; spaceId: string | null }>> {
  const r = resourcesClient();
  if (!r) return [];
  const [rows, costs] = await Promise.all([r.list(R.movements), r.list(R.movementCosts)]);
  const costed = new Set(costs.filter((c) => !c.deleted_at).map((c) => c.movement_id));
  return rows.filter((m) => !m.deleted_at && !costed.has(m.id) && m.item_id === itemId && m.kind === 'entrada_manual' && m.source_app === 'food' && Number(m.quantity) > 0 && (m.unit_cost === null || m.unit_cost === undefined))
    .map((m) => ({ id: m.id, quantity: Number(m.quantity), at: String(m.at ?? m.created_at), spaceId: (m.space_id as string | null) ?? null }))
    .sort((a, b) => b.at.localeCompare(a.at));
}
