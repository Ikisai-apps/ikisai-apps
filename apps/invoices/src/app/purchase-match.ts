/** Al asignar una línea: la solicitud de compra abierta del mismo proveedor (sin DOM ni dependencias; tests/invoices/purchase-match.test.ts). */

export interface PurchaseRequestChoice { kind: string; archived: boolean; supplier?: string | null }

const normName = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/(s\.?\s?l\.?u?|s\.?\s?a\.?|sociedad limitada|sociedad anonima)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Propuesta al asignar una línea (ESTADO.md, nota de Core del 8-10): la solicitud de compra abierta del mismo proveedor,
 * solo si hay **una**. Compara la tienda de la solicitud con el nombre o el rótulo del proveedor, sin mayúsculas, tildes
 * ni la forma societaria. Sin tienda en las solicitudes (Tasks aún no la da), no propone nada.
 */
export function proposePurchaseRequest<T extends PurchaseRequestChoice>(requests: T[], supplierNames: Array<string | null | undefined>): T | null {
  const names = new Set(supplierNames.filter((n): n is string => !!n && !!n.trim()).map(normName).filter(Boolean));
  if (!names.size) return null;
  const same = requests.filter((r) => r.kind === 'purchase_request' && !r.archived && r.supplier && names.has(normName(r.supplier)));
  return same.length === 1 ? same[0]! : null;
}
