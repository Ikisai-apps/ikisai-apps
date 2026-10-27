/**
 * Ikisai Tasks · la compra recibida se registra en Finance (encargo de Core del 27-10-2026; contrato de Finance en
 * docs/invoices/API.md §18 y §5; docs/tasks/API.md §44).
 *
 * `POST purchases/:id/finance`: con el token de la persona, nunca con un superusuario.
 * 1. Lee la solicitud (`tasks.purchase_finance`, solo si la ve). Tiene que estar recibida y con lo pagado (`paid_total`).
 *    Si ya está registrada, devuelve lo que hay.
 * 2. Comprueba la capacidad `invoices.register_purchase_quick` del catálogo: sin acceso a Finance (editor u owner), la
 *    solicitud queda `needs_access` y la app ofrece «Registrar en Finance» para después. Nada se bloquea.
 * 3. Si hay foto o PDF del justificante (`receipt_file_id`, archivo de Tasks), sube esos mismos bytes a Finance de servidor
 *    a servidor (`uploads`, PUT, `uploads/:id/verify`; sin cabecera Origin) y usa el `file_id` de Finance.
 * 4. Invoca la capacidad con `requestId: tasks-purchase-<id>` (idempotente: repetir devuelve lo mismo) y deja en la
 *    solicitud `finance_status`, `finance_invoice_id` y `finance_code`, o el motivo si falló (`failed`).
 * Responde `{status, invoiceId, code, nature, url, error?}`. La ficha en Finance: `https://finance.ikisai.com/#/facturas/<id>`.
 */
import { Fault, createCapabilities, createSync, fail, type AppRoute, type CapabilitiesOptions, type RequestContext, type StorageAccess, type Supabase } from '../_kit/mod.ts';

export const FINANCE_CAPABILITY = 'invoices.register_purchase_quick';
export const FINANCE_URL = 'https://finance.ikisai.com/#/facturas/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Purchase = {
  id: string; revision: number; title: string; status: string; project: string | null; supplierName: string | null; receivedAt: string | null;
  paidTotal: number | string | null; receiptKind: 'invoice' | 'ticket' | null; invoiceNumber: string | null; receiptFileId: string | null;
  sourceApp: string | null; sourceUrl: string | null; financeStatus: string | null; financeInvoiceId: string | null; financeCode: string | null;
};

/** El día de la compra (Europa/Madrid): el de la recepción o, sin ella, hoy. */
function purchaseDay(receivedAt: string | null): string {
  const at = receivedAt ? new Date(receivedAt) : new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export function financeRoutes(supabase: Supabase, storage: StorageAccess, options: CapabilitiesOptions = {}): AppRoute[] {
  const internal = createSync(supabase, 'tasks', {});
  const capabilities = createCapabilities(supabase, 'tasks', options);
  const transport = options.fetch ?? fetch;
  const env = (name: string) => (globalThis as any).Deno?.env?.get?.(name) as string | undefined;
  const apiBaseOf = options.apiBaseOf ?? ((app: string, domain: string | null) => env('IKISAI_API_BASE_' + app.toUpperCase()) ?? (domain ? 'https://' + domain : null));

  const read = (ctx: RequestContext, id: string) => supabase.rpc<Purchase>('core_read', { p_app: 'tasks', p_actor: ctx.user.id, p_name: 'tasks.purchase_finance', p_args: { id } });
  // El resultado solo lo escribe el servidor (tasks.purchase_finance_set; la app no puede fijar `finance_*`).
  const save = async (ctx: RequestContext, row: Purchase, fields: { finance_status: string; finance_invoice_id?: string | null; finance_code?: string | null; finance_error?: string | null }) => {
    await internal.commit(ctx, { requestId: `finance-${row.id}-${crypto.randomUUID()}`, operations: [{ op: 'call', procedure: 'tasks.purchase_finance_set', args: {
      id: row.id, status: fields.finance_status, invoiceId: fields.finance_invoice_id ?? null, code: fields.finance_code ?? null, error: fields.finance_error ?? null } }] });
  };

  /** Sube a Finance los bytes del justificante de Tasks y devuelve el `file_id` de Finance. */
  async function uploadToFinance(ctx: RequestContext, base: string, fileId: string): Promise<string> {
    // El archivo es el de la solicitud que esta persona ve: lo puso quien lo subió (hook tasks.validate_purchase_finance).
    const file = await supabase.rpc<any>('core_file_get', { p_app: 'tasks', p_actor: ctx.user.id, p_id: fileId });
    if (file.status !== 'verified') fail(422, 'RECEIPT_NOT_READY', 'La foto del justificante aún no se ha subido del todo.');
    if (!['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(String(file.mime).toLowerCase())) fail(422, 'RECEIPT_NOT_READY', 'El justificante tiene que ser un PDF o una foto.');
    const stored = await storage.download(file);
    if (!stored.ok) fail(503, 'STORAGE_UNAVAILABLE', 'No se pudo leer la foto del justificante.');
    const bytes = new Uint8Array(await stored.arrayBuffer());
    const call = async (path: string, body: unknown) => {
      const res = await transport(`${base}/api/v1/${path}`, { method: 'POST', headers: { Authorization: 'Bearer ' + ctx.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({})) as any;
      if (!res.ok) throw new Fault(res.status, out?.error?.code ?? 'APP_UNAVAILABLE', out?.error?.message ?? 'Finance no contestó.', out?.error?.details ?? null);
      return out;
    };
    const ticket = await call('uploads', { filename: file.filename || 'justificante', mime: file.mime, size: bytes.byteLength, sha256: file.sha256 });
    const put = await transport(ticket.uploadUrl, { method: ticket.method ?? 'PUT', headers: ticket.headers ?? { 'Content-Type': file.mime }, body: bytes });
    if (!put.ok) fail(503, 'APP_UNAVAILABLE', 'No se pudo subir la foto del justificante a Finance.');
    await call(`uploads/${ticket.id}/verify`, {});
    return ticket.id as string;
  }

  return [{
    method: 'POST', pattern: 'purchases/:id/finance', handler: async ({ ctx, params }) => {
      if (!['editor', 'owner'].includes(ctx.membership.role)) fail(403, 'FORBIDDEN', 'Registrar una compra en Finance necesita permiso de edición en Tasks.');
      // Un agente no registra en Finance: la factura se crearía allí antes de su revisión de riesgo en Tasks (autoauditoría 27-10).
      if (ctx.user.kind === 'agent') fail(403, 'FORBIDDEN', 'Un agente no registra compras en Finance.');
      const id = (params.id ?? '').toLowerCase();
      if (!UUID.test(id)) fail(404, 'NOT_FOUND', 'Esa compra no existe o no la ves.');
      const row = await read(ctx, id);
      const answer = (status: string, extra: Record<string, unknown> = {}) => ({ status, invoiceId: row.financeInvoiceId, code: row.financeCode, url: row.financeInvoiceId ? FINANCE_URL + row.financeInvoiceId : null, ...extra });
      if (row.financeStatus === 'registered' && row.financeInvoiceId) return answer('registered');
      const total = row.paidTotal == null ? null : Number(row.paidTotal);
      if (row.status !== 'received' || !total || total <= 0) fail(422, 'NOT_READY', 'Para registrarla en Finance, la compra tiene que estar recibida y con lo pagado.');
      if (!row.supplierName?.trim()) fail(422, 'SUPPLIER_REQUIRED', 'Para registrarla en Finance, di en qué tienda se compró.');

      // ¿Puede esta persona? Sin acceso a Finance, queda para después (nada se bloquea).
      let cap: { domain: string | null };
      try {
        cap = await supabase.rpc<{ domain: string | null }>('core_capability_check', { p_actor: ctx.user.id, p_id: FINANCE_CAPABILITY });
      } catch (error) {
        if (error instanceof Fault && (error.status === 403 || error.code === 'NEEDS_ACCESS')) {
          await save(ctx, row, { finance_status: 'needs_access', finance_error: 'Sin acceso a Finance' });
          return answer('needs_access', { error: 'NEEDS_ACCESS' });
        }
        throw error;
      }
      const base = apiBaseOf('invoices', cap.domain);
      try {
        const fileId = row.receiptFileId ? await uploadToFinance(ctx, base ?? fail(503, 'APP_UNAVAILABLE', 'Finance no tiene dirección conocida.'), row.receiptFileId) : null;
        const out = await capabilities.invoke(ctx, FINANCE_CAPABILITY, {
          requestId: `tasks-purchase-${row.id}`,
          supplier: { name: row.supplierName!.trim().slice(0, 200) },
          date: purchaseDay(row.receivedAt),
          total: Math.round(total * 100) / 100,
          description: row.title.slice(0, 120),
          receipt_kind: row.receiptKind ?? 'ticket',
          ...(row.invoiceNumber ? { invoice_number: row.invoiceNumber.slice(0, 64) } : {}),
          ...(fileId ? { file_id: fileId } : {}),
          // El destino: general, sin asignar; la oficina lo asigna en Finance (Core, 27-10). El evento, cuando venga de Flow con él.
          target: { app: 'general', kind: 'unassigned' },
          notes: `Compra de Tasks ${row.id}${row.project ? ` · ${row.project}` : ''}`.slice(0, 2000),
        }) as { result?: { invoice_id?: string; code?: string | null; nature?: string } };
        const result = out?.result ?? {};
        if (!result.invoice_id) fail(502, 'APP_UNAVAILABLE', 'Finance no devolvió la factura.');
        await save(ctx, row, { finance_status: 'registered', finance_invoice_id: result.invoice_id, finance_code: result.code ?? null, finance_error: null });
        return { status: 'registered', invoiceId: result.invoice_id, code: result.code ?? null, nature: result.nature ?? null, url: FINANCE_URL + result.invoice_id };
      } catch (error) {
        if (!(error instanceof Fault)) throw error;
        const access = error.code === 'NEEDS_ACCESS' || error.code === 'FORBIDDEN';
        await save(ctx, row, { finance_status: access ? 'needs_access' : 'failed', finance_error: `${error.code}: ${error.message}`.slice(0, 300) });
        return answer(access ? 'needs_access' : 'failed', { error: error.code, message: error.message });
      }
    },
  }];
}
