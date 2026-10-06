/**
 * Facturas (API.md §9.2): lista por mes, ficha en hoja (documento, artículos, impuestos, asignación, pago, fiscal),
 * alta con documento, importación del JSON `ikisai.invoice.v1`, validar, anular, archivar.
 */
import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import { closeSheet, confirmDialog, el, icon, openSheet, renderList, replace, toast, type ListRowSpec, type Sheet } from '@ikisai/ui-kit';
import {
  DEDUCTIBILITIES, EXTRACTION_PROMPT, PAYMENT_METHODS, TAX_TYPES, ITEM_TYPES, importDocumentSha256, importOperations, matchSupplier, normalizedFilename, parseImportDocument, proposeImport, recalculate,
  slugify, sumCents, fromCents, toCents, type ImportDocument, type SchemaError, type Deductibility,
} from '@ikisai/domain-invoices';
import {
  ALLOCATIONS, CATEGORIES, CATEGORY_LABELS, INVOICES, INVOICE_FILES, INVOICE_LINES, SUPPLIERS, TAX_LINES, categoryLabel, describeError,
  type LocalAllocation, type LocalInvoice, type LocalInvoiceLine, type LocalSupplier, type LocalTaxLine,
} from '../app/client.ts';
import {
  DEDUCTIBILITY_LABELS, GENERAL_KIND_LABELS, ITEM_TYPE_LABELS, PAYMENT_METHOD_LABELS, TAX_TYPE_LABELS, eur, loadMirror, monthKey, monthLabel, onAnyTable, parseAmount, shortDate,
  statusChipClass, statusText, todayIso, type Mirror,
} from '../app/data.ts';
import { ACCEPT_ATTR, formatBytes, openFile, stageDocument, type StagedDocument } from '../app/files.ts';
import { FRESHNESS_LABELS, KIND_LABELS, checkTargetFreshness, kindsFor, recentTargets, rememberTarget, searchTargets, targetLabel, type TargetChoice } from '../app/targets.ts';
import { guard } from '../app/guard.ts';
import { extractDocument, extractionQueue } from '../app/extract.ts';
import type { ViewContext, ViewMount } from './shell.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Utilidades de la vista
// ---------------------------------------------------------------------------
async function commitSafely(client: SyncClient, operations: RowOperation[], okMessage: string, blobs?: Blob[]): Promise<boolean> {
  try {
    await client.commit(operations, blobs ? { blobs } : undefined);
    toast(client.status().network === 'offline' ? `${okMessage} Se sincronizará cuando haya red.` : okMessage);
    return true;
  } catch (error) {
    toast(describeError(error));
    return false;
  }
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return el('label', { class: 'field' }, el('span', null, label), control, hint ? el('span', { class: 'hint' }, hint) : null);
}

function select(id: string, options: Array<[string, string]>, value: string | null | undefined, extra: Record<string, unknown> = {}): HTMLSelectElement {
  return el('select', { id, ...extra }, ...options.map(([v, label]) => el('option', { value: v, selected: (value ?? '') === v }, label)));
}

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
export const mountInvoices: ViewMount = (ctx) => {
  const { main, client } = ctx;
  let mirror: Mirror | null = null;
  let query = '';
  let filter = 'activas';
  let opened: string | null = null;

  const search = el('input', { type: 'search', id: 'invoiceSearch', placeholder: 'Proveedor, objeto, número o código', 'aria-label': 'Buscar facturas', autocomplete: 'off',
    oninput: () => { query = search.value.trim().toLowerCase(); paint(); } });
  const statusSelect = select('invoiceFilter', [['activas', 'Todas las activas'], ['pendiente_datos', 'Pendientes de datos'], ['pendiente_revision', 'Pendientes de revisión'], ['validada', 'Validadas'], ['archivada', 'Archivadas'], ['sin_pagar', 'Sin pagar'], ['sin_documento', 'Sin documento'], ['anulada', 'Anuladas']], filter,
    { 'aria-label': 'Filtrar por estado', onchange: () => { filter = statusSelect.value; paint(); } });
  const listHost = el('div', { id: 'invoiceList' });
  const canEdit = client.bootstrap()?.membership.role !== 'reader';
  const newButton = el('button', { class: 'fab', type: 'button', id: 'newInvoice', hidden: !canEdit, onclick: () => openNewInvoice(ctx, mirror!) }, icon('plus'), 'Nueva factura');
  const extractAll = el('button', { class: 'softbtn small', type: 'button', id: 'extractPending', hidden: true, onclick: () => void extractPending() }, icon('upload', 16), 'Extraer pendientes');
  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Facturas'), el('p', null, 'Documento, datos importados, revisión y validación. Nada se valida en silencio.'))),
    el('div', { class: 'toolbar' }, el('div', { class: 'search' }, search), statusSelect),
    el('div', { class: 'toolbar', id: 'invoiceTools' }, extractAll),
    listHost,
    newButton,
  );

  /** Facturas con documento y sin datos: candidatas a la extracción automática. */
  function extractable(): LocalInvoice[] {
    if (!mirror) return [];
    return mirror.invoices.filter((i) => !i.deleted_at && i.status === 'pendiente_datos' && (mirror!.filesByInvoice.get(i.id) ?? []).some((f) => f.kind === 'original'))
      .sort((a, b) => a.invoice_date.localeCompare(b.invoice_date));
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
      default: return invoice.status === filter;
    }
  }

  function rowSpec(invoice: LocalInvoice): ListRowSpec {
    const m = mirror!;
    const hasFile = (m.filesByInvoice.get(invoice.id) ?? []).some((f) => f.kind === 'original');
    const chips = [el('span', { class: statusChipClass(invoice.status, invoice.review_reason) }, statusText(invoice))];
    if (invoice.payment_status === 'pagada') chips.push(el('span', { class: 'chip ok' }, 'Pagada'));
    if (!hasFile && invoice.status !== 'anulada') chips.push(el('span', { class: 'chip alert' }, 'Sin documento'));
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
    const visible = mirror.invoices.filter((i) => !i.deleted_at && matches(i)).sort((a, b) => b.invoice_date.localeCompare(a.invoice_date) || (b.code ?? '').localeCompare(a.code ?? ''));
    if (!visible.length) {
      replace(listHost, el('div', { class: 'empty' }, el('strong', null, mirror.invoices.length ? 'Ninguna factura coincide' : 'Todavía no hay facturas'),
        mirror.invoices.length ? 'Cambia el filtro o la búsqueda.' : 'Sube el documento con «Nueva factura» o importa el JSON de ChatGPT. Funciona también sin conexión.'));
      return;
    }
    const groups = new Map<string, LocalInvoice[]>();
    for (const inv of visible) { const k = monthKey(inv.invoice_date); groups.set(k, [...(groups.get(k) ?? []), inv]); }
    replace(listHost, ...[...groups.entries()].map(([key, rows]) => el('section', null,
      el('div', { class: 'sectionlabel' }, monthLabel(key), el('span', { class: 'count' }, String(rows.length))),
      renderList({ label: `Facturas de ${monthLabel(key)}`, rows: rows.map(rowSpec) }),
    )));
  }

  async function load(): Promise<void> {
    mirror = await loadMirror(client);
    paint();
    if (opened) refreshOpenInvoice(ctx, opened, mirror);
  }

  function fromHash(): void {
    const tail = location.hash.replace(/^#\/facturas\/?/, '');
    if (tail === 'nueva' && mirror) { openNewInvoice(ctx, mirror); history.replaceState(null, '', '#/facturas'); }
    else if (UUID.test(tail)) { openInvoice(ctx, tail.toLowerCase()); history.replaceState(null, '', '#/facturas'); }
  }

  // Las filas (también su marca «pendiente») llegan por onTable; el estado de red no cambia la lista.
  const offTables = onAnyTable(client, () => void load());
  const offOpen = onOpen((id) => { opened = id; });
  void load().then(fromHash);
  return () => { offTables(); offOpen(); void closeSheet(true); };
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
    foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void closeSheet() }, 'Cerrar')],
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
  if (editable && pendingState) {
    actions.push(el('button', { class: 'primary', type: 'button', id: 'validateInvoice', onclick: () => void call('invoices.validate', { invoice_id: invoice.id, expectedRevision: invoice.revision }, 'Factura validada.') }, icon('check', 18), 'Validar'));
    actions.push(el('button', { class: 'softbtn', type: 'button', id: 'importInto', onclick: () => void openImport(ctx, mirror, invoice) }, icon('upload', 18), 'Importar JSON'));
    if (invoice.status === 'pendiente_datos' && files.some((f) => f.kind === 'original')) {
      actions.push(el('button', { class: 'softbtn', type: 'button', id: 'extractInvoice', title: 'Pide a la Edge el JSON del documento y lo lleva a la vista previa de importación', onclick: () => void extractInto(ctx, invoice) }, icon('upload', 18), 'Extraer'));
    }
  }
  if (canEdit && invoice.status !== 'anulada') {
    actions.push(el('button', { class: 'softbtn', type: 'button', id: 'togglePaid', onclick: () => void togglePaid() }, invoice.payment_status === 'pagada' ? 'Marcar pendiente de pago' : 'Marcar pagada'));
  }
  if (role === 'owner' && invoice.status === 'validada') actions.push(el('button', { class: 'ghost', type: 'button', onclick: () => void update({ status: 'archivada' }, 'Factura archivada.') }, 'Archivar'));
  if (role === 'owner' && invoice.status === 'archivada') actions.push(el('button', { class: 'ghost', type: 'button', onclick: () => void update({ status: 'validada' }, 'Factura desarchivada.') }, 'Desarchivar'));
  if (canEdit && invoice.status !== 'anulada') actions.push(el('button', { class: 'danger', type: 'button', id: 'annulInvoice', onclick: () => void annul() }, icon('trash', 18), 'Anular'));

  async function togglePaid(): Promise<void> {
    if (invoice.payment_status === 'pagada') { await update({ payment_status: 'pendiente', paid_at: null }, 'Pago marcado como pendiente.'); return; }
    const date = el('input', { type: 'date', value: todayIso(), id: 'paidAt' });
    const method = select('paidMethod', [['', 'Sin indicar'], ...PAYMENT_METHODS.map((m) => [m, PAYMENT_METHOD_LABELS[m] ?? m] as [string, string])], invoice.payment_method);
    const ok = await confirmDialog({ title: 'Marcar como pagada', text: el('div', null, field('Fecha de pago', date), field('Método', method)), confirmLabel: 'Marcar pagada' });
    if (!ok) return;
    await update({ payment_status: 'pagada', paid_at: date.value || todayIso(), payment_method: method.value || null }, 'Factura marcada como pagada.');
  }

  async function annul(): Promise<void> {
    const reason = el('input', { type: 'text', id: 'annulReason', maxlength: '500', placeholder: 'Duplicada, abono, error…' });
    const ok = await confirmDialog({ title: `¿Anular ${invoice.code ?? 'esta factura'}?`, text: el('div', null, el('p', null, 'La factura se conserva fuera de los resúmenes y de la gestoría. Sus asignaciones pasan a la papelera.'), field('Motivo', reason)), confirmLabel: 'Anular', danger: true });
    if (!ok) return;
    if (!reason.value.trim()) { toast('Indica el motivo de la anulación.'); return; }
    await call('invoices.annul', { invoice_id: invoice.id, expectedRevision: invoice.revision, reason: reason.value.trim() }, 'Factura anulada.');
  }

  // --- Cabecera y totales --------------------------------------------------
  const header = el('div', { class: 'inv-head' },
    el('div', { class: 'chips' },
      el('span', { class: statusChipClass(invoice.status, invoice.review_reason) }, statusText(invoice)),
      invoice.payment_status === 'pagada' ? el('span', { class: 'chip ok' }, `Pagada${invoice.paid_at ? ' ' + shortDate(invoice.paid_at) : ''}`) : el('span', { class: 'chip' }, 'Pendiente de pago'),
      invoice.source === 'import_v1' ? el('span', { class: 'chip', title: 'Datos importados del JSON de ChatGPT' }, 'Desde JSON') : null,
    ),
    el('dl', { class: 'kv' },
      el('dt', null, 'Proveedor'), el('dd', null, supplier?.name ?? '—', supplier?.tax_id ? ` · ${supplier.tax_id}` : ''),
      el('dt', null, 'Fecha'), el('dd', null, shortDate(invoice.invoice_date), ` · periodo ${invoice.fiscal_period ?? periodOf(invoice.invoice_date)}`),
      el('dt', null, 'Número'), el('dd', null, invoice.invoice_number ?? '—'),
      el('dt', null, 'Objeto'), el('dd', null, invoice.object),
    ),
    el('div', { class: 'btnrow inv-actions' }, ...actions),
  );

  const totals = el('section', { class: 'inv-totals' },
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
  const documentBlock = block('Documento', files.length ? `${files.length}` : 'ninguno', true,
    files.length ? renderList({ label: 'Documentos', rows: files.map((f) => ({
      id: f.id, title: f.normalized_filename, meta: [f.kind === 'attachment' ? 'Adjunto' : `Página ${f.page_order}`, formatBytes(Number(f.size_bytes)), f.original_filename], pending: f._pending === true,
      actions: [el('button', { class: 'linkbtn', type: 'button', onclick: () => openFile(client, f.file_id).catch((e) => toast(describeError(e))) }, icon('eye', 16), 'Ver')],
    })) }) : el('p', { class: 'hint' }, 'Sin documento. Una factura no se valida sin su original.'),
    canEdit && invoice.status !== 'anulada' ? el('div', { class: 'btnrow' }, el('button', { class: 'softbtn', type: 'button', onclick: () => fileInput.click() }, icon('attach', 18), pendingState ? 'Añadir PDF o fotos' : 'Añadir adjunto'), fileInput) : null,
  );

  // --- Artículos -----------------------------------------------------------
  const lineForm = (line: LocalInvoiceLine | null) => renderLineForm(client, invoice, line, lines.length);
  const linesBlock = block('Artículos', String(lines.length), true,
    lines.length ? el('table', { class: 'inv-table' },
      el('thead', null, el('tr', null, el('th', null, 'Descripción'), el('th', { class: 'num' }, 'Cant.'), el('th', { class: 'num' }, 'Base'), el('th', { class: 'num' }, 'IVA'), editable ? el('th') : null)),
      el('tbody', null, ...lines.map((l) => el('tr', { dataset: { id: l.id } },
        el('td', null, l.description, l.item_type ? el('span', { class: 'hint' }, ' · ' + (ITEM_TYPE_LABELS[l.item_type] ?? l.item_type)) : null, l._pending ? el('span', { class: 'chip pending' }, 'Pendiente') : null),
        el('td', { class: 'num' }, l.quantity === null ? '—' : `${Number(l.quantity)} ${l.unit ?? ''}`.trim()),
        el('td', { class: 'num' }, eur(l.net_amount)),
        el('td', { class: 'num' }, l.vat_rate === null ? '—' : `${Number(l.vat_rate)} %`),
        editable ? el('td', null, el('button', { class: 'linkbtn', type: 'button', 'aria-label': `Editar ${l.description}`, onclick: () => replace(lineEditor, lineForm(l)) }, 'Editar')) : null,
      ))),
    ) : el('p', { class: 'hint' }, 'Sin artículos. Importa el JSON o añádelos a mano.'),
    editable ? el('div', { class: 'btnrow' }, el('button', { class: 'softbtn', type: 'button', id: 'addLine', onclick: () => replace(lineEditor, lineForm(null)) }, icon('plus', 18), 'Añadir artículo')) : null,
  );
  const lineEditor = el('div', { class: 'inv-editor' });
  linesBlock.appendChild(lineEditor);

  // --- Impuestos -----------------------------------------------------------
  const taxEditor = el('div', { class: 'inv-editor' });
  const taxBlock = block('Impuestos', String(taxes.length), false,
    taxes.length ? el('table', { class: 'inv-table' },
      el('thead', null, el('tr', null, el('th', null, 'Tipo'), el('th', { class: 'num' }, 'Tasa'), el('th', { class: 'num' }, 'Base'), el('th', { class: 'num' }, 'Importe'), editable ? el('th') : null)),
      el('tbody', null, ...taxes.map((t) => el('tr', null,
        el('td', null, TAX_TYPE_LABELS[t.tax_type] ?? t.tax_type), el('td', { class: 'num' }, t.rate === null ? '—' : `${Number(t.rate)} %`), el('td', { class: 'num' }, eur(t.taxable_base)), el('td', { class: 'num' }, eur(t.amount)),
        editable ? el('td', null, el('button', { class: 'linkbtn', type: 'button', onclick: () => replace(taxEditor, renderTaxForm(client, invoice, t, taxes.length)) }, 'Editar')) : null,
      ))),
    ) : el('p', { class: 'hint' }, 'Sin desglose: el IVA se calcula desde los artículos.'),
    editable ? el('div', { class: 'btnrow' }, el('button', { class: 'softbtn', type: 'button', onclick: () => replace(taxEditor, renderTaxForm(client, invoice, null, taxes.length)) }, icon('plus', 18), 'Añadir impuesto')) : null,
  );
  taxBlock.appendChild(taxEditor);

  // --- Asignación ----------------------------------------------------------
  const allocBlock = block('Asignación', lines.length ? `${lines.filter((l) => unallocated(l, mirror) > 0).length} sin asignar` : '—', lines.length > 0,
    ...lines.map((l) => {
      const allocations = mirror.allocationsByLine.get(l.id) ?? [];
      const assigned = fromCents(sumCents(allocations.map((a) => Number(a.allocated_amount))));
      const rest = unallocated(l, mirror);
      const pct = Number(l.net_amount) > 0 ? Math.min(100, Math.round((assigned / Number(l.net_amount)) * 100)) : 0;
      return el('div', { class: 'alloc-line' },
        el('div', { class: 'alloc-head' }, el('strong', null, l.description), el('span', null, `${eur(assigned)} de ${eur(l.net_amount)}`)),
        el('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' }, el('span', { style: `width:${pct}%` })),
        el('div', { class: 'chips' },
          ...allocations.map((a) => {
            const chip = el('span', { class: 'chip', style: '--chip:#6b7f52', dataset: { allocation: a.id } }, allocationLabel(a), ` · ${eur(a.allocated_amount)}`,
              canEdit && invoice.status !== 'anulada' ? el('button', { class: 'x', type: 'button', 'aria-label': `Quitar asignación ${allocationLabel(a)}`, onclick: () => void commitSafely(client, [{ op: 'delete', table: ALLOCATIONS, id: a.id, expectedRevision: a.revision }], 'Asignación enviada a la papelera.') }, '×') : null);
            void checkTargetFreshness(client, a).then((f) => { if (f === 'changed' || f === 'missing') { chip.classList.add('alert'); chip.title = FRESHNESS_LABELS[f]; chip.appendChild(el('span', { class: 'stale' }, ` · ${FRESHNESS_LABELS[f]}`)); } });
            return chip;
          }),
          rest > 0 ? el('span', { class: 'chip alert' }, `Sin asignar ${eur(rest)}`) : null,
          canEdit && invoice.status !== 'anulada' && rest > 0 ? el('button', { class: 'linkbtn', type: 'button', onclick: () => void openAllocation(ctx, mirror, invoice, l) }, icon('plus', 16), 'Asignar a…') : null,
        ),
      );
    }),
  );

  // --- Pago y fiscal -------------------------------------------------------
  const category = select('invCategory', [['', 'Sin categoría'], ...CATEGORIES.map((c) => [c, CATEGORY_LABELS[c]] as [string, string])], invoice.expense_category, { disabled: !editable, onchange: () => void update({ expense_category: category.value || null }) });
  const investment = el('input', { type: 'checkbox', id: 'invInvestment', checked: invoice.is_investment, disabled: !editable, onchange: () => void update({ is_investment: investment.checked }) });
  const deductibility = select('invDeductibility', DEDUCTIBILITIES.map((d) => [d, DEDUCTIBILITY_LABELS[d] ?? d] as [string, string]), invoice.deductibility, { disabled: !canEdit || invoice.status === 'anulada', onchange: () => void update({ deductibility: deductibility.value as Deductibility }) });
  const dueDate = el('input', { type: 'date', id: 'invDue', value: invoice.due_date ?? '', disabled: !editable, onchange: () => void update({ due_date: dueDate.value || null }) });
  const sourceTotal = el('input', { type: 'text', inputmode: 'decimal', id: 'invSourceTotal', value: invoice.source_total === null ? '' : String(Number(invoice.source_total)).replace('.', ','), disabled: !editable, placeholder: 'Total impreso en la factura',
    onchange: () => { const v = parseAmount(sourceTotal.value); if (sourceTotal.value.trim() && v === null) { toast('Importe inválido.'); return; } void update({ source_total: v }); } });
  const notes = el('textarea', { id: 'invNotes', rows: '2', disabled: !canEdit }); notes.value = invoice.notes ?? '';
  notes.addEventListener('change', () => void update({ notes: notes.value.trim() || null }));
  const fiscalBlock = block('Fiscal y pago', `${categoryLabel(invoice.expense_category)}${invoice.is_investment ? ' · inversión' : ''}`, false,
    el('div', { class: 'row2' }, field('Categoría de gasto', category), field('Deducibilidad', deductibility)),
    el('label', { class: 'check' }, investment, el('span', null, 'Es inversión (no gasto de explotación)')),
    el('div', { class: 'row2' }, field('Total del documento', sourceTotal, 'Lo que imprime la factura; se compara con el total calculado (tolerancia 0,02 €).'), field('Vencimiento', dueDate)),
    field('Notas', notes),
  );

  // --- Importación ---------------------------------------------------------
  const meta = invoice.import_meta as Record<string, unknown> | null;
  const importBlock = meta ? block('Importación', `confianza ${typeof meta.overall_confidence === 'number' ? Math.round(meta.overall_confidence * 100) + ' %' : '—'}`, false,
    meta.extraction_notes ? el('p', null, String(meta.extraction_notes)) : null,
    Array.isArray(meta.warnings) && meta.warnings.length ? el('div', { class: 'chips' }, ...(meta.warnings as string[]).map((w) => el('span', { class: 'chip alert' }, w))) : el('p', { class: 'hint' }, 'Sin avisos de extracción.'),
  ) : null;

  return el('div', { class: 'inv' }, header, totals, documentBlock, linesBlock, taxBlock, allocBlock, fiscalBlock, importBlock);
}

/** Periodo fiscal derivado en el cliente para filas optimistas (el servidor lo genera al confirmar). */
function periodOf(isoDate: string): string {
  const year = isoDate.slice(0, 4); const month = Number(isoDate.slice(5, 7)) || 1;
  return `${year}T${Math.ceil(month / 3)}`;
}

function block(title: string, summary: string, open: boolean, ...children: Array<HTMLElement | null>): HTMLElement {
  return el('details', { class: 'inv-block', open }, el('summary', null, el('span', null, title), el('span', { class: 'hint' }, summary)), ...children);
}

function unallocated(line: LocalInvoiceLine, mirror: Mirror): number {
  const assigned = sumCents((mirror.allocationsByLine.get(line.id) ?? []).map((a) => Number(a.allocated_amount)));
  return fromCents(Math.max(0, toCents(Number(line.net_amount)) - assigned));
}

function allocationLabel(a: LocalAllocation): string {
  if (a.target_app === 'general') return GENERAL_KIND_LABELS[a.target_kind] ?? a.target_kind;
  return a.target_label;
}

// ---------------------------------------------------------------------------
// Formularios de artículo e impuesto
// ---------------------------------------------------------------------------
function renderLineForm(client: SyncClient, invoice: LocalInvoice, line: LocalInvoiceLine | null, count: number): HTMLElement {
  const description = el('input', { type: 'text', id: 'lineDescription', required: true, maxlength: '500', value: line?.description ?? '' });
  const quantity = el('input', { type: 'text', inputmode: 'decimal', id: 'lineQuantity', value: line?.quantity === null || line?.quantity === undefined ? '' : String(Number(line.quantity)) });
  const unit = el('input', { type: 'text', id: 'lineUnit', maxlength: '16', value: line?.unit ?? '' });
  const unitPrice = el('input', { type: 'text', inputmode: 'decimal', id: 'lineUnitPrice', value: line?.unit_price === null || line?.unit_price === undefined ? '' : String(Number(line.unit_price)) });
  const net = el('input', { type: 'text', inputmode: 'decimal', id: 'lineNet', required: true, value: line ? String(Number(line.net_amount)) : '' });
  const vatRate = select('lineVat', [['', 'Sin IVA'], ['0', '0 %'], ['4', '4 %'], ['10', '10 %'], ['21', '21 %']], line?.vat_rate === null || line?.vat_rate === undefined ? '' : String(Number(line.vat_rate)));
  const itemType = select('lineType', [['', 'Tipo de artículo'], ...ITEM_TYPES.map((t) => [t, ITEM_TYPE_LABELS[t] ?? t] as [string, string])], line?.item_type);
  const error = el('p', { class: 'formerror', role: 'alert' });
  const autoNet = () => { const q = parseAmount(quantity.value); const p = parseAmount(unitPrice.value); if (q !== null && p !== null && !net.value.trim()) net.value = String(Math.round(q * p * 100) / 100); };
  quantity.addEventListener('input', autoNet); unitPrice.addEventListener('input', autoNet);
  const host = el('form', { class: 'inv-form', novalidate: true, onsubmit: async (e: Event) => {
    e.preventDefault();
    error.textContent = '';
    const netValue = parseAmount(net.value);
    if (!description.value.trim()) { error.textContent = 'La descripción es obligatoria.'; return; }
    if (netValue === null) { error.textContent = 'La base de la línea es obligatoria.'; return; }
    const rate = vatRate.value === '' ? null : Number(vatRate.value);
    const fields: Record<string, unknown> = {
      description: description.value.trim(), quantity: parseAmount(quantity.value), unit: unit.value.trim() || null, unit_price: parseAmount(unitPrice.value), net_amount: netValue,
      vat_rate: rate, vat_amount: rate === null ? null : Math.round(netValue * rate) / 100, gross_amount: rate === null ? null : Math.round(netValue * (100 + rate)) / 100, item_type: itemType.value || null,
    };
    const ops: RowOperation[] = line
      ? [{ op: 'update', table: INVOICE_LINES, id: line.id, expectedRevision: line.revision, fields: changed(fields, line) }]
      : [{ op: 'insert', table: INVOICE_LINES, id: crypto.randomUUID(), fields: { ...fields, invoice_id: invoice.id, position: count, discount_amount: 0 } }];
    if (await commitSafely(client, ops, line ? 'Artículo guardado.' : 'Artículo añadido.')) replace(host);
  } },
    el('div', { class: 'row2' }, field('Descripción', description), field('Tipo', itemType)),
    el('div', { class: 'row2' }, field('Cantidad', quantity), field('Unidad', unit), field('Precio unitario', unitPrice)),
    el('div', { class: 'row2' }, field('Base (sin IVA)', net), field('IVA', vatRate)),
    error,
    el('div', { class: 'btnrow' },
      el('button', { class: 'primary', type: 'submit', id: 'saveLine' }, line ? 'Guardar artículo' : 'Añadir artículo'),
      el('button', { class: 'ghost', type: 'button', onclick: () => replace(host) }, 'Cancelar'),
      line && (invoice.status === 'pendiente_datos' || invoice.status === 'pendiente_revision') ? el('button', { class: 'danger', type: 'button', onclick: async () => { if (await commitSafely(client, [{ op: 'delete', table: INVOICE_LINES, id: line.id, expectedRevision: line.revision }], 'Artículo quitado.')) replace(host); } }, 'Quitar') : null,
    ),
  );
  return host;
}

function renderTaxForm(client: SyncClient, invoice: LocalInvoice, tax: LocalTaxLine | null, count: number): HTMLElement {
  const type = select('taxType', TAX_TYPES.map((t) => [t, TAX_TYPE_LABELS[t] ?? t] as [string, string]), tax?.tax_type ?? 'iva');
  const rate = el('input', { type: 'text', inputmode: 'decimal', id: 'taxRate', value: tax?.rate === null || tax?.rate === undefined ? '' : String(Number(tax.rate)) });
  const base = el('input', { type: 'text', inputmode: 'decimal', id: 'taxBase', value: tax?.taxable_base === null || tax?.taxable_base === undefined ? '' : String(Number(tax.taxable_base)) });
  const amount = el('input', { type: 'text', inputmode: 'decimal', id: 'taxAmount', required: true, value: tax ? String(Number(tax.amount)) : '' });
  const error = el('p', { class: 'formerror', role: 'alert' });
  const auto = () => { const b = parseAmount(base.value); const r = parseAmount(rate.value); if (b !== null && r !== null && !amount.value.trim()) amount.value = String(Math.round(b * r) / 100); };
  base.addEventListener('input', auto); rate.addEventListener('input', auto);
  const host = el('form', { class: 'inv-form', novalidate: true, onsubmit: async (e: Event) => {
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
      el('button', { class: 'primary', type: 'submit', id: 'saveTax' }, tax ? 'Guardar impuesto' : 'Añadir impuesto'),
      el('button', { class: 'ghost', type: 'button', onclick: () => replace(host) }, 'Cancelar'),
      tax && (invoice.status === 'pendiente_datos' || invoice.status === 'pendiente_revision') ? el('button', { class: 'danger', type: 'button', onclick: async () => { if (await commitSafely(client, [{ op: 'delete', table: TAX_LINES, id: tax.id, expectedRevision: tax.revision }], 'Impuesto quitado.')) replace(host); } }, 'Quitar') : null,
    ),
  );
  return host;
}

// ---------------------------------------------------------------------------
// Nueva factura (subir documento) · API.md §6.1 paso 1
// ---------------------------------------------------------------------------
export function openNewInvoice(ctx: ViewContext, mirror: Mirror): void {
  const { client } = ctx;
  const suppliers = supplierOptions(mirror.suppliers);
  const supplier = select('newSupplier', [['', 'Elige proveedor'], ...suppliers], null);
  const date = el('input', { type: 'date', id: 'newDate', value: todayIso(), required: true });
  const object = el('input', { type: 'text', id: 'newObject', required: true, maxlength: '120', placeholder: 'alimentos retiro yoga' });
  const number = el('input', { type: 'text', id: 'newNumber', maxlength: '64', placeholder: 'Opcional' });
  const total = el('input', { type: 'text', inputmode: 'decimal', id: 'newTotal', placeholder: 'Opcional, con IVA' });
  const files = el('input', { type: 'file', id: 'newFiles', accept: ACCEPT_ATTR, multiple: true });
  const error = el('p', { class: 'formerror', role: 'alert' });
  const save = el('button', { class: 'primary', type: 'submit', id: 'saveInvoice', form: 'newInvoiceForm' }, 'Crear factura');
  const form = el('form', { id: 'newInvoiceForm', novalidate: true, oninput: () => { guard.dirtyEditor = true; }, onsubmit: async (e: Event) => {
    e.preventDefault();
    error.textContent = '';
    if (!supplier.value) { error.textContent = 'Elige el proveedor (o créalo antes en Proveedores).'; supplier.focus(); return; }
    if (!date.value) { error.textContent = 'Indica la fecha de la factura.'; date.focus(); return; }
    if (!object.value.trim()) { error.textContent = 'Indica el objeto (qué se compró).'; object.focus(); return; }
    const sourceTotal = total.value.trim() ? parseAmount(total.value) : null;
    if (total.value.trim() && sourceTotal === null) { error.textContent = 'Total inválido.'; total.focus(); return; }
    save.disabled = true;
    try {
      const staged = await pickFiles(files, client);
      const invoiceId = crypto.randomUUID();
      const chosen = mirror.supplierById.get(supplier.value);
      const ops: RowOperation[] = [
        { op: 'insert', table: INVOICES, id: invoiceId, fields: { supplier_id: supplier.value, invoice_date: date.value, object: object.value.trim(), invoice_number: number.value.trim() || null, source_total: sourceTotal, expense_category: chosen?.default_category ?? null, is_investment: chosen?.default_is_investment ?? false } },
        ...staged.map((s, i): RowOperation => ({ op: 'insert', table: INVOICE_FILES, id: crypto.randomUUID(), fields: { invoice_id: invoiceId, file_id: s.marker, original_filename: s.filename, page_order: i + 1, kind: 'original', mime_type: s.mime, size_bytes: s.size, sha256: s.sha256 } })),
      ];
      if (await commitSafely(client, ops, 'Factura creada en este dispositivo.')) {
        guard.dirtyEditor = false;
        await closeSheet(true);
        void openInvoice(ctx, invoiceId);
      }
    } catch (err) { error.textContent = describeError(err); }
    save.disabled = false;
  } },
    field('Proveedor', supplier, suppliers.length ? undefined : 'Primero da de alta el proveedor en Inicio › Proveedores.'),
    el('div', { class: 'row2' }, field('Fecha', date), field('Número de factura', number)),
    field('Objeto', object, 'Qué se compró, en pocas palabras. Forma parte del nombre del archivo.'),
    field('Total del documento', total),
    field('PDF o fotos', files, 'Las fotos se reducen en el móvil antes de subirse. Puedes añadir más páginas después.'),
    el('p', { class: 'hint' }, 'Vista previa del nombre: ', el('code', { id: 'namePreview' }, '…')),
    error,
  );
  const preview = () => {
    const chosen = mirror.supplierById.get(supplier.value);
    form.querySelector('#namePreview')!.textContent = normalizedFilename({ invoiceDate: date.value || todayIso(), supplierSlug: chosen?.slug ?? slugify(chosen?.name ?? ''), object: object.value, mime: 'application/pdf' });
  };
  form.addEventListener('input', preview);
  preview();
  openSheet({
    title: 'Nueva factura',
    body: el('div', null,
      el('div', { class: 'btnrow', style: 'margin-bottom:12px' }, el('button', { class: 'softbtn', type: 'button', id: 'importNew', onclick: () => void openImport(ctx, mirror, null) }, icon('upload', 18), 'Importar JSON de ChatGPT')),
      form),
    foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void closeSheet() }, 'Cancelar'), save],
    initialFocus: supplier,
    beforeClose: async () => !guard.dirtyEditor || confirmDialog({ title: 'Hay cambios sin guardar', text: '¿Descartarlos?', confirmLabel: 'Descartar', danger: true }),
    onClose: () => { guard.dirtyEditor = false; },
  });
}

// ---------------------------------------------------------------------------
// Importar JSON ikisai.invoice.v1 · API.md §6.1 pasos 3-4
// ---------------------------------------------------------------------------
export function openImport(ctx: ViewContext, mirror: Mirror, target: LocalInvoice | null, prefill?: { document: ImportDocument; warnings: string[] }): void {
  const { client } = ctx;
  let document: ImportDocument | null = null;
  let errors: SchemaError[] = [];
  const textarea = el('textarea', { id: 'importJson', rows: '6', placeholder: 'Pega aquí el JSON que devolvió ChatGPT…', spellcheck: 'false' });
  const jsonFile = el('input', { type: 'file', accept: 'application/json,.json', id: 'importFile' });
  const docs = el('input', { type: 'file', accept: ACCEPT_ATTR, multiple: true, id: 'importDocs' });
  const preview = el('div', { id: 'importPreview' });
  const error = el('p', { class: 'formerror', role: 'alert' });
  const confirm = el('button', { class: 'primary', type: 'button', id: 'confirmImport', disabled: true, onclick: () => void submit() }, 'Importar');

  // Controles de la vista previa (se recrean con cada documento válido)
  let supplierSelect: HTMLSelectElement | null = null;
  let objectInput: HTMLInputElement | null = null;
  let dateInput: HTMLInputElement | null = null;
  let categorySelect: HTMLSelectElement | null = null;
  let investmentInput: HTMLInputElement | null = null;
  let deductibilitySelect: HTMLSelectElement | null = null;

  function parse(text: string): void {
    const result = parseImportDocument(text);
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
    ], chosenDefault?.id ?? '__new__');
    const supplierFor = () => (supplierSelect && supplierSelect.value !== '__new__' ? mirror.supplierById.get(supplierSelect.value) ?? null : null);
    const proposal = () => proposeImport(doc, supplierFor(), {
      object: objectInput?.value || null, invoice_date: dateInput?.value || null,
      expense_category: (categorySelect?.value || null) as never, is_investment: investmentInput ? investmentInput.checked : null, deductibility: (deductibilitySelect?.value || null) as Deductibility | null,
    });
    const first = proposeImport(doc, supplierFor());
    objectInput = el('input', { type: 'text', id: 'importObject', value: target?.object ?? first.object, maxlength: '120' });
    dateInput = el('input', { type: 'date', id: 'importDate', value: target?.invoice_date ?? first.invoice_date });
    categorySelect = select('importCategory', [['', 'Sin categoría'], ...CATEGORIES.map((c) => [c, CATEGORY_LABELS[c]] as [string, string])], target?.expense_category ?? first.expense_category);
    investmentInput = el('input', { type: 'checkbox', id: 'importInvestment', checked: target?.is_investment ?? first.is_investment });
    deductibilitySelect = select('importDeductibility', DEDUCTIBILITIES.map((d) => [d, DEDUCTIBILITY_LABELS[d] ?? d] as [string, string]), first.deductibility);
    const recalc = recalculate(doc.lines.map((l) => ({ quantity: l.quantity ?? null, unit_price: l.unit_price ?? null, discount_amount: l.discount_amount ?? 0, net_amount: l.net_amount, vat_rate: l.vat_rate ?? null, vat_amount: l.vat_amount ?? null })), doc.taxes.map((t) => ({ tax_type: t.tax_type, rate: t.rate ?? null, taxable_base: t.taxable_base ?? null, amount: t.amount })), doc.document_totals);
    const duplicate = mirror.invoices.find((i) => !i.deleted_at && i.status !== 'anulada' && i.id !== target?.id && supplierFor() && i.supplier_id === supplierFor()!.id && doc.invoice.invoice_number && (i.invoice_number ?? '').toLowerCase() === doc.invoice.invoice_number.toLowerCase());
    const row = (label: string, calc: number, declared: number) => el('tr', { class: Math.abs(toCents(calc) - toCents(declared)) > 2 ? 'bad' : '' }, el('td', null, label), el('td', { class: 'num' }, eur(calc)), el('td', { class: 'num' }, eur(declared)), el('td', { class: 'num' }, eur(fromCents(toCents(declared) - toCents(calc)))));
    supplierSelect.addEventListener('change', () => { const p = proposal(); if (categorySelect && !categorySelect.value && p.expense_category) categorySelect.value = p.expense_category; });
    replace(preview,
      duplicate ? el('div', { class: 'banner warn' }, icon('warn', 18), el('span', null, `Ya existe la factura ${duplicate.code ?? ''} de este proveedor con el número ${doc.invoice.invoice_number}. La importación será rechazada como duplicado.`)) : null,
      el('div', { class: 'row2' }, field('Proveedor', supplierSelect, doc.invoice.supplier_tax_id ? `NIF del documento: ${doc.invoice.supplier_tax_id}` : 'El documento no trae NIF.'), field('Fecha', dateInput)),
      field('Objeto', objectInput),
      el('div', { class: 'row2' }, field('Categoría', categorySelect), field('Deducibilidad', deductibilitySelect)),
      el('label', { class: 'check' }, investmentInput, el('span', null, 'Es inversión')),
      el('h3', null, `Cuadre · ${doc.lines.length} artículo${doc.lines.length === 1 ? '' : 's'} · ${recalc.taxes.length} impuesto${recalc.taxes.length === 1 ? '' : 's'}${recalc.taxes_derived ? ' (derivados de las líneas)' : ''}`),
      el('table', { class: 'inv-table cuadre-table' },
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
      target ? null : field('PDF o fotos del documento', docs, 'Opcional: puedes adjuntarlos ahora o después.'),
    );
  }

  async function submit(): Promise<void> {
    if (!document || !supplierSelect) return;
    error.textContent = '';
    confirm.disabled = true;
    try {
      const staged = target ? [] : await pickFiles(docs, client);
      const sha = await importDocumentSha256(document);
      const existingSupplier = supplierSelect.value !== '__new__' ? mirror.supplierById.get(supplierSelect.value) ?? null : null;
      const invoiceId = target?.id ?? crypto.randomUUID();
      // Operaciones de fila (no `call`): la factura aparece en el espejo al momento y la importación funciona sin red (API.md §10).
      const { operations } = importOperations({
        document, documentSha256: sha, invoiceId, existing: target ? { revision: target.revision } : null,
        supplier: existingSupplier ? { mode: 'existing', row: existingSupplier } : { mode: 'create', id: crypto.randomUUID() },
        overrides: { object: objectInput?.value.trim() || null, invoice_date: dateInput?.value || null, expense_category: (categorySelect?.value || null) as never, is_investment: investmentInput?.checked ?? null, deductibility: (deductibilitySelect?.value || null) as Deductibility | null },
        files: staged.map((s, i) => ({ file_id: s.marker, original_filename: s.filename, page_order: i + 1, mime_type: s.mime, size_bytes: s.size, sha256: s.sha256 })),
      });
      if (await commitSafely(client, operations as RowOperation[], 'Factura importada en este dispositivo. Queda pendiente de revisión.')) {
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
  const extractionNote = prefill ? el('div', { class: 'banner info', id: 'extractionNote' }, icon('info', 18), el('div', null, el('strong', null, 'Extraído automáticamente del documento. '), 'Revisa el cuadre antes de importar.', prefill.warnings.length ? el('ul', { class: 'hint' }, ...prefill.warnings.map((w) => el('li', null, w))) : null)) : null;
  openSheet({
    title: target ? `Importar JSON en ${target.code ?? 'la factura'}` : 'Importar JSON de ChatGPT',
    meta: 'Formato ikisai.invoice.v1. La app recalcula y compara con el total del documento; nada se valida en silencio.',
    body: el('div', null, queueNote, extractionNote, promptPanel(), field('JSON', textarea), field('…o cargar archivo .json', jsonFile), preview, error),
    foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void closeSheet() }, 'Cancelar'), confirm],
    initialFocus: prefill ? confirm : textarea,
    beforeClose: async () => !guard.dirtyEditor || confirmDialog({ title: 'Hay una importación sin terminar', text: '¿Descartarla?', confirmLabel: 'Descartar', danger: true }),
    onClose: () => { guard.dirtyEditor = false; if (extractionQueue.ids.length) void extractNext(ctx); },
  });
  if (prefill) {
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
    const result = await extractDocument(client, files.map((f) => f.file_id));
    await closeSheet(true);
    openImport(ctx, mirror, invoice, { document: result.document, warnings: result.warnings });
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === 'EXTRACTION_UNAVAILABLE') {
      toast(describeError(error));
      await closeSheet(true);
      openImport(ctx, mirror, invoice);
    } else {
      toast(describeError(error));
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

/** Prompt de extracción para ChatGPT, copiable desde la app (handoff 05_PROMPT_EXTRACCION_FACTURA.md). */
function promptPanel(): HTMLElement {
  const copy = el('button', { class: 'softbtn small', type: 'button', id: 'copyPrompt', onclick: async () => {
    try {
      await navigator.clipboard.writeText(EXTRACTION_PROMPT);
      toast('Prompt copiado. Pégalo en ChatGPT junto con el PDF o las fotos de la factura.');
    } catch {
      promptText.hidden = false;
      promptText.focus();
      promptText.select();
      toast('Selecciona el texto y cópialo.');
    }
  } }, icon('attach', 16), 'Copiar el prompt para ChatGPT');
  const promptText = el('textarea', { class: 'prompt-text', readonly: true, rows: '8', hidden: true, 'aria-label': 'Prompt de extracción' });
  promptText.value = EXTRACTION_PROMPT;
  return el('details', { class: 'inv-block prompt-block' },
    el('summary', null, el('span', null, '¿Cómo obtengo el JSON?'), el('span', { class: 'hint' }, 'ChatGPT + prompt')),
    el('ol', { class: 'steps' },
      el('li', null, 'Abre ChatGPT y adjunta el PDF o las fotos de la factura.'),
      el('li', null, 'Pega el prompt (botón de abajo). ChatGPT devuelve un JSON en formato ikisai.invoice.v1.'),
      el('li', null, 'Copia ese JSON y pégalo en el cuadro de aquí abajo. La app recalcula y compara con el total del documento.'),
    ),
    el('div', { class: 'btnrow' }, copy, el('button', { class: 'linkbtn', type: 'button', onclick: () => { promptText.hidden = !promptText.hidden; } }, 'Ver el texto')),
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
    ...[['general', 'General'], ['tasks', 'Tareas'], ['food', 'Cocina'], ['booking', 'Reservas']].map(([value, label]) => el('button', { type: 'button', class: value === app ? 'on' : '', dataset: { app: value! }, onclick: () => { app = value!; choice = null; paintApp(); } }, label)),
  );
  const kindSelect = select('allocKind', kindsFor('general').map((k) => [k, KIND_LABELS[k] ?? k] as [string, string]), 'operating_expense');
  const searchInput = el('input', { type: 'search', id: 'targetSearch', placeholder: 'Buscar destino…', autocomplete: 'off' });
  const results = el('div', { id: 'targetResults' });
  const chosen = el('p', { class: 'hint', id: 'chosenTarget' });
  const amount = el('input', { type: 'text', inputmode: 'decimal', id: 'allocAmount', value: String(rest).replace('.', ',') });
  const quantity = el('input', { type: 'text', inputmode: 'decimal', id: 'allocQuantity', placeholder: line.quantity === null ? 'Sin cantidad' : `de ${Number(line.quantity)} ${line.unit ?? ''}` });
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
    replace(results, items.length ? el('div', null, el('div', { class: 'sectionlabel' }, title), renderList({ label: title, rows: items.map((t) => ({
      id: `${t.app}:${t.kind}:${t.id}`, title: t.label, meta: [KIND_LABELS[t.kind] ?? t.kind, ...(t.path?.length ? [t.path.join(' › ')] : []), ...(t.archived ? ['archivado'] : [])], selected: choice?.id === t.id && choice?.kind === t.kind,
      onClick: () => { choice = t; chosen.textContent = `Destino: ${targetLabel(t)}`; paintResults(items, title); }, label: `Elegir ${t.label}`,
    })) })) : el('p', { class: 'hint' }, 'Sin resultados.'));
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

  const save = el('button', { class: 'primary', type: 'button', id: 'saveAllocation', onclick: async () => {
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
    const ok = await commitSafely(client, [{ op: 'insert', table: ALLOCATIONS, id: crypto.randomUUID(), fields: { ...fields, invoice_line_id: line.id, allocated_amount: a, allocated_quantity: q } }], 'Asignación guardada.');
    if (ok) { await closeSheet(true); void openInvoice(ctx, invoice.id); }
  } }, 'Asignar');

  openSheet({
    title: `Asignar «${line.description}»`,
    meta: `${eur(rest)} sin asignar de ${eur(line.net_amount)}`,
    body: el('div', null, appButtons, appArea, el('div', { class: 'row2' }, field('Importe (base, sin IVA)', amount), field('Cantidad', quantity)), error),
    foot: [el('button', { class: 'ghost', type: 'button', onclick: async () => { await closeSheet(true); void openInvoice(ctx, invoice.id); } }, 'Volver'), save],
    initialFocus: amount,
  });
  paintApp();
}

export { SUPPLIERS };
