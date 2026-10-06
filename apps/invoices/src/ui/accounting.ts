/** Gestoría (API.md §6.4, §6.5, §9.4): resumen fiscal del rango, alertas y entregas (ZIP, CSV, manifest). */
import { confirmDialog, el, icon, renderList, replace, toast, type ListRowSpec } from '@ikisai/ui-kit';
import { fiscalSummary, type FiscalSummary } from '@ikisai/domain-invoices';
import { categoryLabel as categoryName, describeError, type LocalExport } from '../app/client.ts';
import { DEDUCTIBILITY_LABELS, TAX_TYPE_LABELS, currentQuarter, eur, loadMirror, onAnyTable, rangeFor, rangeLabel, shortDate, type Mirror, type RangeKind } from '../app/data.ts';
import { downloadWithSession } from '../app/files.ts';
import { openInvoice } from './invoices.ts';
import type { ViewMount } from './shell.ts';

export const mountAccounting: ViewMount = (ctx) => {
  const { main, client } = ctx;
  let mirror: Mirror | null = null;
  let range = currentQuarter();
  const role = client.bootstrap()?.membership.role ?? 'reader';
  const canEdit = role !== 'reader';

  const rangeKind = el('select', { 'aria-label': 'Tipo de periodo', onchange: () => setRange() }, el('option', { value: 'quarter', selected: true }, 'Trimestre'), el('option', { value: 'year' }, 'Año'));
  const year = el('input', { type: 'number', 'aria-label': 'Año', min: '2020', max: '2100', value: String(range.year), style: 'width:5.5em', onchange: () => setRange() });
  const part = el('select', { 'aria-label': 'Trimestre', onchange: () => setRange() }, ...[1, 2, 3, 4].map((q) => el('option', { value: String(q), selected: q === range.quarter }, `${q}.º trimestre`)));
  function setRange(): void {
    const kind = rangeKind.value as RangeKind;
    range = rangeFor(kind, Number(year.value) || range.year, Number(part.value) || 1);
    part.hidden = kind === 'year';
    paint();
  }
  const summaryHost = el('div', { id: 'fiscalSummary' });
  const alertsHost = el('div', { id: 'fiscalAlerts' });
  const exportsHost = el('div', { id: 'exportsList' });
  const prepare = el('button', { class: 'primary', type: 'button', id: 'prepareExport', hidden: !canEdit, onclick: () => void prepareExport() }, icon('download', 18), 'Preparar entrega');

  replace(main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Gestoría'), el('p', null, 'Resumen documental del periodo y entregas con originales, CSV y manifest con hashes. El ZIP no cierra registros.'))),
    el('div', { class: 'toolbar wrap' }, rangeKind, year, part),
    summaryHost,
    alertsHost,
    el('div', { class: 'sectionlabel' }, 'Entregas', el('span', { class: 'count', id: 'exportCount' }, '0')),
    exportsHost,
    el('div', { class: 'btnrow', style: 'margin-top:12px' }, prepare),
  );

  function summaryBlock(title: string, rows: Array<[string, string]>): HTMLElement {
    return el('article', { class: 'card' }, el('h3', null, title), el('dl', { class: 'kv' }, ...rows.flatMap(([k, v]) => [el('dt', null, k), el('dd', null, v)])));
  }

  function paint(): void {
    if (!mirror) return;
    const withFile = new Set(mirror.files.filter((f) => f.kind === 'original').map((f) => f.invoice_id));
    const s: FiscalSummary = fiscalSummary({ invoices: mirror.invoices, taxLines: mirror.taxes, invoicesWithFile: withFile }, range);
    replace(summaryHost,
      el('div', { class: 'cardgrid' },
        summaryBlock(rangeLabel(range), [['Base', eur(s.base)], ['IVA soportado', eur(s.vat)], ...(s.other ? [['Otros tributos', eur(s.other)] as [string, string]] : []), ['Retenciones', eur(s.withholding)], ['Total facturado', eur(s.total)], ['Facturas validadas', String(s.invoices.validada + s.invoices.archivada)]]),
        summaryBlock('IVA por tipo', s.vat_by_rate.length ? s.vat_by_rate.map((g) => [`${g.rate} %`, `${eur(g.base)} → ${eur(g.amount)}`] as [string, string]) : [['—', 'Sin IVA registrado']]),
        summaryBlock('Explotación e inversión', [['Gasto de explotación', `${eur(s.operating.base)} (${s.operating.count})`], ['Inversión', `${eur(s.investment.base)} (${s.investment.count})`]]),
        summaryBlock('Deducibilidad (base)', Object.entries(s.deductibility).map(([k, v]) => [DEDUCTIBILITY_LABELS[k] ?? k, eur(v)] as [string, string])),
        summaryBlock('Por categoría', s.by_category.length ? s.by_category.map((g) => [`${categoryName(g.expense_category)}${g.is_investment ? ' (inv.)' : ''}`, `${eur(g.base)} · ${g.count}`] as [string, string]) : [['—', 'Nada validado']]),
        s.withholdings_by_type.length ? summaryBlock('Retenciones', s.withholdings_by_type.map((g) => [`${TAX_TYPE_LABELS[g.tax_type] ?? g.tax_type}${g.rate !== null ? ` ${g.rate} %` : ''}`, eur(g.amount)] as [string, string])) : null,
      ),
    );
    const alerts: HTMLElement[] = [];
    if (s.alerts.pending_invoices.length) alerts.push(el('div', { class: 'banner warn' }, icon('warn', 18), el('span', null, `${s.alerts.pending_invoices.length} factura${s.alerts.pending_invoices.length === 1 ? '' : 's'} pendiente${s.alerts.pending_invoices.length === 1 ? '' : 's'} de revisión en el periodo: no entrarán en la entrega.`), el('button', { class: 'linkbtn', type: 'button', onclick: () => void openInvoice(ctx, s.alerts.pending_invoices[0]!.id) }, 'Abrir la primera')));
    if (s.alerts.discrepancies.length) alerts.push(el('div', { class: 'banner alert' }, icon('warn', 18), el('span', null, `${s.alerts.discrepancies.length} con REVISAR IMPORTES.`)));
    if (s.alerts.deductibility_unreviewed) alerts.push(el('div', { class: 'banner info' }, icon('info', 18), el('span', null, `${s.alerts.deductibility_unreviewed} validada${s.alerts.deductibility_unreviewed === 1 ? '' : 's'} con deducibilidad sin revisar.`)));
    if (s.alerts.missing_file) alerts.push(el('div', { class: 'banner alert' }, icon('warn', 18), el('span', null, `${s.alerts.missing_file} sin documento original.`)));
    if (s.alerts.unpaid_overdue) alerts.push(el('div', { class: 'banner warn' }, icon('warn', 18), el('span', null, `${s.alerts.unpaid_overdue} vencida${s.alerts.unpaid_overdue === 1 ? '' : 's'} sin pagar.`)));
    replace(alertsHost, ...alerts);

    const exports = mirror.exports.filter((e) => !e.deleted_at && e.fiscal_year === range.year).sort((a, b) => b.created_at.localeCompare(a.created_at));
    main.querySelector('#exportCount')!.textContent = String(exports.length);
    replace(exportsHost, renderList({ label: 'Entregas', empty: { title: 'Sin entregas este año', text: canEdit ? 'Cuando el periodo esté validado, pulsa «Preparar entrega».' : 'Todavía no hay entregas.' }, rows: exports.map((e): ListRowSpec => {
      const stale = isStale(e, mirror!);
      return {
        id: e.id,
        title: `${e.code} · ${e.folder_name}`,
        meta: [`${e.invoice_count} factura${e.invoice_count === 1 ? '' : 's'}`, shortDate(e.created_at), `hash ${e.manifest_sha256.slice(0, 12)}…`, e.delivered_to ? `entregada: ${e.delivered_to}` : ''].filter(Boolean),
        chips: [el('span', { class: e.status === 'entregada' ? 'chip ok' : 'chip' }, e.status === 'entregada' ? 'Entregada' : 'Generada'), stale ? el('span', { class: 'chip alert' }, 'Desfasada') : null],
        pending: e._pending === true,
        actions: [
          el('button', { class: 'linkbtn', type: 'button', onclick: () => void download(`/exports/${e.id}/download`, `${e.folder_name}.zip`) }, icon('download', 16), 'ZIP'),
          el('button', { class: 'linkbtn', type: 'button', onclick: () => void download(`/exports/${e.id}/manifest.json`, `${e.folder_name}_manifest.json`) }, 'Manifest'),
          el('button', { class: 'linkbtn', type: 'button', onclick: () => void download(`/exports/${e.id}/facturas_recibidas.csv`, `${e.folder_name}_facturas_recibidas.csv`) }, 'CSV'),
          canEdit && e.status !== 'entregada' ? el('button', { class: 'linkbtn', type: 'button', onclick: () => void markDelivered(e) }, 'Marcar entregada') : null,
          role === 'owner' && e.status === 'entregada' ? el('button', { class: 'linkbtn', type: 'button', onclick: () => void archivePeriod(e) }, 'Archivar periodo') : null,
        ],
      };
    }) }));
  }

  function isStale(e: LocalExport, m: Mirror): boolean {
    const items = m.itemsByExport.get(e.id) ?? [];
    const byId = new Map(m.invoices.map((i) => [i.id, i]));
    if (items.some((it) => { const inv = byId.get(it.invoice_id); return !inv || inv.revision !== it.invoice_revision || inv.status === 'anulada'; })) return true;
    const included = new Set(items.map((it) => it.invoice_id));
    return m.invoices.some((i) => !i.deleted_at && (i.status === 'validada' || i.status === 'archivada') && i.invoice_date >= e.from_date && i.invoice_date <= e.to_date && !included.has(i.id));
  }

  async function download(path: string, filename: string): Promise<void> {
    if (!navigator.onLine) { toast('La descarga necesita conexión.'); return; }
    try { await downloadWithSession(client, path, filename); } catch (error) { toast(describeError(error)); }
  }

  async function prepareExport(): Promise<void> {
    if (!navigator.onLine) { toast('Preparar una entrega necesita conexión para la vista previa.'); return; }
    const kind = range.kind === 'year' ? 'year' : 'quarter';
    let preview: { folder_name: string; invoice_count: number; excluded: Array<{ code: string; status: string; reason: string | null }>; totals: { base: number; vat: number; total: number } };
    try {
      preview = await client.api('/exports/accountant', { json: { period_kind: kind, fiscal_year: range.year, fiscal_quarter: range.quarter } });
    } catch (error) { toast(describeError(error)); return; }
    if (!preview.invoice_count) { toast('No hay facturas validadas en el periodo.'); return; }
    const ok = await confirmDialog({
      title: `Preparar ${preview.folder_name}`,
      text: el('div', null,
        el('p', null, `${preview.invoice_count} factura${preview.invoice_count === 1 ? '' : 's'} validada${preview.invoice_count === 1 ? '' : 's'} · base ${eur(preview.totals.base)} · IVA ${eur(preview.totals.vat)} · total ${eur(preview.totals.total)}.`),
        preview.excluded.length ? el('p', null, `Quedan fuera ${preview.excluded.length}: ${preview.excluded.map((x) => `${x.code} (${x.reason ?? x.status})`).join(', ')}.`) : null,
        el('p', { class: 'hint' }, 'La entrega congela el manifest con los hashes. No cambia el estado de ninguna factura.'),
      ),
      confirmLabel: 'Generar entrega',
    });
    if (!ok) return;
    try {
      await client.commit([{ op: 'call', procedure: 'invoices.create_export', args: { export_id: crypto.randomUUID(), period_kind: kind, fiscal_year: range.year, fiscal_quarter: range.quarter } }]);
      toast('Entrega generada. Descarga el ZIP cuando se confirme.');
    } catch (error) { toast(describeError(error)); }
  }

  async function markDelivered(e: LocalExport): Promise<void> {
    const to = el('input', { type: 'text', maxlength: '300', placeholder: 'Correo a la gestoría el 7 de abril' });
    const ok = await confirmDialog({ title: `Marcar ${e.code} como entregada`, text: el('label', { class: 'field' }, el('span', null, 'Cómo se entregó'), to), confirmLabel: 'Entregada' });
    if (!ok) return;
    try { await client.commit([{ op: 'call', procedure: 'invoices.mark_delivered', args: { export_id: e.id, expectedRevision: e.revision, delivered_to: to.value.trim() || null } }]); toast('Entrega marcada como entregada.'); } catch (error) { toast(describeError(error)); }
  }

  async function archivePeriod(e: LocalExport): Promise<void> {
    const ok = await confirmDialog({ title: `Archivar las facturas de ${e.folder_name}`, text: 'Las facturas validadas incluidas en la entrega pasan a archivadas: solo se podrán tocar pago y notas.', confirmLabel: 'Archivar', danger: true });
    if (!ok) return;
    try { await client.commit([{ op: 'call', procedure: 'invoices.archive_period', args: { export_id: e.id } }]); toast('Periodo archivado.'); } catch (error) { toast(describeError(error)); }
  }

  async function load(): Promise<void> { mirror = await loadMirror(client); paint(); }
  const off = onAnyTable(client, () => void load());
  void load();
  return () => off();
};
