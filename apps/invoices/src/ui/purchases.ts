/**
 * Compras (API.md §6.3, §9.3): las líneas como artículos comprados, por categoría, destino, proveedor o lista; todo calculado en local.
 * Tanda 27 (MUELA-070):
 * - delante, «Por asignar» con su número: lo pendiente por el destino que se propone (`purchase-proposals.ts`), en
 *   baldosas que dicen lo que hará el toque; el toque asigna solo si el destino sigue abierto en la fecha de la factura
 *   (`targetOpenFor`) y, si no, abre la hoja de asignar (ya separada de la ficha); siempre con «Deshacer»; el lote
 *   «Asignar los 2 a Cocina · 115,80 €»; en cada una, «Otro destino» y «Factura»;
 * - el periodo y los filtros, en dos botones con su hoja (mismos controles e ids); el buscador sigue a la vista;
 * - la franja de un enlace de otra app dice de dónde viene.
 */
import { linkedItem, linksEnabled } from '../app/resources.ts';
import { closeSheet, el, fieldAttrs, icon, openSheet, renderGroups as renderWorstGroups, renderList, renderTile, replace, type ListRowSpec } from '@ikisai/ui-kit';
import { fbRows } from './feedback.ts';
import { purchaseItems, type PurchaseFilters, type PurchaseGroup, type PurchaseItemsResult } from '@ikisai/domain-invoices';
import { ALLOCATIONS, categoryLabel, type LocalInvoice, type LocalInvoiceLine } from '../app/client.ts';
import { currentQuarter, eur, loadMirror, onAnyTable, rangeFor, rangeLabel, shortDate, statusChipClass, statusText, type Mirror, type RangeKind } from '../app/data.ts';
import { ITEM_TYPE_LABELS, lineName, supplierName } from '../app/data.ts';
import { openAllocation, openInvoice } from './invoices.ts';
import { FRESHNESS_LABELS, checkTargetFreshness, recentTargets, resolveTarget, targetOpenFor, type TargetChoice } from '../app/targets.ts';
import { batchLabel, lineKeyOf, proposeTarget, targetKeyOf, type PastAllocation, type ProposalTarget } from '../app/purchase-proposals.ts';
import { offerUndoInsert } from './undo.ts';
import { describeError } from '../app/client.ts';
import { toast } from '@ikisai/ui-kit';
import type { ViewMount } from './shell.ts';

type Tab = 'pending' | 'category' | 'target' | 'supplier' | 'items';

/** Pestañas de la vista: ids literales para el catálogo de «Uso». */
const TAB_MARKS: Record<string, Record<string, string>> = {
  pending: { 'data-feedback-id': 'invoices.compras.vista.por_asignar', 'data-feedback-label': 'Por asignar' },
  category: { 'data-feedback-id': 'invoices.compras.vista.categoria', 'data-feedback-label': 'Categoría' },
  target: { 'data-feedback-id': 'invoices.compras.vista.destino', 'data-feedback-label': 'Destino' },
  supplier: { 'data-feedback-id': 'invoices.compras.vista.proveedor', 'data-feedback-label': 'Proveedor' },
  items: { 'data-feedback-id': 'invoices.compras.vista.articulos', 'data-feedback-label': 'Artículos' },
};

export const mountPurchases: ViewMount = (ctx) => {
  const { main, client } = ctx;
  let mirror: Mirror | null = null;
  let range = currentQuarter();
  let tab: Tab = 'pending';
  /** De dónde viene un enlace de otra app (la franja lo dice). */
  let linkOrigin: string | null = null;
  /** Lo que se sabe de cada destino propuesto (archivado, último día), resuelto con red o de los recientes. */
  const targetInfo = new Map<string, TargetChoice | null>();
  let validatedOnly = true;
  let query = '';
  let groupFilter: Partial<PurchaseFilters> = {};

  const rangeKind = el('select', { ...fieldAttrs({ id: 'invoices.compras.periodo.tipo', label: 'Tipo de periodo', type: 'select', sensitivity: 'internal', confirm: 'none' }),'aria-label': 'Tipo de periodo', onchange: () => { setRange(); } }, el('option', { value: 'quarter', selected: true }, 'Trimestre'), el('option', { value: 'month' }, 'Mes'), el('option', { value: 'year' }, 'Año'));
  const year = el('input', { ...fieldAttrs({ id: 'invoices.compras.periodo.ano', label: 'Año', type: 'number', sensitivity: 'internal', confirm: 'none' }),type: 'number', 'aria-label': 'Año', min: '2020', max: '2100', value: String(range.year), style: 'width:5.5em', onchange: () => setRange() });
  const part = el('select', { ...fieldAttrs({ id: 'invoices.compras.periodo.parte', label: 'Periodo', type: 'select', sensitivity: 'internal', confirm: 'none' }),'aria-label': 'Periodo', onchange: () => setRange() });
  const validatedToggle = el('label', { class: 'check' }, el('input', { ...fieldAttrs({ id: 'invoices.compras.filtros.solo_validadas', label: 'Solo validadas', type: 'toggle', sensitivity: 'internal', confirm: 'none' }),type: 'checkbox', checked: true, id: 'onlyValidated', onchange: (e: Event) => { validatedOnly = (e.target as HTMLInputElement).checked; paint(); } }), el('span', null, 'Solo validadas'));
  const search = el('input', { ...fieldAttrs({ id: 'invoices.compras.filtros.buscar', label: 'Buscar compras', type: 'search', sensitivity: 'internal', confirm: 'none' }),type: 'search', placeholder: 'Artículo, proveedor, código', 'aria-label': 'Buscar compras', oninput: () => { query = search.value; paint(); } });
  // Filtros del handoff: destino (retiro = booking/event, ingrediente = food/ingredient, …), tipo de artículo y «sin asignar».
  let targetFilter = '';
  let itemTypeFilter = '';
  // R4: con el enlace con Recursos encendido, filtro por artículo (de varios proveedores a la vez)
  let itemFilter = '';
  const itemSelect = el('select', { ...fieldAttrs({ id: 'invoices.compras.filtros.articulo', label: 'Filtrar por artículo', type: 'select', sensitivity: 'internal', confirm: 'none' }),id: 'purchaseItem', 'aria-label': 'Filtrar por artículo', onchange: () => { itemFilter = itemSelect.value; paint(); } });
  let unassignedFilter = false;
  const TARGET_OPTIONS: Array<[string, string]> = [['', 'Cualquier destino'], ['booking:event', 'Retiro (evento de Reservas)'], ['booking:reservation', 'Reserva'], ['food:ingredient', 'Ingrediente'], ['food:equipment', 'Maquinaria'], ['tasks:project', 'Proyecto de Tareas'], ['tasks:task', 'Tarea'], ['tasks:area', 'Área de Tareas'], ['general:investment', 'Inversión (general)'], ['general:operating_expense', 'Gasto de explotación (general)']];
  const targetSelect = el('select', { ...fieldAttrs({ id: 'invoices.compras.filtros.destino', label: 'Filtrar por destino', type: 'select', sensitivity: 'internal', confirm: 'none' }),id: 'purchaseTarget', 'aria-label': 'Filtrar por destino', onchange: () => { targetFilter = targetSelect.value; paint(); } }, ...TARGET_OPTIONS.map(([v, l]) => el('option', { value: v }, l)));
  const itemTypeSelect = el('select', { ...fieldAttrs({ id: 'invoices.compras.filtros.tipo_articulo', label: 'Filtrar por tipo de artículo', type: 'select', sensitivity: 'internal', confirm: 'none' }),id: 'purchaseItemType', 'aria-label': 'Filtrar por tipo de artículo', onchange: () => { itemTypeFilter = itemTypeSelect.value; paint(); } },
    el('option', { value: '' }, 'Cualquier artículo'), ...Object.entries(ITEM_TYPE_LABELS).map(([v, l]) => el('option', { value: v }, l)));
  const unassignedToggle = el('label', { class: 'check' }, el('input', { ...fieldAttrs({ id: 'invoices.compras.filtros.sin_asignar', label: 'Solo sin asignar', type: 'toggle', sensitivity: 'internal', confirm: 'none' }),type: 'checkbox', id: 'onlyUnassigned', onchange: (e: Event) => { unassignedFilter = (e.target as HTMLInputElement).checked; paint(); } }), el('span', null, 'Solo sin asignar'));
  const pendingCount = el('span', { class: 'count', id: 'pendingCount' }, '0');
  const tabs = el('div', { 'data-feedback-id': 'invoices.compras.vista', 'data-feedback-label': 'Vista', class: 'segmented inv-tabs-scroll', role: 'tablist' }, ...([['pending', 'Por asignar'], ['category', 'Categoría'], ['target', 'Destino'], ['supplier', 'Proveedor'], ['items', 'Artículos']] as Array<[Tab, string]>).map(([value, label]) =>
    el('button', { ...TAB_MARKS[value], type: 'button', role: 'tab', class: value === tab ? 'on' : '', dataset: { tab: value }, onclick: () => { tab = value; groupFilter = {}; linkOrigin = null; paint(); } }, label, value === 'pending' ? [' ', pendingCount] : null)));
  const host = el('div', { id: 'purchases', 'data-feedback-id': 'invoices.compras.resultados', 'data-feedback-label': 'Resultados' });
  const footer = el('div', { 'data-feedback-id': 'invoices.compras.totales', 'data-feedback-label': 'Totales', 'data-feedback-ignore': '', class: 'totals-foot', id: 'purchaseTotals' });

  function fillParts(): void {
    const kind = rangeKind.value as RangeKind;
    const options = kind === 'quarter' ? [1, 2, 3, 4].map((q) => [String(q), `${q}.º trimestre`]) : kind === 'month' ? Array.from({ length: 12 }, (_, i) => [String(i + 1), new Date(Date.UTC(2000, i, 1)).toLocaleDateString('es-ES', { month: 'long', timeZone: 'UTC' })]) : [['1', 'Todo el año']];
    const current = kind === 'quarter' ? String(range.quarter ?? 1) : kind === 'month' ? String(range.month ?? 1) : '1';
    replace(part, ...options.map(([v, label]) => el('option', { value: v, selected: v === current }, label)));
    part.hidden = kind === 'year';
  }
  function setRange(): void {
    const kind = rangeKind.value as RangeKind;
    range = rangeFor(kind, Number(year.value) || range.year, Number(part.value) || 1);
    fillParts();
    paint();
  }
  fillParts();

  // El periodo y los filtros, cada uno en su hoja (los mismos controles: se mueven a la hoja al abrirla)
  const periodButton = el('button', { 'data-feedback-id': 'invoices.compras.periodo', 'data-feedback-label': 'Periodo', class: 'softbtn small', type: 'button', id: 'purchasePeriod', onclick: () => openControls('Periodo', [el('div', { class: 'toolbar wrap' }, rangeKind, year, part), validatedToggle]) });
  const filtersButton = el('button', { 'data-feedback-id': 'invoices.compras.filtros', 'data-feedback-label': 'Filtros', class: 'softbtn small', type: 'button', id: 'purchaseFilters', onclick: () => openControls('Filtros', [targetSelect, itemTypeSelect, itemSelect, unassignedToggle]) });
  function openControls(title: string, controls: HTMLElement[]): void {
    openSheet({ title, body: el('div', { class: 'inv-controls' }, ...controls), foot: [el('button', { class: 'primary', type: 'button', onclick: () => void closeSheet() }, 'Hecho')] });
  }
  function paintControlButtons(): void {
    replace(periodButton, icon('calendar', 16), `${rangeLabel(range)}${validatedOnly ? ' · solo validadas' : ''}`);
    const n = [targetFilter, itemTypeFilter, linksEnabled() ? itemFilter : '', unassignedFilter ? 'x' : ''].filter(Boolean).length;
    replace(filtersButton, icon('filter', 16), n ? `Filtros · ${n}` : 'Filtros');
  }

  replace(main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Compras'), el('p', null, 'Qué se ha comprado, para qué y qué falta por asignar.'))),
    el('div', { class: 'toolbar wrap' }, periodButton, filtersButton),
    tabs,
    el('div', { class: 'toolbar' }, el('div', { class: 'search' }, search)),
    host,
    footer,
  );

  /** Los artículos enlazados en alguna línea, por nombre; sin el enlace encendido, el filtro no se ve. */
  function paintItemOptions(m: NonNullable<typeof mirror>): void {
    itemSelect.hidden = !linksEnabled();
    if (itemSelect.hidden) return;
    const ids = [...new Set(m.lines.filter((l) => !l.deleted_at && l.item_id).map((l) => l.item_id as string))];
    const named = ids.map((id) => [id, linkedItem(id)?.name ?? 'Artículo'] as const).sort((a, b) => a[1].localeCompare(b[1], 'es'));
    if (itemFilter && !ids.includes(itemFilter)) itemFilter = '';
    replace(itemSelect, el('option', { value: '' }, 'Cualquier artículo del inventario'), ...named.map(([id, name]) => el('option', { value: id, selected: id === itemFilter }, name)));
  }

  function paint(): void {
    if (!mirror) return;
    paintControlButtons();
    for (const b of Array.from(tabs.querySelectorAll('button'))) b.classList.toggle('on', b.dataset.tab === tab);
    paintItemOptions(mirror);
    const [targetApp, targetKind] = targetFilter ? targetFilter.split(':') : [undefined, undefined];
    const result = purchaseItems({ invoices: mirror.invoices, lines: mirror.lines, suppliers: mirror.suppliers, allocations: mirror.allocations },
      { range, validatedOnly, query, ...(targetApp ? { targetApp, targetKind } : {}), ...(itemTypeFilter ? { itemType: itemTypeFilter } : {}), ...(linksEnabled() && itemFilter ? { itemId: itemFilter } : {}), ...(unassignedFilter ? { unassignedOnly: true } : {}), ...groupFilter });
    replace(footer, el('span', null, rangeLabel(range)), el('strong', null, `Base ${eur(result.total_base)}`), el('span', null, `asignado ${eur(result.total_allocated)}`), el('span', { class: result.total_unallocated > 0 ? 'alert' : '' }, `sin asignar ${eur(result.total_unallocated)}`));
    const pendingAll = purchaseItems({ invoices: mirror.invoices, lines: mirror.lines, suppliers: mirror.suppliers, allocations: mirror.allocations }, { unassignedOnly: true });
    pendingCount.textContent = String(pendingAll.items.length);
    if (tab === 'pending' && !Object.keys(groupFilter).length) { replace(host, renderPending(pendingAll, result.total_unallocated)); return; }
    if (Object.keys(groupFilter).length) {
      replace(host, el('div', { class: 'banner info', id: 'purchaseOrigin' }, el('span', null, linkOrigin ?? 'Filtro aplicado desde la agrupación.'), el('button', { 'data-feedback-id': 'invoices.compras.filtros.quitar_agrupacion', 'data-feedback-label': 'Quitar filtro', class: 'linkbtn', type: 'button', onclick: () => { groupFilter = {}; paint(); } }, 'Quitar')), renderItems(result));
      return;
    }
    if (tab === 'items') { replace(host, renderItems(result)); return; }
    const groups = tab === 'category' ? result.by_category : tab === 'target' ? result.by_target : result.by_supplier;
    replace(host, renderGroups(groups, tab, result));
  }

  function renderGroups(groups: PurchaseGroup[], kind: Tab, result: PurchaseItemsResult): HTMLElement {
    if (!result.items.length) return el('div', { class: 'empty' }, el('strong', null, 'Nada que mostrar'), validatedOnly ? 'No hay facturas validadas en este periodo. Quita «Solo validadas» para ver también las pendientes.' : 'No hay compras en este periodo.');
    return fbRows(renderList({ label: 'Agrupación', rows: groups.map((g): ListRowSpec => ({
      id: g.key,
      title: kind === 'category' ? (g.key === 'sin_categoria' ? 'Sin categoría' : categoryLabel(g.key.split(':')[0]) + (g.key.endsWith(':inv') ? ' (inversión)' : '')) : g.label,
      meta: [`${g.count} ${g.count === 1 ? 'artículo' : 'artículos'}`],
      chips: [el('span', { class: g.key === 'unassigned' ? 'chip alert' : 'chip' }, eur(g.base))],
      onClick: () => { groupFilter = filterFor(kind, g); tab = 'items'; paint(); },
      label: `Ver ${g.label}`,
    })) }), { feedbackId: 'invoices.compras.resultados.grupos', feedbackLabel: 'Agrupación' }, { feedbackId: 'invoices.compras.resultados.grupo', feedbackLabel: 'Grupo' });
  }

  /** Lo ya asignado, como historia para proponer (proveedor, nombre de la línea, fecha y destino). */
  function pastAllocations(m: Mirror): PastAllocation[] {
    const lineById = new Map(m.lines.map((l) => [l.id, l]));
    const invoiceById = new Map(m.invoices.map((i) => [i.id, i]));
    return m.allocations.filter((a) => !a.deleted_at && a.target_app !== 'general').flatMap((a) => {
      const line = lineById.get(a.invoice_line_id); const invoice = line ? invoiceById.get(line.invoice_id) : null;
      if (!line || !invoice || invoice.status === 'anulada') return [];
      return [{ supplierId: invoice.supplier_id, lineKey: lineKeyOf(lineName(line)), date: invoice.invoice_date ?? '', target: { app: a.target_app, kind: a.target_kind, id: a.target_id, code: a.target_code ?? null, label: a.target_label, revision: a.target_revision ?? null } }];
    });
  }

  /** ¿Sigue abierto? Con lo resuelto (con red) o lo de los recientes; si no se sabe, no se asigna de un toque. */
  function openFor(target: ProposalTarget, invoice: LocalInvoice): boolean {
    const info = targetInfo.get(targetKeyOf(target)) ?? recentTargets().find((r) => targetKeyOf(r) === targetKeyOf(target)) ?? null;
    return !!info && targetOpenFor(info, invoice.invoice_date);
  }
  function resolveProposals(targets: ProposalTarget[]): void {
    if (!navigator.onLine) return;
    for (const t of targets) {
      const key = targetKeyOf(t);
      if (targetInfo.has(key) || !t.id) continue;
      targetInfo.set(key, null);
      void resolveTarget(client, t.app as TargetChoice['app'], t.kind, t.id).then((info) => { targetInfo.set(key, info); paint(); }).catch(() => undefined);
    }
  }

  /** Asigna lo que falta de cada línea al destino, en un solo envío, y ofrece «Deshacer». */
  async function assign(items: PurchaseItemsResult['items'], target: ProposalTarget): Promise<void> {
    const info = targetInfo.get(targetKeyOf(target));
    const ops = items.map((item) => ({ op: 'insert' as const, table: ALLOCATIONS, id: crypto.randomUUID(), fields: {
      target_app: target.app, target_kind: target.kind, target_id: target.id, target_code: info?.code ?? target.code, target_label: target.label, target_revision: info?.revision ?? target.revision,
      invoice_line_id: item.line.id, allocated_amount: Number(item.line.net_amount) < 0 ? -item.unallocated_amount : item.unallocated_amount, allocated_quantity: null } }));
    try {
      await client.commit(ops);
      offerUndoInsert(client, ALLOCATIONS, ops.map((o) => o.id), items.length === 1 ? `Asignada a ${target.label}.` : `${items.length} asignadas a ${target.label}.`, 'Asignación deshecha.');
    } catch (error) { toast(describeError(error)); }
  }

  /** La hoja de asignar de siempre, sin reabrir la factura; con «Deshacer» de lo que se asigne. */
  function openSheetFor(item: PurchaseItemsResult['items'][number]): void {
    openAllocation(ctx, mirror!, item.invoice as LocalInvoice, item.line as LocalInvoiceLine, (id) => { if (id) offerUndoInsert(client, ALLOCATIONS, [id], 'Asignación guardada.', 'Asignación deshecha.'); });
  }

  function renderPending(all: PurchaseItemsResult, inPeriod: number): HTMLElement {
    const m = mirror!;
    if (!all.items.length) return el('div', { class: 'empty', id: 'pendingEmpty' }, el('strong', null, 'Todo asignado'), 'No queda ninguna compra validada sin destino.');
    const past = pastAllocations(m);
    const q = query.trim().toLowerCase();
    const items = all.items.filter((i) => !q || [lineName(i.line), supplierName(i.supplier), i.invoice.code ?? ''].join(' ').toLowerCase().includes(q));
    const groups = new Map<string, { target: ProposalTarget | null; title: string; items: typeof items }>();
    for (const item of items) {
      const target = proposeTarget(item.invoice.supplier_id, lineName(item.line), past);
      const key = target ? targetKeyOf(target) : `sin:${item.invoice.supplier_id}`;
      if (!groups.has(key)) groups.set(key, { target, title: target ? `Para ${target.label}` : `Sin propuesta · ${supplierName(item.supplier)}`, items: [] });
      groups.get(key)!.items.push(item);
    }
    resolveProposals([...groups.values()].map((g) => g.target).filter((t): t is ProposalTarget => !!t));
    const canEdit = client.bootstrap()?.membership.role !== 'reader';
    const view = renderWorstGroups<typeof items[number]>({
      label: 'Por asignar', feedbackId: 'invoices.compras.por_asignar',
      // Primero los que tienen destino propuesto (se asignan de un toque); después, sin propuesta
      groups: [...groups.entries()].sort(([, a], [, b]) => Number(!a.target) - Number(!b.target) || a.title.localeCompare(b.title, 'es')).map(([key, g]) => {
        const open = g.target ? g.items.filter((i) => openFor(g.target!, i.invoice as LocalInvoice)) : [];
        const total = open.reduce((s, i) => s + Math.round(i.unallocated_amount * 100), 0) / 100;
        return { key, title: g.title, items: g.items, open: true, summary: `${g.items.length} sin asignar · ${eur(g.items.reduce((s, i) => s + Math.round(i.unallocated_amount * 100), 0) / 100)}`,
          actions: canEdit && g.target && open.length > 1 ? [el('button', { 'data-feedback-id': 'invoices.compras.por_asignar.lote', 'data-feedback-label': 'Asignar el lote', class: 'softbtn small inv-batch', type: 'button', onclick: (e: Event) => { e.preventDefault(); void assign(open, g.target!); } }, batchLabel(open.length, g.target, eur(total)))] : [] };
      }),
      row: (item) => {
        const target = proposeTarget(item.invoice.supplier_id, lineName(item.line), past);
        const ready = !!target && openFor(target, item.invoice as LocalInvoice);
        const linked = linksEnabled() && item.line.item_id ? linkedItem(item.line.item_id) : null;
        const tile = renderTile({ title: linked?.name ?? lineName(item.line), value: eur(item.unallocated_amount), icon: 'tag', feedbackId: 'invoices.compras.por_asignar.baldosa',
          levelText: !canEdit ? `${supplierName(item.supplier)} · ${shortDate(item.invoice.invoice_date)}` : ready ? `Toca: a ${target!.label}` : target ? `${target.label} ya no está abierto: toca para elegir` : 'Toca para elegir destino',
          onClick: canEdit ? () => { if (ready) void assign([item], target!); else openSheetFor(item); } : undefined });
        return el('li', { class: 'inv-tile-row' }, tile,
          el('p', { class: 'hint inv-tile-meta' }, `${supplierName(item.supplier)} · ${shortDate(item.invoice.invoice_date)}${item.invoice.code ? ` · ${item.invoice.code}` : ''}`),
          el('div', { class: 'btnrow' },
            canEdit ? el('button', { 'data-feedback-id': 'invoices.compras.por_asignar.otro_destino', 'data-feedback-label': 'Otro destino', class: 'linkbtn', type: 'button', onclick: () => openSheetFor(item) }, 'Otro destino') : null,
            el('button', { 'data-feedback-id': 'invoices.compras.por_asignar.factura', 'data-feedback-label': 'Ver la factura', class: 'linkbtn', type: 'button', onclick: () => void openInvoice(ctx, item.invoice.id) }, icon('invoice', 16), 'Factura')));
      },
    });
    return el('div', null,
      el('p', { class: 'hint', id: 'pendingSummary', 'data-feedback-ignore': '' }, `Todo lo pendiente: ${eur(all.total_unallocated)} · de este periodo: ${eur(inPeriod)}`),
      view.element);
  }

  function filterFor(kind: Tab, g: PurchaseGroup): Partial<PurchaseFilters> {
    if (kind === 'category') { const [cat, inv] = g.key.split(':'); return cat === 'sin_categoria' ? {} : { expenseCategory: cat as never, isInvestment: inv === 'inv' }; }
    if (kind === 'supplier') return { supplierId: g.key };
    if (g.key === 'unassigned') return { unassignedOnly: true };
    const [app, targetKind, id] = g.key.split(':');
    return { targetApp: app, targetKind, targetId: id || undefined };
  }

  function renderItems(result: PurchaseItemsResult): HTMLElement {
    return fbRows(renderList({ label: 'Artículos comprados', empty: { title: 'Sin artículos', text: 'Ajusta el periodo o los filtros.' }, rows: result.items.map((item): ListRowSpec => ({
      id: item.line.id,
      title: lineName(item.line),
      meta: [supplierName(item.supplier), shortDate(item.invoice.invoice_date), item.invoice.code ?? 'código pendiente', item.line.quantity === null ? '' : `${Number(item.line.quantity)} ${item.line.unit ?? ''}`.trim(), item.line.item_type ? ITEM_TYPE_LABELS[item.line.item_type] ?? item.line.item_type : ''].filter(Boolean),
      chips: [
        el('span', { class: 'chip' }, eur(item.line.net_amount)),
        ...item.allocations.map((a) => {
          const chip = el('span', { class: 'chip', style: '--chip:#6b7f52' }, a.target_label);
          void checkTargetFreshness(client, a).then((f) => { if (f === 'changed' || f === 'missing') { chip.classList.add('alert'); chip.title = FRESHNESS_LABELS[f]; chip.append(` · ${FRESHNESS_LABELS[f]}`); } });
          return chip;
        }),
        item.unallocated_amount > 0 ? el('span', { class: 'chip alert' }, `Sin asignar ${eur(item.unallocated_amount)}`) : null,
        item.invoice.status !== 'validada' && item.invoice.status !== 'archivada' ? el('span', { class: statusChipClass(item.invoice.status, item.invoice.review_reason) }, statusText(item.invoice)) : null,
      ],
      pending: (item.line as { _pending?: boolean })._pending === true || (item.invoice as { _pending?: boolean })._pending === true,
      onClick: () => void openInvoice(ctx, item.invoice.id),
      label: `Abrir la factura de ${lineName(item.line)}`,
      actions: [el('button', { 'data-feedback-id': 'invoices.compras.resultados.articulo.factura', 'data-feedback-label': 'Factura', class: 'linkbtn', type: 'button', onclick: () => void openInvoice(ctx, item.invoice.id) }, icon('invoice', 16), 'Factura')],
    })) }), { feedbackId: 'invoices.compras.resultados.articulos', feedbackLabel: 'Artículos comprados' }, { feedbackId: 'invoices.compras.resultados.articulo', feedbackLabel: 'Artículo' });
  }

  async function load(): Promise<void> { mirror = await loadMirror(client); paint(); }
  const off = onAnyTable(client, () => void load());
  void load().then(fromHash);

  /** Enlace de otra app (API.md §9.6): `#/compras?destino=booking:reservation:<id>`. */
  function fromHash(): void {
    const query = new URLSearchParams(location.hash.split('?')[1] ?? '');
    const destino = query.get('destino');
    if (!destino || !mirror) return;
    const [targetApp, targetKind, targetId] = destino.split(':');
    if (!targetApp || !targetKind) return;
    const matching = mirror.allocations.filter((a) => !a.deleted_at && a.target_app === targetApp && a.target_kind === targetKind && (!targetId || a.target_id === targetId));
    const dates = matching.map((a) => mirror!.invoices.find((i) => i.id === a.invoice_id)?.invoice_date).filter((d): d is string => !!d).sort();
    if (dates.length) range = { kind: 'custom', year: Number(dates[0]!.slice(0, 4)), quarter: null, month: null, from: dates[0]!, to: dates[dates.length - 1]! };
    validatedOnly = false;
    (validatedToggle.querySelector('input') as HTMLInputElement).checked = false;
    tab = 'items';
    groupFilter = { targetApp, targetKind, ...(targetId ? { targetId } : {}) };
    const label = matching[0]?.target_label ?? null;
    const from = ({ booking: 'Reservas', tasks: 'Tareas', food: 'Cocina' } as Record<string, string>)[targetApp] ?? targetApp;
    linkOrigin = `Desde ${from}: solo lo asignado${label ? ` a «${label}»` : ''}, de cualquier fecha y también sin validar.`;
    history.replaceState(null, '', '#/compras');
    paint();
  }
  return () => off();
};
