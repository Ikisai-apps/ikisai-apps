/** Compras (API.md §6.3, §9.3): las líneas como artículos comprados, por categoría, destino, proveedor o lista; todo calculado en local. */
import { el, icon, renderList, replace, type ListRowSpec } from '@ikisai/ui-kit';
import { purchaseItems, type PurchaseFilters, type PurchaseGroup, type PurchaseItemsResult } from '@ikisai/domain-invoices';
import { categoryLabel } from '../app/client.ts';
import { currentQuarter, eur, loadMirror, onAnyTable, rangeFor, rangeLabel, shortDate, statusChipClass, statusText, type Mirror, type RangeKind } from '../app/data.ts';
import { ITEM_TYPE_LABELS } from '../app/data.ts';
import { openInvoice } from './invoices.ts';
import type { ViewMount } from './shell.ts';

type Tab = 'category' | 'target' | 'supplier' | 'items';

export const mountPurchases: ViewMount = (ctx) => {
  const { main, client } = ctx;
  let mirror: Mirror | null = null;
  let range = currentQuarter();
  let tab: Tab = 'category';
  let validatedOnly = true;
  let query = '';
  let groupFilter: Partial<PurchaseFilters> = {};

  const rangeKind = el('select', { 'aria-label': 'Tipo de periodo', onchange: () => { setRange(); } }, el('option', { value: 'quarter', selected: true }, 'Trimestre'), el('option', { value: 'month' }, 'Mes'), el('option', { value: 'year' }, 'Año'));
  const year = el('input', { type: 'number', 'aria-label': 'Año', min: '2020', max: '2100', value: String(range.year), style: 'width:5.5em', onchange: () => setRange() });
  const part = el('select', { 'aria-label': 'Periodo', onchange: () => setRange() });
  const validatedToggle = el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: true, id: 'onlyValidated', onchange: (e: Event) => { validatedOnly = (e.target as HTMLInputElement).checked; paint(); } }), el('span', null, 'Solo validadas'));
  const search = el('input', { type: 'search', placeholder: 'Artículo, proveedor, código', 'aria-label': 'Buscar compras', oninput: () => { query = search.value; paint(); } });
  const tabs = el('div', { class: 'segmented', role: 'tablist' }, ...([['category', 'Por categoría'], ['target', 'Por destino'], ['supplier', 'Por proveedor'], ['items', 'Artículos']] as Array<[Tab, string]>).map(([value, label]) =>
    el('button', { type: 'button', role: 'tab', class: value === tab ? 'on' : '', dataset: { tab: value }, onclick: () => { tab = value; groupFilter = {}; paint(); } }, label)));
  const host = el('div', { id: 'purchases' });
  const footer = el('div', { class: 'totals-foot', id: 'purchaseTotals' });

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

  replace(main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Compras'), el('p', null, 'Qué se ha comprado, para qué y qué falta por asignar.'))),
    el('div', { class: 'toolbar wrap' }, rangeKind, year, part, validatedToggle),
    tabs,
    el('div', { class: 'toolbar' }, el('div', { class: 'search' }, search)),
    host,
    footer,
  );

  function paint(): void {
    if (!mirror) return;
    for (const b of Array.from(tabs.querySelectorAll('button'))) b.classList.toggle('on', b.dataset.tab === tab);
    const result = purchaseItems({ invoices: mirror.invoices, lines: mirror.lines, suppliers: mirror.suppliers, allocations: mirror.allocations }, { range, validatedOnly, query, ...groupFilter });
    replace(footer, el('span', null, rangeLabel(range)), el('strong', null, `Base ${eur(result.total_base)}`), el('span', null, `asignado ${eur(result.total_allocated)}`), el('span', { class: result.total_unallocated > 0 ? 'alert' : '' }, `sin asignar ${eur(result.total_unallocated)}`));
    if (Object.keys(groupFilter).length) {
      replace(host, el('div', { class: 'banner info' }, el('span', null, 'Filtro aplicado desde la agrupación.'), el('button', { class: 'linkbtn', type: 'button', onclick: () => { groupFilter = {}; paint(); } }, 'Quitar')), renderItems(result));
      return;
    }
    if (tab === 'items') { replace(host, renderItems(result)); return; }
    const groups = tab === 'category' ? result.by_category : tab === 'target' ? result.by_target : result.by_supplier;
    replace(host, renderGroups(groups, tab, result));
  }

  function renderGroups(groups: PurchaseGroup[], kind: Tab, result: PurchaseItemsResult): HTMLElement {
    if (!result.items.length) return el('div', { class: 'empty' }, el('strong', null, 'Nada que mostrar'), validatedOnly ? 'No hay facturas validadas en este periodo. Quita «Solo validadas» para ver también las pendientes.' : 'No hay compras en este periodo.');
    return renderList({ label: 'Agrupación', rows: groups.map((g): ListRowSpec => ({
      id: g.key,
      title: kind === 'category' ? (g.key === 'sin_categoria' ? 'Sin categoría' : categoryLabel(g.key.split(':')[0]) + (g.key.endsWith(':inv') ? ' (inversión)' : '')) : g.label,
      meta: [`${g.count} ${g.count === 1 ? 'artículo' : 'artículos'}`],
      chips: [el('span', { class: g.key === 'unassigned' ? 'chip alert' : 'chip' }, eur(g.base))],
      onClick: () => { groupFilter = filterFor(kind, g); tab = 'items'; paint(); },
      label: `Ver ${g.label}`,
    })) });
  }

  function filterFor(kind: Tab, g: PurchaseGroup): Partial<PurchaseFilters> {
    if (kind === 'category') { const [cat, inv] = g.key.split(':'); return cat === 'sin_categoria' ? {} : { expenseCategory: cat as never, isInvestment: inv === 'inv' }; }
    if (kind === 'supplier') return { supplierId: g.key };
    if (g.key === 'unassigned') return { unassignedOnly: true };
    const [app, targetKind, id] = g.key.split(':');
    return { targetApp: app, targetKind, targetId: id || undefined };
  }

  function renderItems(result: PurchaseItemsResult): HTMLElement {
    return renderList({ label: 'Artículos comprados', empty: { title: 'Sin artículos', text: 'Ajusta el periodo o los filtros.' }, rows: result.items.map((item): ListRowSpec => ({
      id: item.line.id,
      title: item.line.description,
      meta: [item.supplier?.name ?? '—', shortDate(item.invoice.invoice_date), item.invoice.code ?? 'código pendiente', item.line.quantity === null ? '' : `${Number(item.line.quantity)} ${item.line.unit ?? ''}`.trim(), item.line.item_type ? ITEM_TYPE_LABELS[item.line.item_type] ?? item.line.item_type : ''].filter(Boolean),
      chips: [
        el('span', { class: 'chip' }, eur(item.line.net_amount)),
        ...item.allocations.map((a) => el('span', { class: 'chip', style: '--chip:#6b7f52' }, a.target_app === 'general' ? a.target_label : a.target_label)),
        item.unallocated_amount > 0 ? el('span', { class: 'chip alert' }, `Sin asignar ${eur(item.unallocated_amount)}`) : null,
        item.invoice.status !== 'validada' && item.invoice.status !== 'archivada' ? el('span', { class: statusChipClass(item.invoice.status, item.invoice.review_reason) }, statusText(item.invoice)) : null,
      ],
      pending: (item.line as { _pending?: boolean })._pending === true || (item.invoice as { _pending?: boolean })._pending === true,
      onClick: () => void openInvoice(ctx, item.invoice.id),
      label: `Abrir la factura de ${item.line.description}`,
      actions: [el('button', { class: 'linkbtn', type: 'button', onclick: () => void openInvoice(ctx, item.invoice.id) }, icon('invoice', 16), 'Factura')],
    })) });
  }

  async function load(): Promise<void> { mirror = await loadMirror(client); paint(); }
  const off = onAnyTable(client, () => void load());
  void load();
  return () => off();
};
