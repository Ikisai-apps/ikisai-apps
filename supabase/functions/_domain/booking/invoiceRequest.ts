/**
 * Factura a petición de las noches (VG, vg-38: ticket de Finance siempre y factura con NIF a petición; contrato con Finance
 * del 27-10-2026). Booking no guarda los datos fiscales: los comprueba por forma y los reenvía a Finance
 * (`worker/entry-invoice`), que valida el NIF con su dígito de control (`TAX_ID_INVALID`) y los guarda en la factura.
 */
export const INVOICE_ID_TYPES = ['NIF', '02', '03', '04', '05', '06'] as const;
export type InvoiceIdType = (typeof INVOICE_ID_TYPES)[number];

export interface InvoiceCustomer {
  name: string;
  tax_id: string;
  id_type: InvoiceIdType;
  country: string;
  kind: 'particular' | 'empresa';
  address?: { line: string; postal_code: string; city: string; province?: string; country: string };
}

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** El destinatario normalizado, o el campo que falla (para pintarlo en el formulario). */
export function checkInvoiceCustomer(raw: unknown): { customer: InvoiceCustomer } | { field: string } {
  const c = (raw ?? {}) as Record<string, unknown>;
  const name = text(c.name, 200);
  if (!name) return { field: 'name' };
  const taxId = text(c.tax_id, 30)?.toUpperCase().replace(/[\s.-]/g, '') ?? null;
  if (!taxId || !/^[A-Z0-9]{2,30}$/.test(taxId)) return { field: 'tax_id' };
  const idType = (c.id_type ?? 'NIF') as InvoiceIdType;
  if (!INVOICE_ID_TYPES.includes(idType)) return { field: 'id_type' };
  const country = (text(c.country, 2) ?? 'ES').toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return { field: 'country' };
  const kind = c.kind === 'empresa' ? 'empresa' : c.kind === undefined || c.kind === null || c.kind === 'particular' ? 'particular' : null;
  if (!kind) return { field: 'kind' };
  const a = c.address as Record<string, unknown> | null | undefined;
  let address: InvoiceCustomer['address'];
  if (a && typeof a === 'object') {
    const line = text(a.line, 200); const postal = text(a.postal_code, 20); const city = text(a.city, 120);
    if (!line || !postal || !city) return { field: 'address' };
    const province = text(a.province, 120);
    address = { line, postal_code: postal, city, ...(province ? { province } : {}), country: (text(a.country, 2) ?? country).toUpperCase() };
  }
  if (kind === 'empresa' && !address) return { field: 'address' };
  return { customer: { name, tax_id: taxId, id_type: idType, country, kind, ...(address ? { address } : {}) } };
}
