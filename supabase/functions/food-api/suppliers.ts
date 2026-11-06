/**
 * Food · alta de proveedores en Finance desde la compra (C2, FB_2026_086; decisión de VG Q3 d, 06-11).
 *
 * El proveedor habitual del ingrediente y el de cada línea de la compra se eligen de los proveedores de Finance (la vista
 * `invoices.food_supplier_projection`, que el navegador lee como lectura registrada). Si no existe, se da de alta desde
 * Food con el nombre y, si se sabe, el NIF. El alta la hace Finance: la ruta de worker `POST /api/v1/worker/suppliers`
 * (docs/invoices/API.md §7.10), con la clave de worker y `X-Ikisai-Caller: food`, que un navegador no tiene. Finance
 * comprueba el NIF, busca uno igual (por NIF y, si no, por nombre) y devuelve ese en vez de crear otro.
 */
import { fail, type AppRoute } from '../_kit/mod.ts';

export const DEFAULT_INVOICES_API_BASE = 'https://finance.ikisai.com';

export interface FinanceSupplier { id: string; name: string; tax_id: string | null; active: boolean }

export interface SupplierOptions {
  /** Base de la API de Finance; en pruebas, una falsa. */
  invoicesApiBase?: string;
  invoicesFetch?: typeof fetch;
  workerKey?: string;
}

/** El nombre y el NIF de un alta, limpios; un nombre vacío o demasiado largo se rechaza aquí, el NIF lo valida Finance. */
export function supplierInput(body: Record<string, unknown>): { name: string; tax_id: string | null } {
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 1 || name.length > 200) fail(422, 'INVALID_OPERATION', 'El nombre del proveedor, entre 1 y 200 caracteres.');
  const tax = typeof body.tax_id === 'string' ? body.tax_id.trim() : '';
  if (tax.length > 32) fail(422, 'TAX_ID_INVALID', 'El NIF, como mucho 32 caracteres.');
  return { name, tax_id: tax || null };
}

/** `POST suppliers {name, tax_id?}`: el proveedor dado de alta en Finance, o el que ya había. Editor u owner de Food. */
export function supplierRoutes(options: SupplierOptions): AppRoute[] {
  const base = (options.invoicesApiBase ?? DEFAULT_INVOICES_API_BASE).replace(/\/$/, '');
  const transport = options.invoicesFetch ?? fetch;
  return [{
    method: 'POST', pattern: 'suppliers', handler: async ({ ctx, json }) => {
      if (!['editor', 'owner'].includes(ctx.membership.role)) fail(403, 'FORBIDDEN', 'Solo quien edita puede dar de alta un proveedor.');
      const input = supplierInput(((await json().catch(() => ({}))) ?? {}) as Record<string, unknown>);
      let response: Response;
      try {
        response = await transport(`${base}/api/v1/worker/suppliers`, {
          method: 'POST',
          headers: { 'X-Ikisai-Worker-Key': options.workerKey ?? '', 'X-Ikisai-Caller': 'food', 'Content-Type': 'application/json' },
          body: JSON.stringify(input), signal: AbortSignal.timeout(10_000),
        });
      } catch {
        fail(503, 'FINANCE_UNAVAILABLE', 'Finance no responde ahora mismo. Inténtalo más tarde.');
      }
      const out = await response.json().catch(() => ({})) as any;
      const code = out?.error?.code ?? out?.code ?? null;
      if (code === 'TAX_ID_INVALID') fail(422, 'TAX_ID_INVALID', 'Ese NIF no es válido.', { field: 'tax_id' });
      if (response.status >= 400 && response.status < 500) fail(422, 'FINANCE_REJECTED', out?.error?.message ?? 'Finance no ha aceptado el alta.', { error: out?.error ?? null });
      if (!response.ok || typeof out?.id !== 'string') fail(503, 'FINANCE_UNAVAILABLE', 'Finance no responde ahora mismo. Inténtalo más tarde.', { status: response.status });
      const supplier: FinanceSupplier = { id: out.id, name: String(out.name ?? input.name), tax_id: out.tax_id ?? null, active: out.active !== false };
      return { supplier, created: out.status === 'created' };
    },
  }];
}
