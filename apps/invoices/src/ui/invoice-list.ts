/**
 * Facturas (API.md §9.2) · la lista: pestañas Recibidas · Emitidas, buscador, filtros y enlaces (`?filtro=`,
 * `?compartido=`, `#/facturas/<id|código>`). La ficha y sus hojas viven en `invoices.ts`.
 */
import { closeSheet, el, icon, renderList, replace, toast, type ListRowSpec } from '@ikisai/ui-kit';
import { periodOfDate } from '@ikisai/domain-invoices';
import type { LocalInvoice } from '../app/client.ts';
import { eur, loadMirror, monthKey, monthLabel, onAnyTable, shortDate, statusChipClass, statusText, type Mirror } from '../app/data.ts';
import { extractionQueue } from '../app/extract.ts';
import { takeSharedDocuments, takeSharedText } from '../app/ai-share.ts';
import { fbRows } from './feedback.ts';
import { select } from './common.ts';
import { openBatchUpload } from './batch.ts';
import { renderIssuedPanel } from './issued.ts';
import type { ViewMount } from './shell.ts';
import { extractNext, invoiceTitle, isLate, onOpen, openImport, openInvoice, openNewInvoice, quarterName, refreshOpenInvoice } from './invoices.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pestañas Recibidas · Emitidas: ids literales para el catálogo de «Uso». */
const INVOICE_TAB_MARKS: Record<string, Record<string, string>> = {
  recibidas: { 'data-feedback-id': 'invoices.facturas.pestanas.recibidas', 'data-feedback-label': 'Recibidas' },
  emitidas: { 'data-feedback-id': 'invoices.facturas.pestanas.emitidas', 'data-feedback-label': 'Emitidas' },
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
    const hay = [supplier?.name ?? '', supplier?.label ?? '', invoice.object, invoice.invoice_number ?? '', invoice.code ?? ''].join(' ').toLowerCase();
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
    if (invoice.payment_status === 'pagada') chips.push(invoice.payment_source === 'sin_confirmar' ? el('span', { class: 'chip' }, 'Pagada (sin confirmar)') : el('span', { class: 'chip ok' }, 'Pagada'));
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
