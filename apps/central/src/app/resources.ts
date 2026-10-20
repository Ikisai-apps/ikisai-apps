/**
 * Central · Recursos (pantalla Inventario; docs/resources/API.md §1).
 *
 * Segundo `sync-client`, contra `/api/v1/resources`, con la sesión de Central: artículos, unidades, tipos, movimientos,
 * lotes, costes, espacios y dibujos de los planos en su propio espejo, también sin red. Arranca la primera vez que se abre Inventario; el espejo
 * queda en el dispositivo y se borra al cerrar sesión, con el principal.
 */
import { createSyncClient, type SyncClient, type TableName } from '@ikisai/sync-client';

/** Las tablas que leen `createSyncItemSource` (con el recuento de la 0.38) y `createSyncSpaceSource` del kit. */
export const R = {
  items: 'resources.items',
  itemUnits: 'resources.item_units',
  itemKinds: 'resources.item_kinds',
  movements: 'resources.movements',
  lots: 'resources.lots',
  movementCosts: 'resources.movement_costs',
  counts: 'resources.counts',
  countLines: 'resources.count_lines',
  spaces: 'resources.spaces',
  spaceKinds: 'resources.space_kinds',
  /** Mapa de zonas (0808): el dibujo de cada edificio y planta (Planos del centro). */
  floorPlans: 'resources.floor_plans',
} as const satisfies Record<string, TableName>;

let resources: SyncClient | null = null;
let started: Promise<unknown> | null = null;

/** El cliente de Recursos de esta sesión (uno por app). */
export function resourcesClient(client: SyncClient): SyncClient {
  resources ??= createSyncClient({ app: 'resources', apiBase: '/api/v1/resources', sessionFrom: client, clearOnLogout: true, tables: Object.values(R), pullIntervalMs: 30_000 });
  return resources;
}

/** Arranca Recursos sin esperar: la pantalla pinta el espejo mientras tanto. Si falla (sin red), se reintenta al volver. */
export function startResources(client: SyncClient): SyncClient {
  const r = resourcesClient(client);
  started ??= r.start().catch((error) => {
    console.warn('[central] Recursos sin red o sin acceso', error);
    started = null;
  });
  return r;
}
