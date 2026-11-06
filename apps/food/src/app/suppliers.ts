/**
 * Proveedores de Finance para la compra (C2, FB_2026_086; decisión de VG Q3 d, 06-11): leídos de la vista que Finance
 * registra para Food (`invoices.food_supplier_projection`) y dados de alta por food-api (`POST suppliers`), que los crea en
 * Finance con la identidad de servicio de Food. Sin red o sin acceso a Finance, la lista es `null` y la compra sigue con
 * la tienda en texto libre.
 */
import type { SyncClient } from '@ikisai/sync-client';

/** `active: false`: en la papelera de Finance. No se ofrece para elegir, pero su nombre se sigue enseñando. */
export interface FinanceSupplier { id: string; name: string; tax_id: string | null; active: boolean }

const MIN_REFRESH_MS = 60_000;
let current: FinanceSupplier[] | null = null;
let lastAttempt = 0;
let inFlight: Promise<FinanceSupplier[] | null> | null = null;

const byName = (a: FinanceSupplier, b: FinanceSupplier) => a.name.localeCompare(b.name, 'es');

/** Los proveedores de Finance por nombre, refrescados como mucho una vez por minuto; `null` si no se han podido leer. */
export function loadSuppliers(client: SyncClient): Promise<FinanceSupplier[] | null> {
  if (inFlight) return inFlight;
  if (!navigator.onLine || !client.session() || Date.now() - lastAttempt < MIN_REFRESH_MS) return Promise.resolve(current);
  lastAttempt = Date.now();
  inFlight = client.api<{ rows: FinanceSupplier[] }>('/read/invoices.food_supplier_projection?limit=5000')
    .then((out) => (current = [...out.rows].sort(byName)))
    .catch(() => current)
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** Los ya leídos, sin ir a la red. */
export const knownSuppliers = (): FinanceSupplier[] | null => current;

/** Da de alta un proveedor en Finance (o devuelve el que ya había con ese NIF o nombre: lo decide Finance) y lo añade a la lista. */
export async function createSupplier(client: SyncClient, input: { name: string; tax_id: string | null }): Promise<FinanceSupplier> {
  const out = await client.api<{ supplier: FinanceSupplier; created: boolean }>('/suppliers', { method: 'POST', json: input });
  const supplier = { ...out.supplier, active: true };
  current = [...(current ?? []).filter((s) => s.id !== supplier.id), supplier].sort(byName);
  return supplier;
}

/** El mismo nombre de tienda, sin mayúsculas ni espacios de más. */
export const sameName = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();
