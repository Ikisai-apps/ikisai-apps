/**
 * Facturas (API.md §9.2) · la lista: pestañas Recibidas · Emitidas, buscador, buzones y enlaces (`?filtro=`,
 * `?compartido=`, `#/facturas/<id|código>`). La ficha y sus hojas viven en `invoices.ts`.
 * Tanda 27 (MUELA-036 y 070):
 * - buzones con su número e importe: Por resolver (al abrir, con «Sin datos» y «Por revisar») · Sin pagar · Validadas ·
 *   Todas · Más (Drive, rectificativas sin enlazar, sin documento, archivadas, anuladas); los `?filtro=` llevan a su buzón;
 * - grupos por proveedor, primero lo que pide algo; dentro, por fecha y con la fecha a la vista;
 * - en cada factura, el recorrido mini con su frase, las dos etiquetas más graves y «+n», y «Confirmar pago» con «Deshacer»;
 * - se ven 8 proveedores y 3 facturas de cada uno; la búsqueda mira todas.
 */
import { closeSheet, el, icon, listRow, renderGroups, renderStages, replace, toast } from '@ikisai/ui-kit';
import { INVOICES, type LocalInvoice } from '../app/client.ts';
import { eur, loadMirror, onAnyTable, shortDate, supplierName, todayIso, type Mirror } from '../app/data.ts';
import { extractionQueue } from '../app/extract.ts';
import { takeSharedDocuments, takeSharedText } from '../app/ai-share.ts';
import { INVOICE_STAGES, MAILBOXES, MORE_MAILBOXES, RESOLVE_PILLS, groupSummary, inMailbox, mailboxFromFilter, supplierGroups, type Mailbox, type ResolvePill } from '../app/work-state.ts';
import { mirrorRows, type MirrorRow } from '../app/work-mirror.ts';
import { openBatchUpload } from './batch.ts';
import { renderIssuedPanel } from './issued.ts';
import type { ViewMount } from './shell.ts';
import { commitWithUndo } from './undo.ts';
import { chipsWithMore } from './chips.ts';
import { openPaySheet } from './pay-sheet.ts';
import { extractNext, onOpen, openImport, openInvoice, openNewInvoice, refreshOpenInvoice } from './invoices.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Tandas: proveedores a la vista y facturas de cada uno antes de «Ver más». */
const GROUPS_STEP = 8;
const ROWS_STEP = 3;

/** Pestañas Recibidas · Emitidas: ids literales para el catálogo de «Uso». */
const INVOICE_TAB_MARKS: Record<string, Record<string, string>> = {
  recibidas: { 'data-feedback-id': 'invoices.facturas.pestanas.recibidas', 'data-feedback-label': 'Recibidas' },
  emitidas: { 'data-feedback-id': 'invoices.facturas.pestanas.emitidas', 'data-feedback-label': 'Emitidas' },
};

const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);

export const mountInvoices: ViewMount = (ctx) => {
  const { main, client } = ctx;
  let mirror: Mirror | null = null;
  let query = '';
  let box: Mailbox = 'por_resolver';
  let pill: ResolvePill | null = null;
  let moreOpen = false;
  let shownGroups = GROUPS_STEP;
  const expanded = new Set<string>();
  let opened: string | null = null;

  const search = el('input', { 'data-feedback-id': 'invoices.facturas.buscar', 'data-feedback-label': 'Buscar facturas', type: 'search', id: 'invoiceSearch', placeholder: 'Proveedor, objeto, número o código', 'aria-label': 'Buscar facturas', autocomplete: 'off',
    oninput: () => { query = search.value.trim().toLowerCase(); paint(); } });
  // Buzones (mismo id que el desplegable de antes): cada uno con su número y su importe; «Más» abre los demás.
  const boxes = el('div', { 'data-feedback-id': 'invoices.facturas.filtro', 'data-feedback-label': 'Buzones', class: 'inv-boxes', role: 'group', 'aria-label': 'Buzones de facturas', id: 'invoiceFilter' });
  const pills = el('div', { 'data-feedback-id': 'invoices.facturas.filtro.por_resolver', 'data-feedback-label': 'Sin datos o por revisar', class: 'inv-boxes inv-pills', role: 'group', 'aria-label': 'Por resolver', id: 'resolvePills' });
  const summary = el('p', { class: 'hint inv-summary', id: 'invoiceSummary', 'aria-live': 'polite', 'data-feedback-ignore': '' });
  const listHost = el('div', { 'data-feedback-id': 'invoices.facturas.lista', 'data-feedback-label': 'Facturas recibidas', id: 'invoiceList' });
  const canEdit = client.bootstrap()?.membership.role !== 'reader';
  // El lector no tiene en el DOM los botones de escribir, ni ocultos (tanda 30, MUELA-080)
  const newButton = !canEdit ? null : el('button', { 'data-feedback-id': 'invoices.facturas.nueva', 'data-feedback-label': 'Nueva factura', class: 'fab', type: 'button', id: 'newInvoice', onclick: () => openNewInvoice(ctx, mirror!) }, icon('plus'), 'Nueva factura');
  const extractAll = !canEdit ? null : el('button', { 'data-feedback-id': 'invoices.facturas.extraer_pendientes', 'data-feedback-label': 'Extraer pendientes', class: 'softbtn small', type: 'button', id: 'extractPending', hidden: true, onclick: () => void extractPending() }, icon('upload', 16), 'Extraer pendientes');
  // Pestañas «Recibidas · Emitidas» (API.md §13.5): las emitidas registradas viven en su propio panel.
  const received = el('div', { id: 'receivedPanel' },
    el('div', { class: 'toolbar' }, el('div', { class: 'search' }, search)),
    boxes, pills,
    el('div', { class: 'toolbar', id: 'invoiceTools' }, canEdit ? el('button', { 'data-feedback-id': 'invoices.facturas.subir_varias', 'data-feedback-label': 'Subir varias', class: 'softbtn small', type: 'button', id: 'batchUpload', onclick: () => openBatchUpload(ctx, () => loadMirror(client), () => void load()) }, icon('upload', 16), 'Subir varias') : null, extractAll),
    summary,
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

  /** Las del buzón; con búsqueda, todas menos las anuladas (o solo ellas, en «Anuladas»). */
  function inView(row: MirrorRow): boolean {
    if (query) {
      const supplier = mirror!.supplierById.get(row.invoice.supplier_id);
      const hay = [supplier?.name ?? '', supplier?.label ?? '', row.invoice.object, row.invoice.invoice_number ?? '', row.invoice.code ?? ''].join(' ').toLowerCase();
      if (!hay.includes(query)) return false;
      return box === 'anulada' ? row.invoice.status === 'anulada' : row.invoice.status !== 'anulada';
    }
    return inMailbox(box, row.invoice, row.facts.hasOriginal, pill);
  }

  function setBox(next: Mailbox, nextPill: ResolvePill | null = null): void {
    box = next; pill = nextPill; shownGroups = GROUPS_STEP; expanded.clear();
    if (MORE_MAILBOXES.some((x) => x.key === next)) moreOpen = true;
    paint();
  }

  function paintBoxes(rows: MirrorRow[]): void {
    const button = (key: Mailbox, label: string) => {
      const list = rows.filter((r) => inMailbox(key, r.invoice, r.facts.hasOriginal));
      const total = list.reduce((sum, r) => sum + cents(r.invoice.calculated_total), 0) / 100;
      return el('button', { type: 'button', class: 'inv-box', dataset: { box: key }, 'aria-pressed': String(box === key && !query), onclick: () => setBox(key) },
        el('span', null, label), el('strong', null, String(list.length)), list.length && key !== 'anulada' ? el('span', { class: 'inv-box-amount' }, eur(total)) : null);
    };
    replace(boxes, ...MAILBOXES.map((x) => button(x.key, x.label)),
      el('button', { type: 'button', class: 'inv-box', id: 'moreBoxes', 'aria-expanded': String(moreOpen), onclick: () => { moreOpen = !moreOpen; paint(); } }, el('span', null, moreOpen ? 'Menos' : 'Más')),
      ...(moreOpen ? MORE_MAILBOXES.map((x) => button(x.key, x.label)) : []));
    pills.hidden = box !== 'por_resolver' || !!query;
    const pillButton = (key: ResolvePill | null, label: string) => {
      const n = rows.filter((r) => inMailbox('por_resolver', r.invoice, r.facts.hasOriginal, key)).length;
      return el('button', { type: 'button', class: 'inv-box small', dataset: { pill: key ?? 'todas' }, 'aria-pressed': String(pill === key), onclick: () => setBox('por_resolver', key) }, el('span', null, label), el('strong', null, String(n)));
    };
    replace(pills, pillButton(null, 'Todas'), ...RESOLVE_PILLS.map((x) => pillButton(x.key, x.label)));
  }

  /** «Confirmar pago» de una pagada sin confirmar, en la fila, con «Deshacer». */
  async function confirmFromRow(invoice: LocalInvoice): Promise<void> {
    await commitWithUndo(client, { table: INVOICES, id: invoice.id, revision: invoice.revision, fields: { payment_source: 'confirmado' }, before: { payment_source: invoice.payment_source } },
      `Pago de ${invoice.code ?? 'la factura'} confirmado.`, 'Vuelve a estar sin confirmar.');
  }

  function invoiceRow(row: MirrorRow): HTMLLIElement {
    const m = mirror!;
    const invoice = row.invoice;
    const supplier = supplierName(m.supplierById.get(invoice.supplier_id), 'Proveedor');
    // En la fila, lo que pide el pago: «Confirmar pago» si está sin confirmar; «Marcar pagada» (en su hoja) si está pendiente
    const unpaid = invoice.status !== 'anulada' && invoice.status !== 'pendiente_datos' && invoice.payment_status === 'pendiente';
    const actions = !canEdit ? []
      : row.state.pay.kind === 'unconfirmed'
        ? [el('button', { 'data-feedback-id': 'invoices.facturas.lista.confirmar_pago', 'data-feedback-label': 'Confirmar pago', class: 'softbtn small', type: 'button', onclick: () => void confirmFromRow(invoice) }, icon('check', 16), 'Confirmar pago')]
        : unpaid
          ? [el('button', { 'data-feedback-id': 'invoices.facturas.lista.marcar_pagada', 'data-feedback-label': 'Marcar pagada', class: 'softbtn small', type: 'button', onclick: () => openPaySheet(client, invoice, `${supplier} · ${invoice.object}`) }, icon('euro', 16), 'Marcar pagada')]
          : [];
    const li = listRow({
      id: invoice.id,
      // El proveedor ya está en el grupo: en la fila va oculto a la vista (lectores de pantalla y búsqueda en la página).
      title: el('span', null, el('span', { class: 'vh' }, `${supplier} · `), invoice.object),
      meta: [shortDate(invoice.invoice_date), invoice.code ?? 'código pendiente', eur(invoice.calculated_total)],
      chips: chipsWithMore(row.labels),
      actions,
      pending: invoice._pending === true,
      onClick: () => openInvoice(ctx, invoice.id),
      label: `Abrir ${supplier} · ${invoice.object}`,
    });
    li.setAttribute('data-feedback-id', 'invoices.facturas.lista.fila');
    li.setAttribute('data-feedback-label', 'Factura');
    const stages = renderStages({ label: 'Recorrido de la factura', stages: [...INVOICE_STAGES], current: row.state.stage, bad: row.state.bad, mini: true, caption: row.state.caption, stopText: row.state.caption });
    stages.classList.add('inv-row-stages');
    li.insertBefore(stages, li.querySelector('.row-actions'));
    return li;
  }

  function paint(): void {
    if (!mirror) return;
    const m = mirror;
    const pendingDocs = extractable().length;
    if (extractAll) {
      extractAll.hidden = pendingDocs === 0;
      extractAll.textContent = '';
      extractAll.append(icon('upload', 16), pendingDocs === 1 ? 'Extraer la factura pendiente' : `Extraer ${pendingDocs} pendientes`);
    }
    const all = mirrorRows(m, todayIso());
    paintBoxes(all);
    const visible = all.filter(inView);
    if (!visible.length) {
      summary.textContent = '';
      const none = !m.invoices.some((i) => !i.deleted_at);
      replace(listHost, el('div', { class: 'empty' },
        el('strong', null, none ? 'Todavía no hay facturas' : query ? 'Ninguna factura coincide' : box === 'por_resolver' ? 'Nada por resolver' : 'Ninguna factura en este buzón'),
        none ? (canEdit ? 'Sube el documento con «Nueva factura» o importa el JSON de ChatGPT. Funciona también sin conexión.' : 'Cuando el equipo suba facturas, las verás aquí.') : 'Cambia de buzón o la búsqueda.',
        !none && !query && box !== 'todas' ? el('p', null, el('button', { type: 'button', class: 'ghost small', id: 'showAllInvoices', onclick: () => setBox('todas') }, 'Ver todas')) : null));
      return;
    }
    const nameOf = (id: string) => supplierName(m.supplierById.get(id), 'Proveedor');
    const groups = supplierGroups(visible, nameOf);
    const total = visible.reduce((sum, r) => sum + (r.invoice.status === 'anulada' ? 0 : cents(r.invoice.calculated_total)), 0) / 100;
    const unpaid = groups.reduce((sum, g) => sum + cents(g.unpaid), 0) / 100;
    const overdue = groups.reduce((sum, g) => sum + g.overdue, 0);
    summary.textContent = [`${visible.length} factura${visible.length === 1 ? '' : 's'} · ${eur(total)}`, `${groups.length} proveedor${groups.length === 1 ? '' : 'es'}`,
      unpaid > 0 ? `sin pagar ${eur(unpaid)}` : null, overdue ? `${overdue} vencida${overdue === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
    type Item = MirrorRow | { more: string; count: number };
    const view = renderGroups<Item>({
      label: 'Facturas por proveedor', feedbackId: 'invoices.facturas.lista.grupos',
      groups: (query ? groups : groups.slice(0, shownGroups)).map((g) => {
        const full = !!query || expanded.has(g.supplierId);
        const items: Item[] = full ? g.rows : g.rows.slice(0, ROWS_STEP);
        if (!full && g.rows.length > ROWS_STEP) items.push({ more: g.supplierId, count: g.rows.length });
        return { key: g.supplierId, title: nameOf(g.supplierId), medal: { name: nameOf(g.supplierId) }, items, summary: `${groupSummary(g, eur)} · total ${eur(g.total)}`, open: true };
      }),
      toneOf: (item) => ('more' in item || item.state.tone === 'ok' ? null : item.state.tone),
      row: (item) => ('more' in item
        ? el('li', { class: 'inv-group-more' }, el('button', { type: 'button', class: 'linkbtn', onclick: () => { expanded.add(item.more); paint(); } }, `Ver las ${item.count} de ${nameOf(item.more)}`))
        : invoiceRow(item)),
    });
    const moreGroups = !query && groups.length > shownGroups
      ? el('p', { class: 'inv-more-groups' }, el('button', { type: 'button', class: 'ghost', id: 'moreSuppliers', onclick: () => { shownGroups += GROUPS_STEP; paint(); } }, `Ver más proveedores (${groups.length - shownGroups})`))
      : null;
    replace(listHost, view.element, moreGroups);
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
    // Inicio, Gestoría y otras apps: `#/facturas?filtro=pendiente_datos|pendiente_revision|sin_pagar|drive|…`, a su buzón.
    // «Ver sus facturas» desde Proveedores: `#/facturas?proveedor=<id>` busca por su nombre en «Todas»
    const bySupplier = tail.match(/^\?proveedor=([0-9a-f-]{36})/i);
    if (bySupplier && mirror) {
      history.replaceState(null, '', '#/facturas');
      const supplier = mirror.supplierById.get(bySupplier[1]!.toLowerCase());
      if (supplier) { search.value = supplier.label || supplier.name; query = search.value.trim().toLowerCase(); }
      setBox('todas');
      return;
    }
    const wanted = tail.match(/^\?filtro=([a-z_]+)/);
    const target = wanted ? mailboxFromFilter(wanted[1]!) : null;
    if (target) { history.replaceState(null, '', '#/facturas'); setBox(target.box, target.pill); return; }
    if (tail === 'nueva' && mirror) { openNewInvoice(ctx, mirror); history.replaceState(null, '', '#/facturas'); }
    else if (UUID.test(tail.split('?')[0]!)) {
      // Desde Inicio: `?ir=<lo que falta>` abre la ficha en ello (tanda 30)
      const focus = tail.match(/[?&]ir=([a-z_]+)/)?.[1] ?? null;
      void openInvoice(ctx, tail.split('?')[0]!.toLowerCase(), focus);
      history.replaceState(null, '', '#/facturas');
    }
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
