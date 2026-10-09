/**
 * Facturas (API.md §9.2): lista por mes, ficha en hoja (documento, artículos, impuestos, asignación, pago, fiscal),
 * alta con documento, importación del JSON `ikisai.invoice.v1`, validar, anular, archivar.
 */
import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import { closeSheet, confirmDialog, createSortableList, el, icon, openSheet, renderList, replace, toast, type ListRowSpec, type Sheet } from '@ikisai/ui-kit';
import { fbRows } from './feedback.ts';
import { usage } from '../app/usage.ts';
import {
  DEDUCTIBILITIES, EXTRACTION_PROMPT, PAYMENT_METHODS, periodOfDate, detectRectification, negateDocument, proposeRectificationAllocations, TAX_TYPES, ITEM_TYPES, importDocumentSha256, importOperations, matchSupplier, normalizedFilename, parseExternalResult, proposeImport, importDateChoice, confirmedFromInvoice, emptyPartial, readingMessage, readingText, learnFromConfirmation, linesFromItems, templateOperation, softDuplicate, type FieldProvenance, type PdfTextItem, recalculate,
  slugify, sumCents, fromCents, toCents, type ImportDocument, type SchemaError, type Deductibility,
} from '@ikisai/domain-invoices';
import {
  ALLOCATIONS, CATEGORIES, CATEGORY_LABELS, INVOICES, INVOICE_FILES, INVOICE_LINES, SUPPLIERS, TAX_LINES, categoryLabel, describeError,
  type LocalAllocation, type LocalInvoice, type LocalInvoiceFile, type LocalInvoiceLine, type LocalSupplier, type LocalTaxLine,
} from '../app/client.ts';
import {
  DEDUCTIBILITY_LABELS, GENERAL_KIND_LABELS, ITEM_TYPE_LABELS, PAYMENT_METHOD_LABELS, TAX_TYPE_LABELS, eur, lineName, loadMirror, workingQuarter, monthKey, monthLabel, onAnyTable, parseAmount, shortDate,
  statusChipClass, statusText, todayIso, type Mirror,
} from '../app/data.ts';
import { ACCEPT_ATTR, formatBytes, openFile, stageDocument, storedMime, type StagedDocument } from '../app/files.ts';
import { FRESHNESS_LABELS, KIND_LABELS, checkTargetFreshness, kindsFor, recentTargets, rememberTarget, searchTargets, targetLabel, type TargetChoice } from '../app/targets.ts';
import { guard } from '../app/guard.ts';
import { describeExtractionError, describeUsage, extractDocument, extractionQueue, type ExtractionUsage } from '../app/extract.ts';
import type { ViewContext, ViewMount } from './shell.ts';
import { fetchStoredDocument, sha256Hex, shareWithAi, takeSharedDocuments, takeSharedText } from '../app/ai-share.ts';
import { READ_LIMITS, ReadLimitError, readPdfItems } from '../app/pdf-text.ts';
import { block, fbBlock, commitSafely, field, select } from './common.ts';
import { renderIssuedPanel } from './issued.ts';
import { openBatchUpload } from './batch.ts';
import { openManualEntry, type ManualPrefill } from './manual.ts';
import { documentReadingBlock, extractFor, readingPanel } from './reading.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Utilidades de la vista
// ---------------------------------------------------------------------------
function supplierOptions(suppliers: LocalSupplier[]): Array<[string, string]> {
  return suppliers.filter((s) => !s.deleted_at).sort((a, b) => a.name.localeCompare(b.name, 'es')).map((s) => [s.id, s.name] as [string, string]);
}

function invoiceTitle(invoice: LocalInvoice, mirror: Mirror): string {
  const supplier = mirror.supplierById.get(invoice.supplier_id);
  return `${supplier?.name ?? 'Proveedor'} · ${invoice.object}`;
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
/** Pestañas Recibidas · Emitidas y apps de la hoja de asignación: ids literales para el catálogo de «Uso». */
const INVOICE_TAB_MARKS: Record<string, Record<string, string>> = {
  recibidas: { 'data-feedback-id': 'invoices.facturas.pestanas.recibidas', 'data-feedback-label': 'Recibidas' },
  emitidas: { 'data-feedback-id': 'invoices.facturas.pestanas.emitidas', 'data-feedback-label': 'Emitidas' },
};
const ALLOC_APP_MARKS: Record<string, Record<string, string>> = {
  general: { 'data-feedback-id': 'invoices.facturas.asignar.app.general', 'data-feedback-label': 'General' },
  tasks: { 'data-feedback-id': 'invoices.facturas.asignar.app.tareas', 'data-feedback-label': 'Tareas' },
  food: { 'data-feedback-id': 'invoices.facturas.asignar.app.cocina', 'data-feedback-label': 'Cocina' },
  booking: { 'data-feedback-id': 'invoices.facturas.asignar.app.reservas', 'data-feedback-label': 'Reservas' },
};

export const mountInvoices: ViewMount = (ctx) => {
  const { main, client } = ctx;
  let mirror: Mirror | null = null;
  let query = '';
  let filter = 'activas';
  let opened: string | null = null;

  const search = el('input', { 'data-feedback-id': 'invoices.facturas.buscar', 'data-feedback-label': 'Buscar facturas', type: 'search', id: 'invoiceSearch', placeholder: 'Proveedor, objeto, número o código', 'aria-label': 'Buscar facturas', autocomplete: 'off',
    oninput: () => { query = search.value.trim().toLowerCase(); paint(); } });
  const statusSelect = select('invoiceFilter', [['activas', 'Todas las activas'], ['drive', 'Llegadas por Drive, sin validar'], ['rect_sin_enlazar', 'Rectificativas sin enlazar'], ['pendiente_datos', 'Pendientes de datos'], ['pendiente_revision', 'Pendientes de revisión'], ['validada', 'Validadas'], ['archivada', 'Archivadas'], ['sin_pagar', 'Sin pagar'], ['sin_documento', 'Sin documento'], ['anulada', 'Anuladas']], filter,
    { 'data-feedback-id': 'invoices.facturas.filtro', 'data-feedback-label': 'Filtrar por estado', 'aria-label': 'Filtrar por estado', onchange: () => { filter = statusSelect.value; paint(); } });
  const listHost = el('div', { 'data-feedback-id': 'invoices.facturas.lista', 'data-feedback-label': 'Facturas recibidas', id: 'invoiceList' });
  const canEdit = client.bootstrap()?.membership.role !== 'reader';
  const newButton = el('button', { 'data-feedback-id': 'invoices.facturas.nueva', 'data-feedback-label': 'Nueva factura', class: 'fab', type: 'button', id: 'newInvoice', hidden: !canEdit, onclick: () => openNewInvoice(ctx, mirror!) }, icon('plus'), 'Nueva factura');
  const extractAll = el('button', { 'data-feedback-id': 'invoices.facturas.extraer_pendientes', 'data-feedback-label': 'Extraer pendientes', class: 'softbtn small', type: 'button', id: 'extractPending', hidden: true, onclick: () => void extractPending() }, icon('upload', 16), 'Extraer pendientes');
  // Pestañas «Recibidas · Emitidas» (API.md §13.5): las emitidas registradas viven en su propio panel.
  const received = el('div', { id: 'receivedPanel' },
    el('div', { class: 'toolbar' }, el('div', { class: 'search' }, search), statusSelect),
    el('div', { class: 'toolbar', id: 'invoiceTools' }, canEdit ? el('button', { 'data-feedback-id': 'invoices.facturas.subir_varias', 'data-feedback-label': 'Subir varias', class: 'softbtn small', type: 'button', id: 'batchUpload', onclick: () => openBatchUpload(ctx, () => loadMirror(client), () => void load()) }, icon('upload', 16), 'Subir varias') : null, extractAll),
    listHost,
    newButton);
  let issuedPanel: { element: HTMLElement; destroy: () => void } | null = null;
  const tabs = el('div', { 'data-feedback-id': 'invoices.facturas.pestanas', 'data-feedback-label': 'Recibidas y emitidas', class: 'segmented', role: 'tablist', id: 'invoiceTabs' },
    ...([['recibidas', 'Recibidas'], ['emitidas', 'Emitidas']] as Array<[string, string]>).map(([value, label]) =>
      el('button', { ...INVOICE_TAB_MARKS[value], type: 'button', role: 'tab', class: value === 'recibidas' ? 'on' : '', dataset: { tab: value }, onclick: () => showTab(value) }, label)));
  const issuedHost = el('div', { id: 'issuedHost', hidden: true });
  function showTab(value: string): void {
    for (const b of Array.from(tabs.querySelectorAll('button'))) { b.classList.toggle('on', b.dataset.tab === value); b.setAttribute('aria-selected', String(b.dataset.tab === value)); }
    received.hidden = value !== 'recibidas';
    issuedHost.hidden = value !== 'emitidas';
    if (value === 'emitidas' && !issuedPanel) { issuedPanel = renderIssuedPanel(ctx); replace(issuedHost, issuedPanel.element); }
  }
  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Facturas'), el('p', null, 'Recibidas: documento, datos importados, revisión y validación. Emitidas: registro de las que expides.'))),
    tabs,
    received,
    issuedHost,
  );

  /** Facturas con documento y sin datos: candidatas a la extracción automática. */
  function extractable(): LocalInvoice[] {
    if (!mirror) return [];
    return mirror.invoices.filter((i) => !i.deleted_at && i.status === 'pendiente_datos' && (mirror!.filesByInvoice.get(i.id) ?? []).some((f) => f.kind === 'original'))
      .sort((a, b) => (a.invoice_date ?? '').localeCompare(b.invoice_date ?? ''));
  }

  async function extractPending(): Promise<void> {
    const list = extractable();
    if (!list.length) return;
    extractionQueue.ids = list.map((i) => i.id);
    extractionQueue.total = list.length;
    await extractNext(ctx);
  }

  function matches(invoice: LocalInvoice): boolean {
    if (!mirror) return false;
    const supplier = mirror.supplierById.get(invoice.supplier_id);
    const hay = [supplier?.name ?? '', invoice.object, invoice.invoice_number ?? '', invoice.code ?? ''].join(' ').toLowerCase();
    if (query && !hay.includes(query)) return false;
    const hasFile = (mirror.filesByInvoice.get(invoice.id) ?? []).some((f) => f.kind === 'original');
    switch (filter) {
      case 'activas': return invoice.status !== 'anulada';
      case 'anulada': return invoice.status === 'anulada';
      case 'sin_pagar': return invoice.status !== 'anulada' && invoice.payment_status === 'pendiente';
      case 'sin_documento': return invoice.status !== 'anulada' && !hasFile;
      case 'rect_sin_enlazar': return invoice.status !== 'anulada' && invoice.invoice_kind === 'rectificativa' && !invoice.rectifies_invoice_id && !invoice.rectification_without_original;
      case 'drive': return !!invoice.drive_file_id && (invoice.status === 'pendiente_datos' || invoice.status === 'pendiente_revision');
      default: return invoice.status === filter;
    }
  }

  function rowSpec(invoice: LocalInvoice): ListRowSpec {
    const m = mirror!;
    const hasFile = (m.filesByInvoice.get(invoice.id) ?? []).some((f) => f.kind === 'original');
    const chips = [el('span', { class: statusChipClass(invoice.status, invoice.review_reason) }, statusText(invoice))];
    if (invoice.payment_status === 'pagada') chips.push(el('span', { class: 'chip ok' }, 'Pagada'));
    if (!hasFile && invoice.status !== 'anulada') chips.push(el('span', { class: 'chip alert' }, 'Sin documento'));
    if (isLate(invoice)) chips.push(el('span', { class: 'chip warn' }, `Atrasada (${quarterName(periodOfDate(invoice.invoice_date))})`));
    if (invoice.invoice_kind === 'rectificativa') chips.push(el('span', { class: invoice.rectifies_invoice_id || invoice.rectification_without_original ? 'chip' : 'chip warn' }, invoice.rectifies_invoice_id || invoice.rectification_without_original ? 'Rectificativa' : 'Rectificativa sin enlazar'));
    return {
      id: invoice.id,
      title: invoiceTitle(invoice, m),
      meta: [shortDate(invoice.invoice_date), invoice.code ?? 'código pendiente', eur(invoice.calculated_total)],
      chips,
      pending: invoice._pending === true,
      onClick: () => openInvoice(ctx, invoice.id),
      label: `Abrir ${invoiceTitle(invoice, m)}`,
    };
  }

  function paint(): void {
    if (!mirror) return;
    const pendingDocs = extractable().length;
    extractAll.hidden = !canEdit || pendingDocs === 0;
    extractAll.textContent = '';
    extractAll.append(icon('upload', 16), pendingDocs === 1 ? 'Extraer la factura pendiente' : `Extraer ${pendingDocs} pendientes`);
    const visible = mirror.invoices.filter((i) => !i.deleted_at && matches(i)).sort((a, b) => (b.invoice_date ?? '').localeCompare(a.invoice_date ?? '') || (b.code ?? '').localeCompare(a.code ?? ''));
    if (!visible.length) {
      replace(listHost, el('div', { class: 'empty' }, el('strong', null, mirror.invoices.length ? 'Ninguna factura coincide' : 'Todavía no hay facturas'),
        mirror.invoices.length ? 'Cambia el filtro o la búsqueda.' : 'Sube el documento con «Nueva factura» o importa el JSON de ChatGPT. Funciona también sin conexión.'));
      return;
    }
    const groups = new Map<string, LocalInvoice[]>();
    for (const inv of visible) { const k = monthKey(inv.invoice_date); groups.set(k, [...(groups.get(k) ?? []), inv]); }
    replace(listHost, ...[...groups.entries()].map(([key, rows]) => el('section', null,
      el('div', { class: 'sectionlabel' }, monthLabel(key), el('span', { class: 'count' }, String(rows.length))),
      fbRows(renderList({ label: `Facturas de ${monthLabel(key)}`, rows: rows.map(rowSpec) }), { feedbackId: 'invoices.facturas.lista.mes', feedbackLabel: 'Facturas del mes' }, { feedbackId: 'invoices.facturas.lista.fila', feedbackLabel: 'Factura' }),
    )));
  }

  async function load(): Promise<void> {
    mirror = await loadMirror(client);
    paint();
    if (opened) refreshOpenInvoice(ctx, opened, mirror);
  }

  function fromHash(): void {
    const tail = location.hash.replace(/^#\/facturas\/?/, '');
    // Resultado compartido hacia Ikisai (share_target): se abre la importación sobre la pendiente más reciente con documento.
    // Facturas (PDF o fotos) compartidas desde otra app: «Subir varias» con ellas.
    if (/^\?compartido=docs/.test(tail) && mirror) {
      history.replaceState(null, '', '#/facturas');
      void takeSharedDocuments().then((files) => {
        if (!files.length) { toast('No ha llegado ninguna factura. Vuelve a compartirla o usa «Subir varias».'); return; }
        if (!canEdit) { toast('Tu cuenta no puede subir facturas.'); return; }
        openBatchUpload(ctx, () => loadMirror(client), () => void load(), files);
      });
      return;
    }
    const shared = tail.match(/^\?compartido=([01])/);
    if (shared && mirror) {
      history.replaceState(null, '', '#/facturas');
      if (shared[1] === '0') { toast('No se pudo recibir lo compartido. Copia el resultado y usa «Pegar resultado».'); return; }
      void takeSharedText().then((text) => {
        if (!text) { toast('No ha llegado ningún resultado. Copia el resultado y usa «Pegar resultado».'); return; }
        const pending = mirror!.invoices.filter((i) => !i.deleted_at && i.status === 'pendiente_datos' && (mirror!.filesByInvoice.get(i.id) ?? []).some((f) => f.kind === 'original'))
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
        openImport(ctx, mirror!, pending, undefined, { text });
      });
      return;
    }
    // Tarjetas de Inicio: `#/facturas?filtro=pendiente_datos|pendiente_revision|sin_pagar|drive`.
    const wanted = tail.match(/^\?filtro=([a-z_]+)/);
    if (wanted && [...statusSelect.options].some((o) => o.value === wanted[1])) { filter = wanted[1]!; statusSelect.value = filter; history.replaceState(null, '', '#/facturas'); paint(); return; }
    if (tail === 'nueva' && mirror) { openNewInvoice(ctx, mirror); history.replaceState(null, '', '#/facturas'); }
    else if (UUID.test(tail)) { openInvoice(ctx, tail.toLowerCase()); history.replaceState(null, '', '#/facturas'); }
    else if (/^(FVR|GST)_\d{4}_\d+$/i.test(tail) && mirror) {
      // Enlace por código desde otras apps (Reservas, Cocina): `#/facturas/FVR_2026_012`.
      const code = tail.toUpperCase();
      const found = mirror.invoices.find((i) => !i.deleted_at && i.code === code);
      history.replaceState(null, '', '#/facturas');
      if (found) openInvoice(ctx, found.id);
      else toast(`No encuentro la factura ${code} en este dispositivo.`);
    }
  }

  // Las filas (también su marca «pendiente») llegan por onTable; el estado de red no cambia la lista.
  const offTables = onAnyTable(client, () => void load());
  const offOpen = onOpen((id) => { opened = id; });
  void load().then(fromHash);
  if (/[?&]vista=emitidas\b/.test(location.hash)) showTab('emitidas');
  return () => { offTables(); offOpen(); issuedPanel?.destroy(); void closeSheet(true); };
};

// Quién tiene la ficha abierta (para refrescarla cuando llegan cambios).
const openListeners = new Set<(id: string | null) => void>();
function onOpen(listener: (id: string | null) => void): () => void { openListeners.add(listener); return () => openListeners.delete(listener); }
let openInvoiceId: string | null = null;
let openSheetRef: Sheet | null = null;
function setOpen(id: string | null): void { openInvoiceId = id; for (const l of openListeners) l(id); }

function refreshOpenInvoice(ctx: ViewContext, id: string, mirror: Mirror): void {
  if (openInvoiceId !== id || !openSheetRef) return;
  const invoice = mirror.invoices.find((i) => i.id === id);
  if (!invoice) return;
  replace(openSheetRef.body, renderInvoice(ctx, invoice, mirror));
}

// ---------------------------------------------------------------------------
// Ficha
// ---------------------------------------------------------------------------
export async function openInvoice(ctx: ViewContext, id: string): Promise<void> {
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

  const update = (fields: Record<string, unknown>, message = 'Guardado en este dispositivo.') =>
    commitSafely(client, [{ op: 'update', table: INVOICES, id: invoice.id, expectedRevision: invoice.revision, fields }], message);
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
    actions.push(el('button', { 'data-feedback-id': 'invoices.facturas.ficha.rellenar', 'data-feedback-label': 'Rellenar a mano', class: 'softbtn', type: 'button', id: 'fillManually',
      onclick: () => openManualEntry(ctx, mirror, invoice, validateAndReopen(ctx)) }, icon('edit', 18), 'Rellenar a mano'));
  }
  if (editable && pendingState) {
    actions.push(el('button', { 'data-feedback-id': 'invoices.facturas.ficha.validar', 'data-feedback-label': 'Validar', class: invoice.status === 'pendiente_datos' ? 'softbtn' : 'primary', type: 'button', id: 'validateInvoice', onclick: async () => { const ok = await commitSafely(client, await validateWithLearning(ctx, mirror, invoice), 'Factura validada.'); usage.track('invoices.facturas.validar', ok ? 'success' : 'error'); } }, icon('check', 18), 'Validar'));
    actions.push(el('button', { 'data-feedback-id': 'invoices.facturas.ficha.importar_json', 'data-feedback-label': 'Importar JSON', class: 'softbtn', type: 'button', id: 'importInto', onclick: () => void openImport(ctx, mirror, invoice) }, icon('upload', 18), 'Importar JSON'));
    if (invoice.status === 'pendiente_datos' && files.some((f) => f.kind === 'original')) {
      actions.push(el('button', { 'data-feedback-id': 'invoices.facturas.ficha.extraer', 'data-feedback-label': 'Extraer', class: 'softbtn', type: 'button', id: 'extractInvoice', title: 'Pide a la Edge el JSON del documento y lo lleva a la vista previa de importación', onclick: () => void extractInto(ctx, invoice) }, icon('upload', 18), 'Extraer'));
    }
  }
  if (canEdit && invoice.status !== 'anulada') {
    actions.push(el('button', { 'data-feedback-id': 'invoices.facturas.ficha.pago', 'data-feedback-label': 'Pago', class: 'softbtn', type: 'button', id: 'togglePaid', onclick: () => void togglePaid() }, invoice.payment_status === 'pagada' ? 'Marcar pendiente de pago' : 'Marcar pagada'));
  }
  if (role === 'owner' && invoice.status === 'validada') actions.push(el('button', { 'data-feedback-id': 'invoices.facturas.ficha.archivar', 'data-feedback-label': 'Archivar', class: 'ghost', type: 'button', onclick: () => void update({ status: 'archivada' }, 'Factura archivada.') }, 'Archivar'));
  if (role === 'owner' && invoice.status === 'archivada') actions.push(el('button', { 'data-feedback-id': 'invoices.facturas.ficha.desarchivar', 'data-feedback-label': 'Desarchivar', class: 'ghost', type: 'button', onclick: () => void update({ status: 'validada' }, 'Factura desarchivada.') }, 'Desarchivar'));
  if (canEdit && invoice.status !== 'anulada') actions.push(el('button', { 'data-feedback-id': 'invoices.facturas.ficha.anular', 'data-feedback-label': 'Anular', class: 'danger', type: 'button', id: 'annulInvoice', onclick: () => void annul() }, icon('trash', 18), 'Anular'));

  async function togglePaid(): Promise<void> {
    if (invoice.payment_status === 'pagada') { await update({ payment_status: 'pendiente', paid_at: null }, 'Pago marcado como pendiente.'); return; }
    const date = el('input', { 'data-feedback-id': 'invoices.facturas.ficha.pago.fecha', 'data-feedback-label': 'Fecha de pago', type: 'date', value: todayIso(), id: 'paidAt' });
    const method = select('paidMethod', [['', 'Sin indicar'], ...PAYMENT_METHODS.map((m) => [m, PAYMENT_METHOD_LABELS[m] ?? m] as [string, string])], invoice.payment_method, { 'data-feedback-id': 'invoices.facturas.ficha.pago.metodo', 'data-feedback-label': 'Método de pago' });
    const ok = await confirmDialog({ title: 'Marcar como pagada', text: el('div', null, field('Fecha de pago', date), field('Método', method)), confirmLabel: 'Marcar pagada' });
    if (!ok) return;
    await update({ payment_status: 'pagada', paid_at: date.value || todayIso(), payment_method: method.value || null }, 'Factura marcada como pagada.');
  }

  async function annul(): Promise<void> {
    const reason = el('input', { 'data-feedback-id': 'invoices.facturas.ficha.anular.motivo', 'data-feedback-label': 'Motivo', type: 'text', id: 'annulReason', maxlength: '500', placeholder: 'Duplicada, abono, error…' });
    const ok = await confirmDialog({ title: `¿Anular ${invoice.code ?? 'esta factura'}?`, text: el('div', null, el('p', null, 'La factura se conserva fuera de los resúmenes y de la gestoría. Sus asignaciones pasan a la papelera.'), field('Motivo', reason)), confirmLabel: 'Anular', danger: true });
    if (!ok) return;
    if (!reason.value.trim()) { toast('Indica el motivo de la anulación.'); return; }
    usage.track('invoices.facturas.anular', (await call('invoices.annul', { invoice_id: invoice.id, expectedRevision: invoice.revision, reason: reason.value.trim() }, 'Factura anulada.')) ? 'success' : 'error');
  }

  // --- Cabecera y totales --------------------------------------------------
  const header = el('div', { class: 'inv-head', 'data-feedback-id': 'invoices.facturas.ficha', 'data-feedback-label': 'Ficha de factura' },
    el('div', { class: 'chips' },
      el('span', { class: statusChipClass(invoice.status, invoice.review_reason) }, statusText(invoice)),
      invoice.payment_status === 'pagada' ? el('span', { class: 'chip ok' }, `Pagada${invoice.paid_at ? ' ' + shortDate(invoice.paid_at) : ''}`) : el('span', { class: 'chip' }, 'Pendiente de pago'),
      invoice.source === 'import_v1' ? el('span', { class: 'chip', title: 'Datos importados del JSON de ChatGPT' }, 'Desde JSON') : null,
      invoice.invoice_kind === 'rectificativa' ? el('span', { class: 'chip warn', id: 'rectChip' }, 'Rectificativa') : null,
    ),
    el('dl', { class: 'kv', 'data-feedback-ignore': '' },
      el('dt', null, 'Proveedor'), el('dd', null, supplier?.name ?? '—', supplier?.tax_id ? ` · ${supplier.tax_id}` : ''),
      el('dt', null, 'Fecha'), el('dd', null, invoice.invoice_date ? [shortDate(invoice.invoice_date), ` · periodo ${invoice.fiscal_period ?? periodOf(invoice.invoice_date)}`] : 'Sin fecha: léela del PDF o escríbela para poder validar'),
      el('dt', null, 'Número'), el('dd', null, invoice.invoice_number ?? '—'),
      el('dt', null, 'Objeto'), el('dd', null, invoice.object),
      ...rectificationRows(ctx, invoice, mirror),
      el('dt', null, 'Se declara en'), el('dd', { id: 'declaredPeriod' }, invoice.invoice_date || invoice.declared_period
        ? `${quarterName(invoice.declared_period ?? periodOfDate(invoice.invoice_date))}${invoice.delivered_elsewhere ? ' · ya pasada a la gestoría' : isLate(invoice) ? ` · atrasada (la fecha es del ${quarterName(periodOfDate(invoice.invoice_date))})` : ''}` : 'Sin fecha'),
      ...(invoice.drive_url ? [el('dt', null, 'Origen'), el('dd', null, 'Llegó por Google Drive · ', el('a', { href: invoice.drive_url, target: '_blank', rel: 'noopener', id: 'driveOrigin' }, 'abrir el original'))] : []),
    ),
    el('div', { class: 'btnrow inv-actions', 'data-feedback-id': 'invoices.facturas.ficha.acciones', 'data-feedback-label': 'Acciones' }, ...actions),
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
  const fileInput = el('input', { type: 'file', accept: ACCEPT_ATTR, multiple: true, hidden: true, id: 'addFiles',
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
  const lineRow = (l: LocalInvoiceLine) => el('div', { class: 'line-row', 'data-feedback-id': 'invoices.facturas.ficha.articulos.fila', 'data-feedback-label': 'Artículo', dataset: { id: l.id } },
    el('div', { class: 'line-main' }, el('span', { class: 'line-desc', 'data-feedback-ignore': '' }, lineName(l)),
      l.label_source === 'recordado' ? el('span', { class: 'chip', title: 'Puesto solo: lo recordaba de otra factura de este proveedor' }, 'recordado') : null,
      l.item_type ? el('span', { class: 'hint' }, ' · ' + (ITEM_TYPE_LABELS[l.item_type] ?? l.item_type)) : null, l._pending ? el('span', { class: 'chip pending' }, 'Pendiente') : null,
      // La descripción de la factura (la que vale fiscalmente) sigue a la vista bajo «Mi nombre».
      l.label ? el('span', { class: 'hint line-original', 'data-feedback-ignore': '' }, `En la factura: ${l.description}`) : null),
    el('div', { class: 'line-nums' },
      el('span', { 'data-feedback-ignore': '' }, l.quantity === null ? '—' : `${Number(l.quantity)} ${l.unit ?? ''}`.trim()),
      el('strong', { 'data-feedback-ignore': '' }, eur(l.net_amount)),
      returnedOf(l.id, mirror) ? el('span', { class: 'chip warn', 'data-feedback-ignore': '' }, `Devuelto: ${eur(returnedOf(l.id, mirror))}`) : null,
      el('span', null, l.vat_rate === null ? 'sin IVA' : `IVA ${Number(l.vat_rate)} %`),
      editable ? el('button', { 'data-feedback-id': 'invoices.facturas.ficha.articulos.editar', 'data-feedback-label': 'Editar artículo', class: 'linkbtn', type: 'button', 'aria-label': `Editar ${lineName(l)}`, onclick: () => replace(lineEditor, lineForm(l)) }, 'Editar') : null,
      // «Mi nombre»: también en una factura validada (no la devuelve a revisión).
      canEdit && invoice.status !== 'anulada' && invoice.status !== 'archivada' ? el('button', { 'data-feedback-id': 'invoices.facturas.ficha.articulos.mi_nombre', 'data-feedback-label': 'Mi nombre', class: 'linkbtn', type: 'button', 'aria-label': `Mi nombre para ${l.description}`, onclick: () => replace(lineEditor, labelForm(client, l, () => replace(lineEditor))) }, 'Mi nombre') : null,
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
  const linesBlock = fbBlock({ feedbackId: 'invoices.facturas.ficha.articulos', feedbackLabel: 'Artículos' }, 'Artículos', String(lines.length), true,
    linesView,
    editable ? el('div', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'invoices.facturas.ficha.articulos.anadir', 'data-feedback-label': 'Añadir artículo', class: 'softbtn', type: 'button', id: 'addLine', onclick: () => replace(lineEditor, lineForm(null)) }, icon('plus', 18), 'Añadir artículo')) : null,
  );
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
  const category = select('invCategory', [['', 'Sin categoría'], ...CATEGORIES.map((c) => [c, CATEGORY_LABELS[c]] as [string, string])], invoice.expense_category, { 'data-feedback-id': 'invoices.facturas.ficha.fiscal.categoria', 'data-feedback-label': 'Categoría de gasto', disabled: !editable, onchange: () => void update({ expense_category: category.value || null }) });
  const investment = el('input', { 'data-feedback-id': 'invoices.facturas.ficha.fiscal.inversion', 'data-feedback-label': 'Es inversión', type: 'checkbox', id: 'invInvestment', checked: invoice.is_investment, disabled: !editable, onchange: () => void update({ is_investment: investment.checked }) });
  const deductibility = select('invDeductibility', DEDUCTIBILITIES.map((d) => [d, DEDUCTIBILITY_LABELS[d] ?? d] as [string, string]), invoice.deductibility, { 'data-feedback-id': 'invoices.facturas.ficha.fiscal.deducibilidad', 'data-feedback-label': 'Deducibilidad', disabled: !canEdit || invoice.status === 'anulada', onchange: () => void update({ deductibility: deductibility.value as Deductibility }) });
  const invDate = el('input', { 'data-feedback-id': 'invoices.facturas.ficha.fiscal.fecha', 'data-feedback-label': 'Fecha de la factura', type: 'date', id: 'invDate', value: invoice.invoice_date ?? '', disabled: !editable, onchange: () => void update({ invoice_date: invDate.value || null }) });
  const kind = select('invKind', [['ordinaria', 'Factura ordinaria'], ['rectificativa', 'Rectificativa (abono o devolución)']], invoice.invoice_kind ?? 'ordinaria',
    { 'data-feedback-id': 'invoices.facturas.ficha.fiscal.tipo', 'data-feedback-label': 'Tipo de factura', disabled: !editable, onchange: () => void update({ invoice_kind: kind.value }) });
  const rectNumber = el('input', { 'data-feedback-id': 'invoices.facturas.ficha.fiscal.rectifica_numero', 'data-feedback-label': 'Número de la factura que rectifica', type: 'text', id: 'invRectNumber', maxlength: '64',
    value: invoice.rectifies_number ?? '', disabled: !editable, onchange: () => void update({ rectifies_number: rectNumber.value.trim() || null }) });
  const candidates = mirror.invoices.filter((o) => !o.deleted_at && o.status !== 'anulada' && o.id !== invoice.id && o.supplier_id === invoice.supplier_id && (o.invoice_kind ?? 'ordinaria') === 'ordinaria')
    .sort((a, b) => (b.invoice_date ?? '').localeCompare(a.invoice_date ?? ''));
  const rectOriginal = select('invRectOriginal', [['', 'Sin enlazar'], ...candidates.map((o) => [o.id, `nº ${o.invoice_number ?? '—'} · ${shortDate(o.invoice_date)} · ${eur(o.calculated_total)}`] as [string, string])], invoice.rectifies_invoice_id ?? '',
    { 'data-feedback-id': 'invoices.facturas.ficha.fiscal.rectifica_original', 'data-feedback-label': 'Factura original', disabled: !editable, onchange: () => void update({ rectifies_invoice_id: rectOriginal.value || null }) });
  const withoutOriginal = el('input', { 'data-feedback-id': 'invoices.facturas.ficha.fiscal.sin_original', 'data-feedback-label': 'No tengo la original', type: 'checkbox', id: 'invWithoutOriginal', checked: !!invoice.rectification_without_original, disabled: !editable,
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
  const periodSelect = select('invDeclaredPeriod', periodOptions, invoice.declared_period ?? '', { 'data-feedback-id': 'invoices.facturas.ficha.fiscal.periodo', 'data-feedback-label': 'Se declara en',
    disabled: !canEdit || ['validada', 'archivada', 'anulada'].includes(invoice.status) && invoice.status !== 'validada', onchange: () => void update({ declared_period: periodSelect.value || null }) });
  const delivered = (date: string) => mirror.exports.some((e) => !e.deleted_at && e.from_date <= date && date <= e.to_date);
  const askLate = canEdit && !invoice.declared_period && !!ownPeriod && ownPeriod < workingPeriod() && invoice.status !== 'anulada' && invoice.status !== 'archivada' && !delivered(invoice.invoice_date!);
  // FB_2026_024: «Se deja en su trimestre» para la atrasada que la gestoría ya tiene; queda fuera de las entregas.
  const keepInQuarter = () => el('button', { 'data-feedback-id': 'invoices.facturas.ficha.dejar_en_su_trimestre', 'data-feedback-label': 'Se deja en su trimestre', class: 'softbtn small', type: 'button', id: 'keepInQuarter',
    onclick: () => void update({ declared_period: ownPeriod, delivered_elsewhere: true }, `Se queda en el ${quarterName(ownPeriod!)}, como ya pasada a la gestoría.`) }, `Se deja en el ${quarterName(ownPeriod!)} (ya la tiene la gestoría)`);
  if (askLate) {
    header.appendChild(el('div', { class: 'banner warn', id: 'lateBanner' }, el('span', null, `Es del ${quarterName(ownPeriod)}: ¿la declaras en el ${quarterName(workingPeriod())}? Si ese trimestre ya lo declaraste fuera de la app, sí. Si la gestoría ya la tiene, se deja en su trimestre.`),
      el('button', { 'data-feedback-id': 'invoices.facturas.ficha.declarar_ahora', 'data-feedback-label': 'Declararla en el trimestre en curso', class: 'softbtn small', type: 'button', id: 'declareNow',
        onclick: () => void update({ declared_period: workingPeriod() }, `Se declarará en el ${quarterName(workingPeriod())}.`) }, `Sí, en el ${quarterName(workingPeriod())}`),
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
  const dueDate = el('input', { 'data-feedback-id': 'invoices.facturas.ficha.fiscal.vencimiento', 'data-feedback-label': 'Vencimiento', type: 'date', id: 'invDue', value: invoice.due_date ?? '', disabled: !editable, onchange: () => void update({ due_date: dueDate.value || null }) });
  const sourceTotal = el('input', { 'data-feedback-ignore': '', type: 'text', inputmode: 'decimal', id: 'invSourceTotal', value: invoice.source_total === null ? '' : String(Number(invoice.source_total)).replace('.', ','), disabled: !editable, placeholder: 'Total impreso en la factura',
    onchange: () => { const v = parseAmount(sourceTotal.value); if (sourceTotal.value.trim() && v === null) { toast('Importe inválido.'); return; } void update({ source_total: v }); } });
  const notes = el('textarea', { 'data-feedback-ignore': '', id: 'invNotes', rows: '2', disabled: !canEdit }); notes.value = invoice.notes ?? '';
  notes.addEventListener('change', () => void update({ notes: notes.value.trim() || null }));
  const fiscalBlock = fbBlock({ feedbackId: 'invoices.facturas.ficha.fiscal', feedbackLabel: 'Fiscal y pago' }, 'Fiscal y pago', `${categoryLabel(invoice.expense_category)}${invoice.is_investment ? ' · inversión' : ''}`, false,
    el('div', { class: 'row2' }, field('Categoría de gasto', category), field('Deducibilidad', deductibility)),
    el('label', { class: 'check' }, investment, el('span', null, 'Es inversión (no gasto de explotación)')),
    field('Tipo de factura', kind),
    rectFields,
    field('Se declara en', periodSelect, 'Fecha real aparte: una factura del 2T que no declaraste entonces se declara en el trimestre que elijas.'),
    el('div', { class: 'row2' }, field('Fecha de la factura', invDate, invoice.invoice_date ? undefined : 'Sin fecha no se puede validar.'), field('Vencimiento', dueDate)),
    field('Total del documento', sourceTotal, 'Lo que imprime la factura; se compara con el total calculado (tolerancia 0,02 €).'),
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

  return el('div', { class: 'inv' }, header, totals, documentBlock, readingBlock, linesBlock, taxBlock, allocBlock, fiscalBlock, importBlock);
}

/** Periodo fiscal derivado en el cliente para filas optimistas (el servidor lo genera al confirmar). */
function periodOf(isoDate: string): string {
  const year = isoDate.slice(0, 4); const month = Number(isoDate.slice(5, 7)) || 1;
  return `${year}T${Math.ceil(month / 3)}`;
}

/** Mensaje para una sesión de Claude Code con la MCP de Finance (§15.1). */
const CLAUDE_MESSAGE = 'Lee las facturas pendientes de Drive en Ikisai Finance y complétalas. Usa la herramienta invoices_pending_drafts para ver cuáles son; descarga cada PDF de su enlace, léelo con cuidado y llama a invoices_import_json con su invoice_id, el JSON ikisai.invoice.v1 y la procedencia de cada dato (provenance con confidence, text y page). Si un dato no se lee con seguridad, déjalo a null y explícalo en extraction_notes. Si es una factura rectificativa o un abono, dilo en extraction_notes con el número de la factura que rectifica. No valides nada. Al terminar, dime cuántas has completado y cuáles te han dado problemas.';

/**
 * «Leer con IA» (flujo recomendado para la primera factura de un proveedor): ChatGPT en el móvil (comparte el PDF y las
 * instrucciones; el JSON vuelve compartido o pegado) o una sesión de Claude en el ordenador (el mensaje, listo para copiar).
 */
function openReadWithAi(ctx: ViewContext, invoice: LocalInvoice, original: LocalInvoiceFile): void {
  const message = el('textarea', { 'data-feedback-ignore': '', readonly: true, rows: '5', id: 'claudeMessage', style: 'width:100%' });
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
          const how = await shareWithAi(file, { filename: original.normalized_filename, sha256: original.sha256 });
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
function quarterName(period: string | null): string {
  const m = period?.match(/^(\d{4})T([1-4])$/);
  return m ? `${m[2]}T ${m[1]}` : '—';
}
/** Se declara en un trimestre posterior al de su fecha (0228). */
function isLate(invoice: LocalInvoice): boolean {
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
  const description = el('input', { 'data-feedback-ignore': '', type: 'text', id: 'lineDescription', required: true, maxlength: '500', value: line?.description ?? '' });
  const label = el('input', { 'data-feedback-ignore': '', type: 'text', id: 'lineLabel', maxlength: '120', placeholder: 'Opcional: cómo lo llamas tú', value: line?.label ?? '' });
  const quantity = el('input', { 'data-feedback-id': 'invoices.facturas.articulo.cantidad', 'data-feedback-label': 'Cantidad', type: 'text', inputmode: 'decimal', id: 'lineQuantity', value: line?.quantity === null || line?.quantity === undefined ? '' : String(Number(line.quantity)) });
  const unit = el('input', { 'data-feedback-id': 'invoices.facturas.articulo.unidad', 'data-feedback-label': 'Unidad', type: 'text', id: 'lineUnit', maxlength: '16', value: line?.unit ?? '' });
  const unitPrice = el('input', { 'data-feedback-ignore': '', type: 'text', inputmode: 'decimal', id: 'lineUnitPrice', value: line?.unit_price === null || line?.unit_price === undefined ? '' : String(Number(line.unit_price)) });
  const net = el('input', { 'data-feedback-ignore': '', type: 'text', inputmode: 'decimal', id: 'lineNet', required: true, value: line ? String(Number(line.net_amount)) : '' });
  const vatRate = select('lineVat', [['', 'Sin IVA'], ['0', '0 %'], ['4', '4 %'], ['10', '10 %'], ['21', '21 %']], line?.vat_rate === null || line?.vat_rate === undefined ? '' : String(Number(line.vat_rate)), { 'data-feedback-id': 'invoices.facturas.articulo.iva', 'data-feedback-label': 'IVA' });
  const itemType = select('lineType', [['', 'Tipo de artículo'], ...ITEM_TYPES.map((t) => [t, ITEM_TYPE_LABELS[t] ?? t] as [string, string])], line?.item_type, { 'data-feedback-id': 'invoices.facturas.articulo.tipo', 'data-feedback-label': 'Tipo de artículo' });
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
function labelForm(client: SyncClient, line: LocalInvoiceLine, done: () => void): HTMLElement {
  const input = el('input', { 'data-feedback-ignore': '', type: 'text', id: 'labelInput', maxlength: '120', value: line.label ?? '', placeholder: line.description, 'aria-label': 'Mi nombre' });
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
  const type = select('taxType', TAX_TYPES.map((t) => [t, TAX_TYPE_LABELS[t] ?? t] as [string, string]), tax?.tax_type ?? 'iva', { 'data-feedback-id': 'invoices.facturas.impuesto.tipo', 'data-feedback-label': 'Tipo de impuesto' });
  const rate = el('input', { 'data-feedback-id': 'invoices.facturas.impuesto.tasa', 'data-feedback-label': 'Tasa', type: 'text', inputmode: 'decimal', id: 'taxRate', value: tax?.rate === null || tax?.rate === undefined ? '' : String(Number(tax.rate)) });
  const base = el('input', { 'data-feedback-ignore': '', type: 'text', inputmode: 'decimal', id: 'taxBase', value: tax?.taxable_base === null || tax?.taxable_base === undefined ? '' : String(Number(tax.taxable_base)) });
  const amount = el('input', { 'data-feedback-ignore': '', type: 'text', inputmode: 'decimal', id: 'taxAmount', required: true, value: tax ? String(Number(tax.amount)) : '' });
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
  const supplier = select('newSupplier', [['', 'Elige proveedor'], ...suppliers, [NEW_SUPPLIER, '+ Nuevo proveedor…']], suppliers.length ? null : NEW_SUPPLIER, { 'data-feedback-ignore': '' });
  const supplierName = el('input', { 'data-feedback-ignore': '', type: 'text', id: 'newSupplierName', maxlength: '160', placeholder: 'Nombre del proveedor', autocomplete: 'organization' });
  const supplierTaxId = el('input', { 'data-feedback-ignore': '', type: 'text', id: 'newSupplierTaxId', maxlength: '32', placeholder: 'Opcional', autocapitalize: 'characters' });
  const supplierFields = el('div', { class: 'row2 new-supplier', id: 'newSupplierFields' }, field('Nombre del proveedor', supplierName), field('NIF', supplierTaxId));
  const syncSupplierFields = () => { supplierFields.hidden = supplier.value !== NEW_SUPPLIER; };
  supplier.addEventListener('change', () => { syncSupplierFields(); if (supplier.value === NEW_SUPPLIER) supplierName.focus(); });
  syncSupplierFields();
  const date = el('input', { 'data-feedback-id': 'invoices.facturas.nueva.fecha', 'data-feedback-label': 'Fecha', type: 'date', id: 'newDate' });
  const object = el('input', { 'data-feedback-id': 'invoices.facturas.nueva.objeto', 'data-feedback-label': 'Objeto', type: 'text', id: 'newObject', required: true, maxlength: '120', placeholder: 'alimentos retiro yoga' });
  const number = el('input', { 'data-feedback-id': 'invoices.facturas.nueva.numero', 'data-feedback-label': 'Número de factura', type: 'text', id: 'newNumber', maxlength: '64', placeholder: 'Opcional' });
  const total = el('input', { 'data-feedback-ignore': '', type: 'text', inputmode: 'decimal', id: 'newTotal', placeholder: 'Opcional, con IVA' });
  const files = el('input', { 'data-feedback-id': 'invoices.facturas.nueva.documentos', 'data-feedback-label': 'PDF o fotos', type: 'file', id: 'newFiles', accept: ACCEPT_ATTR, multiple: true });
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
    const file = files.files?.[0];
    return file ? { file, source: { filename: file.name, sha256: await sha256Hex(file) } } : null;
  }, (file) => readNew(file, false));
  /** Lee el PDF elegido (al elegirlo, o con «Leer PDF») y rellena el formulario con lo que encuentre. */
  async function readNew(file: File, auto: boolean): Promise<void> {
    const picked = Array.from(files.files ?? []);
    if (auto) replace(readingHost, el('p', { class: 'hint', id: 'readingProgress', role: 'status' }, 'Leyendo el PDF…'));
    await readPdfInto(ctx, mirror, null, file, picked, undefined, (prefill) => {
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
  }
  const readingHost = el('div', { id: 'newReading' });
  chatgpt.hidden = true;
  // Fase 1: elegir el PDF ya lo lee (en el worker de PDF.js, con límites de tamaño y tiempo); sin pulsar nada más.
  files.addEventListener('change', () => {
    chatgpt.hidden = !(files.files && files.files.length);
    const first = files.files?.[0];
    if (first && (first.type === 'application/pdf' || /\.pdf$/i.test(first.name))) void readNew(first, true);
    else replace(readingHost);
  });
  const form = el('form', { 'data-feedback-id': 'invoices.facturas.nueva.formulario', 'data-feedback-label': 'Datos de la factura', id: 'newInvoiceForm', novalidate: true, oninput: () => { guard.dirtyEditor = true; }, onsubmit: async (e: Event) => {
    e.preventDefault();
    error.textContent = '';
    // Fase 1: con documento, ni el proveedor ni el objeto son obligatorios: queda en «Pendiente de datos» con el
    // proveedor provisional y el objeto del nombre del archivo, y se completa después.
    const firstFile = files.files?.[0] ?? null;
    const noSupplier = !supplier.value || (supplier.value === NEW_SUPPLIER && !supplierName.value.trim() && !supplierTaxId.value.trim());
    if (noSupplier && !firstFile) { error.textContent = 'Elige el PDF o foto, o el proveedor.'; files.focus(); return; }
    if (supplier.value === NEW_SUPPLIER && !noSupplier && !supplierName.value.trim()) { error.textContent = 'Escribe el nombre del proveedor nuevo.'; supplierName.focus(); return; }
    if (!object.value.trim() && firstFile) object.value = (firstFile.name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_\s]+/g, ' ').trim() || 'factura').slice(0, 120);
    if (!object.value.trim()) { error.textContent = 'Indica el objeto (qué se compró).'; object.focus(); return; }
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
      ];
      if (sameTaxId) toast(`Ya tenías el proveedor ${sameTaxId.name} con ese NIF: la factura queda a su nombre.`);
      const created = await commitSafely(client, ops, 'Factura creada en este dispositivo.');
      usage.track('invoices.facturas.subir', created ? 'success' : 'error');
      if (created) {
        guard.dirtyEditor = false;
        await closeSheet(true);
        void openInvoice(ctx, invoiceId);
      }
    } catch (err) { error.textContent = describeError(err); }
    save.disabled = false;
  } },
    field('PDF o fotos', files, 'Elige el PDF: se lee solo y rellena lo que encuentre. Las fotos se reducen en el móvil.'),
    chatgpt,
    readingHost,
    el('p', { class: 'hint form-section' }, 'O a mano (si no hay PDF con texto ni IA):'),
    field('Proveedor', supplier, 'Si no está en la lista, elige «+ Nuevo proveedor…» y créalo aquí. Con el JSON de ChatGPT se crea solo.'),
    supplierFields,
    el('div', { class: 'row2' }, field('Fecha', date, 'Opcional: si la dejas vacía, se toma del PDF al leerlo.'), field('Número de factura', number)),
    field('Objeto', object, 'Qué se compró, en pocas palabras. Forma parte del nombre del archivo.'),
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
export interface ExtractionPrefill { rectification?: { isRectification: boolean; number: string | null; evidence: string | null }; document?: ImportDocument; warnings: string[]; errors?: unknown[]; usage?: ExtractionUsage | null; provenance?: Record<string, FieldProvenance>; origin?: 'api' | 'pdf_text' }

const PROVENANCE_LABELS: Record<string, string> = {
  'invoice.supplier_name': 'Proveedor', 'invoice.supplier_tax_id': 'NIF', 'invoice.invoice_date': 'Fecha', 'invoice.invoice_number': 'Número',
  'invoice.object': 'Objeto', 'document_totals.base': 'Base', 'document_totals.vat': 'IVA', 'document_totals.withholding': 'Retención', 'document_totals.total': 'Total',
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
  if (auto && onPartial) { onPartial({ read: result.read, found: result.found, message: readingMessage(result), text: readingText(items) }); return; }
  if (!result.ok || !result.document) {
    // Lectura parcial (fase 0): nunca una pantalla vacía. Lo leído rellena «Rellenar a mano» (o el formulario nuevo).
    const prefill: ManualPrefill = { read: result.read, found: result.found, message: readingMessage(result), text: readingText(items) };
    if (target) { guard.dirtyEditor = false; await closeSheet(true); openManualEntry(ctx, mirror, target, validateAndReopen(ctx), prefill); }
    else if (onPartial) onPartial(prefill);
    else toast(prefill.message);
    return;
  }
  guard.dirtyEditor = false;
  await closeSheet(true);
  const templateNote = result.template ? `Plantilla del proveedor v${result.template.version} · ${result.template.confirmations} factura${result.template.confirmations === 1 ? '' : 's'}${result.template.status === 'aprendiendo' ? ' (aprendiendo)' : ''}.` : null;
  const rectification = detectRectification({ text: items.map((i) => i.str).join('\n'), document: result.document });
  const documentForImport = rectification.isRectification && result.document.document_totals.total > 0 ? negateDocument(result.document) : result.document;
  openImport(ctx, mirror, target, { document: documentForImport, rectification, warnings: [...(rectification.isRectification ? [`Parece una rectificativa (${rectification.evidence}): revisa el número de la original.`] : []), ...(templateNote ? [templateNote] : []), ...result.warnings], provenance: result.provenance, origin: 'pdf_text' }, files?.length ? { files } : {});
}

/** Tras «Rellenar a mano» con «Guardar y validar»: valida con aprendizaje y vuelve a abrir la ficha. */
function validateAndReopen(ctx: ViewContext): (invoiceId: string) => Promise<void> {
  return async (invoiceId) => {
    const fresh = await loadMirror(ctx.client);
    const current = fresh.invoices.find((i) => i.id === invoiceId);
    if (!current) return;
    const ok = await commitSafely(ctx.client, await validateWithLearning(ctx, fresh, current), 'Factura validada. Finance aprende este proveedor para la próxima.');
    if (ok) void openInvoice(ctx, invoiceId);
  };
}

async function saveDocumentText(ctx: ViewContext, fileId: string, items: PdfTextItem[]): Promise<void> {
  try { await ctx.client.api(`/documents/${fileId}/text`, { json: { source: 'pdf_text', items: items.slice(0, 20_000) } }); } catch { /* aprender al validar volverá a leer el PDF */ }
}

/**
 * Validar y, en el mismo lote, aprender la plantilla del proveedor con lo confirmado (API.md §6.9). El servidor exige que
 * vayan juntos. Si no hay texto del documento (sin red, foto o escaneado), se valida sin aprender: nunca bloquea.
 */
async function validateWithLearning(ctx: ViewContext, mirror: Mirror, invoice: LocalInvoice): Promise<RowOperation[]> {
  const ops: RowOperation[] = [{ op: 'call', procedure: 'invoices.validate', args: { invoice_id: invoice.id, expectedRevision: invoice.revision } }];
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
    });
    if (!learning) return ops;
    const current = learning.template.id ? mirror.templates.find((t) => t.id === learning.template.id) ?? null : null;
    ops.push(templateOperation(learning, current, invoice.id, crypto.randomUUID()) as RowOperation);
  } catch { /* aprender es un extra: la validación sigue */ }
  return ops;
}

export function openImport(ctx: ViewContext, mirror: Mirror, target: LocalInvoice | null, prefill?: ExtractionPrefill, options: { files?: File[]; text?: string } = {}): void {
  const { client } = ctx;
  let document: ImportDocument | null = null;
  let errors: SchemaError[] = [];
  const textarea = el('textarea', { 'data-feedback-ignore': '', id: 'importJson', rows: '6', placeholder: 'Pega aquí el resultado de ChatGPT (el JSON o la respuesta entera)…', spellcheck: 'false' });
  const jsonFile = el('input', { 'data-feedback-id': 'invoices.facturas.importar.archivo', 'data-feedback-label': 'Cargar archivo', type: 'file', accept: 'application/json,.json,text/plain,.txt', id: 'importFile' });
  const sourceNote = el('div', { id: 'sourceCheck' });
  const docs = el('input', { 'data-feedback-id': 'invoices.facturas.importar.documentos', 'data-feedback-label': 'Documentos', type: 'file', accept: ACCEPT_ATTR, multiple: true, id: 'importDocs' });
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
    ], chosenDefault?.id ?? '__new__', { 'data-feedback-ignore': '' });
    const supplierFor = () => (supplierSelect && supplierSelect.value !== '__new__' ? mirror.supplierById.get(supplierSelect.value) ?? null : null);
    const proposal = () => proposeImport(doc, supplierFor(), {
      object: objectInput?.value || null, invoice_date: dateInput?.value || null,
      expense_category: (categorySelect?.value || null) as never, is_investment: investmentInput ? investmentInput.checked : null, deductibility: (deductibilitySelect?.value || null) as Deductibility | null,
    });
    const first = proposeImport(doc, supplierFor());
    objectInput = el('input', { 'data-feedback-id': 'invoices.facturas.importar.objeto', 'data-feedback-label': 'Objeto', type: 'text', id: 'importObject', value: target?.object ?? first.object, maxlength: '120' });
    // Fecha (decisión de Core, ronda 35): si la escrita al subir no coincide con la del documento, se marca y se ofrece
    // la del documento; se preselecciona solo si la escrita era la de hoy por defecto.
    // El día de creación en hora local (el «hoy» que vio el usuario al subirla), no en UTC.
    const createdOn = target?.created_at ? new Date(target.created_at).toLocaleDateString('sv-SE') : null;
    const dateChoice = importDateChoice(target?.invoice_date, createdOn, doc.invoice.invoice_date);
    dateInput = el('input', { 'data-feedback-id': 'invoices.facturas.importar.fecha', 'data-feedback-label': 'Fecha', type: 'date', id: 'importDate', value: target ? dateChoice.value : first.invoice_date });
    categorySelect = select('importCategory', [['', 'Sin categoría'], ...CATEGORIES.map((c) => [c, CATEGORY_LABELS[c]] as [string, string])], target?.expense_category ?? first.expense_category, { 'data-feedback-id': 'invoices.facturas.importar.categoria', 'data-feedback-label': 'Categoría' });
    investmentInput = el('input', { 'data-feedback-id': 'invoices.facturas.importar.inversion', 'data-feedback-label': 'Es inversión', type: 'checkbox', id: 'importInvestment', checked: target?.is_investment ?? first.is_investment });
    // Rectificativa (0227): detectada al leer el PDF o por el documento (nota o total negativo); el usuario la confirma.
    const detected = prefill?.rectification ?? detectRectification({ document: doc });
    kindSelect = select('importKind', [['ordinaria', 'Factura ordinaria'], ['rectificativa', 'Rectificativa (abono o devolución)']], detected.isRectification ? 'rectificativa' : 'ordinaria', { 'data-feedback-id': 'invoices.facturas.importar.tipo', 'data-feedback-label': 'Tipo de factura' });
    rectNumberInput = el('input', { 'data-feedback-id': 'invoices.facturas.importar.rectifica', 'data-feedback-label': 'Rectifica a la factura nº', type: 'text', id: 'importRectNumber', maxlength: '64', value: detected.number ?? '' });
    deductibilitySelect = select('importDeductibility', DEDUCTIBILITIES.map((d) => [d, DEDUCTIBILITY_LABELS[d] ?? d] as [string, string]), first.deductibility, { 'data-feedback-id': 'invoices.facturas.importar.deducibilidad', 'data-feedback-label': 'Deducibilidad' });
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
  const promptText = el('textarea', { class: 'prompt-text', readonly: true, rows: '8', hidden: true, 'aria-label': 'Prompt de extracción' });
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
export function openAllocation(ctx: ViewContext, mirror: Mirror, invoice: LocalInvoice, line: LocalInvoiceLine): void {
  const { client } = ctx;
  const rest = unallocated(line, mirror);
  let app = 'general';
  let choice: TargetChoice | null = null;
  const appButtons = el('div', { class: 'segmented', role: 'tablist' },
    ...[['general', 'General'], ['tasks', 'Tareas'], ['food', 'Cocina'], ['booking', 'Reservas']].map(([value, label]) => el('button', { ...ALLOC_APP_MARKS[value!], type: 'button', class: value === app ? 'on' : '', dataset: { app: value! }, onclick: () => { app = value!; choice = null; paintApp(); } }, label)),
  );
  const kindSelect = select('allocKind', kindsFor('general').map((k) => [k, KIND_LABELS[k] ?? k] as [string, string]), 'operating_expense', { 'data-feedback-id': 'invoices.facturas.asignar.tipo', 'data-feedback-label': 'Tipo' });
  const searchInput = el('input', { 'data-feedback-id': 'invoices.facturas.asignar.buscar', 'data-feedback-label': 'Buscar destino', type: 'search', id: 'targetSearch', placeholder: 'Buscar destino…', autocomplete: 'off' });
  const results = el('div', { id: 'targetResults' });
  const chosen = el('p', { class: 'hint', id: 'chosenTarget' });
  const amount = el('input', { 'data-feedback-ignore': '', type: 'text', inputmode: 'decimal', id: 'allocAmount', value: String(rest).replace('.', ',') });
  const quantity = el('input', { 'data-feedback-id': 'invoices.facturas.asignar.cantidad', 'data-feedback-label': 'Cantidad', type: 'text', inputmode: 'decimal', id: 'allocQuantity', placeholder: line.quantity === null ? 'Sin cantidad' : `de ${Number(line.quantity)} ${line.unit ?? ''}` });
  const error = el('p', { class: 'formerror', role: 'alert' });
  const appArea = el('div');

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
    const ok = await commitSafely(client, [{ op: 'insert', table: ALLOCATIONS, id: crypto.randomUUID(), fields: { ...fields, invoice_line_id: line.id, allocated_amount: Number(line.net_amount) < 0 ? -a : a, allocated_quantity: q } }], 'Asignación guardada.');
    usage.track('invoices.facturas.asignar', ok ? 'success' : 'error');
    if (ok) { await closeSheet(true); void openInvoice(ctx, invoice.id); }
  } }, 'Asignar');

  openSheet({
    title: `Asignar «${lineName(line)}»`,
    meta: `${eur(rest)} sin asignar de ${eur(line.net_amount)}`,
    body: el('div', null, appButtons, appArea, el('div', { class: 'row2' }, field('Importe (base, sin IVA)', amount), field('Cantidad', quantity)), error),
    foot: [el('button', { 'data-feedback-id': 'invoices.facturas.asignar.volver', 'data-feedback-label': 'Volver', class: 'ghost', type: 'button', onclick: async () => { await closeSheet(true); void openInvoice(ctx, invoice.id); } }, 'Volver'), save],
    initialFocus: amount,
  });
  paintApp();
}

export { SUPPLIERS };
