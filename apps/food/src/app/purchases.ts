/**
 * Compras reales de ingredientes, leídas de Invoices (`invoices.food_stock_projection`, lectura registrada para Food).
 * Como los eventos, no es una tabla sincronizable: la última respuesta se guarda en `ikisai-food-cache-v1` para
 * calcular costes sin red. Se borra al cerrar sesión con el resto de la caché.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { ingredientPrices, type FoodPurchase, type IngredientPrice } from '@ikisai/domain-food';

const DATABASE = 'ikisai-food-cache-v1';
const STORE = 'kv';
const KEY = 'purchases';
const MIN_REFRESH_MS = 60_000;

export interface PurchasesSnapshot {
  purchases: FoodPurchase[];
  prices: Map<string, IngredientPrice[]>;
  fetchedAt: string | null;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readCache(): Promise<{ purchases: FoodPurchase[]; fetchedAt: string | null } | null> {
  try {
    const db = await open();
    return await new Promise((resolve) => {
      const request = db.transaction(STORE).objectStore(STORE).get(KEY);
      request.onsuccess = () => { db.close(); resolve(request.result ?? null); };
      request.onerror = () => { db.close(); resolve(null); };
    });
  } catch {
    return null;
  }
}

async function writeCache(value: { purchases: FoodPurchase[]; fetchedAt: string }): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, KEY);
      tx.oncomplete = tx.onerror = () => { db.close(); resolve(); };
    });
  } catch {
    // sin IndexedDB se trabaja con lo que haya en memoria
  }
}

let current: PurchasesSnapshot = { purchases: [], prices: new Map(), fetchedAt: null };
let loaded = false;
let lastAttempt = 0;
let inFlight: Promise<PurchasesSnapshot> | null = null;

const snapshotOf = (purchases: FoodPurchase[], fetchedAt: string | null): PurchasesSnapshot => ({ purchases, prices: ingredientPrices(purchases), fetchedAt });

/** Compras y precios medios: de la caché y, con red, refrescados de Invoices (como mucho una vez por minuto). */
export function loadPurchases(client: SyncClient): Promise<PurchasesSnapshot> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    if (!loaded) {
      const cached = await readCache();
      if (cached) current = snapshotOf(cached.purchases, cached.fetchedAt);
      loaded = true;
    }
    if (navigator.onLine && client.session() && Date.now() - lastAttempt > MIN_REFRESH_MS) {
      lastAttempt = Date.now();
      try {
        const out = await client.api<{ rows: FoodPurchase[] }>('/read/invoices.food_stock_projection?where[target_kind]=ingredient&limit=2000');
        const fetchedAt = new Date().toISOString();
        current = snapshotOf(out.rows, fetchedAt);
        await writeCache({ purchases: out.rows, fetchedAt });
      } catch {
        // sin acceso a Invoices o sin red: se sigue con la caché
      }
    }
    return current;
  })().finally(() => { inFlight = null; });
  return inFlight;
}
