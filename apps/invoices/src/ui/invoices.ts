/**
 * Facturas (API.md §9.2): la lista vive en `invoice-list.ts`; aquí la ficha en hoja (documento, artículos, impuestos, asignación, pago, fiscal),
 * alta con documento, importación del JSON `ikisai.invoice.v1`, validar, anular, archivar.
 */
import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import { closeSheet, confirmDialog, createSortableList, el, fieldAttrs, icon, openSheet, renderList, renderMedal, replace, toast, type Sheet } from '@ikisai/ui-kit';
import { fbRows } from './feedback.ts';
import { usage } from '../app/usage.ts';
import {
  DEDUCTIBILITIES, EXTRACTION_PROMPT, PAYMENT_METHODS, periodOfDate, detectRectification, negateDocument, proposeRectificationAllocations, TAX_TYPES, ITEM_TYPES, importDocumentSha256, importOperations, matchSupplier, normalizedFilename, parseExternalResult, proposeImport, importDateChoice, emptyPartial, MISSING_LABELS, type MissingKey, knownFieldsText, missingLabels, readingMessage, readingText, type ReadLevel, softDuplicate, type FieldProvenance, type PdfTextItem, type ReadPayment, recalculate,
  slugify, sumCents, fromCents, toCents, type ImportDocument, type SchemaError, type Deductibility,
} from '@ikisai/domain-invoices';
import {
  ALLOCATIONS, CATEGORIES, CATEGORY_LABELS, INVOICES, INVOICE_FILES, INVOICE_LINES, SUPPLIERS, TAX_LINES, categoryLabel, describeError,
  type LocalAllocation, type LocalInvoice, type LocalInvoiceFile, type LocalInvoiceLine, type LocalSupplier, type LocalTaxLine,
} from '../app/client.ts';
import {
  DEDUCTIBILITY_LABELS, GENERAL_KIND_LABELS, ITEM_TYPE_LABELS, PAYMENT_METHOD_LABELS, TAX_TYPE_LABELS, eur, lineName, loadMirror, supplierName, workingQuarter, parseAmount, shortDate,
  statusChipClass, statusText, todayIso, type Mirror,
} from '../app/data.ts';
import { ACCEPT_ATTR, formatBytes, openFile, stageDocument, storedMime, type StagedDocument } from '../app/files.ts';
import { FRESHNESS_LABELS, KIND_LABELS, checkTargetFreshness, kindsFor, proposePurchaseRequest, recentTargets, rememberTarget, searchTargets, targetLabel, type TargetChoice } from '../app/targets.ts';
import { guard } from '../app/guard.ts';
import { describeExtractionError, describeUsage, extractDocument, extractionQueue, type ExtractionUsage } from '../app/extract.ts';
import type { ViewContext } from './shell.ts';
import { fetchStoredDocument, sha256Hex, shareWithAi } from '../app/ai-share.ts';
import { READ_LIMITS, ReadLimitError, readPdfItems } from '../app/pdf-text.ts';
import { flushDocumentTexts, queueDocumentText } from '../app/text-queue.ts';
import { block, fbBlock, commitSafely, field, select } from './common.ts';
import { articleForm } from './article.ts';
import { linkedItem, linksEnabled, spaceName } from '../app/resources.ts';
import { openBatchUpload } from './batch.ts';
import type { ManualPrefill } from './manual.ts';
import { createInvoiceEditor, type InvoiceEditor } from './editor.ts';
import { missingOf, saveDocumentText, settlePending, validateNow } from '../app/validate.ts';
import { commitWithUndo, pick } from './undo.ts';
import { currentReading, documentReadingBlock, extractFor, readingPanel } from './reading.ts';

// ---------------------------------------------------------------------------
// Utilidades de la vista
// ---------------------------------------------------------------------------
function supplierOptions(suppliers: LocalSupplier[]): Array<[string, string]> {
  return suppliers.filter((s) => !s.deleted_at).sort((a, b) => supplierName(a).localeCompare(supplierName(b), 'es')).map((s) => [s.id, s.label ? `${s.label} (${s.name})` : s.name] as [string, string]);
}

export function invoiceTitle(invoice: LocalInvoice, mirror: Mirror): string {
  const supplier = mirror.supplierById.get(invoice.supplier_id);
  return `${supplierName(supplier, 'Proveedor')} · ${invoice.object}`;
}

function changed(fields: Record<string, unknown>, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) if ((row[key] ?? null) !== (value ?? null)) out[key] = value;
  return out;
}

async function pickFiles(input: HTMLInputElement, client: SyncClient): Promise<StagedDocument[]> {
  const out: StagedDocument[] = [];
  for (const file of Array.from(input.files ?? [])) out.push(await stageDocument(client, file));
  return out;
}

// ---------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------
/** Apps de la hoja de asignación: ids literales para el catálogo de «Uso». */
const ALLOC_APP_MARKS: Record<string, Record<string, string>> = {
  general: { 'data-feedback-id': 'invoices.facturas.asignar.app.general', 'data-feedback-label': 'General' },
  tasks: { 'data-feedback-id': 'invoices.facturas.asignar.app.tareas', 'data-feedback-label': 'Tareas' },
  food: { 'data-feedback-id': 'invoices.facturas.asignar.app.cocina', 'data-feedback-label': 'Cocina' },
  booking: { 'data-feedback-id': 'invoices.facturas.asignar.app.reservas', 'data-feedback-label': 'Reservas' },
};

// Quién tiene la ficha abierta (para refrescarla cuando llegan cambios).
const openListeners = new Set<(id: string | null) => void>();
export function onOpen(listener: (id: string | null) => void): () => void { openListeners.add(listener); return () => openListeners.delete(listener); }
let openInvoiceId: string | null = null;
let openSheetRef: Sheet | null = null;
function setOpen(id: string | null): void { openInvoiceId = id; for (const l of openListeners) l(id); }

/** El editor de «Datos de la factura» de la ficha abierta (para «Leer PDF»). */
let activeEditor: InvoiceEditor | null = null;

export function refreshOpenInvoice(ctx: ViewContext, id: string, mirror: Mirror): void {
  if (openInvoiceId !== id || !openSheetRef) return;
  // Con cambios sin guardar en «Datos de la factura», no se repinta (se perdería lo escrito).
  if (guard.dirtyEditor) return;
  const invoice = mirror.invoices.find((i) => i.id === id);
  if (!invoice) return;
  replace(openSheetRef.body, renderInvoice(ctx, invoice, mirror));
}

// ---------------------------------------------------------------------------
// Ficha
// ---------------------------------------------------------------------------
export async function openInvoice(ctx: ViewContext, id: string, focus: string | null = null): Promise<void> {
  const mirror = await loadMirror(ctx.client);
  const invoice = mirror.invoices.find((i) => i.id === id);
  if (!invoice) { toast('La factura no está en este dispositivo.'); return; }
  const body = el('div', null, renderInvoice(ctx, invoice, mirror));
  openSheetRef = openSheet({
    title: invoiceTitle(invoice, mirror),
    meta: `${invoice.code ?? 'código pendiente'} · revisión ${invoice.revision}${invoice._pending ? ' · pendiente de sincronizar' : ''}`,
    body,
    foot: [el('button', { 'data-feedback-id': 'invoices.facturas.ficha.cerrar', 'data-feedback-label': 'Cerrar', class: 'ghost', type: 'button', onclick: () => void closeSheet() }, 'Cerrar')],
    titleId: 'invoiceSheetTitle',
    beforeClose: async () => !guard.dirtyEditor || confirmDialog({ title: 'Hay cambios sin guardar', text: '¿Descartarlos?', confirmLabel: 'Descartar', danger: true }),
    onClose: () => { guard.dirtyEditor = false; if (openInvoiceId === id) { setOpen(null); openSheetRef = null; } },
  });
  setOpen(id);
  if (focus) goToFocus(body, focus);
}

/**
 * Inicio abre la ficha en lo que toca (tanda 30): lo que falta (su enlace «Ir a lo que falta»), los importes o leer el
 * documento. Si no está a la vista, la ficha se queda abierta sin más.
 */
function goToFocus(body: HTMLElement, focus: string): void {
  const target = focus === 'leer'
    ? body.querySelector<HTMLElement>('[data-feedback-id="invoices.facturas.ficha.extraer"], [data-feedback-id="invoices.facturas.ficha.leer_ia"], #chatgptInvoice')
    : focus === 'totals' && !body.querySelector(`[data-missing="totals"]`)
      ? body.querySelector<HTMLElement>('#invSourceTotal, #manualTotal')
      : body.querySelector<HTMLElement>(`[data-missing="${focus}"]`);
  if (!target) return;
  requestAnimationFrame(() => {
    if (target.matches('[data-missing]')) { target.click(); return; }
    target.closest('details')?.setAttribute('open', '');
    target.scrollIntoView({ block: 'center' });
    target.focus({ preventScroll: true });
  });
}

/**
 * Botón de la fila de acciones (FB_2026_031): el texto va en `.act-label` (en el móvil solo se ve el icono) y es también su
 * nombre accesible y su título, para que quepan todos en una fila.
 */
const SHORT_ACTION: Record<string, string> = {
  'invoices.facturas.ficha.validar': 'Validar', 'invoices.facturas.ficha.importar_json': 'JSON', 'invoices.facturas.ficha.pago': 'Pago',
  'invoices.facturas.ficha.anular': 'Anular', 'invoices.facturas.ficha.leer_ia': 'IA', 'invoices.facturas.ficha.extraer': 'Extraer',
  'invoices.facturas.ficha.archivar': 'Archivar', 'invoices.facturas.ficha.desarchivar': 'Sacar',
};
function compactAction(button: HTMLElement): HTMLElement {
  const text = button.textContent?.trim() ?? '';
  for (const node of [...button.childNodes]) if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) button.replaceChild(el('span', { class: 'act-label' }, node.textContent.trim()), node);
  const short = SHORT_ACTION[button.getAttribute('data-feedback-id') ?? ''];
  if (short) button.appendChild(el('span', { class: 'act-short', 'aria-hidden': 'true' }, short));
  if (text && !button.getAttribute('aria-label')) button.setAttribute('aria-label', text);
  if (text && !button.title) button.title = text;
  return button;
}

function renderInvoice(ctx: ViewContext, invoice: LocalInvoice, mirror: Mirror): HTMLElement {
  const { client } = ctx;
  const role = client.bootstrap()?.membership.role ?? 'reader';
  const canEdit = role !== 'reader';
  const supplier = mirror.supplierById.get(invoice.supplier_id);
  const lines = mirror.linesByInvoice.get(invoice.id) ?? [];
  const taxes = mirror.taxesByInvoice.get(invoice.id) ?? [];
  const files = (mirror.filesByInvoice.get(invoice.id) ?? []).sort((a, b) => a.kind.localeCompare(b.kind) || a.page_order - b.page_order);
  const locked = invoice.status === 'archivada' || invoice.status === 'anulada';
  const editable = canEdit && !locked;
  const pendingState = invoice.status === 'pendiente_datos' || invoice.status === 'pendiente_revision';
  const delta = invoice.totals_delta === null ? null : Number(invoice.totals_delta);
  const outside = delta !== null && Math.abs(toCents(delta)) > 2;

  const unconfirmedPaid = invoice.payment_status === 'pagada' && invoice.payment_source === 'sin_confirmar';
  /** «Pagada · Tarjeta · 05/10/2026 · leído», «Pagada (sin confirmar) · 05/10/2026» o «Pendiente de pago». */
  const paymentText = (): string[] => {
    if (invoice.payment_status !== 'pagada') return ['Pendiente de pago'];
    const parts = [unconfirmedPaid ? 'Pagada (sin confirmar)' : 'Pagada'];
    if (invoice.payment_method) parts.push(PAYMENT_METHOD_LABELS[invoice.payment_method] ?? invoice.payment_method);
    if (invoice.paid_at) parts.push(shortDate(invoice.paid_at));
    if (invoice.payment_source === 'leido') parts.push('leído del documento');
    return [parts.join(' · ')];
  };
  const update = (fields: Record<string, unknown>, message = 'Guardado en este dispositivo.') =>
    commitSafely(client, [{ op: 'update', table: INVOICES, id: invoice.id, expectedRevision: invoice.revision, fields }], message);
  // Lo que falta para validar (incidencia del usuario, 9-10-2026): lo mismo que comprueba el servidor, antes de enviar.
  const missing: MissingKey[] = pendingState ? missingOf(mirror, invoice) : [];
  const missingText = missing.map((m) => MISSING_LABELS[m]).join(', ');
  // «Datos de la factura» editables en la propia ficha (petición del usuario, 9-10-2026)
  const withEditor = editable && pendingState;
  const pdfOriginalForEditor = files.filter((f) => f.kind === 'original' && f.mime_type === 'application/pdf').sort((a, b) => a.page_order - b.page_order)[0];
  const editor: InvoiceEditor | null = withEditor ? createInvoiceEditor(ctx, mirror, invoice, {
    onReread: pdfOriginalForEditor ? () => void rereadIntoEditor(ctx, mirror, invoice, pdfOriginalForEditor) : undefined,
  }) : null;
  activeEditor = editor;
  const editorBlock = editor ? fbBlock({ feedbackId: 'invoices.facturas.ficha.datos', feedbackLabel: 'Datos de la factura' }, 'Datos de la factura', missing.length ? `falta ${missingText}` : 'revisa y corrige aquí', true, editor.element) : null;
  if (editorBlock) editorBlock.id = 'editorBlock';
  const call = (procedure: string, args: Record<string, unknown>, message: string) => commitSafely(client, [{ op: 'call', procedure, args }], message);

  // --- Acciones ------------------------------------------------------------
  const actions: HTMLElement[] = [];
  if (editable && invoice.status === 'pendiente_datos') {
    // Flujo recomendado (usuario, 9-10-2026): la primera factura de cada proveedor, con IA; al validarla se aprende la
    // plantilla y las siguientes se leen solas. Con plantilla, «Leer PDF» (en el bloque del documento) basta.
    const supplierRow = mirror.supplierById.get(invoice.supplier_id);
    const noTemplate = !supplierRow || supplierRow.slug === 'sin_identificar' || !mirror.templates.some((t) => t.supplier_id === invoice.supplier_id && t.status !== 'retirada');
    const original = files.filter((f) => f.kind === 'original').sort((a, b) => a.page_order - b.page_order)[0];
    if (original) actions.push(el('button', { 'data-feedback-id': 'invoices.facturas.ficha.leer_ia', 'data-feedback-label': 'Leer con IA', class: noTemplate ? 'primary' : 'softbtn', type: 'button', id: 'readWithAi',
      onclick: () => openReadWithAi(ctx, invoice, original) }, icon('upload', 18), 'Leer con IA'));
  }
  if (editable && pendingState) {
    // Con algo pendiente no se envía: se dice qué falta y se lleva al campo (nunca un «1 rechazado» sin explicación).
    actions.push(el('button', { 'data-feedback-id': 'invoices.facturas.ficha.validar', 'data-feedback-label': 'Validar', class: invoice.status === 'pendiente_datos' ? 'softbtn' : 'primary', type: 'button', id: 'validateInvoice',
      'aria-disabled': missing.length ? 'true' : null, title: missing.length ? `Para validar falta ${missingText}.` : null,
      onclick: async () => {
        if (editor?.dirty()) { toast('Guarda primero los cambios de «Datos de la factura» (o descártalos).'); document.querySelector<HTMLElement>('#saveAmounts:not([hidden]), #saveRead')?.scrollIntoView({ block: 'center' }); return; }
        // Con el espejo de ahora: el último cambio (p. ej. la categoría recién elegida) puede no estar aún en la cola ni pintado.
        await settlePending(client);
        const freshMirror = await loadMirror(client);
        const fresh = freshMirror.invoices.find((i) => i.id === invoice.id) ?? invoice;
        const now = missingOf(freshMirror, fresh);
        if (now.length) { toast(`Para validar falta ${now.map((m) => MISSING_LABELS[m]).join(', ')}.`); goToMissing(now[0]!); return; }
        const ok = await validateNow(ctx, invoice.id, 'Factura validada.'); usage.track('invoices.facturas.validar', ok ? 'success' : 'error');
      } }, icon('check', 18), 'Validar'));
    actions.push(el('button', { 'data-feedback-id': 'invoices.facturas.ficha.importar_json', 'data-feedback-label': 'Importar JSON', class: 'softbtn', type: 'button', id: 'importInto', onclick: () => void openImport(ctx, mirror, invoice) }, icon('upload', 18), 'Importar JSON'));
    if (invoice.status === 'pendiente_datos' && files.some((f) => f.kind === 'original')) {
      actions.push(el('button', { 'data-feedback-id': 'invoices.facturas.ficha.extraer', 'data-feedback-label': 'Extraer', class: 'softbtn', type: 'button', id: 'extractInvoice', title: 'Pide a la Edge el JSON del documento y lo lleva a la vista previa de importación', onclick: () => void extractInto(ctx, invoice) }, icon('upload', 18), 'Extraer'));
    }
  }
  if (canEdit && invoice.status !== 'anulada') {
    actions.push(el('button', { 'data-feedback-id': 'invoices.facturas.ficha.pago', 'data-feedback-label': 'Pago', class: 'softbtn', type: 'button', id: unconfirmedPaid ? 'confirmPaid' : 'togglePaid', onclick: () => void (unconfirmedPaid ? confirmPaid() : togglePaid()) }, icon(unconfirmedPaid ? 'check' : 'euro', 18), unconfirmedPaid ? 'Confirmar pago' : invoice.payment_status === 'pagada' ? 'Marcar pendiente de pago' : 'Marcar pagada'));
  }
  if (role === 'owner' && invoice.status === 'validada') actions.push(el('button', { 'data-feedback-id': 'invoices.facturas.ficha.archivar', 'data-feedback-label': 'Archivar', class: 'ghost', type: 'button', onclick: () => void update({ status: 'archivada' }, 'Factura archivada.') }, icon('briefcase', 18), 'Archivar'));
  if (role === 'owner' && invoice.status === 'archivada') actions.push(el('button', { 'data-feedback-id': 'invoices.facturas.ficha.desarchivar', 'data-feedback-label': 'Desarchivar', class: 'ghost', type: 'button', onclick: () => void update({ status: 'validada' }, 'Factura desarchivada.') }, icon('undo', 18), 'Desarchivar'));
  if (canEdit && invoice.status !== 'anulada') actions.push(el('button', { 'data-feedback-id': 'invoices.facturas.ficha.anular', 'data-feedback-label': 'Anular', class: 'danger', type: 'button', id: 'annulInvoice', onclick: () => void annul() }, icon('trash', 18), 'Anular'));

  // FB_2026_027 y FB_2026_030: la fecha de pago nunca es la del clic. Sin confirmar, un toque la confirma tal cual.
  // Tanda 27: todo cambio del pago sale al momento con «Deshacer», que vuelve a poner los cuatro campos como estaban.
  const PAY_FIELDS = ['payment_status', 'paid_at', 'payment_method', 'payment_source'];
  const payChange = (fields: Record<string, unknown>, message: string, undone: string) =>
    commitWithUndo(client, { table: INVOICES, id: invoice.id, revision: invoice.revision, fields, before: pick(invoice as unknown as Record<string, unknown>, PAY_FIELDS) }, message, undone);
  async function confirmPaid(): Promise<void> {
    await payChange({ payment_source: 'confirmado' }, 'Pago confirmado.', 'Vuelve a estar sin confirmar.');
  }
  async function togglePaid(): Promise<void> {
    if (invoice.payment_status === 'pagada') { await payChange({ payment_status: 'pendiente', paid_at: null, payment_source: 'confirmado' }, 'Pago marcado como pendiente.', 'Vuelve a estar pagada.'); return; }
    const date = el('input', { ...fieldAttrs({ id: 'invoices.facturas.ficha.pago.fecha', label: 'Fecha de pago', type: 'date', entity: 'invoices.invoices', prop: 'paid_at', sensitivity: 'internal', confirm: 'none' }), type: 'date', value: invoice.paid_at ?? invoice.invoice_date ?? '', id: 'paidAt' });
    const method = select('paidMethod', [['', 'Sin indicar'], ...PAYMENT_METHODS.map((m) => [m, PAYMENT_METHOD_LABELS[m] ?? m] as [string, string])], invoice.payment_method, { ...fieldAttrs({ id: 'invoices.facturas.ficha.pago.metodo', label: 'Método de pago', type: 'select', entity: 'invoices.invoices', prop: 'payment_method', sensitivity: 'internal', confirm: 'none' }) });
    const ok = await confirmDialog({ title: 'Marcar como pagada', text: el('div', null, field('Fecha de pago', date), field('Método', method)), confirmLabel: 'Marcar pagada' });
    if (!ok) return;
    if (!date.value) { toast('Indica la fecha de pago.'); return; }
    await payChange({ payment_status: 'pagada', paid_at: date.value, payment_method: method.value || null, payment_source: 'confirmado' }, 'Factura marcada como pagada.', 'Vuelve a estar pendiente de pago.');
  }

  async function annul(): Promise<void> {
    const reason = el('input', { ...fieldAttrs({ id: 'invoices.facturas.ficha.anular.motivo', label: 'Motivo', type: 'text', entity: 'invoices.invoices', prop: 'annulled_reason', sensitivity: 'internal', confirm: 'none' }), type: 'text', id: 'annulReason', maxlength: '500', placeholder: 'Duplicada, abono, error…' });
    const ok = await confirmDialog({ title: `¿Anular ${invoice.code ?? 'esta factura'}?`, text: el('div', null, el('p', null, 'La factura se conserva fuera de los resúmenes y de la gestoría. Sus asignaciones pasan a la papelera.'), field('Motivo', reason)), confirmLabel: 'Anular', danger: true });
    if (!ok) return;
    if (!reason.value.trim()) { toast('Indica el motivo de la anulación.'); return; }
    usage.track('invoices.facturas.anular', (await call('invoices.annul', { invoice_id: invoice.id, expectedRevision: invoice.revision, reason: reason.value.trim() }, 'Factura anulada.')) ? 'success' : 'error');
  }

  // --- Cabecera y totales --------------------------------------------------
  /** Abre el bloque del campo que falta, lo lleva a la vista, le da el foco y lo resalta un momento. */
  function goToMissing(key: MissingKey): void {
    const selector: Record<MissingKey, string> = withEditor
      ? { invoice_date: '#manualDate', expense_category: '#manualCategory', original_file: '[data-feedback-id="invoices.facturas.ficha.documento"]', lines_or_taxes: '#manualRows input', rectified_invoice: '#invKind', rectification_sign: '#invKind', totals: '#manualTotal' }
      : { invoice_date: '#invDate', expense_category: '#invCategory', original_file: '[data-feedback-id="invoices.facturas.ficha.documento"]', lines_or_taxes: '[data-feedback-id="invoices.facturas.ficha.articulos"]', rectified_invoice: '#invKind', rectification_sign: '#invKind', totals: '#invSourceTotal' };
    const target = document.querySelector<HTMLElement>(selector[key]);
    if (!target) return;
    const details = target.closest('details');
    if (details) (details as HTMLDetailsElement).open = true;
    if (target.tagName === 'DETAILS') (target as HTMLDetailsElement).open = true;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) target.focus({ preventScroll: true });
    target.classList.add('needs-attention');
    setTimeout(() => target.classList.remove('needs-attention'), 2500);
  }
  const header = el('div', { class: 'inv-head', 'data-feedback-id': 'invoices.facturas.ficha', 'data-feedback-label': 'Ficha de factura' },
    el('div', { class: 'chips' },
      el('span', { class: statusChipClass(invoice.status, invoice.review_reason) }, statusText(invoice)),
      invoice.payment_status !== 'pagada' ? el('span', { class: 'chip' }, 'Pendiente de pago')
        : unconfirmedPaid ? el('span', { class: 'chip warn' }, 'Pagada (sin confirmar)') : el('span', { class: 'chip ok' }, `Pagada${invoice.paid_at ? ' ' + shortDate(invoice.paid_at) : ''}`),
      invoice.source === 'import_v1' ? el('span', { class: 'chip', title: 'Datos importados del JSON de ChatGPT' }, 'Desde JSON') : null,
      invoice.invoice_kind === 'rectificativa' ? el('span', { class: 'chip warn', id: 'rectChip' }, 'Rectificativa') : null,
    ),
    el('dl', { class: 'kv', 'data-feedback-ignore': '' },
      el('dt', null, 'Proveedor'), el('dd', { id: 'invSupplier' }, supplierName(supplier), supplier?.label ? el('span', { class: 'hint' }, ` · ${supplier.name}`) : null, supplier?.tax_id ? ` · ${supplier.tax_id}` : ''),
      el('dt', null, 'Fecha'), el('dd', null, invoice.invoice_date ? [shortDate(invoice.invoice_date), ` · periodo ${invoice.fiscal_period ?? periodOf(invoice.invoice_date)}`] : 'Sin fecha: léela del PDF o escríbela para poder validar'),
      el('dt', null, 'Número'), el('dd', null, invoice.invoice_number ?? '—'),
      el('dt', null, 'Objeto'), el('dd', null, invoice.object),
      el('dt', null, 'Pago'), el('dd', { id: 'invPayment' }, ...paymentText(),
        unconfirmedPaid && canEdit ? [' · ', el('button', { 'data-feedback-id': 'invoices.facturas.ficha.pago.no_pagada', 'data-feedback-label': 'No está pagada', class: 'linkbtn inline', type: 'button', id: 'notPaid',
          onclick: () => void payChange({ payment_status: 'pendiente', paid_at: null, payment_method: null, payment_source: 'confirmado' }, 'Pago marcado como pendiente.', 'Vuelve a estar pagada (sin confirmar).') }, 'No está pagada')] : []),
      ...rectificationRows(ctx, invoice, mirror),
      el('dt', null, 'Se declara en'), el('dd', { id: 'declaredPeriod' }, invoice.invoice_date || invoice.declared_period
        ? `${quarterName(invoice.declared_period ?? periodOfDate(invoice.invoice_date))}${invoice.delivered_elsewhere ? ' · ya pasada a la gestoría' : isLate(invoice) ? ` · atrasada (la fecha es del ${quarterName(periodOfDate(invoice.invoice_date))})` : ''}` : 'Sin fecha'),
      ...(invoice.drive_url ? [el('dt', null, 'Origen'), el('dd', null, 'Llegó por Google Drive · ', el('a', { href: invoice.drive_url, target: '_blank', rel: 'noopener', id: 'driveOrigin' }, 'abrir el original'))] : []),
    ),
    el('div', { class: 'btnrow inv-actions', 'data-feedback-id': 'invoices.facturas.ficha.acciones', 'data-feedback-label': 'Acciones' }, ...actions.map(compactAction)),
  );

  const totals = el('section', { class: 'inv-totals', 'data-feedback-id': 'invoices.facturas.ficha.totales', 'data-feedback-label': 'Totales', 'data-feedback-ignore': '' },
    el('div', { class: 'tot' }, el('span', null, 'Base'), el('strong', null, eur(invoice.calculated_base))),
    el('div', { class: 'tot' }, el('span', null, 'IVA'), el('strong', null, eur(invoice.calculated_vat))),
    Number(invoice.calculated_other) ? el('div', { class: 'tot' }, el('span', null, 'Otros'), el('strong', null, eur(invoice.calculated_other))) : null,
    el('div', { class: 'tot' }, el('span', null, 'Retenciones'), el('strong', null, eur(invoice.calculated_withholding))),
    el('div', { class: 'tot total' }, el('span', null, 'TOTAL'), el('strong', null, eur(invoice.calculated_total))),
    el('div', { class: `cuadre${outside ? ' bad' : delta === null ? '' : ' ok'}` },
      delta === null ? 'Sin total del documento' : outside ? `⚠ REVISAR IMPORTES · documento ${eur(invoice.source_total)} · diferencia ${eur(delta)}` : `✓ Importes comprobados · documento ${eur(invoice.source_total)}`),
  );

  // --- Documento -----------------------------------------------------------
  const fileInput = el('input', { ...fieldAttrs({ id: 'invoices.facturas.ficha.documento.archivos', label: 'Añadir documento', type: 'file', entity: 'invoices.invoice_files', prop: 'file_id', sensitivity: 'internal', confirm: 'none' }), type: 'file', accept: ACCEPT_ATTR, multiple: true, hidden: true, id: 'addFiles',
    onchange: async () => {
      try {
        const staged = await pickFiles(fileInput, client);
        if (!staged.length) return;
        const base = files.filter((f) => f.kind === 'original').length;
        const ops: RowOperation[] = staged.map((s, i) => ({ op: 'insert', table: INVOICE_FILES, id: crypto.randomUUID(), fields: { invoice_id: invoice.id, file_id: s.marker, original_filename: s.filename, page_order: base + i + 1, kind: pendingState || !files.some((f) => f.kind === 'original') ? 'original' : 'attachment', mime_type: s.mime, size_bytes: s.size, sha256: s.sha256 } }));
        await commitSafely(client, ops, staged.length === 1 ? 'Documento añadido.' : `${staged.length} documentos añadidos.`);
      } catch (error) { toast(describeError(error)); }
      fileInput.value = '';
    } });
  const documentBlock = fbBlock({ feedbackId: 'invoices.facturas.ficha.documento', feedbackLabel: 'Documento' }, 'Documento', files.length ? `${files.length}` : 'ninguno', true,
    files.length ? fbRows(renderList({ label: 'Documentos', rows: files.map((f) => ({
      id: f.id, title: f.normalized_filename, meta: [f.kind === 'attachment' ? 'Adjunto' : `Página ${f.page_order}`, formatBytes(Number(f.size_bytes)), f.original_filename], pending: f._pending === true,
      actions: [el('button', { 'data-feedback-id': 'invoices.facturas.ficha.documento.ver', 'data-feedback-label': 'Ver', class: 'linkbtn', type: 'button', onclick: () => openFile(client, f.file_id).catch((e) => toast(describeError(e))) }, icon('eye', 16), 'Ver')],
    })) }), { feedbackId: 'invoices.facturas.ficha.documento.lista', feedbackLabel: 'Documentos' }, { feedbackId: 'invoices.facturas.ficha.documento.fila', feedbackLabel: 'Documento' }) : el('p', { class: 'hint' }, 'Sin documento. Una factura no se valida sin su original.'),
    editable && invoice.status === 'pendiente_datos' && files.some((f) => f.kind === 'original') ? chatgptSteps('chatgptInvoice', () => void openImport(ctx, mirror, invoice), async () => {
      const original = files.filter((f) => f.kind === 'original').sort((a, b) => a.page_order - b.page_order)[0];
      if (!original) return null;
      if (!navigator.onLine) { toast('Para compartir el documento hace falta conexión (está en la nube).'); return null; }
      const file = await fetchStoredDocument(client, original.file_id, original.normalized_filename, original.mime_type);
      return { file, source: { filename: original.normalized_filename, sha256: original.sha256 } };
    }, (file) => readPdfInto(ctx, mirror, invoice, file, undefined, files.filter((f) => f.kind === 'original').sort((a, b) => a.page_order - b.page_order)[0]?.file_id)) : null,
    canEdit && invoice.status !== 'anulada' ? el('div', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'invoices.facturas.ficha.documento.anadir', 'data-feedback-label': 'Añadir PDF o fotos', class: 'softbtn', type: 'button', onclick: () => fileInput.click() }, icon('attach', 18), pendingState ? 'Añadir PDF o fotos' : 'Añadir adjunto'), fileInput) : null,
  );

  // --- Artículos -----------------------------------------------------------
  const lineForm = (line: LocalInvoiceLine | null) => renderLineForm(client, invoice, line, lines.length);
  // Orden manual (decisión del usuario, TABLÓN): con dos o más artículos y permiso de edición, lista reordenable del kit.
  // `position` se renumera 0..n-1 y solo se envían las filas que cambian; no hay unicidad por factura, así que no choca.
  const canLink = canEdit && invoice.status !== 'anulada' && invoice.status !== 'archivada';
  const openArticle = (l: LocalInvoiceLine) => openArticleSheet(ctx, invoice, l, mirror);
  // Tanda 30 (MUELA-080): la línea enlazada lleva el medallón de su artículo, y el bloque, el borde de lo peor
  const lineRow = (l: LocalInvoiceLine) => el('div', { class: `line-row${linksEnabled() && !l.item_id ? ' inv-line-free' : ''}`, 'data-feedback-id': 'invoices.facturas.ficha.articulos.fila', 'data-feedback-label': 'Artículo', dataset: { id: l.id, tone: linksEnabled() ? lineTone(l) ?? 'none' : 'none' } },
    el('div', { class: 'line-main' }, el('span', { class: 'line-desc', 'data-feedback-ignore': '' },
      linksEnabled() && l.item_id ? renderMedal({ size: 28, name: linkedItem(l.item_id)?.name ?? lineName(l) }) : null, lineName(l)),
      (linksEnabled() && l.item_id ? l.item_source : l.label_source) === 'recordado' ? el('span', { class: 'chip', title: 'Puesto solo: lo recordaba de otra factura de este proveedor' }, 'recordado') : null,
      l.item_type ? el('span', { class: 'hint' }, ' · ' + (ITEM_TYPE_LABELS[l.item_type] ?? l.item_type)) : null, l._pending ? el('span', { class: 'chip pending' }, 'Pendiente') : null,
      // La descripción de la factura (la que vale fiscalmente) sigue a la vista bajo «Mi nombre».
      lineName(l) !== l.description ? el('span', { class: 'hint line-original', 'data-feedback-ignore': '' }, `En la factura: ${l.description}`) : null,
      // R4: con el enlace encendido, cómo entra al inventario («1 saco = 25 kg → Despensa»)
      linksEnabled() && l.item_id ? el('span', { class: 'hint line-stock', 'data-feedback-ignore': '' }, stockText(l)) : null,
      // Tanda 27: la línea sin artículo lo dice y se toca para elegirlo
      linksEnabled() && !l.item_id ? (canLink
        ? el('button', { 'data-feedback-id': 'invoices.facturas.ficha.articulos.sin_articulo', 'data-feedback-label': 'Elegir artículo', class: 'linkbtn inv-line-pick', type: 'button', 'aria-label': `Elegir el artículo de ${l.description}`, onclick: () => openArticle(l) }, 'Sin artículo: no entra al inventario. Toca para elegirlo.')
        : el('span', { class: 'hint' }, 'Sin artículo: no entra al inventario.')) : null),
    el('div', { class: 'line-nums' },
      el('span', { 'data-feedback-ignore': '' }, l.quantity === null ? '—' : `${Number(l.quantity)} ${l.unit ?? ''}`.trim()),
      el('strong', { 'data-feedback-ignore': '' }, eur(l.net_amount)),
      returnedOf(l.id, mirror) ? el('span', { class: 'chip warn', 'data-feedback-ignore': '' }, `Devuelto: ${eur(returnedOf(l.id, mirror))}`) : null,
      el('span', null, l.vat_rate === null ? 'sin IVA' : `IVA ${Number(l.vat_rate)} %`),
      editable ? el('button', { 'data-feedback-id': 'invoices.facturas.ficha.articulos.editar', 'data-feedback-label': 'Editar artículo', class: 'linkbtn', type: 'button', 'aria-label': `Editar ${lineName(l)}`, onclick: () => replace(lineEditor, lineForm(l)) }, 'Editar') : null,
      // «Mi nombre»: también en una factura validada (no la devuelve a revisión).
      canEdit && invoice.status !== 'anulada' && invoice.status !== 'archivada' ? (linksEnabled()
        // R4: «Artículo» sustituye a «Mi nombre» (el texto sin artículo sigue siendo posible)
        ? el('button', { 'data-feedback-id': 'invoices.facturas.ficha.articulos.articulo', 'data-feedback-label': 'Artículo', class: 'linkbtn', type: 'button', 'aria-label': `${l.item_id ? 'Cambiar el artículo de' : 'Artículo para'} ${l.description}`, onclick: () => openArticle(l) }, l.item_id ? 'Cambiar' : 'Artículo')
        : el('button', { 'data-feedback-id': 'invoices.facturas.ficha.articulos.mi_nombre', 'data-feedback-label': 'Mi nombre', class: 'linkbtn', type: 'button', 'aria-label': `Mi nombre para ${l.description}`, onclick: () => replace(lineEditor, labelForm(client, l, () => replace(lineEditor))) }, 'Mi nombre')) : null,
    ),
  );
  const linesView = !lines.length
    ? el('p', { class: 'hint' }, 'Sin artículos. Importa el JSON o añádelos a mano.')
    : editable && lines.length > 1
      ? createSortableList<LocalInvoiceLine>({
        items: lines, key: (l) => l.id, name: (l) => lineName(l), label: 'Artículos de la factura', id: 'invoiceLines', render: lineRow,
        onReorder: async (ordered) => {
          const ops: RowOperation[] = ordered.flatMap((l, index): RowOperation[] => l.position === index ? [] : [{ op: 'update', table: INVOICE_LINES, id: l.id, expectedRevision: l.revision, fields: { position: index } }]);
          if (ops.length) await commitSafely(client, ops, 'Orden de los artículos guardado.');
        },
      }).element
      : el('div', { class: 'list plain-lines', id: 'invoiceLines' }, ...lines.map(lineRow));
  const linesBlock = fbBlock({ feedbackId: 'invoices.facturas.ficha.articulos', feedbackLabel: 'Artículos' }, 'Artículos', linksEnabled() ? articlesSummary(lines) : String(lines.length), true,
    linesView,
    editable ? el('div', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'invoices.facturas.ficha.articulos.anadir', 'data-feedback-label': 'Añadir artículo', class: 'softbtn', type: 'button', id: 'addLine', onclick: () => replace(lineEditor, lineForm(null)) }, icon('plus', 18), 'Añadir artículo')) : null,
  );
  const worstLine = linksEnabled() ? lines.filter((l) => !l.deleted_at).some((l) => lineTone(l)) ? 'warn' : null : null;
  if (worstLine) linesBlock.dataset.tone = worstLine;
  const lineEditor = el('div', { class: 'inv-editor' });
  linesBlock.appendChild(lineEditor);

  // --- Impuestos -----------------------------------------------------------
  const taxEditor = el('div', { class: 'inv-editor' });
  const taxBlock = fbBlock({ feedbackId: 'invoices.facturas.ficha.impuestos', feedbackLabel: 'Impuestos' }, 'Impuestos', String(taxes.length), false,
    taxes.length ? el('table', { class: 'inv-table', 'data-feedback-ignore': '' },
      el('thead', null, el('tr', null, el('th', null, 'Tipo'), el('th', { class: 'num' }, 'Tasa'), el('th', { class: 'num' }, 'Base'), el('th', { class: 'num' }, 'Importe'), editable ? el('th') : null)),
      el('tbody', null, ...taxes.map((t) => el('tr', null,
        el('td', null, TAX_TYPE_LABELS[t.tax_type] ?? t.tax_type), el('td', { class: 'num' }, t.rate === null ? '—' : `${Number(t.rate)} %`), el('td', { class: 'num' }, eur(t.taxable_base)), el('td', { class: 'num' }, eur(t.amount)),
        editable ? el('td', null, el('button', { 'data-feedback-id': 'invoices.facturas.ficha.impuestos.editar', 'data-feedback-label': 'Editar impuesto', class: 'linkbtn', type: 'button', onclick: () => replace(taxEditor, renderTaxForm(client, invoice, t, taxes.length)) }, 'Editar')) : null,
      ))),
    ) : el('p', { class: 'hint' }, 'Sin desglose: el IVA se calcula desde los artículos.'),
    editable ? el('div', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'invoices.facturas.ficha.impuestos.anadir', 'data-feedback-label': 'Añadir impuesto', class: 'softbtn', type: 'button', onclick: () => replace(taxEditor, renderTaxForm(client, invoice, null, taxes.length)) }, icon('plus', 18), 'Añadir impuesto')) : null,
  );
  taxBlock.appendChild(taxEditor);

  // --- Asignación ----------------------------------------------------------
  const allocBlock = fbBlock({ feedbackId: 'invoices.facturas.ficha.asignacion', feedbackLabel: 'Asignación' }, 'Asignación', lines.length ? `${lines.filter((l) => unallocated(l, mirror) > 0).length} sin asignar` : '—', lines.length > 0,
    ...lines.map((l) => {
      const allocations = mirror.allocationsByLine.get(l.id) ?? [];
      const assigned = fromCents(sumCents(allocations.map((a) => Number(a.allocated_amount))));
      const rest = unallocated(l, mirror);
      const pct = Number(l.net_amount) !== 0 ? Math.min(100, Math.round((Math.abs(assigned) / Math.abs(Number(l.net_amount))) * 100)) : 0;
      return el('div', { class: 'alloc-line' },
        el('div', { class: 'alloc-head', 'data-feedback-ignore': '' }, el('strong', null, lineName(l)), el('span', null, `${eur(assigned)} de ${eur(l.net_amount)}`)),
        el('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' }, el('span', { style: `width:${pct}%` })),
        el('div', { class: 'chips' },
          ...allocations.map((a) => {
            const chip = el('span', { class: 'chip', style: '--chip:#6b7f52', dataset: { allocation: a.id } }, allocationLabel(a), ` · ${eur(a.allocated_amount)}`,
              canEdit && invoice.status !== 'anulada' ? el('button', { 'data-feedback-id': 'invoices.facturas.ficha.asignacion.quitar', 'data-feedback-label': 'Quitar asignación', class: 'x', type: 'button', 'aria-label': `Quitar asignación ${allocationLabel(a)}`, onclick: () => void commitSafely(client, [{ op: 'delete', table: ALLOCATIONS, id: a.id, expectedRevision: a.revision }], 'Asignación enviada a la papelera.') }, '×') : null);
            void checkTargetFreshness(client, a).then((f) => { if (f === 'changed' || f === 'missing') { chip.classList.add('alert'); chip.title = FRESHNESS_LABELS[f]; chip.appendChild(el('span', { class: 'stale' }, ` · ${FRESHNESS_LABELS[f]}`)); } });
            return chip;
          }),
          rest > 0 ? el('span', { class: 'chip alert' }, `Sin asignar ${eur(rest)}`) : null,
          canEdit && invoice.status !== 'anulada' && rest > 0 ? el('button', { 'data-feedback-id': 'invoices.facturas.ficha.asignacion.asignar', 'data-feedback-label': 'Asignar a…', class: 'linkbtn', type: 'button', onclick: () => void openAllocation(ctx, mirror, invoice, l) }, icon('plus', 16), 'Asignar a…') : null,
        ),
      );
    }),
  );

  // Rectificativa enlazada: su reparto se propone igual que el de la original, en proporción y en negativo (0227).
  const originalLines = invoice.rectifies_invoice_id ? mirror.lines.filter((l) => !l.deleted_at && l.invoice_id === invoice.rectifies_invoice_id) : [];
  const originalAllocations = originalLines.flatMap((l) => mirror.allocationsByLine.get(l.id) ?? []).filter((a) => !a.deleted_at);
  if (canEdit && invoice.status !== 'anulada' && invoice.invoice_kind === 'rectificativa' && originalAllocations.length && lines.every((l) => !(mirror.allocationsByLine.get(l.id) ?? []).length)) {
    allocBlock.appendChild(el('div', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'invoices.facturas.ficha.asignacion.como_original', 'data-feedback-label': 'Repartir como la original', class: 'softbtn', type: 'button', id: 'allocateLikeOriginal',
      onclick: async () => {
        const proposed = proposeRectificationAllocations({ rectLines: lines.map((l) => ({ id: l.id, net_amount: Number(l.net_amount), rectifies_line_id: l.rectifies_line_id ?? null })),
          originalLines: originalLines.map((l) => ({ id: l.id, net_amount: Number(l.net_amount) })),
          originalAllocations: originalAllocations.map((a) => ({ ...a, allocated_amount: Number(a.allocated_amount), target_revision: a.target_revision ?? null, target_code: a.target_code ?? null })) });
        if (!proposed.length) { toast('La original no tiene reparto que copiar.'); return; }
        const ok = await confirmDialog({ title: 'Repartir como la original', text: proposed.map((p) => `${p.target_label}: ${eur(p.allocated_amount)}`).join(' · '), confirmLabel: 'Repartir' });
        if (!ok) return;
        await commitSafely(client, proposed.map((p): RowOperation => ({ op: 'insert', table: ALLOCATIONS, id: crypto.randomUUID(), fields: { ...p } })), 'Reparto copiado de la original.');
      } }, 'Repartir como la original'),
      el('span', { class: 'hint' }, 'Resta de las mismas obras, proyectos o retiros que la original, en proporción.')));
  }

  // --- Pago y fiscal -------------------------------------------------------
  const category = select('invCategory', [['', 'Sin categoría'], ...CATEGORIES.map((c) => [c, CATEGORY_LABELS[c]] as [string, string])], invoice.expense_category, { ...fieldAttrs({ id: 'invoices.facturas.ficha.fiscal.categoria', label: 'Categoría de gasto', type: 'select', entity: 'invoices.invoices', prop: 'expense_category', sensitivity: 'internal', confirm: 'none' }), disabled: !editable, onchange: () => void update({ expense_category: category.value || null }) });
  const investment = el('input', { ...fieldAttrs({ id: 'invoices.facturas.ficha.fiscal.inversion', label: 'Es inversión', type: 'toggle', entity: 'invoices.invoices', prop: 'is_investment', sensitivity: 'internal', confirm: 'none' }), type: 'checkbox', id: 'invInvestment', checked: invoice.is_investment, disabled: !editable, onchange: () => void update({ is_investment: investment.checked }) });
  const deductibility = select('invDeductibility', DEDUCTIBILITIES.map((d) => [d, DEDUCTIBILITY_LABELS[d] ?? d] as [string, string]), invoice.deductibility, { ...fieldAttrs({ id: 'invoices.facturas.ficha.fiscal.deducibilidad', label: 'Deducibilidad', type: 'select', entity: 'invoices.invoices', prop: 'deductibility', sensitivity: 'internal', confirm: 'none' }), disabled: !canEdit || invoice.status === 'anulada', onchange: () => void update({ deductibility: deductibility.value as Deductibility }) });
  const invDate = el('input', { ...fieldAttrs({ id: 'invoices.facturas.ficha.fiscal.fecha', label: 'Fecha de la factura', type: 'date', entity: 'invoices.invoices', prop: 'invoice_date', sensitivity: 'internal', confirm: 'none' }), type: 'date', id: 'invDate', value: invoice.invoice_date ?? '', disabled: !editable, onchange: () => void update({ invoice_date: invDate.value || null }) });
  const kind = select('invKind', [['ordinaria', 'Factura ordinaria'], ['rectificativa', 'Rectificativa (abono o devolución)']], invoice.invoice_kind ?? 'ordinaria',
    { ...fieldAttrs({ id: 'invoices.facturas.ficha.fiscal.tipo', label: 'Tipo de factura', type: 'select', entity: 'invoices.invoices', prop: 'invoice_kind', sensitivity: 'internal', confirm: 'none' }), disabled: !editable, onchange: () => void update({ invoice_kind: kind.value }) });
  // 0247 (VG, 27-10): un ticket se registra, pero no es deducible ni va a la gestoría. Validada, ya no vuelve a ser ticket.
  const receiptKind = select('invReceiptKind', [['invoice', 'Factura'], ['ticket', 'Ticket (no deducible, no va a la gestoría)']], invoice.receipt_kind ?? 'invoice',
    { ...fieldAttrs({ id: 'invoices.facturas.ficha.fiscal.justificante', label: 'Factura o ticket', type: 'select', entity: 'invoices.invoices', prop: 'receipt_kind', sensitivity: 'internal', confirm: 'none' }), disabled: !editable || ((invoice.receipt_kind ?? 'invoice') === 'invoice' && (invoice.status === 'validada' || invoice.status === 'archivada')),
      onchange: () => void update({ receipt_kind: receiptKind.value }) });
  const rectNumber = el('input', { ...fieldAttrs({ id: 'invoices.facturas.ficha.fiscal.rectifica_numero', label: 'Número de la factura que rectifica', type: 'text', entity: 'invoices.invoices', prop: 'rectifies_number', sensitivity: 'internal', confirm: 'none' }), type: 'text', id: 'invRectNumber', maxlength: '64',
    value: invoice.rectifies_number ?? '', disabled: !editable, onchange: () => void update({ rectifies_number: rectNumber.value.trim() || null }) });
  const candidates = mirror.invoices.filter((o) => !o.deleted_at && o.status !== 'anulada' && o.id !== invoice.id && o.supplier_id === invoice.supplier_id && (o.invoice_kind ?? 'ordinaria') === 'ordinaria')
    .sort((a, b) => (b.invoice_date ?? '').localeCompare(a.invoice_date ?? ''));
  const rectOriginal = select('invRectOriginal', [['', 'Sin enlazar'], ...candidates.map((o) => [o.id, `nº ${o.invoice_number ?? '—'} · ${shortDate(o.invoice_date)} · ${eur(o.calculated_total)}`] as [string, string])], invoice.rectifies_invoice_id ?? '',
    { ...fieldAttrs({ id: 'invoices.facturas.ficha.fiscal.rectifica_original', label: 'Factura original', type: 'select', entity: 'invoices.invoices', prop: 'rectifies_invoice_id', sensitivity: 'internal', confirm: 'none' }), disabled: !editable, onchange: () => void update({ rectifies_invoice_id: rectOriginal.value || null }) });
  const withoutOriginal = el('input', { ...fieldAttrs({ id: 'invoices.facturas.ficha.fiscal.sin_original', label: 'No tengo la original', type: 'toggle', entity: 'invoices.invoices', prop: 'rectification_without_original', sensitivity: 'internal', confirm: 'none' }), type: 'checkbox', id: 'invWithoutOriginal', checked: !!invoice.rectification_without_original, disabled: !editable,
    onchange: () => void update({ rectification_without_original: withoutOriginal.checked }) });
  const rectFields = invoice.invoice_kind === 'rectificativa' ? el('div', { id: 'rectFields' },
    el('div', { class: 'row2' }, field('Rectifica a la factura nº', rectNumber, 'Tal como lo imprime el proveedor: la app la enlaza sola cuando esté.'), field('Factura original', rectOriginal)),
    el('label', { class: 'check' }, withoutOriginal, el('span', null, 'No tengo la original (se valida igual, con aviso en Gestoría)'))) : null;
  // Periodo de declaración (0228): el de su fecha o uno posterior (atrasada). El aviso propone el trimestre en curso cuando la
  // fecha es de uno anterior que aún no se ha entregado desde la app (lo normal es que se declarara fuera).
  const ownPeriod = periodOfDate(invoice.invoice_date);
  const periodOptions: Array<[string, string]> = [['', ownPeriod ? `El de su fecha (${quarterName(ownPeriod)})` : 'El de su fecha']];
  if (ownPeriod) {
    let [y, q] = [Number(ownPeriod.slice(0, 4)), Number(ownPeriod.slice(5))];
    for (let i = 0; i < 4; i++) { q += 1; if (q > 4) { q = 1; y += 1; } periodOptions.push([`${y}T${q}`, `${q}T ${y} (atrasada)`]); }
  }
  if (invoice.declared_period && !periodOptions.some(([v]) => v === invoice.declared_period)) periodOptions.push([invoice.declared_period, quarterName(invoice.declared_period)]);
  const periodSelect = select('invDeclaredPeriod', periodOptions, invoice.declared_period ?? '', { ...fieldAttrs({ id: 'invoices.facturas.ficha.fiscal.periodo', label: 'Se declara en', type: 'select', entity: 'invoices.invoices', prop: 'declared_period', sensitivity: 'internal', confirm: 'none' }),
    disabled: !canEdit || ['validada', 'archivada', 'anulada'].includes(invoice.status) && invoice.status !== 'validada', onchange: () => void update({ declared_period: periodSelect.value || null }) });
  const delivered = (date: string) => mirror.exports.some((e) => !e.deleted_at && e.from_date <= date && date <= e.to_date);
  const askLate = canEdit && !invoice.declared_period && !!ownPeriod && ownPeriod < workingPeriod() && invoice.status !== 'anulada' && invoice.status !== 'archivada' && !delivered(invoice.invoice_date!);
  // Cómo se edita y qué falta (incidencia del usuario, 9-10-2026): arriba de la ficha, con la lista viva de lo que falta.
  if (editable && pendingState) {
    header.appendChild(el('div', { class: `banner ${missing.length ? 'warn' : 'ok'}`, id: 'reviewBanner', role: 'status' },
      el('span', null, missing.length ? 'Falta: ' : 'Todo listo para validar. Lo que cambies abajo se guarda solo.',
        ...missing.flatMap((m, i) => [i ? ', ' : '', el('button', { 'data-feedback-id': 'invoices.facturas.ficha.falta', 'data-feedback-label': 'Ir a lo que falta', class: 'linkbtn inline', type: 'button', dataset: { missing: m }, onclick: () => goToMissing(m) }, MISSING_LABELS[m])]),
        missing.length ? '.' : '')));
  }
  // FB_2026_024: «Se deja en su trimestre» para la atrasada que la gestoría ya tiene; queda fuera de las entregas.
  const keepInQuarter = () => el('button', { 'data-feedback-id': 'invoices.facturas.ficha.dejar_en_su_trimestre', 'data-feedback-label': 'Se deja en su trimestre', class: 'softbtn small', type: 'button', id: 'keepInQuarter',
    onclick: () => void update({ declared_period: ownPeriod, delivered_elsewhere: true }, `Se queda en el ${quarterName(ownPeriod!)}, como ya pasada a la gestoría.`) }, `En el ${quarterName(ownPeriod!)} (ya la tiene la gestoría)`);
  if (askLate) {
    header.appendChild(el('div', { class: 'banner warn', id: 'lateBanner' }, el('span', null, `Es del ${quarterName(ownPeriod)}. ¿Dónde la declaras?`),
      el('button', { 'data-feedback-id': 'invoices.facturas.ficha.declarar_ahora', 'data-feedback-label': 'Declararla en el trimestre en curso', class: 'softbtn small', type: 'button', id: 'declareNow',
        onclick: () => void update({ declared_period: workingPeriod() }, `Se declarará en el ${quarterName(workingPeriod())}.`) }, `En el ${quarterName(workingPeriod())}`),
      keepInQuarter()));
  } else if (canEdit && ownPeriod && isLate(invoice) && !invoice.delivered_elsewhere && invoice.status !== 'anulada' && invoice.status !== 'archivada') {
    // Atrasada (movida a otro trimestre): también se puede dejar en el suyo si la gestoría ya la tiene.
    header.appendChild(el('div', { class: 'banner info', id: 'lateMoved' }, el('span', null, `Atrasada: es del ${quarterName(ownPeriod)} y se declara en el ${quarterName(invoice.declared_period!)}. Si la gestoría ya la tiene, se deja en su trimestre.`), keepInQuarter()));
  }
  if (canEdit && invoice.delivered_elsewhere && invoice.status !== 'anulada' && invoice.status !== 'archivada') {
    header.appendChild(el('div', { class: 'banner info', id: 'deliveredElsewhere' }, el('span', null, `Ya pasada a la gestoría: se queda en el ${quarterName(invoice.declared_period ?? ownPeriod ?? '')} y no entra en las entregas.`),
      el('button', { 'data-feedback-id': 'invoices.facturas.ficha.deshacer_ya_pasada', 'data-feedback-label': 'Deshacer «ya pasada a la gestoría»', class: 'linkbtn', type: 'button', id: 'undoDeliveredElsewhere',
        onclick: () => void update({ declared_period: null, delivered_elsewhere: false }, 'Vuelve a contar para las entregas.') }, 'Deshacer')));
  }
  const dueDate = el('input', { ...fieldAttrs({ id: 'invoices.facturas.ficha.fiscal.vencimiento', label: 'Vencimiento', type: 'date', entity: 'invoices.invoices', prop: 'due_date', sensitivity: 'internal', confirm: 'none' }), type: 'date', id: 'invDue', value: invoice.due_date ?? '', disabled: !editable, onchange: () => void update({ due_date: dueDate.value || null }) });
  const sourceTotal = el('input', { ...fieldAttrs({ id: 'invoices.facturas.ficha.fiscal.total_documento', label: 'Total del documento', type: 'number', entity: 'invoices.invoices', prop: 'source_total', sensitivity: 'internal', confirm: 'none' }), 'data-feedback-ignore': '', type: 'text', inputmode: 'decimal', id: 'invSourceTotal', value: invoice.source_total === null ? '' : String(Number(invoice.source_total)).replace('.', ','), disabled: !editable, placeholder: 'Total impreso en la factura',
    onchange: () => { const v = parseAmount(sourceTotal.value); if (sourceTotal.value.trim() && v === null) { toast('Importe inválido.'); return; } void update({ source_total: v }); } });
  const notes = el('textarea', { ...fieldAttrs({ id: 'invoices.facturas.ficha.fiscal.notas', label: 'Notas', type: 'text', entity: 'invoices.invoices', prop: 'notes', sensitivity: 'internal', confirm: 'none' }), 'data-feedback-ignore': '', id: 'invNotes', rows: '2', disabled: !canEdit }); notes.value = invoice.notes ?? '';
  notes.addEventListener('change', () => void update({ notes: notes.value.trim() || null }));
  // Abierto si falta algo suyo para validar: al volver a pintarse la ficha, lo que falta sigue a la vista.
  const fiscalMissing = missing.some((m) => (withEditor ? m === 'rectified_invoice' || m === 'rectification_sign' : m !== 'original_file' && m !== 'lines_or_taxes'));
  const fiscalBlock = fbBlock({ feedbackId: 'invoices.facturas.ficha.fiscal', feedbackLabel: 'Fiscal y pago' }, 'Fiscal y pago', `${categoryLabel(invoice.expense_category)}${invoice.is_investment ? ' · inversión' : ''}`, fiscalMissing,
    el('div', { class: 'row2' }, withEditor ? null : field('Categoría de gasto', category), field('Deducibilidad', deductibility)),
    el('label', { class: 'check' }, investment, el('span', null, 'Es inversión (no gasto de explotación)')),
    field('Tipo de factura', kind),
    field('Justificante', receiptKind),
    rectFields,
    field('Se declara en', periodSelect, 'Fecha real aparte: una factura del 2T que no declaraste entonces se declara en el trimestre que elijas.'),
    el('div', { class: 'row2' }, withEditor ? null : field('Fecha de la factura', invDate, invoice.invoice_date ? undefined : 'Sin fecha no se puede validar.'), field('Vencimiento', dueDate)),
    withEditor ? null : field('Total del documento', sourceTotal, 'Lo que imprime la factura; se compara con el total calculado (tolerancia 0,02 €).'),
    field('Notas', notes),
  );

  // --- Importación ---------------------------------------------------------
  const meta = invoice.import_meta as Record<string, unknown> | null;
  const importBlock = meta ? fbBlock({ feedbackId: 'invoices.facturas.ficha.importacion', feedbackLabel: 'Importación' }, 'Importación', `confianza ${typeof meta.overall_confidence === 'number' ? Math.round(meta.overall_confidence * 100) + ' %' : '—'}`, false,
    typeof meta.origin === 'string' ? el('p', { id: 'importOrigin' }, el('strong', null, ORIGIN_LABELS[meta.origin] ?? meta.origin)) : null,
    meta.extraction_notes ? el('p', null, String(meta.extraction_notes)) : null,
    meta.provenance && typeof meta.provenance === 'object' ? renderProvenance(meta.provenance as Record<string, FieldProvenance>) : null,
    Array.isArray(meta.warnings) && meta.warnings.length ? el('div', { class: 'chips' }, ...(meta.warnings as string[]).map((w) => el('span', { class: 'chip alert' }, w))) : el('p', { class: 'hint' }, 'Sin avisos de extracción.'),
  ) : null;

  // Lectura del documento (fase 0): lo que se lee del PDF, lo que falta y el texto, en las pendientes.
  const pdfOriginal = files.filter((f) => f.kind === 'original' && f.mime_type === 'application/pdf').sort((a, b) => a.page_order - b.page_order)[0];
  const readingBlock = pendingState && pdfOriginal ? documentReadingBlock(ctx, mirror, invoice, pdfOriginal) : null;

  return el('div', { class: 'inv' }, header, editorBlock, totals, documentBlock, readingBlock, linesBlock, taxBlock, allocBlock, fiscalBlock, importBlock);
}

/** Periodo fiscal derivado en el cliente para filas optimistas (el servidor lo genera al confirmar). */
function periodOf(isoDate: string): string {
  const year = isoDate.slice(0, 4); const month = Number(isoDate.slice(5, 7)) || 1;
  return `${year}T${Math.ceil(month / 3)}`;
}

/** Mensaje para una sesión de Claude Code con la MCP de Finance (§15.1). */
const CLAUDE_MESSAGE = 'Lee las facturas pendientes de Drive en Ikisai Finance y complétalas. Usa la herramienta invoices_pending_drafts para ver cuáles son; descarga cada PDF de su enlace, léelo con cuidado y llama a invoices_import_json con su invoice_id, el JSON ikisai.invoice.v1 y la procedencia de cada dato (provenance con confidence, text y page). Si el borrador ya tiene datos (en «already»: proveedor, número, fecha o total), compruébalos en el PDF y respétalos salvo error evidente; completa solo lo que falta (reading.missing). Si un dato no se lee con seguridad, déjalo a null y explícalo en extraction_notes. Si es una factura rectificativa o un abono, dilo en extraction_notes con el número de la factura que rectifica. No valides nada. Al terminar, dime cuántas has completado y cuáles te han dado problemas.';

/**
 * «Leer con IA» (flujo recomendado para la primera factura de un proveedor): ChatGPT en el móvil (comparte el PDF y las
 * instrucciones; el JSON vuelve compartido o pegado) o una sesión de Claude en el ordenador (el mensaje, listo para copiar).
 */
function openReadWithAi(ctx: ViewContext, invoice: LocalInvoice, original: LocalInvoiceFile): void {
  const message = el('textarea', { ...fieldAttrs({ id: 'invoices.facturas.leer_ia.mensaje', label: 'Mensaje para Claude', type: 'text', sensitivity: 'internal', confirm: 'none' }), 'data-feedback-ignore': '', readonly: true, rows: '5', id: 'claudeMessage', style: 'width:100%' });
  message.value = CLAUDE_MESSAGE;
  openSheet({
    title: 'Leer con IA',
    meta: 'La primera factura de cada proveedor se lee con IA; al validarla, Finance aprende la plantilla y las siguientes se leen solas.',
    body: el('div', { 'data-feedback-id': 'invoices.facturas.leer_ia', 'data-feedback-label': 'Leer con IA' },
      el('h3', null, 'En el móvil: con ChatGPT'),
      el('p', null, '1. Pulsa «Compartir con ChatGPT» y elige ChatGPT: le llegan el PDF y las instrucciones. 2. Cuando responda, comparte su respuesta con Ikisai Finance (o cópiala y usa «Pegar JSON»). 3. Revisa y valida.'),
      el('p', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'invoices.facturas.leer_ia.chatgpt', 'data-feedback-label': 'Compartir con ChatGPT', class: 'primary', type: 'button', id: 'shareChatgpt', onclick: async () => {
        if (!navigator.onLine) { toast('Para compartir el documento hace falta conexión (está en la nube).'); return; }
        try {
          const file = await fetchStoredDocument(ctx.client, original.file_id, original.normalized_filename, original.mime_type);
          // Fase 3: lo ya leído va con las instrucciones; la IA completa solo lo que falta.
          const reading = await currentReading(ctx, await loadMirror(ctx.client), invoice, original);
          const known = reading?.hasText ? knownFieldsText(reading.found, missingLabels(reading.found)) : null;
          const how = await shareWithAi(file, { filename: original.normalized_filename, sha256: original.sha256 }, known);
          if (how === 'files' || how === 'text') toast('Cuando ChatGPT responda, comparte el resultado con Ikisai Finance o pégalo con «Pegar JSON».');
        } catch (error) { toast(describeError(error)); }
      } }, 'Compartir con ChatGPT'),
        el('button', { 'data-feedback-id': 'invoices.facturas.leer_ia.pegar', 'data-feedback-label': 'Pegar JSON', class: 'softbtn', type: 'button', onclick: async () => { await closeSheet(true); const m = await loadMirror(ctx.client); openImport(ctx, m, m.invoices.find((i) => i.id === invoice.id) ?? invoice); } }, 'Pegar JSON')),
      el('h3', null, 'En el ordenador: con Claude'),
      el('p', null, 'Con Claude Code conectado (Inicio › «Leer con Claude» › «Conectar Claude»), pega este mensaje: completa esta y las demás pendientes de Drive.'),
      message,
      el('p', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'invoices.facturas.leer_ia.claude', 'data-feedback-label': 'Copiar mensaje para Claude', class: 'softbtn', type: 'button', onclick: () => void navigator.clipboard.writeText(CLAUDE_MESSAGE).then(() => toast('Mensaje copiado.')) }, 'Copiar mensaje para Claude'))),
    foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void closeSheet() }, 'Cerrar')],
  });
}

/** «2026T3» → «3T 2026». */
export function quarterName(period: string | null): string {
  const m = period?.match(/^(\d{4})T([1-4])$/);
  return m ? `${m[2]}T ${m[1]}` : '—';
}
/** Se declara en un trimestre posterior al de su fecha (0228). */
export function isLate(invoice: LocalInvoice): boolean {
  const own = periodOfDate(invoice.invoice_date);
  return !!invoice.declared_period && !!own && invoice.declared_period > own;
}
/** Periodo como `AAAATn` del trimestre en el que se trabaja (en octubre, el 3T). */
function workingPeriod(): string {
  const q = workingQuarter();
  return `${q.year}T${q.quarter}`;
}

/** Lo que queda por asignar de una línea, en valor absoluto (en una rectificativa la línea y sus asignaciones son negativas). */
function unallocated(line: LocalInvoiceLine, mirror: Mirror): number {
  const assigned = sumCents((mirror.allocationsByLine.get(line.id) ?? []).map((a) => Number(a.allocated_amount)));
  return fromCents(Math.max(0, Math.abs(toCents(Number(line.net_amount))) - Math.abs(assigned)));
}

/** Importe devuelto de una línea por las rectificativas vivas enlazadas a ella (0227). */
function returnedOf(lineId: string, mirror: Mirror): number {
  const live = new Set(mirror.invoices.filter((i) => !i.deleted_at && i.status !== 'anulada').map((i) => i.id));
  return fromCents(Math.abs(sumCents(mirror.lines.filter((l) => !l.deleted_at && l.rectifies_line_id === lineId && live.has(l.invoice_id)).map((l) => Number(l.net_amount)))));
}

/** Filas de la ficha: a qué rectifica (o «pendiente de enlazar») o por qué rectificativas está rectificada. */
function rectificationRows(ctx: ViewContext, invoice: LocalInvoice, mirror: Mirror): HTMLElement[] {
  const byId = new Map(mirror.invoices.map((i) => [i.id, i]));
  if (invoice.invoice_kind === 'rectificativa') {
    const original = invoice.rectifies_invoice_id ? byId.get(invoice.rectifies_invoice_id) : undefined;
    return [el('dt', null, 'Rectifica a'), el('dd', { id: 'rectifiesOriginal' }, original
      ? el('a', { href: `#/facturas/${original.id}`, onclick: (e: Event) => { e.preventDefault(); void openInvoice(ctx, original.id); } }, `${original.code ?? 'factura'} · nº ${original.invoice_number ?? '—'} · ${shortDate(original.invoice_date)}`)
      : invoice.rectification_without_original ? `Sin la original (nº ${invoice.rectifies_number ?? '—'})` : `Pendiente de enlazar (nº ${invoice.rectifies_number ?? 'sin indicar'})`)];
  }
  const rects = mirror.invoices.filter((r) => !r.deleted_at && r.status !== 'anulada' && r.rectifies_invoice_id === invoice.id);
  if (!rects.length) return [];
  const total = fromCents(sumCents(rects.map((r) => Number(r.calculated_total))));
  return [el('dt', null, 'Rectificada por'), el('dd', { id: 'rectifiedBy' }, ...rects.map((r, i) => [i ? ' · ' : '',
    el('a', { href: `#/facturas/${r.id}`, onclick: (e: Event) => { e.preventDefault(); void openInvoice(ctx, r.id); } }, `${r.code ?? 'rectificativa'} (${eur(r.calculated_total)})`)]).flat(),
    ` · devuelto en total ${eur(Math.abs(total))}`)];
}

function allocationLabel(a: LocalAllocation): string {
  if (a.target_app === 'general') return GENERAL_KIND_LABELS[a.target_kind] ?? a.target_kind;
  return a.target_label;
}

// ---------------------------------------------------------------------------
// Formularios de artículo e impuesto
// ---------------------------------------------------------------------------
function renderLineForm(client: SyncClient, invoice: LocalInvoice, line: LocalInvoiceLine | null, count: number): HTMLElement {
  const description = el('input', { ...fieldAttrs({ id: 'invoices.facturas.articulo.descripcion', label: 'Descripción', type: 'text', entity: 'invoices.invoice_lines', prop: 'description', sensitivity: 'internal', confirm: 'none' }), 'data-feedback-ignore': '', type: 'text', id: 'lineDescription', required: true, maxlength: '500', value: line?.description ?? '' });
  const label = el('input', { ...fieldAttrs({ id: 'invoices.facturas.articulo.nombre_propio', label: 'Mi nombre', type: 'text', entity: 'invoices.invoice_lines', prop: 'label', sensitivity: 'internal', confirm: 'none' }), 'data-feedback-ignore': '', type: 'text', id: 'lineLabel', maxlength: '120', placeholder: 'Opcional: cómo lo llamas tú', value: line?.label ?? '' });
  const quantity = el('input', { ...fieldAttrs({ id: 'invoices.facturas.articulo.cantidad', label: 'Cantidad', type: 'number', entity: 'invoices.invoice_lines', prop: 'quantity', sensitivity: 'internal', confirm: 'none' }), type: 'text', inputmode: 'decimal', id: 'lineQuantity', value: line?.quantity === null || line?.quantity === undefined ? '' : String(Number(line.quantity)) });
  const unit = el('input', { ...fieldAttrs({ id: 'invoices.facturas.articulo.unidad', label: 'Unidad', type: 'text', entity: 'invoices.invoice_lines', prop: 'unit', sensitivity: 'internal', confirm: 'none' }), type: 'text', id: 'lineUnit', maxlength: '16', value: line?.unit ?? '' });
  const unitPrice = el('input', { ...fieldAttrs({ id: 'invoices.facturas.articulo.precio_unitario', label: 'Precio unitario', type: 'number', entity: 'invoices.invoice_lines', prop: 'unit_price', sensitivity: 'internal', confirm: 'none' }), 'data-feedback-ignore': '', type: 'text', inputmode: 'decimal', id: 'lineUnitPrice', value: line?.unit_price === null || line?.unit_price === undefined ? '' : String(Number(line.unit_price)) });
  const net = el('input', { ...fieldAttrs({ id: 'invoices.facturas.articulo.base', label: 'Base (sin IVA)', type: 'number', entity: 'invoices.invoice_lines', prop: 'net_amount', sensitivity: 'internal', confirm: 'none' }), 'data-feedback-ignore': '', type: 'text', inputmode: 'decimal', id: 'lineNet', required: true, value: line ? String(Number(line.net_amount)) : '' });
  const vatRate = select('lineVat', [['', 'Sin IVA'], ['0', '0 %'], ['4', '4 %'], ['10', '10 %'], ['21', '21 %']], line?.vat_rate === null || line?.vat_rate === undefined ? '' : String(Number(line.vat_rate)), { ...fieldAttrs({ id: 'invoices.facturas.articulo.iva', label: 'IVA', type: 'select', entity: 'invoices.invoice_lines', prop: 'vat_rate', sensitivity: 'internal', confirm: 'none' }) });
  const itemType = select('lineType', [['', 'Tipo de artículo'], ...ITEM_TYPES.map((t) => [t, ITEM_TYPE_LABELS[t] ?? t] as [string, string])], line?.item_type, { ...fieldAttrs({ id: 'invoices.facturas.articulo.tipo', label: 'Tipo de artículo', type: 'select', entity: 'invoices.invoice_lines', prop: 'item_type', sensitivity: 'internal', confirm: 'none' }) });
  const error = el('p', { class: 'formerror', role: 'alert' });
  const autoNet = () => { const q = parseAmount(quantity.value); const p = parseAmount(unitPrice.value); if (q !== null && p !== null && !net.value.trim()) net.value = String(Math.round(q * p * 100) / 100); };
  quantity.addEventListener('input', autoNet); unitPrice.addEventListener('input', autoNet);
  const host = el('form', { 'data-feedback-id': 'invoices.facturas.articulo', 'data-feedback-label': 'Artículo', class: 'inv-form', novalidate: true, onsubmit: async (e: Event) => {
    e.preventDefault();
    error.textContent = '';
    const netValue = parseAmount(net.value);
    if (!description.value.trim()) { error.textContent = 'La descripción es obligatoria.'; return; }
    if (netValue === null) { error.textContent = 'La base de la línea es obligatoria.'; return; }
    const rate = vatRate.value === '' ? null : Number(vatRate.value);
    const fields: Record<string, unknown> = {
      description: description.value.trim(), quantity: parseAmount(quantity.value), unit: unit.value.trim() || null, unit_price: parseAmount(unitPrice.value), net_amount: netValue,
      vat_rate: rate, vat_amount: rate === null ? null : Math.round(netValue * rate) / 100, gross_amount: rate === null ? null : Math.round(netValue * (100 + rate)) / 100, item_type: itemType.value || null,
      label: label.value.trim() || null,
    };
    const ops: RowOperation[] = line
      ? [{ op: 'update', table: INVOICE_LINES, id: line.id, expectedRevision: line.revision, fields: changed(fields, line) }]
      : [{ op: 'insert', table: INVOICE_LINES, id: crypto.randomUUID(), fields: { ...fields, invoice_id: invoice.id, position: count, discount_amount: 0 } }];
    if (await commitSafely(client, ops, line ? 'Artículo guardado.' : 'Artículo añadido.')) replace(host);
  } },
    el('div', { class: 'row2' }, field('Descripción', description, 'La de la factura: es la que va a la gestoría.'), field('Tipo', itemType)),
    field('Mi nombre', label, 'Cómo lo llamas tú. Al validar, Finance lo recuerda para las siguientes facturas de este proveedor.'),
    el('div', { class: 'row2' }, field('Cantidad', quantity), field('Unidad', unit), field('Precio unitario', unitPrice)),
    el('div', { class: 'row2' }, field('Base (sin IVA)', net), field('IVA', vatRate)),
    error,
    el('div', { class: 'btnrow' },
      el('button', { 'data-feedback-id': 'invoices.facturas.articulo.guardar', 'data-feedback-label': 'Guardar artículo', class: 'primary', type: 'submit', id: 'saveLine' }, line ? 'Guardar artículo' : 'Añadir artículo'),
      el('button', { 'data-feedback-id': 'invoices.facturas.articulo.cancelar', 'data-feedback-label': 'Cancelar', class: 'ghost', type: 'button', onclick: () => replace(host) }, 'Cancelar'),
      line && (invoice.status === 'pendiente_datos' || invoice.status === 'pendiente_revision') ? el('button', { 'data-feedback-id': 'invoices.facturas.articulo.borrar', 'data-feedback-label': 'Borrar artículo', class: 'danger', type: 'button', onclick: async () => { if (await commitSafely(client, [{ op: 'delete', table: INVOICE_LINES, id: line.id, expectedRevision: line.revision }], 'Artículo quitado.')) replace(host); } }, 'Quitar') : null,
    ),
  );
  return host;
}

/** «Mi nombre» de una línea, en una sola casilla (también en facturas validadas: no las devuelve a revisión). */
/** R4: cómo entra una línea enlazada al inventario: «2 saco = 50 kg → Despensa», «Ya entró desde la compra de Food». */
/**
 * Lo que pide una línea con el enlace encendido (tanda 30): sin artículo, o enlazada sin entrar al inventario (sin cantidad
 * o sin espacio), es «warn»; con algo devuelto que no cuadra no se marca aquí (lo dice su etiqueta).
 */
function lineTone(l: LocalInvoiceLine): 'warn' | null {
  if (l.deleted_at) return null;
  if (!l.item_id) return 'warn';
  if (l.entered_movement_id) return null;
  return l.quantity === null || !spaceName(l.space_id ?? linkedItem(l.item_id)?.defaultSpaceId ?? null) ? 'warn' : null;
}

/** «3 artículos · 2 entran al inventario · 1 sin artículo» (tanda 27). */
function articlesSummary(lines: LocalInvoiceLine[]): string {
  const live = lines.filter((l) => !l.deleted_at);
  const linked = live.filter((l) => l.item_id);
  const entering = linked.filter((l) => !l.entered_movement_id && l.quantity !== null && !!spaceName(l.space_id ?? linkedItem(l.item_id)?.defaultSpaceId ?? null)).length;
  const free = live.length - linked.length;
  return [`${live.length} artículo${live.length === 1 ? '' : 's'}`, `${entering} entra${entering === 1 ? '' : 'n'} al inventario`, free ? `${free} sin artículo` : null].filter(Boolean).join(' · ');
}

/**
 * «Artículo» de una línea en su hoja (tanda 27): sustituye a la ficha mientras se elige y, al guardar, quitar o cerrar,
 * vuelve a la ficha (como la hoja de asignar).
 */
function openArticleSheet(ctx: ViewContext, invoice: LocalInvoice, line: LocalInvoiceLine, mirror: Mirror): void {
  let back = true;
  const done = () => { void closeSheet(true); };
  const form = articleForm(ctx.client, invoice, line, (id) => mirror.supplierById.get(id)?.name ?? null, done);
  openSheet({
    title: `Artículo · ${lineName(line)}`,
    body: form,
    panelAttrs: { 'data-feedback-id': 'invoices.facturas.articulo.hoja', 'data-feedback-label': 'Hoja de artículo' },
    onClose: () => { if (back) { back = false; void openInvoice(ctx, invoice.id); } },
  });
}

function stockText(l: LocalInvoiceLine): string {
  const item = linkedItem(l.item_id);
  if (!item) return 'Artículo enlazado';
  if (l.entered_movement_id) return 'Ya entró desde la compra de Food';
  const where = spaceName(l.space_id ?? item.defaultSpaceId);
  const q = l.quantity === null || l.quantity === undefined ? null : Number(l.quantity);
  const amount = q === null ? 'Sin cantidad: no entra al inventario'
    : l.unit && l.item_factor ? `${q} ${l.unit} = ${Math.round(q * Number(l.item_factor) * 1000) / 1000} ${item.baseUnit}` : `${q} ${item.baseUnit}`;
  return where ? `${amount} → ${where}` : `${amount} · sin sitio: no entra al inventario`;
}

function labelForm(client: SyncClient, line: LocalInvoiceLine, done: () => void): HTMLElement {
  const input = el('input', { ...fieldAttrs({ id: 'invoices.facturas.articulo.mi_nombre.texto', label: 'Mi nombre', type: 'text', entity: 'invoices.invoice_lines', prop: 'label', sensitivity: 'internal', confirm: 'none' }), 'data-feedback-ignore': '', type: 'text', id: 'labelInput', maxlength: '120', value: line.label ?? '', placeholder: line.description, 'aria-label': 'Mi nombre' });
  const form = el('form', { 'data-feedback-id': 'invoices.facturas.articulo.mi_nombre', 'data-feedback-label': 'Mi nombre', class: 'inv-form', novalidate: true, onsubmit: async (e: Event) => {
    e.preventDefault();
    const value = input.value.trim() || null;
    if (value === (line.label ?? null)) { done(); return; }
    if (await commitSafely(client, [{ op: 'update', table: INVOICE_LINES, id: line.id, expectedRevision: line.revision, fields: { label: value } }], value ? 'Nombre guardado. Al validar, se recuerda para este proveedor.' : 'Nombre quitado.')) done();
  } },
    field('Mi nombre', input, `En la factura: «${line.description}». Vacío para usar ese.`),
    el('div', { class: 'btnrow' },
      el('button', { 'data-feedback-id': 'invoices.facturas.articulo.mi_nombre.guardar', 'data-feedback-label': 'Guardar nombre', class: 'primary', type: 'submit', id: 'saveLabel' }, 'Guardar'),
      el('button', { 'data-feedback-id': 'invoices.facturas.articulo.mi_nombre.cancelar', 'data-feedback-label': 'Cancelar', class: 'ghost', type: 'button', onclick: done }, 'Cancelar')));
  setTimeout(() => input.focus(), 0);
  return form;
}

function renderTaxForm(client: SyncClient, invoice: LocalInvoice, tax: LocalTaxLine | null, count: number): HTMLElement {
  const type = select('taxType', TAX_TYPES.map((t) => [t, TAX_TYPE_LABELS[t] ?? t] as [string, string]), tax?.tax_type ?? 'iva', { ...fieldAttrs({ id: 'invoices.facturas.impuesto.tipo', label: 'Tipo de impuesto', type: 'select', entity: 'invoices.tax_lines', prop: 'tax_type', sensitivity: 'internal', confirm: 'none' }) });
  const rate = el('input', { ...fieldAttrs({ id: 'invoices.facturas.impuesto.tasa', label: 'Tasa', type: 'number', entity: 'invoices.tax_lines', prop: 'rate', sensitivity: 'internal', confirm: 'none' }), type: 'text', inputmode: 'decimal', id: 'taxRate', value: tax?.rate === null || tax?.rate === undefined ? '' : String(Number(tax.rate)) });
  const base = el('input', { ...fieldAttrs({ id: 'invoices.facturas.impuesto.base', label: 'Base', type: 'number', entity: 'invoices.tax_lines', prop: 'taxable_base', sensitivity: 'internal', confirm: 'none' }), 'data-feedback-ignore': '', type: 'text', inputmode: 'decimal', id: 'taxBase', value: tax?.taxable_base === null || tax?.taxable_base === undefined ? '' : String(Number(tax.taxable_base)) });
  const amount = el('input', { ...fieldAttrs({ id: 'invoices.facturas.impuesto.importe', label: 'Importe', type: 'number', entity: 'invoices.tax_lines', prop: 'amount', sensitivity: 'internal', confirm: 'none' }), 'data-feedback-ignore': '', type: 'text', inputmode: 'decimal', id: 'taxAmount', required: true, value: tax ? String(Number(tax.amount)) : '' });
  const error = el('p', { class: 'formerror', role: 'alert' });
  const auto = () => { const b = parseAmount(base.value); const r = parseAmount(rate.value); if (b !== null && r !== null && !amount.value.trim()) amount.value = String(Math.round(b * r) / 100); };
  base.addEventListener('input', auto); rate.addEventListener('input', auto);
  const host = el('form', { 'data-feedback-id': 'invoices.facturas.impuesto', 'data-feedback-label': 'Impuesto', class: 'inv-form', novalidate: true, onsubmit: async (e: Event) => {
    e.preventDefault();
    const a = parseAmount(amount.value);
    if (a === null || a < 0) { error.textContent = 'El importe es obligatorio y no puede ser negativo.'; return; }
    const fields: Record<string, unknown> = { tax_type: type.value, rate: parseAmount(rate.value), taxable_base: parseAmount(base.value), amount: a };
    const ops: RowOperation[] = tax
      ? [{ op: 'update', table: TAX_LINES, id: tax.id, expectedRevision: tax.revision, fields: changed(fields, tax) }]
      : [{ op: 'insert', table: TAX_LINES, id: crypto.randomUUID(), fields: { ...fields, invoice_id: invoice.id, position: count } }];
    if (await commitSafely(client, ops, tax ? 'Impuesto guardado.' : 'Impuesto añadido.')) replace(host);
  } },
    el('div', { class: 'row2' }, field('Tipo', type), field('Tasa %', rate), field('Base', base), field('Importe', amount)),
    error,
    el('div', { class: 'btnrow' },
      el('button', { 'data-feedback-id': 'invoices.facturas.impuesto.guardar', 'data-feedback-label': 'Guardar impuesto', class: 'primary', type: 'submit', id: 'saveTax' }, tax ? 'Guardar impuesto' : 'Añadir impuesto'),
      el('button', { 'data-feedback-id': 'invoices.facturas.impuesto.cancelar', 'data-feedback-label': 'Cancelar', class: 'ghost', type: 'button', onclick: () => replace(host) }, 'Cancelar'),
      tax && (invoice.status === 'pendiente_datos' || invoice.status === 'pendiente_revision') ? el('button', { 'data-feedback-id': 'invoices.facturas.impuesto.borrar', 'data-feedback-label': 'Borrar impuesto', class: 'danger', type: 'button', onclick: async () => { if (await commitSafely(client, [{ op: 'delete', table: TAX_LINES, id: tax.id, expectedRevision: tax.revision }], 'Impuesto quitado.')) replace(host); } }, 'Quitar') : null,
    ),
  );
  return host;
}

/** Valor del desplegable de proveedor para crear uno nuevo desde la propia hoja. */
const NEW_SUPPLIER = '__new__';

// ---------------------------------------------------------------------------
// Nueva factura (subir documento) · API.md §6.1 paso 1
// ---------------------------------------------------------------------------
export function openNewInvoice(ctx: ViewContext, mirror: Mirror): void {
  const { client } = ctx;
  const suppliers = supplierOptions(mirror.suppliers);
  // Incidencia de la aceptación (V1): el proveedor se crea aquí mismo, sin ir a Inicio › Proveedores.
  const supplier = select('newSupplier', [['', 'Elige proveedor'], ...suppliers, [NEW_SUPPLIER, '+ Nuevo proveedor…']], suppliers.length ? null : NEW_SUPPLIER, { ...fieldAttrs({ id: 'invoices.facturas.nueva.proveedor', label: 'Proveedor', type: 'select', entity: 'invoices.invoices', prop: 'supplier_id', sensitivity: 'internal', confirm: 'none' }), 'data-feedback-ignore': '' });
  const supplierName = el('input', { ...fieldAttrs({ id: 'invoices.facturas.nueva.proveedor_nombre', label: 'Nombre del proveedor', type: 'text', entity: 'invoices.suppliers', prop: 'name', sensitivity: 'personal', confirm: 'none' }), 'data-feedback-ignore': '', type: 'text', id: 'newSupplierName', maxlength: '160', placeholder: 'Nombre del proveedor', autocomplete: 'organization' });
  const supplierTaxId = el('input', { ...fieldAttrs({ id: 'invoices.facturas.nueva.proveedor_nif', label: 'NIF', type: 'text', entity: 'invoices.suppliers', prop: 'tax_id', sensitivity: 'personal', confirm: 'none' }), 'data-feedback-ignore': '', type: 'text', id: 'newSupplierTaxId', maxlength: '32', placeholder: 'Opcional', autocapitalize: 'characters' });
  const supplierFields = el('div', { class: 'row2 new-supplier', id: 'newSupplierFields' }, field('Nombre del proveedor', supplierName), field('NIF', supplierTaxId));
  const syncSupplierFields = () => { supplierFields.hidden = supplier.value !== NEW_SUPPLIER; };
  supplier.addEventListener('change', () => { syncSupplierFields(); if (supplier.value === NEW_SUPPLIER) supplierName.focus(); });
  syncSupplierFields();
  const date = el('input', { ...fieldAttrs({ id: 'invoices.facturas.nueva.fecha', label: 'Fecha', type: 'date', entity: 'invoices.invoices', prop: 'invoice_date', sensitivity: 'internal', confirm: 'none' }), type: 'date', id: 'newDate' });
  const object = el('input', { ...fieldAttrs({ id: 'invoices.facturas.nueva.objeto', label: 'Objeto', type: 'text', entity: 'invoices.invoices', prop: 'object', sensitivity: 'internal', confirm: 'none' }), type: 'text', id: 'newObject', maxlength: '120', placeholder: 'Opcional: alimentos retiro yoga' });
  // FB_2026_026: artículos opcionales al crear la factura a mano (descripción, base sin IVA y tipo).
  type ArticleRow = { description: HTMLInputElement; amount: HTMLInputElement; rate: HTMLSelectElement };
  const articles: ArticleRow[] = [];
  const articlesHost = el('div', { id: 'newArticles' });
  const addArticle = () => {
    const n = articles.length + 1;
    const row: ArticleRow = {
      description: el('input', { ...fieldAttrs({ id: 'invoices.facturas.nueva.articulo', label: 'Artículo', type: 'text', entity: 'invoices.invoice_lines', prop: 'description', sensitivity: 'internal', confirm: 'none' }), 'data-feedback-ignore': '', type: 'text', maxlength: '500', placeholder: 'Artículo', 'aria-label': `Artículo ${n}` }),
      amount: el('input', { ...fieldAttrs({ id: 'invoices.facturas.nueva.articulo_base', label: 'Base', type: 'number', entity: 'invoices.invoice_lines', prop: 'net_amount', sensitivity: 'internal', confirm: 'none' }), 'data-feedback-ignore': '', type: 'text', inputmode: 'decimal', placeholder: 'Base', 'aria-label': `Base del artículo ${n}` }),
      rate: select('', [['21', 'IVA 21 %'], ['10', 'IVA 10 %'], ['4', 'IVA 4 %'], ['0', 'IVA 0 %']], '21', { ...fieldAttrs({ id: 'invoices.facturas.nueva.articulo_iva', label: 'IVA del artículo', type: 'select', entity: 'invoices.invoice_lines', prop: 'vat_rate', sensitivity: 'internal', confirm: 'none' }), 'data-feedback-ignore': '', 'aria-label': `IVA del artículo ${n}` }),
    };
    articles.push(row);
    articlesHost.appendChild(el('div', { class: 'row3 manual-row' }, row.description, row.amount, row.rate));
    row.description.focus();
  };
  const addArticleButton = el('button', { 'data-feedback-id': 'invoices.facturas.nueva.anadir_articulo', 'data-feedback-label': '+ Añadir artículo', class: 'linkbtn', type: 'button', id: 'newAddArticle', onclick: addArticle }, '+ Añadir artículo');
  const number = el('input', { ...fieldAttrs({ id: 'invoices.facturas.nueva.numero', label: 'Número de factura', type: 'text', entity: 'invoices.invoices', prop: 'invoice_number', sensitivity: 'internal', confirm: 'none' }), type: 'text', id: 'newNumber', maxlength: '64', placeholder: 'Opcional' });
  const total = el('input', { ...fieldAttrs({ id: 'invoices.facturas.nueva.total', label: 'Total del documento', type: 'number', entity: 'invoices.invoices', prop: 'source_total', sensitivity: 'internal', confirm: 'none' }), 'data-feedback-ignore': '', type: 'text', inputmode: 'decimal', id: 'newTotal', placeholder: 'Opcional, con IVA' });
  const files = el('input', { ...fieldAttrs({ id: 'invoices.facturas.nueva.documentos', label: 'PDF o fotos', type: 'file', entity: 'invoices.invoice_files', prop: 'file_id', sensitivity: 'internal', confirm: 'none' }), type: 'file', id: 'newFiles', accept: ACCEPT_ATTR, multiple: true });
  const error = el('p', { class: 'formerror', role: 'alert' });
  const save = el('button', { 'data-feedback-id': 'invoices.facturas.nueva.crear', 'data-feedback-label': 'Crear factura', class: 'primary', type: 'submit', id: 'saveInvoice', form: 'newInvoiceForm' }, 'Crear factura');
  // Incidencia de la aceptación (V1): en cuanto hay documento, el camino manual con ChatGPT a la vista, siempre
  // (con o sin extracción automática). «Pegar JSON» abre la importación con estos mismos documentos.
  const chatgpt = chatgptSteps('chatgptNew', async () => {
    const picked = Array.from(files.files ?? []);
    guard.dirtyEditor = false;
    await closeSheet(true);
    openImport(ctx, mirror, null, undefined, { files: picked });
  }, async () => {
    const all = Array.from(files.files ?? []);
    const file = all.find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) ?? all[0];
    return file ? { file, source: { filename: file.name, sha256: await sha256Hex(file) } } : null;
  }, async (file) => { await readNew(file, false); });
  /** Lee el PDF elegido (al elegirlo, o con «Leer PDF») y rellena el formulario con lo que encuentre. */
  async function readNew(file: File, auto: boolean): Promise<ReadLevel | null> {
    const picked = Array.from(files.files ?? []);
    let level: ReadLevel | null = null;
    if (auto) replace(readingHost, el('p', { class: 'hint', id: 'readingProgress', role: 'status' }, 'Leyendo el PDF…'));
    await readPdfInto(ctx, mirror, null, file, picked, undefined, (prefill) => {
      level = prefill.read;
      if (prefill.items?.length) lastRead = { file, items: prefill.items };
      // Lectura parcial (fase 0): lo encontrado rellena lo vacío del formulario; lo demás, a mano o con la IA.
      const f = prefill.found;
      const taxId = f.supplier_tax_id?.replace(/[\s.-]/g, '').toUpperCase() ?? null;
      const known = taxId ? mirror.suppliers.find((s) => !s.deleted_at && s.slug !== 'sin_identificar' && (s.tax_id ?? '').replace(/[\s.-]/g, '').toUpperCase() === taxId) : undefined;
      if (!supplier.value || supplier.value === NEW_SUPPLIER) {
        if (known) supplier.value = known.id;
        else if (f.supplier_name || f.supplier_tax_id) { supplier.value = NEW_SUPPLIER; if (!supplierName.value && f.supplier_name) supplierName.value = f.supplier_name; if (!supplierTaxId.value && f.supplier_tax_id) supplierTaxId.value = f.supplier_tax_id; }
        syncSupplierFields();
      }
      if (!date.value && f.invoice_date) date.value = f.invoice_date;
      if (!number.value && f.invoice_number) number.value = f.invoice_number;
      if (!total.value && f.total !== null) total.value = String(f.total).replace('.', ',');
      if (!object.value.trim()) object.value = (file.name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_\s]+/g, ' ').trim() || 'factura').slice(0, 120);
      replace(readingHost, readingPanel(prefill), prefill.read === 'sufficient'
        ? el('p', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'invoices.facturas.nueva.importar_leido', 'data-feedback-label': 'Importar lo leído', class: 'primary small', type: 'button', id: 'importRead',
          onclick: () => void readNew(file, false) }, 'Importar lo leído'), el('span', { class: 'hint' }, 'Con los importes y el IVA, para revisarla y validarla.'))
        : null);
      preview();
    }, auto);
    return level;
  }
  const isPdfFile = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
  /** Varias páginas de una misma factura: lee el primer PDF con texto (no solo el primero). */
  async function readFirstWithText(picked: File[]): Promise<void> {
    for (const f of picked.filter(isPdfFile)) if ((await readNew(f, true)) !== 'no_text') return;
  }
  const readingHost = el('div', { id: 'newReading' });
  /** Lo último leído (fase 1, PR 3): al crear la factura, su texto va al servidor para rellenar lo que falte. */
  let lastRead: { file: File; items: PdfTextItem[] } | null = null;
  // Varios archivos (pregunta del usuario, 9-10-2026): ¿páginas de una misma factura o facturas distintas?
  const multiHost = el('div', { id: 'multiFiles' });
  let multiChoice: 'same' | null = null;
  chatgpt.hidden = true;
  // Fase 1: elegir el PDF ya lo lee (en el worker de PDF.js, con límites de tamaño y tiempo); sin pulsar nada más.
  files.addEventListener('change', () => {
    const picked = Array.from(files.files ?? []);
    multiChoice = null;
    replace(readingHost);
    replace(multiHost);
    chatgpt.hidden = !picked.length;
    if (picked.length > 1) {
      chatgpt.hidden = true;
      replace(multiHost, el('div', { class: 'banner info', id: 'multiQuestion', role: 'group', 'aria-label': 'Varios archivos' },
        el('span', null, `Has elegido ${picked.length} archivos. ¿Son páginas de una misma factura o facturas distintas?`),
        el('div', { class: 'btnrow' },
          el('button', { 'data-feedback-id': 'invoices.facturas.nueva.varios.misma', 'data-feedback-label': 'Páginas de una misma factura', class: 'softbtn small', type: 'button', id: 'samePages', onclick: () => {
            multiChoice = 'same';
            replace(multiHost, el('p', { class: 'hint', id: 'multiChoice' }, `Una sola factura con ${picked.length} documentos.`));
            chatgpt.hidden = false;
            void readFirstWithText(picked);
          } }, 'Páginas de una misma factura'),
          el('button', { 'data-feedback-id': 'invoices.facturas.nueva.varios.distintas', 'data-feedback-label': 'Facturas distintas', class: 'primary small', type: 'button', id: 'separateInvoices', onclick: async () => {
            // Como al compartir desde otra app: una factura por archivo, con lectura automática.
            guard.dirtyEditor = false;
            await closeSheet(true);
            openBatchUpload(ctx, () => loadMirror(client), () => undefined, picked);
          } }, 'Facturas distintas'))));
      return;
    }
    if (picked[0] && isPdfFile(picked[0])) void readNew(picked[0], true);
  });
  const form = el('form', { 'data-feedback-id': 'invoices.facturas.nueva.formulario', 'data-feedback-label': 'Datos de la factura', id: 'newInvoiceForm', novalidate: true, oninput: () => { guard.dirtyEditor = true; }, onsubmit: async (e: Event) => {
    e.preventDefault();
    error.textContent = '';
    // Fase 1: con documento, ni el proveedor ni el objeto son obligatorios: queda en «Pendiente de datos» con el
    // proveedor provisional y el objeto del nombre del archivo, y se completa después.
    if ((files.files?.length ?? 0) > 1 && multiChoice !== 'same') { error.textContent = 'Elige si son páginas de una misma factura o facturas distintas.'; multiHost.scrollIntoView({ block: 'nearest' }); return; }
    const firstFile = files.files?.[0] ?? null;
    const noSupplier = !supplier.value || (supplier.value === NEW_SUPPLIER && !supplierName.value.trim() && !supplierTaxId.value.trim());
    if (noSupplier && !firstFile) { error.textContent = 'Elige el PDF o foto, o el proveedor.'; files.focus(); return; }
    if (supplier.value === NEW_SUPPLIER && !noSupplier && !supplierName.value.trim()) { error.textContent = 'Escribe el nombre del proveedor nuevo.'; supplierName.focus(); return; }
    const filledArticles = articles.map((a) => ({ description: a.description.value.trim(), amount: parseAmount(a.amount.value), rate: Number(a.rate.value) })).filter((a) => a.description || a.amount !== null);
    if (filledArticles.some((a) => !a.description || a.amount === null)) { error.textContent = 'Cada artículo necesita descripción y base (o déjalo vacío).'; return; }
    // El objeto es opcional (FB_2026_026): del primer artículo, del nombre del archivo o «factura».
    if (!object.value.trim()) object.value = (filledArticles[0]?.description || (firstFile ? firstFile.name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_\s]+/g, ' ').trim() : '') || 'factura').slice(0, 120);
    const sourceTotal = total.value.trim() ? parseAmount(total.value) : null;
    if (total.value.trim() && sourceTotal === null) { error.textContent = 'Total inválido.'; total.focus(); return; }
    save.disabled = true;
    try {
      const staged = await pickFiles(files, client);
      const invoiceId = crypto.randomUUID();
      // Proveedor nuevo: si el NIF ya existe se usa ese proveedor; si no, se crea en el mismo lote que la factura.
      const taxId = supplierTaxId.value.trim() || null;
      const sameTaxId = supplier.value === NEW_SUPPLIER && taxId ? mirror.suppliers.find((s) => !s.deleted_at && (s.tax_id ?? '').replace(/[\s.-]/g, '').toUpperCase() === taxId.replace(/[\s.-]/g, '').toUpperCase()) : undefined;
      const placeholder = noSupplier ? mirror.suppliers.find((s) => !s.deleted_at && s.slug === 'sin_identificar') : undefined;
      const supplierId = noSupplier ? placeholder?.id ?? crypto.randomUUID() : supplier.value !== NEW_SUPPLIER ? supplier.value : sameTaxId?.id ?? crypto.randomUUID();
      const chosen = mirror.supplierById.get(supplierId);
      const ops: RowOperation[] = [
        ...(noSupplier && !placeholder ? [{ op: 'insert', table: SUPPLIERS, id: supplierId, fields: { name: 'Sin identificar (Drive)', slug: 'sin_identificar' } } as RowOperation] : []),
        ...(!noSupplier && supplier.value === NEW_SUPPLIER && !sameTaxId ? [{ op: 'insert', table: SUPPLIERS, id: supplierId, fields: { name: supplierName.value.trim(), tax_id: taxId } } as RowOperation] : []),
        { op: 'insert', table: INVOICES, id: invoiceId, fields: { supplier_id: supplierId, invoice_date: date.value || null, object: object.value.trim(), invoice_number: number.value.trim() || null, source_total: sourceTotal, expense_category: chosen?.default_category ?? null, is_investment: chosen?.default_is_investment ?? false } },
        ...staged.map((s, i): RowOperation => ({ op: 'insert', table: INVOICE_FILES, id: crypto.randomUUID(), fields: { invoice_id: invoiceId, file_id: s.marker, original_filename: s.filename, page_order: i + 1, kind: 'original', mime_type: s.mime, size_bytes: s.size, sha256: s.sha256 } })),
        ...filledArticles.map((a, i): RowOperation => ({ op: 'insert', table: INVOICE_LINES, id: crypto.randomUUID(), fields: {
          invoice_id: invoiceId, position: i, description: a.description, net_amount: a.amount, vat_rate: a.rate, vat_amount: Math.round(a.amount! * a.rate) / 100, discount_amount: 0 } })),
      ];
      if (sameTaxId) toast(`Ya tenías el proveedor ${sameTaxId.name} con ese NIF: la factura queda a su nombre.`);
      const created = await commitSafely(client, ops, 'Factura creada en este dispositivo.');
      if (created && lastRead) {
        const sha = await sha256Hex(lastRead.file);
        if (staged.some((s) => s.sha256 === sha)) { queueDocumentText(sha, lastRead.items); void flushDocumentTexts(client); }
      }
      usage.track('invoices.facturas.subir', created ? 'success' : 'error');
      if (created) {
        guard.dirtyEditor = false;
        await closeSheet(true);
        void openInvoice(ctx, invoiceId);
      }
    } catch (err) { error.textContent = describeError(err); }
    save.disabled = false;
  } },
    field('PDF o fotos', files, 'Elige el PDF: se lee solo y rellena lo que encuentre. Varias facturas a la vez: se crea una por archivo. Las fotos se reducen en el móvil.'),
    multiHost,
    chatgpt,
    readingHost,
    el('p', { class: 'hint form-section' }, 'O a mano (si no hay PDF con texto ni IA):'),
    field('Proveedor', supplier, 'Si no está en la lista, elige «+ Nuevo proveedor…» y créalo aquí. Con el JSON de ChatGPT se crea solo.'),
    supplierFields,
    el('div', { class: 'row2' }, field('Fecha', date, 'Opcional: si la dejas vacía, se toma del PDF al leerlo.'), field('Número de factura', number)),
    field('Objeto (opcional)', object, 'Qué se compró, en pocas palabras. Forma parte del nombre del archivo.'),
    el('div', { 'data-feedback-id': 'invoices.facturas.nueva.articulos', 'data-feedback-label': 'Artículos (opcional)' }, articlesHost, el('p', { class: 'btnrow' }, addArticleButton, el('span', { class: 'hint' }, 'Opcional: artículo, base sin IVA y tipo.'))),
    field('Total del documento', total),
    el('p', { class: 'hint' }, 'Vista previa del nombre: ', el('code', { id: 'namePreview' }, '…')),
    error,
  );
  const preview = () => {
    const chosen = mirror.supplierById.get(supplier.value);
    const name = supplier.value === NEW_SUPPLIER ? supplierName.value : chosen?.name ?? '';
    form.querySelector('#namePreview')!.textContent = normalizedFilename({ invoiceDate: date.value || null, supplierSlug: chosen?.slug ?? slugify(name), object: object.value, mime: storedMime(files.files?.[0]) });
  };
  files.addEventListener('change', preview);
  form.addEventListener('input', preview);
  preview();
  openSheet({
    title: 'Nueva factura',
    body: el('div', null,
      el('div', { class: 'btnrow', style: 'margin-bottom:12px' }, el('button', { 'data-feedback-id': 'invoices.facturas.nueva.importar_json', 'data-feedback-label': 'Importar JSON de ChatGPT', class: 'softbtn', type: 'button', id: 'importNew', onclick: () => void openImport(ctx, mirror, null) }, icon('upload', 18), 'Importar JSON de ChatGPT')),
      form),
    foot: [el('button', { 'data-feedback-id': 'invoices.facturas.nueva.cancelar', 'data-feedback-label': 'Cancelar', class: 'ghost', type: 'button', onclick: () => void closeSheet() }, 'Cancelar'), save],
    initialFocus: files,
    beforeClose: async () => !guard.dirtyEditor || confirmDialog({ title: 'Hay cambios sin guardar', text: '¿Descartarlos?', confirmLabel: 'Descartar', danger: true }),
    onClose: () => { guard.dirtyEditor = false; },
  });
}

// ---------------------------------------------------------------------------
// Importar JSON ikisai.invoice.v1 · API.md §6.1 pasos 3-4
// ---------------------------------------------------------------------------
/** Lo que llega de «Extraer» a la hoja de importación: documento (si lo hubo), avisos y errores del modelo, y coste. */
export interface ExtractionPrefill { rectification?: { isRectification: boolean; number: string | null; evidence: string | null }; document?: ImportDocument; warnings: string[]; errors?: unknown[]; usage?: ExtractionUsage | null; provenance?: Record<string, FieldProvenance>; origin?: 'api' | 'pdf_text'; payment?: ReadPayment | null }

const PROVENANCE_LABELS: Record<string, string> = {
  'invoice.supplier_name': 'Proveedor', 'invoice.supplier_tax_id': 'NIF', 'invoice.invoice_date': 'Fecha', 'invoice.invoice_number': 'Número',
  'invoice.object': 'Objeto', 'document_totals.base': 'Base', 'document_totals.vat': 'IVA', 'document_totals.withholding': 'Retención', 'document_totals.total': 'Total', lines: 'Artículos',
};
const METHOD_LABELS: Record<string, string> = { pdf_text: 'texto del PDF', supplier_template: 'plantilla del proveedor', external_ai: 'app de IA', manual: 'sin leer', ocr: 'OCR' };
/** Quién leyó la factura (0226, `import_meta.origin`). */
const ORIGIN_LABELS: Record<string, string> = { pdf_text: 'Leída del texto del PDF, sin IA', ia: 'Leída por una sesión de Claude (IA): revisa cada dato', api: 'Extraída automáticamente', json: 'Importada del JSON de ChatGPT' };

/** Procedencia por campo: valor propuesto, confianza y de dónde sale. Nada inferido se presenta como verificado. */
function renderProvenance(provenance: Record<string, FieldProvenance>): HTMLElement {
  return el('ul', { 'data-feedback-ignore': '', class: 'provenance', id: 'provenance' }, ...Object.entries(PROVENANCE_LABELS).filter(([key]) => provenance[key]).map(([key, label]) => {
    const p = provenance[key]!;
    const pct = Math.round(p.confidence * 100);
    return el('li', { dataset: { field: key } },
      el('span', { class: pct >= 80 ? 'chip ok' : pct >= 50 ? 'chip warn' : 'chip alert' }, `${label} · ${pct} %`),
      el('span', { class: 'hint' }, ` ${METHOD_LABELS[p.method] ?? p.method}${p.page ? `, pág. ${p.page}` : ''}${p.text ? `: «${p.text.slice(0, 90)}»` : ''}`));
  }));
}

/**
 * Discrepancia entre lo escrito al subir la factura y lo que dice el documento (fecha u objeto): se ve y se resuelve con
 * un toque, en los dos sentidos. Nada se cambia en silencio.
 */
function discrepancyNote(d: { kind: 'date' | 'object'; typed: string; document: string; input: HTMLInputElement } | null): HTMLElement | null {
  if (!d) return null;
  const show = (v: string) => (d.kind === 'date' ? shortDate(v) : `«${v}»`);
  const label = d.kind === 'date' ? 'fecha' : 'objeto';
  const button = el('button', { 'data-feedback-id': 'invoices.facturas.importar.usar_documento', 'data-feedback-label': 'Usar el dato del documento', class: 'linkbtn', type: 'button', id: d.kind === 'date' ? 'useDocumentDate' : 'useDocumentObject' });
  const paint = () => {
    const usingDocument = d.input.value === d.document;
    button.textContent = usingDocument ? `Usar la mía (${show(d.typed)})` : `Usar la del documento (${show(d.document)})`;
  };
  button.addEventListener('click', () => { d.input.value = d.input.value === d.document ? d.typed : d.document; d.input.dispatchEvent(new Event('input', { bubbles: true })); paint(); });
  d.input.addEventListener('input', paint);
  paint();
  return el('div', { class: 'banner warn', id: d.kind === 'date' ? 'dateDiscrepancy' : 'objectDiscrepancy' }, icon('warn', 18),
    el('div', null, el('span', null, `El documento dice ${d.kind === 'date' ? 'la' : 'el'} ${label} ${show(d.document)}; al subirla escribiste ${show(d.typed)}. `), button));
}

/** «Leer PDF»: texto del PDF en el dispositivo y reglas deterministas; si no hay texto o faltan datos, se dice. */
async function readPdfInto(ctx: ViewContext, mirror: Mirror, target: LocalInvoice | null, file: File, files?: File[], storedFileId?: string, onPartial?: (prefill: ManualPrefill) => void, auto = false): Promise<void> {
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) { toast('«Leer PDF» solo sirve para PDF. Para fotos usa «Analizar con IA».'); return; }
  if (!auto) toast('Leyendo el PDF…');
  // Sin texto, demasiado grande o dañado: con formulario, el aviso va en él (no en un toast que se pierde).
  const notice = (message: string) => (onPartial ? onPartial({ read: 'no_text', found: emptyPartial(), message, text: null }) : toast(message));
  let items;
  try { items = await readPdfItems(file, auto ? READ_LIMITS : {}); } catch (error) {
    notice(error instanceof ReadLimitError
      ? (error.kind === 'size' ? 'Este PDF es muy grande para leerlo en el dispositivo. Créala y léela después con «Leer PDF» o con la IA.' : 'La lectura ha tardado demasiado. Créala y léela después con «Leer PDF» o con la IA.')
      : 'No se pudo abrir el PDF. Puede estar dañado o protegido: usa «Leer con IA» o complétalo a mano.');
    return;
  }
  // Fase 3: la plantilla del proveedor (si la hay) lee primero; las reglas genéricas, lo demás.
  const result = extractFor(mirror, items, target);
  // El texto leído se guarda en el servidor (solo la Edge lo escribe) para aprender al validar sin volver a leer el PDF.
  if (storedFileId && result.hasText && navigator.onLine) void saveDocumentText(ctx, storedFileId, items);
  usage.track('invoices.facturas.leer_pdf', result.hasText && result.ok && result.document ? 'success' : 'error');
  if (!result.hasText) { notice(readingMessage(result)); return; }
  // Lectura automática al elegir el PDF (fase 1): nunca salta de pantalla; rellena el formulario y ofrece importar.
  if (auto && onPartial) { onPartial({ read: result.read, found: result.found, message: readingMessage(result), text: readingText(items), items }); return; }
  if (!result.ok || !result.document) {
    // Lectura parcial (fase 0): nunca una pantalla vacía. Lo leído rellena «Rellenar a mano» (o el formulario nuevo).
    const prefill: ManualPrefill = { read: result.read, found: result.found, message: readingMessage(result), text: readingText(items), items };
    if (target && activeEditor) activeEditor.fill(prefill, 'empty');
    else if (onPartial) onPartial(prefill);
    else toast(prefill.message);
    return;
  }
  guard.dirtyEditor = false;
  await closeSheet(true);
  const templateNote = result.template ? `Plantilla del proveedor v${result.template.version} · ${result.template.confirmations} factura${result.template.confirmations === 1 ? '' : 's'}${result.template.status === 'aprendiendo' ? ' (aprendiendo)' : ''}.` : null;
  const rectification = detectRectification({ text: items.map((i) => i.str).join('\n'), document: result.document });
  const documentForImport = rectification.isRectification && result.document.document_totals.total > 0 ? negateDocument(result.document) : result.document;
  openImport(ctx, mirror, target, { document: documentForImport, rectification, warnings: [...(rectification.isRectification ? [`Parece una rectificativa (${rectification.evidence}): revisa el número de la original.`] : []), ...(templateNote ? [templateNote] : []), ...result.warnings], provenance: result.provenance, origin: 'pdf_text', payment: result.found.payment }, files?.length ? { files } : {});
}

/** Tras «Rellenar a mano» con «Guardar y validar»: valida con aprendizaje y vuelve a abrir la ficha. */
function validateAndReopen(ctx: ViewContext): (invoiceId: string) => Promise<void> {
  return async (invoiceId) => {
    const ok = await validateNow(ctx, invoiceId, 'Factura validada. Finance aprende este proveedor para la próxima.');
    if (ok) void openInvoice(ctx, invoiceId);
  };
}

// ---------------------------------------------------------------------------
// Validar sin chocar con uno mismo (incidencia del usuario, 9-10-2026): elegir la categoría y validar al instante
// salía con la revisión de antes del acuse del cambio → VERSION_CONFLICT contra el propio cambio.
// ---------------------------------------------------------------------------
// `settlePending` y `validateNow` viven en `app/validate.ts`.
let resolving = false;
/** Facturas cuya validación ya se ha reintentado sola en esta sesión: un solo intento, luego decide el usuario. */
const retriedValidations = new Set<string>();
/**
 * Conflictos de «Validar» contra un cambio propio (incidencia del usuario, 9-10-2026):
 * - el `call` de validar aparcado (sync-client 0.5.2, `procedure`): se reintenta UNA vez con «mine» (revisión actual);
 * - el formato antiguo (un update vacío con el `call` aparte, de antes del arreglo): se resuelve una vez y el `call`
 *   vuelve a la cola, donde ya se aparca bien;
 * - si vuelve a chocar, queda en la tarjeta del kit para que decida el usuario. Nada en bucle.
 */
export async function resolveOwnValidationConflicts(ctx: ViewContext): Promise<void> {
  if (resolving) return;
  resolving = true;
  try {
    const { client } = ctx;
    const me = client.bootstrap()?.profile.userId ?? null;
    if (!me) return;
    for (const c of await client.conflicts()) {
      const op = c.operation as unknown as { op: string; table?: string; fields?: Record<string, unknown> };
      const row = c.current as { updated_by?: string | null; status?: string; code?: string | null; id?: string };
      if (row.updated_by !== me) continue;
      const callOnly = op.op === 'update' && op.table === INVOICES && !Object.keys(op.fields ?? {}).length;
      if (!callOnly) continue;
      // Formato de antes del sync-client 0.5.2 (sin `procedure`): se resuelve una vez y el call vuelve a la cola, donde
      // ya se aparca bien (con `procedure`) y entra por la rama de abajo.
      if (!c.procedure) { await client.resolveConflict(c.requestId, { choice: 'theirs' }); continue; }
      const isValidate = c.procedure === 'invoices.validate';
      const invoiceId = String(row.id ?? '');
      if (!isValidate || !invoiceId || retriedValidations.has(invoiceId)) continue;
      if (row.status !== 'pendiente_datos' && row.status !== 'pendiente_revision') continue;
      retriedValidations.add(invoiceId);
      await client.resolveConflict(c.requestId, { choice: 'mine' });
      toast(`Validando ${row.code ?? 'la factura'} con tu último cambio.`);
    }
  } catch { /* lo intenta otra vez en el siguiente cambio de estado */ } finally {
    resolving = false;
  }
}

export function startValidationConflictWatcher(ctx: ViewContext): () => void {
  let last = ctx.client.status().conflicts;
  const off = ctx.client.onStatus((status) => {
    if (status.conflicts && status.conflicts !== last) void resolveOwnValidationConflicts(ctx);
    last = status.conflicts;
  });
  void resolveOwnValidationConflicts(ctx);
  return off;
}

/** «Volver a leer el PDF»: lee el documento guardado y pinta lo leído en «Datos de la factura», resaltando lo que cambia. */
async function rereadIntoEditor(ctx: ViewContext, mirror: Mirror, invoice: LocalInvoice, original: LocalInvoiceFile): Promise<void> {
  if (!navigator.onLine) { toast('Volver a leer necesita conexión (el documento está en la nube).'); return; }
  try {
    toast('Leyendo el PDF…');
    const file = await fetchStoredDocument(ctx.client, original.file_id, original.normalized_filename, original.mime_type);
    const items = await readPdfItems(file, READ_LIMITS);
    const r = extractFor(mirror, items, invoice);
    activeEditor?.fill({ read: r.read, found: r.found, message: readingMessage(r), text: r.hasText ? readingText(items) : null, items }, 'replace');
  } catch (error) {
    toast(error instanceof ReadLimitError ? 'El PDF es muy grande o tarda demasiado: usa «Leer con IA».' : 'No se pudo abrir el PDF. Puede estar dañado o protegido.');
  }
}

export function openImport(ctx: ViewContext, mirror: Mirror, target: LocalInvoice | null, prefill?: ExtractionPrefill, options: { files?: File[]; text?: string } = {}): void {
  const { client } = ctx;
  let document: ImportDocument | null = null;
  let errors: SchemaError[] = [];
  const textarea = el('textarea', { ...fieldAttrs({ id: 'invoices.facturas.importar.json', label: 'JSON', type: 'text', sensitivity: 'internal', confirm: 'none' }), 'data-feedback-ignore': '', id: 'importJson', rows: '6', placeholder: 'Pega aquí el resultado de ChatGPT (el JSON o la respuesta entera)…', spellcheck: 'false' });
  const jsonFile = el('input', { ...fieldAttrs({ id: 'invoices.facturas.importar.archivo', label: 'Cargar archivo', type: 'file', sensitivity: 'internal', confirm: 'none' }), type: 'file', accept: 'application/json,.json,text/plain,.txt', id: 'importFile' });
  const sourceNote = el('div', { id: 'sourceCheck' });
  const docs = el('input', { ...fieldAttrs({ id: 'invoices.facturas.importar.documentos', label: 'Documentos', type: 'file', sensitivity: 'internal', confirm: 'none' }), type: 'file', accept: ACCEPT_ATTR, multiple: true, id: 'importDocs' });
  if (options.files?.length) {
    const transfer = new DataTransfer();
    for (const file of options.files) transfer.items.add(file);
    docs.files = transfer.files;
  }
  const preview = el('div', { 'data-feedback-id': 'invoices.facturas.importar.vista_previa', 'data-feedback-label': 'Vista previa', id: 'importPreview' });
  const error = el('p', { class: 'formerror', role: 'alert' });
  const confirm = el('button', { 'data-feedback-id': 'invoices.facturas.importar.confirmar', 'data-feedback-label': 'Importar', class: 'primary', type: 'button', id: 'confirmImport', disabled: true, onclick: () => void submit() }, 'Importar');

  // Controles de la vista previa (se recrean con cada documento válido)
  let supplierSelect: HTMLSelectElement | null = null;
  let objectInput: HTMLInputElement | null = null;
  let dateInput: HTMLInputElement | null = null;
  let categorySelect: HTMLSelectElement | null = null;
  let investmentInput: HTMLInputElement | null = null;
  let deductibilitySelect: HTMLSelectElement | null = null;
  let kindSelect: HTMLSelectElement | null = null;
  let rectNumberInput: HTMLInputElement | null = null;

  function parse(text: string): void {
    // Lo que vuelve de la app de IA es no confiable: JSON extraído del texto, sobre aparte y validación estricta.
    const external = parseExternalResult(text);
    const result = external.validation;
    replace(sourceNote);
    if (external.source && target) {
      const shas = (mirror.filesByInvoice.get(target.id) ?? []).map((f) => f.sha256);
      if (!shas.includes(external.source.sha256)) {
        replace(sourceNote, el('div', { class: 'banner warn', id: 'sourceMismatch' }, icon('warn', 18), el('span', null,
          `El resultado dice venir de «${external.source.filename}», que no es el documento de esta factura. Revisa que sea la factura correcta antes de importar.`)));
      } else {
        replace(sourceNote, el('p', { class: 'hint', id: 'sourceMatch' }, '✓ El resultado corresponde al documento de esta factura.'));
      }
    }
    if (!result.ok) { document = null; errors = result.errors; confirm.disabled = true; replace(preview, renderErrors(errors)); return; }
    document = result.document;
    errors = [];
    confirm.disabled = false;
    renderPreview();
  }

  function renderErrors(list: SchemaError[]): HTMLElement {
    return el('div', { class: 'banner alert' }, icon('warn', 18), el('div', null, el('strong', null, 'El JSON no cumple el formato ikisai.invoice.v1'), el('ul', null, ...list.slice(0, 8).map((e) => el('li', null, el('code', null, e.path), ' · ', e.reason)))));
  }

  function renderPreview(): void {
    if (!document) return;
    const doc = document;
    const matches = matchSupplier(doc, mirror.suppliers);
    const current = target ? mirror.supplierById.get(target.supplier_id) ?? null : null;
    const chosenDefault = current ?? matches[0]?.supplier ?? null;
    supplierSelect = select('importSupplier', [
      ...(chosenDefault ? [] : [['__new__', `Crear proveedor «${doc.invoice.supplier_name}»`] as [string, string]]),
      ...supplierOptions(mirror.suppliers).map(([id, name]) => { const m = matches.find((x) => x.supplier.id === id); return [id, m ? `${name} · coincide por ${m.by === 'tax_id' ? 'NIF' : m.by === 'alias' ? 'alias' : 'nombre'}` : name] as [string, string]; }),
      ...(chosenDefault ? [['__new__', `Crear proveedor «${doc.invoice.supplier_name}»`] as [string, string]] : []),
    ], chosenDefault?.id ?? '__new__', { ...fieldAttrs({ id: 'invoices.facturas.importar.proveedor', label: 'Proveedor', type: 'select', entity: 'invoices.invoices', prop: 'supplier_id', sensitivity: 'internal', confirm: 'none' }), 'data-feedback-ignore': '' });
    const supplierFor = () => (supplierSelect && supplierSelect.value !== '__new__' ? mirror.supplierById.get(supplierSelect.value) ?? null : null);
    const proposal = () => proposeImport(doc, supplierFor(), {
      object: objectInput?.value || null, invoice_date: dateInput?.value || null,
      expense_category: (categorySelect?.value || null) as never, is_investment: investmentInput ? investmentInput.checked : null, deductibility: (deductibilitySelect?.value || null) as Deductibility | null,
    });
    const first = proposeImport(doc, supplierFor());
    objectInput = el('input', { ...fieldAttrs({ id: 'invoices.facturas.importar.objeto', label: 'Objeto', type: 'text', entity: 'invoices.invoices', prop: 'object', sensitivity: 'internal', confirm: 'none' }), type: 'text', id: 'importObject', value: target?.object ?? first.object, maxlength: '120' });
    // Fecha (decisión de Core, ronda 35): si la escrita al subir no coincide con la del documento, se marca y se ofrece
    // la del documento; se preselecciona solo si la escrita era la de hoy por defecto.
    // El día de creación en hora local (el «hoy» que vio el usuario al subirla), no en UTC.
    const createdOn = target?.created_at ? new Date(target.created_at).toLocaleDateString('sv-SE') : null;
    const dateChoice = importDateChoice(target?.invoice_date, createdOn, doc.invoice.invoice_date);
    dateInput = el('input', { ...fieldAttrs({ id: 'invoices.facturas.importar.fecha', label: 'Fecha', type: 'date', entity: 'invoices.invoices', prop: 'invoice_date', sensitivity: 'internal', confirm: 'none' }), type: 'date', id: 'importDate', value: target ? dateChoice.value : first.invoice_date });
    categorySelect = select('importCategory', [['', 'Sin categoría'], ...CATEGORIES.map((c) => [c, CATEGORY_LABELS[c]] as [string, string])], target?.expense_category ?? first.expense_category, { ...fieldAttrs({ id: 'invoices.facturas.importar.categoria', label: 'Categoría', type: 'select', entity: 'invoices.invoices', prop: 'expense_category', sensitivity: 'internal', confirm: 'none' }) });
    investmentInput = el('input', { ...fieldAttrs({ id: 'invoices.facturas.importar.inversion', label: 'Es inversión', type: 'toggle', entity: 'invoices.invoices', prop: 'is_investment', sensitivity: 'internal', confirm: 'none' }), type: 'checkbox', id: 'importInvestment', checked: target?.is_investment ?? first.is_investment });
    // Rectificativa (0227): detectada al leer el PDF o por el documento (nota o total negativo); el usuario la confirma.
    const detected = prefill?.rectification ?? detectRectification({ document: doc });
    kindSelect = select('importKind', [['ordinaria', 'Factura ordinaria'], ['rectificativa', 'Rectificativa (abono o devolución)']], detected.isRectification ? 'rectificativa' : 'ordinaria', { ...fieldAttrs({ id: 'invoices.facturas.importar.tipo', label: 'Tipo de factura', type: 'select', entity: 'invoices.invoices', prop: 'invoice_kind', sensitivity: 'internal', confirm: 'none' }) });
    rectNumberInput = el('input', { ...fieldAttrs({ id: 'invoices.facturas.importar.rectifica', label: 'Rectifica a la factura nº', type: 'text', entity: 'invoices.invoices', prop: 'rectifies_number', sensitivity: 'internal', confirm: 'none' }), type: 'text', id: 'importRectNumber', maxlength: '64', value: detected.number ?? '' });
    deductibilitySelect = select('importDeductibility', DEDUCTIBILITIES.map((d) => [d, DEDUCTIBILITY_LABELS[d] ?? d] as [string, string]), first.deductibility, { ...fieldAttrs({ id: 'invoices.facturas.importar.deducibilidad', label: 'Deducibilidad', type: 'select', entity: 'invoices.invoices', prop: 'deductibility', sensitivity: 'internal', confirm: 'none' }) });
    const recalc = recalculate(doc.lines.map((l) => ({ quantity: l.quantity ?? null, unit_price: l.unit_price ?? null, discount_amount: l.discount_amount ?? 0, net_amount: l.net_amount, vat_rate: l.vat_rate ?? null, vat_amount: l.vat_amount ?? null })), doc.taxes.map((t) => ({ tax_type: t.tax_type, rate: t.rate ?? null, taxable_base: t.taxable_base ?? null, amount: t.amount })), doc.document_totals);
    const duplicate = mirror.invoices.find((i) => !i.deleted_at && i.status !== 'anulada' && i.id !== target?.id && supplierFor() && i.supplier_id === supplierFor()!.id && doc.invoice.invoice_number && (i.invoice_number ?? '').toLowerCase() === doc.invoice.invoice_number.toLowerCase());
    const row = (label: string, calc: number, declared: number) => el('tr', { class: Math.abs(toCents(calc) - toCents(declared)) > 2 ? 'bad' : '' }, el('td', null, label), el('td', { class: 'num' }, eur(calc)), el('td', { class: 'num' }, eur(declared)), el('td', { class: 'num' }, eur(fromCents(toCents(declared) - toCents(calc)))));
    supplierSelect.addEventListener('change', () => { const p = proposal(); if (categorySelect && !categorySelect.value && p.expense_category) categorySelect.value = p.expense_category; });
    replace(preview,
      (() => {
        const soft = duplicate ? null : softDuplicate(mirror.invoices, { supplier_id: supplierFor()?.id ?? null, invoice_date: doc.invoice.invoice_date, total: doc.document_totals.total }, target?.id ?? null);
        return soft ? el('div', { class: 'banner warn', id: 'softDuplicate' }, icon('warn', 18), el('span', null, `Posible duplicado: ${soft.code ?? 'otra factura'} tiene la misma fecha y el mismo total${supplierFor() ? ' y es del mismo proveedor' : ''}. Compruébalo antes de importar.`)) : null;
      })(),
      duplicate ? el('div', { class: 'banner warn' }, icon('warn', 18), el('span', null, `Ya existe la factura ${duplicate.code ?? ''} de este proveedor con el número ${doc.invoice.invoice_number}. La importación será rechazada como duplicado.`)) : null,
      el('div', { class: 'row2' }, field('Proveedor', supplierSelect, doc.invoice.supplier_tax_id ? `NIF del documento: ${doc.invoice.supplier_tax_id}` : 'El documento no trae NIF.'), field('Fecha', dateInput)),
      discrepancyNote(dateChoice.discrepancy && target?.invoice_date ? { kind: 'date', typed: target.invoice_date, document: doc.invoice.invoice_date, input: dateInput } : null),
      field('Objeto', objectInput),
      discrepancyNote(target && doc.invoice.object.trim() && doc.invoice.object.trim().toLowerCase() !== target.object.trim().toLowerCase() ? { kind: 'object', typed: target.object, document: doc.invoice.object.trim(), input: objectInput } : null),
      el('div', { class: 'row2' }, field('Categoría', categorySelect), field('Deducibilidad', deductibilitySelect)),
      el('label', { class: 'check' }, investmentInput, el('span', null, 'Es inversión')),
      el('div', { class: 'row2', id: 'importKindRow' }, field('Tipo de factura', kindSelect, detected.isRectification ? `Parece una rectificativa (${detected.evidence ?? 'importes negativos'}): se importa en negativo y se enlaza con la original.` : undefined), field('Rectifica a la factura nº', rectNumberInput)),
      el('h3', null, `Cuadre · ${doc.lines.length} artículo${doc.lines.length === 1 ? '' : 's'} · ${recalc.taxes.length} impuesto${recalc.taxes.length === 1 ? '' : 's'}${recalc.taxes_derived ? ' (derivados de las líneas)' : ''}`),
      el('table', { 'data-feedback-ignore': '', class: 'inv-table cuadre-table' },
        el('thead', null, el('tr', null, el('th'), el('th', { class: 'num' }, 'Calculado'), el('th', { class: 'num' }, 'Documento'), el('th', { class: 'num' }, 'Diferencia'))),
        el('tbody', null,
          row('Base', recalc.calculated_base, doc.document_totals.base),
          row('IVA', recalc.calculated_vat + recalc.calculated_other, doc.document_totals.vat),
          row('Retenciones', recalc.calculated_withholding, doc.document_totals.withholding),
          row('Total', recalc.calculated_total, doc.document_totals.total),
        )),
      el('p', { class: recalc.within_tolerance === false ? 'cuadre bad' : 'cuadre ok' }, recalc.within_tolerance === false ? `⚠ REVISAR IMPORTES: la factura quedará pendiente de revisión con una diferencia de ${eur(recalc.totals_delta)}.` : '✓ Dentro de la tolerancia de 0,02 €. Quedará pendiente de revisión hasta que la valides.'),
      recalc.warnings.length ? el('ul', { class: 'hint' }, ...recalc.warnings.filter((w) => w.code !== 'TOTALS_MISMATCH').map((w) => el('li', null, w.message))) : null,
      doc.extraction_notes ? el('p', { class: 'hint' }, 'Notas de la extracción: ', doc.extraction_notes) : null,
      target ? null : field('PDF o fotos del documento', docs, docs.files && docs.files.length ? (docs.files.length === 1 ? 'El documento que subiste se adjunta a la factura.' : `Los ${docs.files.length} documentos que subiste se adjuntan a la factura.`) : 'Opcional: puedes adjuntarlos ahora o después.'),
    );
  }

  async function submit(): Promise<void> {
    if (!document || !supplierSelect) return;
    error.textContent = '';
    confirm.disabled = true;
    try {
      const staged = target ? [] : await pickFiles(docs, client);
      // Rectificativa impresa en positivo: se importa en negativo (resta de la original).
      if (kindSelect?.value === 'rectificativa' && document.document_totals.total > 0) document = negateDocument(document);
      const sha = await importDocumentSha256(document);
      const existingSupplier = supplierSelect.value !== '__new__' ? mirror.supplierById.get(supplierSelect.value) ?? null : null;
      const invoiceId = target?.id ?? crypto.randomUUID();
      // Operaciones de fila (no `call`): la factura aparece en el espejo al momento y la importación funciona sin red (API.md §10).
      const { operations } = importOperations({
        document, documentSha256: sha, invoiceId, existing: target ? { revision: target.revision } : null,
        supplier: existingSupplier ? { mode: 'existing', row: existingSupplier } : { mode: 'create', id: crypto.randomUUID() },
        overrides: { object: objectInput?.value.trim() || null, invoice_date: dateInput?.value || null, expense_category: (categorySelect?.value || null) as never, is_investment: investmentInput?.checked ?? null, deductibility: (deductibilitySelect?.value || null) as Deductibility | null,
          invoice_kind: kindSelect?.value === 'rectificativa' ? 'rectificativa' : 'ordinaria', rectifies_number: rectNumberInput?.value.trim() || null },
        files: staged.map((s, i) => ({ file_id: s.marker, original_filename: s.filename, page_order: i + 1, mime_type: s.mime, size_bytes: s.size, sha256: s.sha256 })),
        payment: prefill?.payment, currentPayment: target,
      });
      const imported = await commitSafely(client, operations as RowOperation[], 'Factura importada en este dispositivo. Queda pendiente de revisión.');
      usage.track('invoices.facturas.importar', imported ? 'success' : 'error');
      if (imported) {
        guard.dirtyEditor = false;
        await closeSheet(true);
        void openInvoice(ctx, invoiceId);
      }
    } catch (err) { error.textContent = describeError(err); }
    confirm.disabled = false;
  }

  textarea.addEventListener('input', () => { guard.dirtyEditor = true; parse(textarea.value); });
  jsonFile.addEventListener('change', async () => { const f = jsonFile.files?.[0]; if (!f) return; textarea.value = await f.text(); parse(textarea.value); });
  const queueNote = extractionQueue.total > 1 ? el('div', { class: 'banner info' }, el('span', null, `Extracción ${extractionQueue.total - extractionQueue.ids.length} de ${extractionQueue.total}. Al confirmar o cancelar, sigue la siguiente.`)) : null;
  // Coste de la extracción, discreto pero visible (petición de Core, ronda 10): modelo, tokens y tiempo.
  const usageText = prefill ? describeUsage(prefill.usage) : null;
  const usageLine = usageText ? el('p', { class: 'hint', id: 'extractionUsage' }, 'Coste de la extracción: ', usageText) : null;
  const extractionNote = !prefill ? null : prefill.document && prefill.origin === 'pdf_text'
    ? el('div', { class: 'banner info', id: 'extractionNote' }, icon('info', 18), el('div', null, el('strong', null, 'Leído del texto del PDF, sin IA. '),
      'Son propuestas: revisa abajo proveedor, fecha, categoría y cuadre antes de importar.',
      prefill.provenance ? el('details', { class: 'provenance' }, el('summary', null, 'De dónde sale cada dato (confianza y texto del PDF)'), renderProvenance(prefill.provenance)) : null,
      prefill.warnings.length ? el('ul', { class: 'hint' }, ...prefill.warnings.map((w) => el('li', null, w))) : null))
    : prefill.document
    ? el('div', { class: 'banner info', id: 'extractionNote' }, icon('info', 18), el('div', null, el('strong', null, 'Extraído automáticamente del documento. '), 'Revisa el cuadre antes de importar.', prefill.warnings.length ? el('ul', { class: 'hint' }, ...prefill.warnings.map((w) => el('li', null, w))) : null, usageLine))
    : el('div', { class: 'banner warn', id: 'extractionNote' }, icon('warn', 18), el('div', null, el('strong', null, 'La extracción automática no ha dado un JSON utilizable. '), 'Pega el JSON de ChatGPT o vuelve a intentarlo.', el('ul', { class: 'hint' }, ...(prefill.errors ?? []).map((e) => el('li', null, describeExtractionError(e))), ...prefill.warnings.map((w) => el('li', null, w))), usageLine));
  openSheet({
    // Auditoría del 3T: con datos ya leídos (PDF o IA), primero la revisión; el JSON queda plegado por si hace falta tocarlo.
    title: prefill?.document ? `Revisar los datos leídos${target?.code ? ` · ${target.code}` : ''}` : target ? `Importar JSON en ${target.code ?? 'la factura'}` : 'Importar JSON de ChatGPT',
    meta: 'La app recalcula y compara con el total del documento; nada se valida en silencio.',
    body: prefill?.document
      ? el('div', null, queueNote, extractionNote, preview, error, el('details', { class: 'inv-block' }, el('summary', null, 'JSON (ikisai.invoice.v1)'), field('JSON', textarea), field('…o cargar archivo .json o .txt', jsonFile)), sourceNote)
      : el('div', null, queueNote, extractionNote, promptPanel(), field('JSON', textarea), field('…o cargar archivo .json o .txt', jsonFile), sourceNote, preview, error),
    foot: [el('button', { 'data-feedback-id': 'invoices.facturas.importar.cancelar', 'data-feedback-label': 'Cancelar', class: 'ghost', type: 'button', onclick: () => void closeSheet() }, 'Cancelar'), confirm],
    initialFocus: prefill?.document ? confirm : textarea,
    beforeClose: async () => !guard.dirtyEditor || confirmDialog({ title: 'Hay una importación sin terminar', text: '¿Descartarla?', confirmLabel: 'Descartar', danger: true }),
    onClose: () => { guard.dirtyEditor = false; if (extractionQueue.ids.length) void extractNext(ctx); },
  });
  if (options.text) {
    textarea.value = options.text;
    parse(textarea.value);
  }
  if (prefill?.document) {
    textarea.value = JSON.stringify(prefill.document, null, 2);
    parse(textarea.value);
  }
}

/** «Extraer» en una factura pendiente de datos: la Edge devuelve el JSON y se abre la vista previa con él. */
export async function extractInto(ctx: ViewContext, invoice: LocalInvoice): Promise<void> {
  const { client } = ctx;
  if (!navigator.onLine) { toast('La extracción automática necesita conexión. Sin red, pega el JSON de ChatGPT.'); return; }
  const mirror = await loadMirror(client);
  const files = (mirror.filesByInvoice.get(invoice.id) ?? []).filter((f) => f.kind === 'original').sort((a, b) => a.page_order - b.page_order);
  if (!files.length) { toast('Esta factura no tiene documento que extraer.'); return; }
  toast('Extrayendo los datos del documento…');
  try {
    const result = await usage.run('invoices.facturas.extraer', () => extractDocument(client, files.map((f) => f.file_id)));
    await closeSheet(true);
    openImport(ctx, mirror, invoice, { document: result.document, warnings: result.warnings, usage: result.usage });
  } catch (error) {
    const e = error as { code?: string; details?: { errors?: unknown[]; warnings?: string[]; usage?: ExtractionUsage | null } | null };
    toast(describeError(error));
    // Sin servicio o sin JSON utilizable: el mismo camino que la importación manual, mostrando por qué falló y lo que costó.
    if (e?.code === 'EXTRACTION_UNAVAILABLE' || e?.code === 'EXTRACTION_INVALID') {
      await closeSheet(true);
      openImport(ctx, mirror, invoice, e.code === 'EXTRACTION_INVALID' ? { warnings: e.details?.warnings ?? [], errors: e.details?.errors ?? [], usage: e.details?.usage ?? null } : undefined);
    }
  }
}

/** Siguiente factura de la cola de «Extraer pendientes». */
export async function extractNext(ctx: ViewContext): Promise<void> {
  const id = extractionQueue.ids.shift();
  if (!id) { extractionQueue.total = 0; return; }
  const mirror = await loadMirror(ctx.client);
  const invoice = mirror.invoices.find((i) => i.id === id);
  if (!invoice || invoice.status !== 'pendiente_datos') { await extractNext(ctx); return; }
  await extractInto(ctx, invoice);
}

/** Copia el prompt; si el portapapeles no está disponible, muestra el texto seleccionado para copiarlo a mano. */
async function copyPrompt(promptText: HTMLTextAreaElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(EXTRACTION_PROMPT);
    toast('Prompt copiado. Pégalo en ChatGPT junto con el PDF o las fotos de la factura.');
  } catch {
    promptText.hidden = false;
    promptText.focus();
    promptText.select();
    toast('Selecciona el texto y cópialo.');
  }
}

function promptTextArea(): HTMLTextAreaElement {
  const promptText = el('textarea', { ...fieldAttrs({ id: 'invoices.facturas.prompt.texto', label: 'Prompt de extracción', type: 'text', sensitivity: 'internal', confirm: 'none' }), class: 'prompt-text', readonly: true, rows: '8', hidden: true, 'aria-label': 'Prompt de extracción' });
  promptText.value = EXTRACTION_PROMPT;
  return promptText;
}

/**
 * «Extraer con ChatGPT» junto al documento (incidencia de la aceptación V1): 1) copiar el prompt y adjuntar en ChatGPT (u
 * otro asistente) esta misma foto o PDF; 2) pegar el JSON que devuelva. Siempre disponible, con o sin extracción automática.
 */
function chatgptSteps(id: string, onPaste: () => void, getDocument?: () => Promise<{ file: File; source: { filename: string; sha256: string } } | null>, onRead?: (file: File) => Promise<void>): HTMLElement {
  const promptText = promptTextArea();
  // Fase 1 sin API de pago (ronda 29): compartir el documento y el contrato con la app de IA del usuario.
  const share = getDocument ? el('button', { 'data-feedback-id': 'invoices.facturas.ia.analizar', 'data-feedback-label': 'Analizar con IA', class: 'primary small', type: 'button', dataset: { step: 'share' }, onclick: async () => {
    try {
      const doc = await getDocument();
      if (!doc) return;
      const how = await shareWithAi(doc.file, doc.source);
      if (how === 'files' || how === 'text') toast('Cuando la app de IA responda, comparte el resultado con Ikisai Finance o pégalo con «Pegar resultado».');
    } catch (error) { toast(describeError(error)); }
  } }, icon('upload', 16), 'Analizar con IA') : null;
  // Auditoría del 3T (8-10-2026): primero «Leer PDF» (gratis, al momento y sin red); la IA, para fotos o PDF escaneados.
  if (share) share.className = 'softbtn small';
  return el('div', { 'data-feedback-id': 'invoices.facturas.ia', 'data-feedback-label': 'Extraer con IA', class: 'chatgpt-steps', id },
    el('p', { class: 'chatgpt-title' }, el('strong', null, 'Leer los datos del documento'), el('span', { class: 'hint' }, ' · primero «Leer PDF»; si es una foto o no sale, con ChatGPT u otro asistente')),
    // Fase 2 (ronda 29): leer el texto del PDF en el propio dispositivo, sin IA, con reglas.
    getDocument && onRead ? el('div', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'invoices.facturas.ia.leer_pdf', 'data-feedback-label': 'Leer PDF', class: 'primary small', type: 'button', dataset: { step: 'read' }, onclick: async () => {
      try { const doc = await getDocument(); if (doc) await onRead(doc.file); } catch (error) { toast(describeError(error)); }
    } }, icon('eye', 16), 'Leer PDF'), el('span', { class: 'hint' }, 'Si el PDF tiene texto, la app lo lee aquí mismo, sin IA.')) : null,
    share ? el('div', { class: 'btnrow' }, share, el('span', { class: 'hint' }, 'Foto o PDF escaneado: comparte el documento y las instrucciones con tu app de IA.')) : null,
    el('ol', { class: 'steps' },
      el('li', null, el('button', { 'data-feedback-id': 'invoices.facturas.ia.copiar_prompt', 'data-feedback-label': 'Copiar prompt', class: 'softbtn small', type: 'button', dataset: { step: 'copy' }, onclick: () => void copyPrompt(promptText) }, icon('attach', 16), '1) Copiar prompt'),
        el('span', { class: 'hint' }, ' Pégalo en ChatGPT y adjunta esta misma foto o PDF.')),
      el('li', null, el('button', { 'data-feedback-id': 'invoices.facturas.ia.pegar_json', 'data-feedback-label': 'Pegar JSON', class: 'softbtn small', type: 'button', dataset: { step: 'paste' }, onclick: onPaste }, icon('upload', 16), '2) Pegar JSON'),
        el('span', { class: 'hint' }, ' Copia la respuesta (o compártela con Ikisai) y pégala para importarla.')),
    ),
    promptText,
  );
}

/** Prompt de extracción para ChatGPT, copiable desde la app (handoff 05_PROMPT_EXTRACCION_FACTURA.md). */
function promptPanel(): HTMLElement {
  const promptText = promptTextArea();
  const copy = el('button', { 'data-feedback-id': 'invoices.facturas.importar.copiar_prompt', 'data-feedback-label': 'Copiar el prompt', class: 'softbtn small', type: 'button', id: 'copyPrompt', onclick: () => void copyPrompt(promptText) }, icon('attach', 16), 'Copiar el prompt para ChatGPT');
  return el('details', { 'data-feedback-id': 'invoices.facturas.importar.ayuda', 'data-feedback-label': '¿Cómo obtengo el JSON?', class: 'inv-block prompt-block' },
    el('summary', null, el('span', null, '¿Cómo obtengo el JSON?'), el('span', { class: 'hint' }, 'ChatGPT + prompt')),
    el('ol', { class: 'steps' },
      el('li', null, 'Abre ChatGPT y adjunta el PDF o las fotos de la factura.'),
      el('li', null, 'Pega el prompt (botón de abajo). ChatGPT devuelve un JSON en formato ikisai.invoice.v1.'),
      el('li', null, 'Copia ese JSON y pégalo en el cuadro de aquí abajo. La app recalcula y compara con el total del documento.'),
    ),
    el('div', { class: 'btnrow' }, copy, el('button', { 'data-feedback-id': 'invoices.facturas.importar.ver_prompt', 'data-feedback-label': 'Ver el texto', class: 'linkbtn', type: 'button', onclick: () => { promptText.hidden = !promptText.hidden; } }, 'Ver el texto')),
    promptText,
  );
}

// ---------------------------------------------------------------------------
// Asignar una línea · API.md §6.2
// ---------------------------------------------------------------------------
/**
 * La hoja de asignar una línea. Desde la ficha, al guardar o volver se reabre la factura; desde Compras (tanda 27) se
 * pasa `onDone` y no se reabre nada: la asignación nueva llega a `onDone` para su «Deshacer».
 */
export function openAllocation(ctx: ViewContext, mirror: Mirror, invoice: LocalInvoice, line: LocalInvoiceLine, onDone: ((allocationId: string | null) => void) | null = null): void {
  const { client } = ctx;
  const finish = async (allocationId: string | null) => { await closeSheet(true); if (onDone) onDone(allocationId); else void openInvoice(ctx, invoice.id); };
  const rest = unallocated(line, mirror);
  let app = 'general';
  let choice: TargetChoice | null = null;
  const appButtons = el('div', { class: 'segmented', role: 'tablist' },
    ...[['general', 'General'], ['tasks', 'Tareas'], ['food', 'Cocina'], ['booking', 'Reservas']].map(([value, label]) => el('button', { ...ALLOC_APP_MARKS[value!], type: 'button', class: value === app ? 'on' : '', dataset: { app: value! }, onclick: () => { app = value!; choice = null; paintApp(); } }, label)),
  );
  const kindSelect = select('allocKind', kindsFor('general').map((k) => [k, KIND_LABELS[k] ?? k] as [string, string]), 'operating_expense', { ...fieldAttrs({ id: 'invoices.facturas.asignar.tipo', label: 'Tipo', type: 'select', entity: 'invoices.allocations', prop: 'target_kind', sensitivity: 'internal', confirm: 'none' }) });
  const searchInput = el('input', { ...fieldAttrs({ id: 'invoices.facturas.asignar.buscar', label: 'Buscar destino', type: 'search', sensitivity: 'internal', confirm: 'none' }), type: 'search', id: 'targetSearch', placeholder: 'Buscar destino…', autocomplete: 'off' });
  const results = el('div', { id: 'targetResults' });
  const chosen = el('p', { class: 'hint', id: 'chosenTarget' });
  const amount = el('input', { ...fieldAttrs({ id: 'invoices.facturas.asignar.importe', label: 'Importe (base, sin IVA)', type: 'number', entity: 'invoices.allocations', prop: 'allocated_amount', sensitivity: 'internal', confirm: 'none' }), 'data-feedback-ignore': '', type: 'text', inputmode: 'decimal', id: 'allocAmount', value: String(rest).replace('.', ',') });
  const quantity = el('input', { ...fieldAttrs({ id: 'invoices.facturas.asignar.cantidad', label: 'Cantidad', type: 'number', entity: 'invoices.allocations', prop: 'allocated_quantity', sensitivity: 'internal', confirm: 'none' }), type: 'text', inputmode: 'decimal', id: 'allocQuantity', placeholder: line.quantity === null ? 'Sin cantidad' : `de ${Number(line.quantity)} ${line.unit ?? ''}` });
  const error = el('p', { class: 'formerror', role: 'alert' });
  const appArea = el('div');
  // La solicitud de compra abierta del mismo proveedor, si hay una sola (con red): se propone, no se elige sola.
  const proposal = el('div', { id: 'allocProposal' });
  if (navigator.onLine) {
    const supplier = mirror.suppliers.find((s) => s.id === invoice.supplier_id);
    void searchTargets(client, 'tasks', '', 'purchase_request').then((items) => {
      const match = proposePurchaseRequest(items, [supplier?.name, (supplier as { label?: string | null } | undefined)?.label]);
      if (!match) return;
      replace(proposal, el('p', { class: 'hint' }, 'Solicitud de compra abierta de este proveedor: ',
        el('button', { 'data-feedback-id': 'invoices.facturas.asignar.propuesta', 'data-feedback-label': 'Usar la solicitud propuesta', class: 'linkbtn', type: 'button', id: 'useProposal',
          onclick: () => { app = 'tasks'; paintApp(); choice = match; chosen.textContent = `Destino: ${targetLabel(match)}`; paintResults([match], 'Propuesta'); } }, match.label)));
    }).catch(() => undefined);
  }

  function paintApp(): void {
    for (const b of Array.from(appButtons.querySelectorAll('button'))) b.classList.toggle('on', b.dataset.app === app);
    if (app === 'general') { replace(appArea, field('Tipo', kindSelect)); return; }
    const recents = recentTargets().filter((t) => t.app === app);
    const where = app === 'tasks' ? 'Tareas (Área › Proyecto › Tarea)' : app === 'food' ? 'Cocina (ingredientes y maquinaria)' : 'Reservas (eventos: retiros)';
    replace(appArea, field('Buscar en ' + where, searchInput, navigator.onLine ? undefined : 'Sin red solo puedes elegir destinos usados recientemente.'), results, chosen);
    paintResults(recents, 'Usados recientemente');
    void runSearch();
  }

  function paintResults(items: TargetChoice[], title: string): void {
    replace(results, items.length ? el('div', null, el('div', { class: 'sectionlabel' }, title), fbRows(renderList({ label: title, rows: items.map((t) => ({
      id: `${t.app}:${t.kind}:${t.id}`, title: t.label, meta: [KIND_LABELS[t.kind] ?? t.kind, ...(t.path?.length ? [t.path.join(' › ')] : []), ...(t.archived ? ['archivado'] : [])], selected: choice?.id === t.id && choice?.kind === t.kind,
      onClick: () => { choice = t; chosen.textContent = `Destino: ${targetLabel(t)}`; paintResults(items, title); }, label: `Elegir ${t.label}`,
    })) }), { feedbackId: 'invoices.facturas.asignar.destinos', feedbackLabel: 'Destinos' }, { feedbackId: 'invoices.facturas.asignar.destino', feedbackLabel: 'Destino' })) : el('p', { class: 'hint' }, 'Sin resultados.'));
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  async function runSearch(): Promise<void> {
    if (!navigator.onLine || app === 'general') return;
    try {
      const items = await searchTargets(client, app as TargetChoice['app'], searchInput.value);
      paintResults(items, searchInput.value ? 'Resultados' : 'Destinos');
    } catch (err) { replace(results, el('p', { class: 'hint' }, describeError(err))); }
  }
  searchInput.addEventListener('input', () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void runSearch(), 250); });

  const save = el('button', { 'data-feedback-id': 'invoices.facturas.asignar.guardar', 'data-feedback-label': 'Asignar', class: 'primary', type: 'button', id: 'saveAllocation', onclick: async () => {
    error.textContent = '';
    const a = parseAmount(amount.value);
    if (a === null || a <= 0) { error.textContent = 'Indica un importe mayor que cero.'; return; }
    if (a > rest + 0.02) { error.textContent = `Solo quedan ${eur(rest)} sin asignar en esta línea.`; return; }
    const q = quantity.value.trim() ? parseAmount(quantity.value) : null;
    let fields: Record<string, unknown>;
    if (app === 'general') fields = { target_app: 'general', target_kind: kindSelect.value, target_id: null, target_label: KIND_LABELS[kindSelect.value] ?? kindSelect.value };
    else {
      if (!choice) { error.textContent = 'Elige un destino.'; return; }
      fields = { target_app: choice.app, target_kind: choice.kind, target_id: choice.id, target_code: choice.code, target_label: targetLabel(choice), target_revision: choice.revision };
      rememberTarget(choice);
    }
    // En una rectificativa la línea es negativa: se escribe el importe en positivo y se guarda con su signo.
    const allocationId = crypto.randomUUID();
    const ok = await commitSafely(client, [{ op: 'insert', table: ALLOCATIONS, id: allocationId, fields: { ...fields, invoice_line_id: line.id, allocated_amount: Number(line.net_amount) < 0 ? -a : a, allocated_quantity: q } }], 'Asignación guardada.');
    usage.track('invoices.facturas.asignar', ok ? 'success' : 'error');
    if (ok) await finish(allocationId);
  } }, 'Asignar');

  openSheet({
    title: `Asignar «${lineName(line)}»`,
    meta: `${eur(rest)} sin asignar de ${eur(line.net_amount)}`,
    body: el('div', null, proposal, appButtons, appArea, el('div', { class: 'row2' }, field('Importe (base, sin IVA)', amount), field('Cantidad', quantity)), error),
    foot: [el('button', { 'data-feedback-id': 'invoices.facturas.asignar.volver', 'data-feedback-label': 'Volver', class: 'ghost', type: 'button', onclick: () => void finish(null) }, 'Volver'), save],
    initialFocus: amount,
  });
  paintApp();
}

export { SUPPLIERS };
