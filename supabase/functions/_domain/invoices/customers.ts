/**
 * Directorio de clientes por NIF (ronda 46): solo los datos fiscales de la factura. El borrador lo busca para rellenar
 * NIF y domicilio; al emitir con un NIF nuevo se ofrece guardarlo, y con uno guardado cuyos datos cambiaron, actualizarlo.
 */
import type { SyncedColumns } from './types.ts';
import type { IssuedAddress } from './issued.ts';

export interface CustomerRow extends SyncedColumns {
  name: string;
  tax_id: string;
  id_type: string;
  country: string;
  kind: 'empresa' | 'profesional' | 'particular' | null;
  address: IssuedAddress | null;
}

/** NIF en la forma guardada: mayúsculas, sin espacios, puntos ni barras. */
export function customerTaxId(value: string | null | undefined): string {
  return (value ?? '').toUpperCase().replace(/[\s./]/g, '');
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** Clientes vivos que casan con el texto (nombre o NIF), los que empiezan igual primero. Como mucho `limit`. */
export function searchCustomers<T extends Pick<CustomerRow, 'name' | 'tax_id' | 'deleted_at'>>(customers: readonly T[], query: string, limit = 5): T[] {
  const q = fold(query.trim());
  if (q.length < 2) return [];
  const qTax = customerTaxId(query);
  const scored = customers.filter((c) => !c.deleted_at).map((c) => {
    const name = fold(c.name);
    const score = c.tax_id === qTax ? 0 : name.startsWith(q) ? 1 : c.tax_id.startsWith(qTax) && qTax.length >= 2 ? 2 : name.includes(q) ? 3 : 99;
    return { c, score };
  }).filter((x) => x.score < 99);
  return scored.sort((a, b) => a.score - b.score || a.c.name.localeCompare(b.c.name)).slice(0, limit).map((x) => x.c);
}

export function findCustomerByTaxId<T extends Pick<CustomerRow, 'tax_id' | 'country' | 'deleted_at'>>(customers: readonly T[], taxId: string | null | undefined, country = 'ES'): T | null {
  const t = customerTaxId(taxId);
  if (!t) return null;
  return customers.find((c) => !c.deleted_at && c.tax_id === t && c.country === (country || 'ES')) ?? null;
}

const sameAddress = (a: IssuedAddress | null | undefined, b: IssuedAddress | null | undefined) =>
  ['line', 'postal_code', 'city', 'province', 'country'].every((k) => ((a as Record<string, unknown> | null)?.[k] ?? null) === ((b as Record<string, unknown> | null)?.[k] ?? null));

/** Qué ofrecer al emitir: guardar un cliente nuevo, actualizar uno guardado cuyos datos cambiaron, o nada. */
export function customerOffer(
  customers: readonly CustomerRow[],
  invoice: { recipient_name: string | null; recipient_tax_id: string | null; recipient_country: string | null; recipient_kind: string | null; recipient_address: IssuedAddress | null; recipient_id_type: string | null },
): { action: 'create'; fields: Record<string, unknown> } | { action: 'update'; customer: CustomerRow; fields: Record<string, unknown> } | null {
  const taxId = customerTaxId(invoice.recipient_tax_id);
  if (!taxId || !invoice.recipient_name?.trim()) return null;
  const fields = {
    name: invoice.recipient_name.trim(), tax_id: taxId, id_type: invoice.recipient_id_type ?? 'NIF', country: invoice.recipient_country ?? 'ES',
    kind: invoice.recipient_kind ?? null, address: invoice.recipient_address ?? null,
  };
  const existing = findCustomerByTaxId(customers, taxId, fields.country);
  if (!existing) return { action: 'create', fields };
  const changed = existing.name !== fields.name || existing.kind !== fields.kind || !sameAddress(existing.address, fields.address);
  return changed ? { action: 'update', customer: existing, fields: { name: fields.name, kind: fields.kind, address: fields.address } } : null;
}
