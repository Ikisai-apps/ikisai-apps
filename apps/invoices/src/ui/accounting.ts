/**
 * Gestoría (API.md §6.4, §6.5, §9.4): resumen fiscal del rango, alertas y entregas (ZIP, CSV, manifest).
 * Tanda 27 (MUELA-042 y 070):
 * - el periodo en un toque (1T · 2T · 3T · 4T · Año, y el año con flechas);
 * - la carpeta del periodo con el recorrido de la entrega (Validar · Preparar · Enviar · Entregada · Archivada): cada
 *   etapa hace lo suyo (Facturas por resolver, el diálogo de preparar de siempre, «Descargar», «Marcar entregada» y
 *   «Archivar periodo», este con su diálogo de peligro y solo del dueño); debajo, la frase del estado, que dice lo que
 *   se queda fuera;
 * - el ticket con las cifras principales; «Antes de enviarla» con enlace a cada lista de Facturas; «Qué cambió» si está
 *   desfasada; el resto de las cifras, plegado en «Todo el detalle»;
 * - las entregas del año por trimestre: cada uno despliega todas sus entregas, con su descarga y su huella.
 * El lector no tiene «Preparar», «Marcar entregada» ni «Archivar» en el DOM.
 * Tanda 30 (MUELA-081 y 042):
 * - la barra fija lleva la acción que toca según el recorrido (Resolver · Preparar · Descargar · Archivar); «Preparar» y
 *   «Descargar» siguen ahí para el editor;
 * - cada entrega tiene una acción principal («Marcar entregada», «Archivar periodo» o «Descargar») y el resto (ZIP, CSV,
 *   Manifest, la huella y la otra acción) en «Más»;
 * - sin red, lo que la necesita (preparar y descargar) se apaga con su motivo junto al botón (`bindOnline`).
 */
import { bindOnline, confirmDialog, closeSheet, el, icon, openSheet, renderList, renderStages, replace, toast, type ListRowSpec } from '@ikisai/ui-kit';
import { INCOME_CATEGORY_LABELS, fiscalSummary, issuedSummary, periodOfDate, type FiscalSummary } from '@ikisai/domain-invoices';
import { APP_ENTRIES, categoryLabel as categoryName, describeError, type LocalAppEntry, type LocalExport } from '../app/client.ts';
import { DEDUCTIBILITY_LABELS, TAX_TYPE_LABELS, workingQuarter, eur, loadMirror, onAnyTable, rangeFor, rangeLabel, shortDate, type Mirror, type RangeKind } from '../app/data.ts';
import { downloadWithSession } from '../app/files.ts';
import { DELIVERY_STAGES, deliveryState, type DeliveryStage } from '../app/delivery-state.ts';
import { openInvoice } from './invoices.ts';
import { loadIssued } from './issued.ts';
import type { ViewMount } from './shell.ts';
import { fbRows } from './feedback.ts';
import { usage } from '../app/usage.ts';
import { appEntriesSummary } from '../app/app-entries-state.ts';

export const mountAccounting: ViewMount = (ctx) => {
  const { main, client, navigate } = ctx;
  let mirror: Mirror | null = null;
  let issued: Awaited<ReturnType<typeof loadIssued>> | null = null;
  // Ingresos y gastos de otras apps (0244): lo facturado entra en el IVA repercutido del periodo
  let appEntries: LocalAppEntry[] = [];
  let range = workingQuarter();
  const role = client.bootstrap()?.membership.role ?? 'reader';
  const canEdit = role !== 'reader';
  const isOwner = role === 'owner';

  // --- Periodo: un toque -----------------------------------------------------------------------------------------------
  const year = el('input', { 'data-feedback-id': 'invoices.gestoria.periodo.ano', 'data-feedback-label': 'Año', type: 'number', 'aria-label': 'Año', id: 'periodYear', min: '2020', max: '2100', value: String(range.year), class: 'inv-year', onchange: () => setRange(kindOf(), Number(year.value) || range.year, range.quarter ?? 1) }) as HTMLInputElement;
  const kindOf = (): RangeKind => (range.kind === 'year' ? 'year' : 'quarter');
  const stepYear = (delta: number) => { year.value = String((Number(year.value) || range.year) + delta); setRange(kindOf(), Number(year.value), range.quarter ?? 1); };
  const periods = el('div', { 'data-feedback-id': 'invoices.gestoria.periodo.trimestre', 'data-feedback-label': 'Trimestre o año', class: 'inv-boxes', role: 'group', 'aria-label': 'Periodo', id: 'periodPicker' });
  // Los botones se crean una vez: al salir del campo del año, su «change» repinta y un botón nuevo perdería el toque.
  const periodButtons = [...[1, 2, 3, 4].map((q) => ({ key: String(q), label: `${q}T`, kind: 'quarter' as RangeKind, q })), { key: 'year', label: 'Año', kind: 'year' as RangeKind, q: 1 }]
    .map((p) => ({ ...p, node: el('button', { type: 'button', class: 'inv-box', dataset: { period: p.key }, onclick: () => setRange(p.kind, Number(year.value) || range.year, p.q) }, p.label) }));
  replace(periods, ...periodButtons.map((p) => p.node));
  function paintPeriods(): void {
    for (const p of periodButtons) p.node.setAttribute('aria-pressed', String(range.kind === p.kind && (p.kind === 'year' || range.quarter === p.q)));
  }
  function setRange(kind: RangeKind, y: number, q: number): void {
    range = rangeFor(kind, y, q);
    paint();
  }

  const folderHost = el('section', { class: 'card inv-folder', id: 'deliveryFolder', 'data-feedback-id': 'invoices.gestoria.carpeta', 'data-feedback-label': 'Carpeta del periodo' });
  const alertsHost = el('div', { 'data-feedback-id': 'invoices.gestoria.alertas', 'data-feedback-label': 'Antes de enviarla', id: 'fiscalAlerts' });
  const changedHost = el('div', { id: 'deliveryChanges', 'data-feedback-id': 'invoices.gestoria.que_cambio', 'data-feedback-label': 'Qué cambió' });
  const summaryHost = el('div', { 'data-feedback-id': 'invoices.gestoria.resumen', 'data-feedback-label': 'Resumen del periodo', id: 'fiscalSummary' });
  const exportsHost = el('div', { 'data-feedback-id': 'invoices.gestoria.entregas', 'data-feedback-label': 'Entregas', id: 'exportsList' });
  const offline: Array<() => void> = [];
  const needsNetwork = <T extends HTMLElement | null>(button: T, reason: string): T => { if (button) offline.push(bindOnline(button, { client, reason })); return button; };
  const prepare = canEdit ? el('button', { 'data-feedback-id': 'invoices.gestoria.entregas.preparar', 'data-feedback-label': 'Preparar entrega', class: 'primary', type: 'button', id: 'prepareExport', onclick: () => void prepareExport() }, icon('download', 18), 'Preparar entrega') : null;
  const downloadLatest = el('button', { 'data-feedback-id': 'invoices.gestoria.descargar', 'data-feedback-label': 'Descargar', class: 'softbtn', type: 'button', id: 'downloadLatest', hidden: true }, icon('download', 18), 'Descargar');
  // La acción que toca cuando no es preparar ni descargar: resolver las pendientes o archivar el periodo
  const nextAction = el('button', { 'data-feedback-id': 'invoices.gestoria.siguiente', 'data-feedback-label': 'Lo que toca', class: 'primary', type: 'button', id: 'deliveryNext', hidden: true });
  needsNetwork(prepare, 'Preparar una entrega necesita conexión.');
  needsNetwork(downloadLatest, 'Descargar necesita conexión.');
  const actionBar = el('div', { class: 'btnrow inv-folder-actions', id: 'deliveryBar', role: 'group', 'aria-label': 'Lo que toca con la entrega' }, nextAction, prepare, downloadLatest);

  replace(main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Gestoría'), el('p', null, 'Resumen documental del periodo y entregas con originales, CSV y manifest con hashes. El ZIP no cierra registros.'))),
    el('div', { class: 'toolbar wrap inv-period' },
      el('button', { type: 'button', class: 'ghost small inv-year-step', 'aria-label': 'Año anterior', onclick: () => stepYear(-1) }, '‹'), year,
      el('button', { type: 'button', class: 'ghost small inv-year-step', 'aria-label': 'Año siguiente', onclick: () => stepYear(1) }, '›'), periods),
    folderHost,
    alertsHost,
    changedHost,
    actionBar,
    el('details', { class: 'inv-block', id: 'fiscalDetail', 'data-feedback-id': 'invoices.gestoria.detalle', 'data-feedback-label': 'Todo el detalle' },
      el('summary', null, el('span', null, 'Todo el detalle'), el('span', { class: 'hint' }, 'IVA por tipo, retenciones, deducibilidad, categorías y emitidas')), summaryHost),
    el('div', { class: 'sectionlabel' }, 'Entregas del año', el('span', { class: 'count', id: 'exportCount' }, '0')),
    exportsHost,
  );

  function summaryBlock(title: string, rows: Array<[string, string]>): HTMLElement {
    return el('article', { class: 'card' }, el('h3', null, title), el('dl', { class: 'kv', 'data-feedback-ignore': '' }, ...rows.flatMap(([k, v]) => [el('dt', null, k), el('dd', null, v)])));
  }

  /** Emitidas del periodo (API.md §13.4): IVA repercutido y diferencia orientativa con el soportado. */
  function issuedTotals(): ReturnType<typeof issuedSummary> | null {
    if (!issued) return null;
    const all = [...issued.linesBy.values()].flat();
    const taxes = [...issued.taxesBy.values()].flat();
    const withFile = new Set([...issued.filesBy.keys()]);
    const t = issuedSummary({ invoices: issued.invoices, lines: all, taxLines: taxes, withFile }, range);
    return t.invoices.registrada || t.invoices.anulada ? t : null;
  }
  function issuedCards(received: FiscalSummary, t: ReturnType<typeof issuedSummary> | null): HTMLElement[] {
    if (!t) return [];
    const balance = Math.round((t.quota - received.vat) * 100) / 100;
    return [
      el('article', { class: 'card', id: 'issuedSummary' }, el('h3', null, 'Emitidas · IVA repercutido'), el('dl', { class: 'kv', 'data-feedback-ignore': '' },
        ...([['Base', eur(t.base)], ['IVA repercutido', eur(t.quota)], ...(t.surcharge ? [['Recargo de equivalencia', eur(t.surcharge)] as [string, string]] : []),
          ...(t.withholding ? [['Retenciones', eur(t.withholding)] as [string, string]] : []), ['Total', eur(t.total)],
          ['Facturas registradas', String(t.invoices.registrada)], ...(t.invoices.anulada ? [['Anuladas', String(t.invoices.anulada)] as [string, string]] : []),
          ...t.quota_by_rate.map((g) => [`${g.tax.toUpperCase()} ${g.rate ?? 0} %`, `${eur(g.base)} → ${eur(g.quota)}`] as [string, string]),
        ] as Array<[string, string]>).flatMap(([k, v]) => [el('dt', null, k), el('dd', null, v)]))),
      el('article', { class: 'card', id: 'vatBalance' }, el('h3', null, 'IVA del periodo'), el('dl', { class: 'kv', 'data-feedback-ignore': '' },
        el('dt', null, 'Repercutido'), el('dd', null, eur(t.quota)),
        el('dt', null, 'Soportado (validadas)'), el('dd', null, eur(received.vat)),
        el('dt', null, balance >= 0 ? 'A ingresar (orientativo)' : 'A compensar (orientativo)'), el('dd', null, eur(Math.abs(balance)))),
        el('p', { class: 'hint' }, 'Orientativo: la deducibilidad y el modelo 303 los decide la gestoría.')),
      ...(t.by_category.length ? [summaryBlock('Ingresos por categoría', t.by_category.map((c) => [c.income_category ? INCOME_CATEGORY_LABELS[c.income_category] : 'Sin categoría', `${eur(c.base)} · ${c.count}`] as [string, string]))] : []),
    ];
  }

  /** Entregas del periodo que se ve (la más nueva primero). */
  function periodExports(m: Mirror): LocalExport[] {
    return m.exports.filter((e) => !e.deleted_at && e.fiscal_year === range.year && (range.kind === 'year' ? e.period_kind === 'year' : e.period_kind === 'quarter' && e.fiscal_quarter === range.quarter))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.code.localeCompare(a.code));
  }
  /** Las facturas de una entrega ya están todas archivadas. */
  function archivedExport(e: LocalExport, m: Mirror): boolean {
    const items = m.itemsByExport.get(e.id) ?? [];
    const byId = new Map(m.invoices.map((i) => [i.id, i]));
    return items.length > 0 && items.every((it) => byId.get(it.invoice_id)?.status === 'archivada');
  }

  function paint(): void {
    if (!mirror) return;
    const m = mirror;
    paintPeriods();
    year.value = String(range.year);
    const withFile = new Set(m.files.filter((f) => f.kind === 'original').map((f) => f.invoice_id));
    const s: FiscalSummary = fiscalSummary({ invoices: m.invoices, taxLines: m.taxes, invoicesWithFile: withFile }, range);
    const t = issuedTotals();
    const exports = periodExports(m);
    const latest = exports[0] ?? null;
    const stale = latest ? isStale(latest, m) : false;
    const state = deliveryState({ pending: s.alerts.pending_invoices.length, ready: s.invoices.validada + s.invoices.archivada,
      latest: latest ? { status: latest.status, stale, archived: archivedExport(latest, m), delivered_to: latest.delivered_to } : null });
    const folder = range.kind === 'year' ? `${range.year}` : `${range.year}_${range.quarter}T`;

    // --- La carpeta: recorrido de la entrega y el ticket --------------------------------------------------------------
    const apps = appEntriesSummary(appEntries, range);
    const hasApps = apps.income.count + apps.expense.count + apps.not_invoiced.count > 0;
    const balance = t || apps.income.count ? Math.round(((t?.quota ?? 0) + apps.income.quota - s.vat) * 100) / 100 : null;
    replace(folderHost,
      el('div', { class: 'inv-folder-head' }, el('h3', null, `Para la gestoría · ${folder}`), el('span', { class: `chip ${state.seal === 'Desfasada' ? 'alert' : state.seal === 'Entregada' || state.seal === 'Archivada' || state.seal === 'Lista' ? 'ok' : 'warn'}`, id: 'deliverySeal' }, state.seal)),
      renderStages({ label: 'Recorrido de la entrega', stages: [...DELIVERY_STAGES], current: state.stage, bad: state.bad, caption: state.caption, feedbackId: 'invoices.gestoria.recorrido',
        onPick: canEdit ? (key) => void pickStage(key as DeliveryStage, latest) : undefined }),
      el('dl', { class: 'inv-ticket', id: 'deliveryTicket', 'data-feedback-ignore': '' },
        el('dt', null, 'Base'), el('dd', null, eur(s.base)),
        el('dt', null, 'IVA soportado'), el('dd', null, eur(s.vat)),
        el('dt', null, 'Retenciones'), el('dd', null, eur(s.withholding)),
        el('dt', null, 'Total facturado'), el('dd', null, eur(s.total)),
        el('dt', null, 'Facturas validadas'), el('dd', null, String(s.invoices.validada + s.invoices.archivada)),
        ...(apps.income.count ? [el('dt', null, 'IVA repercutido de apps'), el('dd', null, eur(apps.income.quota))] : []),
        ...(balance !== null ? [el('dt', null, balance >= 0 ? 'IVA a ingresar (orientativo)' : 'IVA a compensar (orientativo)'), el('dd', null, eur(Math.abs(balance)))] : [])),
      balance !== null ? el('p', { class: 'hint' }, 'Orientativo: la deducibilidad y el modelo 303 los decide la gestoría.') : null,
    );

    // --- Antes de enviarla: cada aviso, con su lista en Facturas ------------------------------------------------------
    const go = (label: string, href: string) => el('button', { 'data-feedback-id': 'invoices.gestoria.alertas.ver', 'data-feedback-label': 'Ver en Facturas', class: 'linkbtn', type: 'button', onclick: () => navigate(href) }, label);
    const alerts: HTMLElement[] = [];
    if (s.alerts.pending_invoices.length) alerts.push(el('div', { class: 'banner warn' }, icon('warn', 18), el('span', null, `${s.alerts.pending_invoices.length} factura${s.alerts.pending_invoices.length === 1 ? '' : 's'} pendiente${s.alerts.pending_invoices.length === 1 ? '' : 's'} de revisión en el periodo: no entrarán en la entrega.`),
      el('button', { 'data-feedback-id': 'invoices.gestoria.alertas.abrir_primera', 'data-feedback-label': 'Abrir la primera', class: 'linkbtn', type: 'button', onclick: () => void openInvoice(ctx, s.alerts.pending_invoices[0]!.id) }, 'Abrir la primera'), go('Ver todas', '#/facturas?filtro=por_resolver')));
    if (s.alerts.discrepancies.length) alerts.push(el('div', { class: 'banner alert' }, icon('warn', 18), el('span', null, `${s.alerts.discrepancies.length} con los importes por revisar.`), go('Verlas', '#/facturas?filtro=pendiente_revision')));
    if (s.alerts.deductibility_unreviewed) alerts.push(el('div', { class: 'banner info' }, icon('info', 18), el('span', null, `${s.alerts.deductibility_unreviewed} validada${s.alerts.deductibility_unreviewed === 1 ? '' : 's'} con deducibilidad sin revisar.`), go('Verlas', '#/facturas?filtro=validada')));
    if (s.alerts.missing_file) alerts.push(el('div', { class: 'banner alert' }, icon('warn', 18), el('span', null, `${s.alerts.missing_file} sin documento original.`), go('Verlas', '#/facturas?filtro=sin_documento')));
    if (s.alerts.unpaid_overdue) alerts.push(el('div', { class: 'banner warn' }, icon('warn', 18), el('span', null, `${s.alerts.unpaid_overdue} vencida${s.alerts.unpaid_overdue === 1 ? '' : 's'} sin pagar.`), go('Verlas', '#/facturas?filtro=sin_pagar')));
    replace(alertsHost, ...(alerts.length ? [el('div', { class: 'sectionlabel' }, 'Antes de enviarla'), ...alerts] : []));

    // --- Qué cambió (desfasada) ---------------------------------------------------------------------------------------
    replace(changedHost, ...(latest && stale ? [el('div', { class: 'sectionlabel' }, 'Qué cambió desde la entrega'), el('ul', { class: 'plain', 'data-feedback-ignore': '' }, ...staleReasons(latest, m).map((r) => el('li', null, r)))] : []));

    // --- Barra fija: la acción que toca, una sola en primario; preparar (editor) y descargar la última, siempre ----------
    const next = nextStep(state.stage, latest, s.alerts.pending_invoices.length);
    if (prepare) prepare.className = next === 'preparar' ? 'primary' : 'softbtn';
    downloadLatest.hidden = !latest;
    downloadLatest.className = next === 'descargar' ? 'primary' : 'softbtn';
    downloadLatest.onclick = latest ? () => openDownloads(latest) : null;
    nextAction.hidden = next !== 'resolver' && next !== 'archivar';
    replace(nextAction, ...(next === 'resolver' ? [icon('check', 18), 'Resolver las pendientes'] : next === 'archivar' ? [icon('briefcase', 18), 'Archivar periodo'] : []));
    nextAction.onclick = next === 'resolver' ? () => navigate('#/facturas?filtro=por_resolver') : next === 'archivar' && latest ? () => void archivePeriod(latest) : null;

    // --- Todo el detalle --------------------------------------------------------------------------------------------
    replace(summaryHost,
      el('div', { class: 'cardgrid' },
        summaryBlock(rangeLabel(range), [['Base', eur(s.base)], ['IVA soportado', eur(s.vat)], ...(s.other ? [['Otros tributos', eur(s.other)] as [string, string]] : []), ['Retenciones', eur(s.withholding)], ['Total facturado', eur(s.total)], ['Facturas validadas', String(s.invoices.validada + s.invoices.archivada)]]),
        summaryBlock('IVA por tipo', s.vat_by_rate.length ? s.vat_by_rate.map((g) => [`${g.rate} %`, `${eur(g.base)} → ${eur(g.amount)}`] as [string, string]) : [['—', 'Sin IVA registrado']]),
        summaryBlock('Explotación e inversión', [['Gasto de explotación', `${eur(s.operating.base)} (${s.operating.count})`], ['Inversión', `${eur(s.investment.base)} (${s.investment.count})`]]),
        summaryBlock('Deducibilidad (base)', Object.entries(s.deductibility).map(([k, v]) => [DEDUCTIBILITY_LABELS[k] ?? k, eur(v)] as [string, string])),
        summaryBlock('Por categoría', s.by_category.length ? s.by_category.map((g) => [`${categoryName(g.expense_category)}${g.is_investment ? ' (inv.)' : ''}`, `${eur(g.base)} · ${g.count}`] as [string, string]) : [['—', 'Nada validado']]),
        s.withholdings_by_type.length ? summaryBlock('Retenciones', s.withholdings_by_type.map((g) => [`${TAX_TYPE_LABELS[g.tax_type] ?? g.tax_type}${g.rate !== null ? ` ${g.rate} %` : ''}`, eur(g.amount)] as [string, string])) : null,
        ...issuedCards(s, t),
        hasApps ? el('article', { class: 'card', id: 'appEntriesSummary' }, el('h3', null, 'Ingresos y gastos de apps'), el('dl', { class: 'kv', 'data-feedback-ignore': '' },
          el('dt', null, 'Ingresos facturados'), el('dd', null, `${eur(apps.income.total)} (${apps.income.count})`),
          el('dt', null, 'Base'), el('dd', null, eur(apps.income.base)),
          el('dt', null, 'IVA repercutido'), el('dd', null, eur(apps.income.quota)),
          ...apps.income.quota_by_rate.map((g) => [el('dt', null, `IVA ${g.rate} %`), el('dd', null, `${eur(g.base)} → ${eur(g.quota)}`)]).flat(),
          ...(apps.expense.count ? [el('dt', null, 'Gastos facturados'), el('dd', null, `${eur(apps.expense.total)} (${apps.expense.count})`)] : []),
          el('dt', null, 'Sin facturar (fuera de la entrega)'), el('dd', null, `${apps.not_invoiced.count} · ${eur(apps.not_invoiced.income - apps.not_invoiced.expense)}`)),
          el('p', null, el('button', { 'data-feedback-id': 'invoices.gestoria.apuntes.ver', 'data-feedback-label': 'Ver los ingresos de apps', class: 'linkbtn', type: 'button', onclick: () => navigate('#/apuntes') }, 'Ver los apuntes'))) : null,
      ),
    );

    // --- Entregas del año, por trimestre ------------------------------------------------------------------------------
    paintTimeline(m);
  }

  /**
   * Lo que toca con el periodo, para la barra: resolver si hay pendientes y nada validado que entregar; preparar (editor);
   * descargar la preparada para enviarla; archivar la entregada (solo el dueño).
   */
  function nextStep(stage: DeliveryStage, latest: LocalExport | null, pending: number): 'resolver' | 'preparar' | 'descargar' | 'archivar' | null {
    if (stage === 'validar') return pending && canEdit ? 'resolver' : null;
    if (stage === 'preparar') return canEdit ? 'preparar' : latest ? 'descargar' : null;
    if (stage === 'enviar') return 'descargar';
    if (stage === 'entregada') return isOwner ? 'archivar' : null;
    return null;
  }

  /** La acción principal de una entrega: la que toca según su estado; el resto, en «Más». */
  function mainOf(e: LocalExport, m: Mirror): 'entregar' | 'archivar' | 'descargar' {
    if (canEdit && e.status !== 'entregada') return 'entregar';
    if (isOwner && e.status === 'entregada' && !archivedExport(e, m)) return 'archivar';
    return 'descargar';
  }

  function exportRow(e: LocalExport, m: Mirror): ListRowSpec {
    const stale = isStale(e, m);
    const primary = mainOf(e, m);
    return {
      id: e.id,
      title: `${e.code} · ${e.folder_name}`,
      meta: [`${e.invoice_count} factura${e.invoice_count === 1 ? '' : 's'}`, shortDate(e.created_at), `hash ${e.manifest_sha256.slice(0, 12)}…`, e.delivered_to ? `entregada: ${e.delivered_to}` : ''].filter(Boolean),
      chips: [el('span', { class: e.status === 'entregada' ? 'chip ok' : 'chip' }, e.status === 'entregada' ? 'Entregada' : 'Generada'), stale ? el('span', { class: 'chip alert' }, 'Desfasada') : null, archivedExport(e, m) ? el('span', { class: 'chip' }, 'Archivada') : null],
      pending: e._pending === true,
      actions: [
        primary === 'entregar' ? el('button', { 'data-feedback-id': 'invoices.gestoria.entregas.marcar_entregada', 'data-feedback-label': 'Marcar entregada', class: 'softbtn small', type: 'button', onclick: () => void markDelivered(e) }, icon('check', 16), 'Marcar entregada')
          : primary === 'archivar' ? el('button', { 'data-feedback-id': 'invoices.gestoria.entregas.archivar', 'data-feedback-label': 'Archivar periodo', class: 'softbtn small', type: 'button', onclick: () => void archivePeriod(e) }, icon('briefcase', 16), 'Archivar periodo')
            : el('button', { 'data-feedback-id': 'invoices.gestoria.entregas.descargar', 'data-feedback-label': 'Descargar', class: 'softbtn small', type: 'button', onclick: () => openDownloads(e) }, icon('download', 16), 'Descargar'),
        // ZIP, CSV, Manifest y la huella (y, para el dueño, archivar si no es la principal), en «Más»
        primary !== 'descargar' ? el('button', { 'data-feedback-id': 'invoices.gestoria.entregas.mas', 'data-feedback-label': 'Más', class: 'linkbtn', type: 'button', 'aria-label': `Más de ${e.code}`, onclick: () => openDownloads(e) }, 'Más') : null,
      ],
    };
  }

  /** Un trimestre por fila: el cerrado con su estado y su total; el actual, en curso; el siguiente, abierto. Cada uno despliega todas sus entregas. */
  function paintTimeline(m: Mirror): void {
    const all = m.exports.filter((e) => !e.deleted_at && e.fiscal_year === range.year).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.code.localeCompare(a.code));
    main.querySelector('#exportCount')!.textContent = String(all.length);
    const today = periodOfDate(new Date().toISOString().slice(0, 10)) ?? '';
    const slot = (label: string, list: LocalExport[], period: string | null) => {
      const latest = list[0] ?? null;
      const where = period === null ? '' : period < today ? 'cerrado' : period === today ? 'en curso' : 'abierto';
      const totals = latest?.totals as { total?: number } | undefined;
      const status = latest ? (isStale(latest, m) ? 'Desfasada' : archivedExport(latest, m) ? 'Archivada' : latest.status === 'entregada' ? 'Entregada' : 'Preparada') : where === 'cerrado' ? 'Sin entrega' : where === 'en curso' ? 'En curso' : where === 'abierto' ? 'Abierto' : 'Sin entrega';
      return el('details', { class: 'inv-block inv-quarter', dataset: { period: label } },
        el('summary', null, el('span', null, label), el('span', { class: 'hint' }, [status, totals?.total !== undefined ? eur(totals.total) : null, list.length > 1 ? `${list.length} entregas` : null].filter(Boolean).join(' · '))),
        list.length
          ? fbRows(renderList({ label: `Entregas de ${label}`, rows: list.map((e) => exportRow(e, m)) }), { feedbackId: 'invoices.gestoria.entregas.lista', feedbackLabel: 'Lista de entregas' }, { feedbackId: 'invoices.gestoria.entregas.fila', feedbackLabel: 'Entrega' })
          : el('p', { class: 'hint' }, canEdit && where !== 'abierto' ? 'Sin entregas. Cuando el periodo esté validado, «Preparar entrega».' : 'Sin entregas.'));
    };
    const quarters = [1, 2, 3, 4].map((q) => slot(`${q}T ${range.year}`, all.filter((e) => e.period_kind === 'quarter' && e.fiscal_quarter === q), `${range.year}T${q}`));
    const yearly = all.filter((e) => e.period_kind === 'year');
    replace(exportsHost, el('div', { class: 'inv-timeline' }, ...quarters, ...(yearly.length ? [slot(`Año ${range.year}`, yearly, null)] : [])));
    // Abierto el trimestre que se ve, para tener a mano sus entregas
    const open = exportsHost.querySelector<HTMLDetailsElement>(`[data-period="${range.kind === 'year' ? `Año ${range.year}` : `${range.quarter}T ${range.year}`}"]`);
    if (open) open.open = true;
  }

  /** Lo que hace cada etapa del recorrido. */
  async function pickStage(stage: DeliveryStage, latest: LocalExport | null): Promise<void> {
    if (stage === 'validar') { navigate('#/facturas?filtro=por_resolver'); return; }
    if (stage === 'preparar') { await prepareExport(); return; }
    if (!latest) { toast('Antes, prepara la entrega.'); return; }
    if (stage === 'enviar') { openDownloads(latest); return; }
    if (stage === 'entregada') { if (latest.status === 'entregada') toast(`Ya está entregada${latest.delivered_to ? `: ${latest.delivered_to}` : ''}.`); else await markDelivered(latest); return; }
    if (!isOwner) { toast('Archivar el periodo es solo del dueño.'); return; }
    if (latest.status !== 'entregada') { toast('Antes, marca la entrega como entregada.'); return; }
    await archivePeriod(latest);
  }

  /** «Descargar» y «Más»: una hoja con el ZIP, el CSV y el manifest, la huella y las otras acciones de la entrega. */
  function openDownloads(e: LocalExport): void {
    const m = mirror;
    const sheetOffline: Array<() => void> = [];
    const button = (mark: [string, string], label: string, path: string, file: string) => {
      const b = el('button', { 'data-feedback-id': mark[0], 'data-feedback-label': mark[1], class: 'softbtn', type: 'button', onclick: () => void download(path, file) }, icon('download', 18), label);
      sheetOffline.push(bindOnline(b, { client, reason: 'Descargar necesita conexión.' }));
      return b;
    };
    const primary = m ? mainOf(e, m) : 'descargar';
    // Lo que no es la acción principal de la fila: marcar entregada (editor) y archivar (solo el dueño, con su diálogo)
    const others = [
      canEdit && e.status !== 'entregada' && primary !== 'entregar' ? el('button', { 'data-feedback-id': 'invoices.gestoria.entregas.mas.marcar_entregada', 'data-feedback-label': 'Marcar entregada', class: 'ghost', type: 'button', onclick: () => { void closeSheet(); void markDelivered(e); } }, 'Marcar entregada') : null,
      m && isOwner && e.status === 'entregada' && !archivedExport(e, m) && primary !== 'archivar' ? el('button', { 'data-feedback-id': 'invoices.gestoria.entregas.mas.archivar', 'data-feedback-label': 'Archivar periodo', class: 'ghost', type: 'button', onclick: () => { void closeSheet(); void archivePeriod(e); } }, 'Archivar periodo') : null,
    ].filter(Boolean);
    openSheet({
      title: `Descargar ${e.folder_name}`,
      meta: `${e.code} · ${e.invoice_count} factura${e.invoice_count === 1 ? '' : 's'} · ${e.status === 'entregada' ? 'entregada' : 'generada'} el ${shortDate(e.created_at)}`,
      body: el('div', { id: 'downloadSheet' },
        el('p', { class: 'btnrow' },
          button(['invoices.gestoria.entregas.zip', 'ZIP'], 'ZIP con todo', `/exports/${e.id}/download`, `${e.folder_name}.zip`),
          button(['invoices.gestoria.entregas.csv', 'CSV'], 'CSV de recibidas', `/exports/${e.id}/facturas_recibidas.csv`, `${e.folder_name}_facturas_recibidas.csv`),
          button(['invoices.gestoria.entregas.manifest', 'Manifest'], 'Manifest', `/exports/${e.id}/manifest.json`, `${e.folder_name}_manifest.json`)),
        el('p', { class: 'hint', 'data-feedback-ignore': '' }, `Huella del manifest: ${e.manifest_sha256}`),
        others.length ? el('p', { class: 'btnrow' }, ...others) : null),
      foot: [el('button', { class: 'primary', type: 'button', onclick: () => void closeSheet() }, 'Cerrar')],
      onClose: () => { for (const off of sheetOffline) off(); },
    });
  }

  function isStale(e: LocalExport, m: Mirror): boolean {
    return staleReasons(e, m).length > 0;
  }
  /** Qué cambió desde la entrega: facturas cambiadas, anuladas o que ya no están, y las que entraron después. */
  function staleReasons(e: LocalExport, m: Mirror): string[] {
    const items = m.itemsByExport.get(e.id) ?? [];
    const byId = new Map(m.invoices.map((i) => [i.id, i]));
    const out: string[] = [];
    for (const it of items) {
      const inv = byId.get(it.invoice_id);
      if (!inv) out.push(`${it.invoice_code}: una factura de la entrega ya no está en este dispositivo`);
      else if (inv.status === 'anulada') out.push(`${it.invoice_code}: anulada después de la entrega`);
      else if (inv.revision !== it.invoice_revision) out.push(`${it.invoice_code}: cambió después de la entrega`);
    }
    const included = new Set(items.map((it) => it.invoice_id));
    for (const i of m.invoices) {
      if (!i.deleted_at && (i.status === 'validada' || i.status === 'archivada') && i.invoice_date !== null && i.invoice_date >= e.from_date && i.invoice_date <= e.to_date && !included.has(i.id)) out.push(`${i.code ?? 'Una factura'}: validada después de la entrega`);
    }
    return out;
  }

  async function download(path: string, filename: string): Promise<void> {
    if (!navigator.onLine) { toast('La descarga necesita conexión.'); return; }
    try { await usage.run('invoices.gestoria.descargar', () => downloadWithSession(client, path, filename)); } catch (error) { toast(describeError(error)); }
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
      await usage.run('invoices.gestoria.generar_entrega', () => client.commit([{ op: 'call', procedure: 'invoices.create_export', args: { export_id: crypto.randomUUID(), period_kind: kind, fiscal_year: range.year, fiscal_quarter: range.quarter } }]));
      toast('Entrega generada. Descarga el ZIP cuando se confirme.');
    } catch (error) { toast(describeError(error)); }
  }

  async function markDelivered(e: LocalExport): Promise<void> {
    const to = el('input', { 'data-feedback-id': 'invoices.gestoria.entregas.como_se_entrego', 'data-feedback-label': 'Cómo se entregó', type: 'text', maxlength: '300', placeholder: 'Correo a la gestoría el 7 de abril' });
    const ok = await confirmDialog({ title: `Marcar ${e.code} como entregada`, text: el('label', { class: 'field' }, el('span', null, 'Cómo se entregó'), to), confirmLabel: 'Entregada' });
    if (!ok) return;
    try { await client.commit([{ op: 'call', procedure: 'invoices.mark_delivered', args: { export_id: e.id, expectedRevision: e.revision, delivered_to: to.value.trim() || null } }]); toast('Entrega marcada como entregada.'); } catch (error) { toast(describeError(error)); }
  }

  async function archivePeriod(e: LocalExport): Promise<void> {
    const ok = await confirmDialog({ title: `Archivar las facturas de ${e.folder_name}`, text: 'Las facturas validadas incluidas en la entrega pasan a archivadas: solo se podrán tocar pago y notas.', confirmLabel: 'Archivar', danger: true });
    if (!ok) return;
    try { await usage.run('invoices.gestoria.archivar_periodo', () => client.commit([{ op: 'call', procedure: 'invoices.archive_period', args: { export_id: e.id } }])); toast('Periodo archivado.'); } catch (error) { toast(describeError(error)); }
  }

  async function load(): Promise<void> { [mirror, issued, appEntries] = await Promise.all([loadMirror(client), loadIssued(client), client.list(APP_ENTRIES) as unknown as Promise<LocalAppEntry[]>]); paint(); }
  const off = onAnyTable(client, () => void load());
  void load();
  return () => { off(); for (const o of offline) o(); };
};
