// Factura con NIF a petición de un cobro de otra app (vg-38, API.md §17.13, migración 0261). La pide el servidor de la
// app dueña del apunte (hoy Booking, con `X-Ikisai-Caller: booking`) y Finance crea un borrador que alguien revisa y emite.
import { ensureServiceActor, fail, type WorkerRoute } from '../_kit/mod.ts';
import { validSpanishTaxId } from '../_domain/invoices/mod.ts';

/** Apps que pueden pedir factura de sus propios apuntes. */
export const ENTRY_INVOICE_CALLERS = ['booking'] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function callerOf(request: Request): string {
  const caller = (request.headers.get('x-ikisai-caller') ?? '').trim().toLowerCase();
  if (!(ENTRY_INVOICE_CALLERS as readonly string[]).includes(caller)) fail(403, 'CALLER_REJECTED', 'Solo el servidor de la app del cobro pide su factura.');
  return caller;
}

/** Destinatario: el NIF español (NIF, NIE o CIF) se comprueba con su dígito de control; el resto, en el SQL. */
export function checkCustomer(customer: unknown): Record<string, unknown> {
  if (!customer || typeof customer !== 'object' || Array.isArray(customer)) fail(422, 'INVALID_ARGS', 'Faltan los datos fiscales.', { field: 'customer' });
  const c = customer as Record<string, unknown>;
  const country = typeof c.country === 'string' && c.country.trim() ? c.country.trim().toUpperCase() : 'ES';
  const idType = typeof c.id_type === 'string' && c.id_type.trim() ? c.id_type.trim() : 'NIF';
  if (typeof c.tax_id !== 'string' || !c.tax_id.trim()) fail(422, 'INVALID_ARGS', 'Falta el NIF.', { field: 'customer.tax_id' });
  let taxId = c.tax_id as string;
  if (idType === 'NIF' && country === 'ES') {
    const valid = validSpanishTaxId(taxId);
    if (!valid) fail(422, 'TAX_ID_INVALID', 'El NIF no es válido (revisa la letra o el dígito de control).', { field: 'customer.tax_id' });
    taxId = valid!;
  }
  return { ...c, tax_id: taxId, id_type: idType, country };
}

export function entryInvoiceRoutes(): WorkerRoute[] {
  let service: Promise<string> | null = null;
  return [{
    method: 'POST', pattern: 'entry-invoice', handler: async ({ request, json, invoke, supabase }) => {
      const app = callerOf(request);
      const body = (await json().catch(() => null)) as { request_id?: unknown; source?: unknown; customer?: unknown } | null;
      if (typeof body?.request_id !== 'string' || !UUID.test(body.request_id)) fail(422, 'INVALID_ARGS', 'Falta request_id.', { field: 'request_id' });
      if (typeof body!.source !== 'string' || !body!.source.startsWith(`${app}:`)) fail(422, 'INVALID_ARGS', 'El cobro tiene que ser de la app que llama.', { field: 'source' });
      const customer = checkCustomer(body!.customer);
      // «Finance (sistema)» escribe el borrador (core.apply_system_operations la necesita).
      await (service ??= ensureServiceActor(supabase, 'invoices').catch((error) => { service = null; throw error; }));
      return invoke('invoices.entry_invoice_request', { request_id: body!.request_id.toLowerCase(), app, source: body!.source, customer });
    },
  }, {
    method: 'GET', pattern: 'entry-invoice', handler: async ({ request, url, invoke }) => {
      const app = callerOf(request);
      const source = url.searchParams.get('source') ?? '';
      if (!source.startsWith(`${app}:`)) fail(422, 'INVALID_ARGS', 'El cobro tiene que ser de la app que llama.', { field: 'source' });
      const state = await invoke('invoices.entry_invoice_of', { app, source });
      if (!state) fail(404, 'NOT_REQUESTED', 'Ese cobro no tiene factura pedida.');
      return state;
    },
  }];
}
