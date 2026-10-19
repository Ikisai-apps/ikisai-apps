/**
 * Validar una factura recibida (sacado de `ui/invoices.ts` para la tanda 27, sin cambios): lo usan la ficha e Inicio.
 * - `missingOf`: lo que falta para validar, con lo del espejo (lo mismo que comprueba el servidor).
 * - `settlePending`: espera a que el último cambio propio llegue al servidor, para no chocar consigo mismo.
 * - `validateNow`: valida con la revisión del servidor y aprende la plantilla del proveedor (`validateWithLearning`).
 */
import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import { toast } from '@ikisai/ui-kit';
import { confirmedFromInvoice, learnFromConfirmation, linesFromItems, templateOperation, validationMissing, type MissingKey, type PdfTextItem } from '@ikisai/domain-invoices';
import { SUPPLIERS, describeError, type LocalInvoice } from './client.ts';
import { loadMirror, type Mirror } from './data.ts';
import { fetchStoredDocument } from './ai-share.ts';
import { readPdfItems } from './pdf-text.ts';
import type { ViewContext } from '../ui/shell.ts';

/** Lo que falta para validar una factura, con lo que hay en el espejo. */
export function missingOf(mirror: Mirror, invoice: LocalInvoice): MissingKey[] {
  const lines = (mirror.linesByInvoice.get(invoice.id) ?? []).filter((l) => !l.deleted_at);
  const taxes = (mirror.taxesByInvoice.get(invoice.id) ?? []).filter((t) => !t.deleted_at);
  return validationMissing({
    invoice, hasOriginal: (mirror.filesByInvoice.get(invoice.id) ?? []).some((f) => f.kind === 'original' && !f.deleted_at),
    lines: lines.map((l) => ({ quantity: l.quantity === null ? null : Number(l.quantity), unit_price: l.unit_price === null ? null : Number(l.unit_price), discount_amount: Number(l.discount_amount ?? 0), net_amount: Number(l.net_amount) })),
    taxes: taxes.map((t) => ({ tax_type: t.tax_type, rate: t.rate === null ? null : Number(t.rate), taxable_base: t.taxable_base === null ? null : Number(t.taxable_base), amount: Number(t.amount) })),
  });
}

/** Deja que el último cambio entre en la cola y, con red, espera (hasta 8 s) a que el servidor lo confirme. */
export async function settlePending(client: SyncClient): Promise<void> {
  await new Promise((r) => setTimeout(r, 250));
  if (client.status().pendingCommands && navigator.onLine) {
    void client.sync().catch(() => undefined);
    const until = Date.now() + 8000;
    while (client.status().pendingCommands && Date.now() < until && navigator.onLine) await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Valida con la revisión que tiene el servidor: con red, espera (hasta 8 s) a que se confirmen los cambios pendientes;
 * si siguen pendientes (sin red), la validación sale sin revisión esperada (los cambios propios van antes en la cola).
 */
/** `okMessage` null: sin aviso (Inicio pone el suyo, con «Deshacer»). */
export async function validateNow(ctx: ViewContext, invoiceId: string, okMessage: string | null): Promise<boolean> {
  const { client } = ctx;
  await settlePending(client);
  const mirror = await loadMirror(client);
  const invoice = mirror.invoices.find((i) => i.id === invoiceId);
  if (!invoice) return false;
  const ops = await validateWithLearning(ctx, mirror, invoice);
  if (client.status().pendingCommands) {
    const call = ops[0] as { op: 'call'; args: Record<string, unknown> };
    delete call.args.expectedRevision;
  }
  try {
    await client.commit(ops);
    if (okMessage) toast(client.status().network === 'offline' ? `${okMessage} Se sincronizará cuando haya red.` : okMessage);
    return true;
  } catch (error) {
    toast(describeError(error));
    return false;
  }
}

export async function saveDocumentText(ctx: ViewContext, fileId: string, items: PdfTextItem[]): Promise<void> {
  try { await ctx.client.api(`/documents/${fileId}/text`, { json: { source: 'pdf_text', items: items.slice(0, 20_000) } }); } catch { /* aprender al validar volverá a leer el PDF */ }
}

/**
 * Validar y, en el mismo lote, aprender la plantilla del proveedor con lo confirmado (API.md §6.9). El servidor exige que
 * vayan juntos. Si no hay texto del documento (sin red, foto o escaneado), se valida sin aprender: nunca bloquea.
 */
export async function validateWithLearning(ctx: ViewContext, mirror: Mirror, invoice: LocalInvoice): Promise<RowOperation[]> {
  const ops: RowOperation[] = [{ op: 'call', procedure: 'invoices.validate', args: { invoice_id: invoice.id, expectedRevision: invoice.revision } }];
  // La categoría con que se valida pasa a ser la del proveedor si no tenía ninguna (sin pisarla): la siguiente ya la lleva.
  const owner = mirror.supplierById.get(invoice.supplier_id);
  if (owner && owner.slug !== 'sin_identificar' && !owner.default_category && invoice.expense_category) {
    ops.push({ op: 'update', table: SUPPLIERS, id: owner.id, expectedRevision: owner.revision, fields: { default_category: invoice.expense_category } });
  }
  try {
    const original = (mirror.filesByInvoice.get(invoice.id) ?? []).filter((f) => f.kind === 'original' && f.mime_type === 'application/pdf').sort((a, b) => a.page_order - b.page_order)[0];
    if (!original || !navigator.onLine) return ops;
    let items: PdfTextItem[] | null = null;
    const stored = await ctx.client.api<{ items: PdfTextItem[] } | null>('/read/invoices.document_text', { json: { file_id: original.file_id } }).catch(() => null);
    if (stored && Array.isArray(stored.items) && stored.items.length) items = stored.items;
    else {
      const file = await fetchStoredDocument(ctx.client, original.file_id, original.normalized_filename, original.mime_type);
      items = await readPdfItems(file);
      if (items.length) void saveDocumentText(ctx, original.file_id, items);
    }
    if (!items?.length) return ops;
    const supplier = mirror.supplierById.get(invoice.supplier_id);
    const learning = await learnFromConfirmation({
      lines: linesFromItems(items), supplierId: invoice.supplier_id, invoiceId: invoice.id, templates: mirror.templates,
      confirmed: confirmedFromInvoice(invoice, supplier?.tax_id ?? null, mirror.taxesByInvoice.get(invoice.id) ?? []),
      items: (mirror.linesByInvoice.get(invoice.id) ?? []).filter((l) => !l.deleted_at).sort((a, b) => a.position - b.position).map((l) => ({ description: l.description, quantity: l.quantity === null ? null : Number(l.quantity), unit_price: l.unit_price === null ? null : Number(l.unit_price), net_amount: Number(l.net_amount) })),
    });
    if (!learning) return ops;
    const current = learning.template.id ? mirror.templates.find((t) => t.id === learning.template.id) ?? null : null;
    ops.push(templateOperation(learning, current, invoice.id, crypto.randomUUID()) as RowOperation);
  } catch { /* aprender es un extra: la validación sigue */ }
  return ops;
}
