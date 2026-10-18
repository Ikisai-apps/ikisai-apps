/**
 * Food · Recursos (R5; docs/resources/API.md §1 y §3; docs/food/API.md §2.7).
 *
 * Segundo `sync-client`, contra `/api/v1/resources`, con la sesión de Food: artículos, conversiones, lotes, movimientos
 * y espacios en su propio espejo, también sin red.
 *
 * **Enlace (R5a):** al abrir la app y cuando cambian ingredientes, máquinas o artículos, un editor deja cada ingrediente
 * y cada máquina de Food enlazados con su artículo (lo crea si hace falta) y copia al artículo lo que Food escribe. Solo
 * con red, y primero en Recursos: el lote de Food no sale hasta que el artículo está en el servidor, para que su
 * comprobación (`INVALID_ITEM`) no lo rechace. Si algo falla, la siguiente vez se retoma sin duplicar nada.
 */
import { createSyncClient, type RowOperation, type SyncClient, type TableName } from '@ikisai/sync-client';
import { linkOperations, linkPlan, type Equipment, type Ingredient, type ResourceItem } from '@ikisai/domain-food';
import { T, type Mirror } from './client.ts';

export const R = {
  items: 'resources.items',
  itemUnits: 'resources.item_units',
  lots: 'resources.lots',
  movements: 'resources.movements',
  spaces: 'resources.spaces',
  // Para las piezas del kit (catálogo, ficha y sitios de la Despensa).
  itemKinds: 'resources.item_kinds',
  movementCosts: 'resources.movement_costs',
  spaceKinds: 'resources.space_kinds',
  counts: 'resources.counts',
  countLines: 'resources.count_lines',
} as const satisfies Record<string, TableName>;

let resources: SyncClient | null = null;
let offLinker: (() => void) | null = null;

/** El cliente de Recursos de esta sesión (uno por app). */
export function resourcesClient(client: SyncClient): SyncClient {
  resources ??= createSyncClient({ app: 'resources', apiBase: '/api/v1/resources', sessionFrom: client, clearOnLogout: true, tables: Object.values(R), pullIntervalMs: 30_000 });
  return resources;
}

/** Arranca Recursos y el enlace, sin esperar: Food funciona igual mientras tanto. */
export function startResources(client: SyncClient): void {
  const r = resourcesClient(client);
  void (async () => {
    try {
      await r.start();
    } catch (error) {
      console.warn('[food] Recursos sin red o sin acceso', error);
    }
    offLinker?.();
    offLinker = installLinker(client, r);
    // Consumo que lleva 24 h sin confirmar (R5c): se descuenta solo, al abrir y al volver la red.
    const auto = () => void import('./consumption.ts').then(({ autoConsume }) => autoConsume(client)).catch((error) => console.warn('[food] consumo automático pendiente', error));
    setTimeout(auto, 3000);
    window.addEventListener('online', auto);
  })();
}

const canWrite = (role: string | null | undefined) => role === 'editor' || role === 'owner';

/** Un enlace cada vez, agrupando los avisos que llegan seguidos. */
function installLinker(client: SyncClient, r: SyncClient): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  const run = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      await linkResources(client, r);
    } catch (error) {
      console.warn('[food] enlace con Recursos pendiente', error);
    } finally {
      running = false;
      if (again) { again = false; schedule(); }
    }
  };
  const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void run(), 800); };
  const offs = [client.onTable(T.ingredients, schedule), client.onTable(T.equipment, schedule), r.onTable(R.items, schedule)];
  window.addEventListener('online', schedule);
  schedule();
  return () => { if (timer) clearTimeout(timer); offs.forEach((off) => off()); window.removeEventListener('online', schedule); };
}

/** Enlaza lo que falte y copia al artículo lo que haya cambiado en Food. Devuelve cuántos pasos ha dado. */
export async function linkResources(client: SyncClient, r: SyncClient): Promise<number> {
  if (!navigator.onLine || !canWrite(client.bootstrap()?.membership.role) || !canWrite(r.bootstrap()?.membership.role)) return 0;
  if (client.status().conflicts > 0 || r.status().conflicts > 0) return 0;
  const [ingredients, equipment, items] = await Promise.all([
    client.list(T.ingredients) as Promise<Array<Mirror<Ingredient>>>,
    client.list(T.equipment) as Promise<Array<Mirror<Equipment>>>,
    r.list(R.items) as unknown as Promise<Array<Mirror<ResourceItem & { revision: number }>>>,
  ]);
  // Lo que aún no ha llegado al servidor se enlaza la próxima vez (el id de Food tiene que existir allí).
  const steps = linkPlan(ingredients.filter((i) => !i._pending), equipment.filter((e) => !e._pending), items);
  if (!steps.length) return 0;
  const ops = linkOperations(steps, {
    items: new Map(items.map((i) => [i.id, i.revision])),
    ingredients: new Map(ingredients.map((i) => [i.id, i.revision])),
    equipment: new Map(equipment.map((e) => [e.id, e.revision])),
  });
  if (ops.resources.length) {
    await r.commit(ops.resources as RowOperation[]);
    await r.sync();
    if (r.status().pendingCommands > 0) return 0; // aún no está en el servidor: la próxima vez
  }
  if (ops.food.length) await client.commit(ops.food as RowOperation[]);
  return steps.length;
}
