/**
 * Subir varias facturas recibidas de una vez (auditoría del 3T, 9-10-2026): lo mismo que hace Drive, pero en el
 * dispositivo y también sin red. Por cada archivo:
 * - PDF con los mismos bytes que el documento de otra factura viva → duplicada, no se sube.
 * - PDF con texto → se lee como «Leer PDF» (plantillas del proveedor, reglas; rectificativa si lo es) y se importa ya
 *   leída, en «Pendiente de revisión». Mismo contenido que otra (huella, o proveedor y número) → duplicada.
 * - Foto, escaneado o PDF que no se lee del todo → factura en «Pendiente de datos» con su documento, sin fecha y con el
 *   proveedor provisional «Sin identificar»: se completa con «Leer PDF», la IA o una sesión de Claude.
 * Nada se valida: validar sigue siendo cosa de una persona.
 */
import type { RowOperation } from '@ikisai/sync-client';
import { closeSheet, el, openSheet, replace, toast } from '@ikisai/ui-kit';
import {
  detectRectification, extractWithTemplates, findDuplicateImport, findDuplicateInvoice, importDocumentSha256, importOperations, matchSupplier, negateDocument,
  partialFillOperations, readingMessage, readingSummary, type ImportDocument, type TemplateExtraction,
} from '@ikisai/domain-invoices';
import { INVOICES, INVOICE_FILES, SUPPLIERS } from '../app/client.ts';
import type { Mirror } from '../app/data.ts';
import { ACCEPT_ATTR, stageDocument } from '../app/files.ts';
import { sha256Hex } from '../app/ai-share.ts';
import { readPdfItems } from '../app/pdf-text.ts';
import { usage } from '../app/usage.ts';
import { commitSafely } from './common.ts';
import type { ViewContext } from './shell.ts';

/** Proveedor provisional de lo que entra sin leer (el mismo que usa Drive). */
const UNIDENTIFIED = { name: 'Sin identificar (Drive)', slug: 'sin_identificar' };
type Outcome = 'leida' | 'parcial' | 'sin_leer' | 'duplicada' | 'error';
const OUTCOME_LABELS: Record<Outcome, string> = { leida: 'Leída', parcial: 'Lectura parcial: complétala', sin_leer: 'Sin leer: complétala después', duplicada: 'Duplicada: no se sube', error: 'Error' };

export function openBatchUpload(ctx: ViewContext, getMirror: () => Promise<Mirror>, onDone: () => void, shared: File[] = []): void {
  const input = el('input', { 'data-feedback-id': 'invoices.facturas.lote.archivos', 'data-feedback-label': 'Facturas', type: 'file', id: 'batchFiles', accept: ACCEPT_ATTR, multiple: true });
  const list = el('ol', { class: 'batch-list', id: 'batchList', 'data-feedback-ignore': '' });
  const summary = el('p', { class: 'hint', id: 'batchSummary', role: 'status' }, 'Elige todas las facturas a la vez (PDF o fotos). Cada una se convierte en una factura.');
  const start = el('button', { 'data-feedback-id': 'invoices.facturas.lote.subir', 'data-feedback-label': 'Subir', class: 'primary', type: 'button', id: 'batchStart', disabled: true, onclick: () => void run() }, 'Subir');
  input.addEventListener('change', () => { start.disabled = !(input.files && input.files.length); replace(summary, `${input.files?.length ?? 0} archivo${input.files?.length === 1 ? '' : 's'} elegido${input.files?.length === 1 ? '' : 's'}.`); });

  async function run(): Promise<void> {
    const files = shared.length ? shared : Array.from(input.files ?? []);
    if (!files.length) return;
    start.disabled = true; input.disabled = true;
    const counts: Record<Outcome, number> = { leida: 0, parcial: 0, sin_leer: 0, duplicada: 0, error: 0 };
    replace(list);
    for (const [index, file] of files.entries()) {
      const item = el('li', null, el('strong', null, file.name), ' · ', el('span', { class: 'hint' }, 'leyendo…'));
      list.appendChild(item);
      let outcome: Outcome; let detail = '';
      try { ({ outcome, detail } = await processOne(ctx, await getMirror(), file)); } catch (error) { outcome = 'error'; detail = (error as Error)?.message ?? ''; }
      counts[outcome] += 1;
      replace(item, el('strong', null, file.name), ' · ', el('span', { class: outcome === 'leida' ? 'chip ok' : outcome === 'error' ? 'chip alert' : 'chip warn' }, OUTCOME_LABELS[outcome]), detail ? el('span', { class: 'hint' }, ` ${detail}`) : null);
      replace(summary, `${index + 1} de ${files.length}…`);
    }
    usage.track('invoices.facturas.lote', counts.error ? 'error' : 'success');
    replace(summary, `${counts.leida} leída${counts.leida === 1 ? '' : 's'}, ${counts.parcial ? `${counts.parcial} con lectura parcial, ` : ''}${counts.sin_leer} sin leer, ${counts.duplicada} duplicada${counts.duplicada === 1 ? '' : 's'}${counts.error ? `, ${counts.error} con error` : ''}. Revísalas y valídalas en la lista.`);
    toast(navigator.onLine ? 'Facturas subidas.' : 'Facturas guardadas en este dispositivo: se subirán al volver la conexión.');
    onDone();
  }

  openSheet({
    title: 'Subir varias facturas',
    meta: 'Los PDF con texto se leen solos; las fotos y los escaneados quedan pendientes de datos. Nada se valida.',
    body: el('div', { 'data-feedback-id': 'invoices.facturas.lote', 'data-feedback-label': 'Subir varias facturas' }, input, summary, list),
    foot: [el('button', { 'data-feedback-id': 'invoices.facturas.lote.cerrar', 'data-feedback-label': 'Cerrar', class: 'ghost', type: 'button', onclick: () => void closeSheet() }, 'Cerrar'), start],
    initialFocus: input,
  });
  // Compartidas desde otra app (Gmail, WhatsApp…): se suben sin más pasos.
  if (shared.length) {
    input.hidden = true;
    replace(summary, `${shared.length} factura${shared.length === 1 ? '' : 's'} compartida${shared.length === 1 ? '' : 's'} con Finance.`);
    void run();
  }
}

async function processOne(ctx: ViewContext, mirror: Mirror, file: File): Promise<{ outcome: Outcome; detail: string }> {
  const { client } = ctx;
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const liveInvoices = new Set(mirror.invoices.filter((i) => !i.deleted_at && i.status !== 'anulada').map((i) => i.id));
  if (isPdf) {
    const sha = await sha256Hex(file);
    const same = mirror.files.find((f) => !f.deleted_at && f.sha256 === sha && liveInvoices.has(f.invoice_id));
    if (same) return { outcome: 'duplicada', detail: `(mismo archivo que ${mirror.invoices.find((i) => i.id === same.invoice_id)?.code ?? 'otra factura'})` };
  }
  // Lectura como «Leer PDF» (las fotos no tienen texto que leer en el dispositivo)
  let document: ImportDocument | null = null;
  let rectification: ReturnType<typeof detectRectification> | null = null;
  let partial: TemplateExtraction | null = null;
  if (isPdf) {
    try {
      const items = await readPdfItems(file);
      const result = extractWithTemplates(items, { suppliers: mirror.suppliers.filter((s) => !s.deleted_at).map((s) => ({ id: s.id, name: s.name, tax_id: s.tax_id })), templates: mirror.templates });
      partial = result;
      if (result.hasText && result.ok && result.document) {
        rectification = detectRectification({ text: items.map((i) => i.str).join('\n'), document: result.document });
        document = rectification.isRectification && result.document.document_totals.total > 0 ? negateDocument(result.document) : result.document;
      }
    } catch { document = null; }
  }
  const staged = await stageDocument(client, file);
  const fileArg = { file_id: staged.marker, original_filename: staged.filename, page_order: 1, mime_type: staged.mime, size_bytes: staged.size, sha256: staged.sha256 };
  if (document) {
    const documentSha = await importDocumentSha256(document);
    const best = matchSupplier(document, mirror.suppliers)[0];
    const existing = best && best.score >= 0.8 ? best.supplier : null;
    const dup = findDuplicateImport(documentSha, mirror.invoices as never) ?? (existing ? findDuplicateInvoice(document, existing.id, mirror.invoices as never) : null);
    if (dup) return { outcome: 'duplicada', detail: `(ya está: ${dup.code ?? 'otra factura'})` };
    const { operations } = importOperations({
      document, documentSha256: documentSha, invoiceId: crypto.randomUUID(),
      supplier: existing ? { mode: 'existing', row: existing } : { mode: 'create', id: crypto.randomUUID() },
      overrides: rectification?.isRectification ? { invoice_kind: 'rectificativa', rectifies_number: rectification.number } : {},
      files: [fileArg],
    });
    const ok = await commitSafely(client, operations as RowOperation[], `Leída: ${file.name}`);
    if (!ok) return { outcome: 'error', detail: '' };
    const total = document.document_totals.total.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
    return { outcome: 'leida', detail: `${document.invoice.supplier_name} · ${total}${rectification?.isRectification ? ' · rectificativa' : ''}` };
  }
  // Sin leer: factura pendiente con su documento y el proveedor provisional
  const placeholder = mirror.suppliers.find((s) => !s.deleted_at && s.slug === UNIDENTIFIED.slug);
  const supplierId = placeholder?.id ?? crypto.randomUUID();
  const invoiceId = crypto.randomUUID();
  const invoiceFields: Record<string, unknown> = { supplier_id: supplierId, invoice_date: null, object: (file.name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_\s]+/g, ' ').trim() || 'factura').slice(0, 120) };
  // Lectura parcial (fase 0): lo encontrado rellena la factura nueva (el resumen `import_meta` solo lo escribe Drive).
  const extra: RowOperation[] = [];
  if (partial?.hasText) {
    const fill = partialFillOperations({
      invoice: { id: invoiceId, supplier_id: supplierId, invoice_number: null, invoice_date: null, source_total: null },
      placeholderSupplierId: supplierId, suppliers: mirror.suppliers, hasContent: false, found: partial.found, provenance: partial.provenance, invoices: mirror.invoices,
      reading: readingSummary(partial, 0, new Date().toISOString()), newId: () => crypto.randomUUID(),
    });
    for (const op of fill.ops) {
      if (op.op === 'update' && op.table === INVOICES) { const { import_meta: _meta, ...fields } = op.fields as Record<string, unknown>; Object.assign(invoiceFields, fields); }
      else extra.push(op as unknown as RowOperation);
    }
  }
  const operations: RowOperation[] = [
    ...(placeholder ? [] : [{ op: 'insert', table: SUPPLIERS, id: supplierId, fields: { name: UNIDENTIFIED.name, slug: UNIDENTIFIED.slug } } as RowOperation]),
    ...extra.filter((op) => 'table' in op && op.table === SUPPLIERS),
    { op: 'insert', table: INVOICES, id: invoiceId, fields: invoiceFields },
    { op: 'insert', table: INVOICE_FILES, id: crypto.randomUUID(), fields: { invoice_id: invoiceId, ...fileArg, kind: 'original' } },
    ...extra.filter((op) => !('table' in op && op.table === SUPPLIERS)),
  ];
  const ok = await commitSafely(client, operations, `Guardada: ${file.name}`);
  if (!ok) return { outcome: 'error', detail: '' };
  if (partial?.hasText) return { outcome: 'parcial', detail: readingMessage(partial) };
  return { outcome: 'sin_leer', detail: isPdf ? '(este PDF no contiene texto legible: parece escaneado)' : '(foto)' };
}
