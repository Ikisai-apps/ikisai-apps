// Alta de proveedor desde otra app (Food, decisión de VG Q3 d, API.md §7.10, migración 0267). La pide el servidor de la
// app (`X-Ikisai-Caller: food` y la clave de worker) y Finance la escribe como «Finance (sistema)», sin duplicar: si ya hay
// un proveedor con ese NIF o ese nombre, lo devuelve.
import { ensureServiceActor, fail, type WorkerRoute } from '../_kit/mod.ts';
import { validSpanishTaxId } from '../_domain/invoices/mod.ts';

/** Apps que pueden dar de alta proveedores. */
export const SUPPLIER_CALLERS = ['food'] as const;

/** NIF opcional: si parece español se comprueba su dígito de control; un NIF-IVA de otro país pasa tal cual. */
export function checkSupplierTaxId(value: unknown): string | null {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return null;
  if (typeof value !== 'string') fail(422, 'INVALID_ARGS', 'El NIF tiene que ser texto.', { field: 'tax_id' });
  const raw = (value as string).toUpperCase().replace(/[\s./-]/g, '');
  const spanish = raw.startsWith('ES') ? raw.slice(2) : raw;
  const valid = validSpanishTaxId(spanish);
  if (valid) return valid;
  if (/^[A-Z]{2}[A-Z0-9]{2,13}$/.test(raw) && !raw.startsWith('ES')) return raw;
  fail(422, 'TAX_ID_INVALID', 'El NIF no es válido (revisa la letra o el dígito de control).', { field: 'tax_id' });
  return null;
}

export function supplierRoutes(): WorkerRoute[] {
  let service: Promise<string> | null = null;
  return [{
    method: 'POST', pattern: 'suppliers', handler: async ({ request, json, invoke, supabase }) => {
      const app = (request.headers.get('x-ikisai-caller') ?? '').trim().toLowerCase();
      if (!(SUPPLIER_CALLERS as readonly string[]).includes(app)) fail(403, 'CALLER_REJECTED', 'Solo el servidor de Food da de alta proveedores.');
      const body = (await json().catch(() => null)) as { name?: unknown; tax_id?: unknown } | null;
      if (typeof body?.name !== 'string' || !body.name.trim()) fail(422, 'INVALID_ARGS', 'Falta el nombre.', { field: 'name' });
      const tax_id = checkSupplierTaxId(body!.tax_id);
      await (service ??= ensureServiceActor(supabase, 'invoices').catch((error) => { service = null; throw error; }));
      return invoke('invoices.register_supplier', { app, name: body!.name, tax_id });
    },
  }];
}
