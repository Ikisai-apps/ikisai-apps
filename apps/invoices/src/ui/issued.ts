/**
 * Facturas emitidas registradas (API.md §13): lista por mes, ficha y alta manual. Se registran las expedidas con otra
 * herramienta (libro registro de expedidas); la emisión desde la app con Verifactu queda preparada en el modelo.
 * Sin papelera: una emitida se anula con motivo y su número sigue ocupado.
 */
import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import { closeSheet, confirmDialog, el, icon, openSheet, renderList, replace, toast, type ListRowSpec, type Sheet } from '@ikisai/ui-kit';
import {
  INCOME_CATEGORIES, INCOME_CATEGORY_LABELS, ISSUED_ORIGIN_LABELS, ISSUED_TYPES, ISSUED_TYPE_LABELS, RECTIFICATION_KIND_LABELS,
  breakdownFromLines, fullNumber, isRectificative, recalculateIssued, recipientOptional,
} from '@ikisai/domain-invoices';
import {
  ISSUED_ALLOCATIONS, ISSUED_FILES, ISSUED_INVOICES, ISSUED_LINES, ISSUED_SERIES, ISSUED_TAX_LINES,
  type LocalIssuedAllocation, type LocalIssuedFile, type LocalIssuedInvoice, type LocalIssuedLine, type LocalIssuedSeries, type LocalIssuedTaxLine,
} from '../app/client.ts';
import { eur, monthKey, monthLabel, onAnyTable, parseAmount, shortDate, todayIso } from '../app/data.ts';
import { ACCEPT_ATTR, formatBytes, openFile, stageDocument } from '../app/files.ts';
import { guard } from '../app/guard.ts';
import { searchTargets, targetLabel, type TargetChoice } from '../app/targets.ts';
import { block, commitSafely, field, select } from './common.ts';
import type { ViewContext } from './shell.ts';

interface IssuedData {
  series: LocalIssuedSeries[];
  invoices: LocalIssuedInvoice[];
  linesBy: Map<string, LocalIssuedLine[]>;
  taxesBy: Map<string, LocalIssuedTaxLine[]>;
  filesBy: Map<string, LocalIssuedFile[]>;
  allocationsBy: Map<string, LocalIssuedAllocation[]>;
}

const NEW_SERIES = '__new__';

function by<T extends { deleted_at: string | null }>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) { if (row.deleted_at) continue; const k = key(row); map.set(k, [...(map.get(k) ?? []), row]); }
  return map;
}

export async function loadIssued(client: SyncClient): Promise<IssuedData> {
  const [series, invoices, lines, taxes, files, allocations] = await Promise.all([
    client.list(ISSUED_SERIES) as Promise<LocalIssuedSeries[]>,
    client.list(ISSUED_INVOICES, { includeDeleted: true }) as Promise<LocalIssuedInvoice[]>,
    client.list(ISSUED_LINES) as Promise<LocalIssuedLine[]>,
    client.list(ISSUED_TAX_LINES) as Promise<LocalIssuedTaxLine[]>,
    client.list(ISSUED_FILES) as Promise<LocalIssuedFile[]>,
    client.list(ISSUED_ALLOCATIONS) as Promise<LocalIssuedAllocation[]>,
  ]);
  const linesBy = by(lines, (l) => l.issued_invoice_id);
  for (const list of linesBy.values()) list.sort((a, b) => a.position - b.position);
  return { series, invoices, linesBy, taxesBy: by(taxes, (t) => t.issued_invoice_id), filesBy: by(files, (f) => f.issued_invoice_id), allocationsBy: by(allocations, (a) => a.issued_invoice_id) };
}

const numberOf = (i: LocalIssuedInvoice) => i.full_number || fullNumber(i.series_code, i.number);
const recipientOf = (i: LocalIssuedInvoice) => i.recipient_name || 'Sin destinatario';

// ---------------------------------------------------------------------------
// Lista (pestaña «Emitidas» de Facturas)
// ---------------------------------------------------------------------------
export function renderIssuedPanel(ctx: ViewContext): { element: HTMLElement; destroy: () => void } {
  const { client } = ctx;
  const canEdit = client.bootstrap()?.membership.role !== 'reader';
  let data: IssuedData | null = null;
  let query = '';
  let filter = 'activas';
  let opened: { id: string; sheet: Sheet } | null = null;
  const search = el('input', { type: 'search', id: 'issuedSearch', placeholder: 'Número, cliente o concepto', 'aria-label': 'Buscar emitidas', autocomplete: 'off',
    oninput: () => { query = search.value.trim().toLowerCase(); paint(); } });
  const statusSelect = select('issuedFilter', [['activas', 'Registradas'], ['anulada', 'Anuladas'], ['pendientes', 'Sin cobrar'], ['revisar', 'Revisar importes']], filter,
    { 'aria-label': 'Filtrar emitidas', onchange: () => { filter = statusSelect.value; paint(); } });
  const list = el('div', { id: 'issuedList' });
  const newButton = el('button', { class: 'fab', type: 'button', id: 'newIssued', hidden: !canEdit, onclick: () => data && openNewIssued(ctx, data) }, icon('plus'), 'Nueva emitida');
  const element = el('div', { id: 'issuedPanel' },
    el('p', { class: 'hint' }, 'Registro de las facturas que emites con otra herramienta: IVA repercutido, gestoría e ingreso por reserva.'),
    el('div', { class: 'toolbar' }, el('div', { class: 'search' }, search), statusSelect), list, newButton);

  function visible(i: LocalIssuedInvoice): boolean {
    if (i.deleted_at) return false;
    const hay = [numberOf(i), i.recipient_name ?? '', i.recipient_tax_id ?? '', i.description].join(' ').toLowerCase();
    if (query && !hay.includes(query)) return false;
    switch (filter) {
      case 'anulada': return i.status === 'anulada';
      case 'pendientes': return i.status !== 'anulada' && i.payment_status !== 'cobrada';
      case 'revisar': return i.status !== 'anulada' && i.review_reason === 'REVISAR IMPORTES';
      default: return i.status !== 'anulada';
    }
  }

  function paint(): void {
    if (!data) return;
    const rows = data.invoices.filter(visible).sort((a, b) => b.issue_date.localeCompare(a.issue_date) || numberOf(b).localeCompare(numberOf(a)));
    if (!rows.length) {
      replace(list, el('div', { class: 'empty' }, el('strong', null, data.invoices.length ? 'Ninguna emitida coincide' : 'Todavía no hay facturas emitidas'),
        data.invoices.length ? 'Cambia el filtro o la búsqueda.' : 'Registra con «Nueva emitida» las facturas que expides con tu herramienta de facturación.'));
      return;
    }
    const groups = new Map<string, LocalIssuedInvoice[]>();
    for (const i of rows) { const k = monthKey(i.issue_date); groups.set(k, [...(groups.get(k) ?? []), i]); }
    replace(list, ...[...groups.entries()].map(([key, items]) => el('section', null,
      el('div', { class: 'sectionlabel' }, monthLabel(key), el('span', { class: 'count' }, String(items.length))),
      renderList({ label: `Emitidas de ${monthLabel(key)}`, rows: items.map((i): ListRowSpec => {
        const chips = [el('span', { class: 'chip' }, i.invoice_type)];
        if (i.status === 'anulada') chips.push(el('span', { class: 'chip alert' }, 'Anulada'));
        if (i.review_reason === 'REVISAR IMPORTES') chips.push(el('span', { class: 'chip alert' }, 'Revisar importes'));
        if (i.payment_status === 'cobrada') chips.push(el('span', { class: 'chip ok' }, 'Cobrada'));
        return { id: i.id, title: `${numberOf(i)} · ${recipientOf(i)}`, meta: [shortDate(i.issue_date), i.description, eur(i.total)], chips, pending: i._pending === true,
          onClick: () => void open(i.id), label: `Abrir ${numberOf(i)}` };
      }) }),
    )));
  }

  async function open(id: string): Promise<void> {
    data = await loadIssued(client);
    const invoice = data.invoices.find((i) => i.id === id);
    if (!invoice) { toast('La factura no está en este dispositivo.'); return; }
    const sheet = openSheet({
      title: `${numberOf(invoice)} · ${recipientOf(invoice)}`,
      meta: `${ISSUED_TYPE_LABELS[invoice.invoice_type] ?? invoice.invoice_type} · revisión ${invoice.revision}${invoice._pending ? ' · pendiente de sincronizar' : ''}`,
      body: el('div', { id: 'issuedSheet' }, renderIssued(ctx, invoice, data, (reopen) => void open(reopen))),
      foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void closeSheet() }, 'Cerrar')],
      onClose: () => { if (opened?.id === id) opened = null; },
    });
    opened = { id, sheet };
  }

  async function load(): Promise<void> {
    data = await loadIssued(client);
    paint();
    if (opened) {
      const invoice = data.invoices.find((i) => i.id === opened!.id);
      if (invoice) replace(opened.sheet.body, el('div', { id: 'issuedSheet' }, renderIssued(ctx, invoice, data, (reopen) => void open(reopen))));
    }
  }
  const off = onAnyTable(client, () => void load());
  void load();
  return { element, destroy: off };
}

// ---------------------------------------------------------------------------
// Ficha
// ---------------------------------------------------------------------------
function renderIssued(ctx: ViewContext, invoice: LocalIssuedInvoice, data: IssuedData, reopen: (id: string) => void): HTMLElement {
  const { client } = ctx;
  const canEdit = client.bootstrap()?.membership.role !== 'reader' && invoice.status !== 'anulada';
  const lines = data.linesBy.get(invoice.id) ?? [];
  const taxes = data.taxesBy.get(invoice.id) ?? [];
  const files = data.filesBy.get(invoice.id) ?? [];
  const allocations = data.allocationsBy.get(invoice.id) ?? [];
  const actions: HTMLElement[] = [];
  if (canEdit) {
    actions.push(el('button', { class: 'softbtn', type: 'button', id: 'toggleCollected', onclick: () => void toggleCollected() }, icon('check', 18), invoice.payment_status === 'cobrada' ? 'Marcar sin cobrar' : 'Marcar cobrada'));
    actions.push(el('button', { class: 'danger', type: 'button', id: 'annulIssued', onclick: () => void annul() }, icon('trash', 18), 'Anular'));
  }

  async function toggleCollected(): Promise<void> {
    const fields = invoice.payment_status === 'cobrada' ? { payment_status: 'pendiente', paid_at: null } : { payment_status: 'cobrada', paid_at: todayIso() };
    await commitSafely(client, [{ op: 'update', table: ISSUED_INVOICES, id: invoice.id, expectedRevision: invoice.revision, fields }], invoice.payment_status === 'cobrada' ? 'Marcada sin cobrar.' : 'Marcada como cobrada.');
  }

  async function annul(): Promise<void> {
    const reason = el('input', { type: 'text', id: 'annulIssuedReason', maxlength: '500', placeholder: 'Emitida por error, sustituida…' });
    const ok = await confirmDialog({ title: `¿Anular ${numberOf(invoice)}?`, text: el('div', null,
      el('p', null, 'Queda en el registro como anulada y fuera de los resúmenes. Su número sigue ocupado. Si la corriges, registra la rectificativa.'), field('Motivo', reason)),
      confirmLabel: 'Anular', danger: true });
    if (!ok) return;
    if (!reason.value.trim()) { toast('Indica el motivo de la anulación.'); return; }
    await commitSafely(client, [{ op: 'call', procedure: 'invoices.annul_issued', args: { issued_invoice_id: invoice.id, expectedRevision: invoice.revision, reason: reason.value.trim() } }], 'Factura emitida anulada.');
  }

  const recipient = [invoice.recipient_name, invoice.recipient_tax_id].filter(Boolean).join(' · ') || 'Sin destinatario (simplificada)';
  return el('div', null,
    actions.length ? el('div', { class: 'btnrow' }, ...actions) : null,
    invoice.status === 'anulada' ? el('div', { class: 'banner alert' }, icon('warn', 18), el('span', null, `Anulada: ${invoice.annulled_reason ?? ''}`)) : null,
    invoice.review_reason === 'REVISAR IMPORTES' ? el('div', { class: 'banner warn', id: 'issuedReview' }, icon('warn', 18), el('span', null, `El total del documento no cuadra con el desglose (diferencia ${eur(Number(invoice.totals_delta ?? 0))}).`)) : null,
    el('div', { class: 'inv-totals' },
      el('div', null, el('span', null, 'Base'), el('strong', null, eur(invoice.base_total))),
      el('div', null, el('span', null, 'Cuotas'), el('strong', null, eur(Number(invoice.quota_total) + Number(invoice.surcharge_total)))),
      el('div', null, el('span', null, 'Retenciones'), el('strong', null, eur(invoice.withholding_total))),
      el('div', { class: 'total' }, el('span', null, 'TOTAL'), el('strong', { id: 'issuedTotal' }, eur(invoice.total)))),
    block('Datos', shortDate(invoice.issue_date), true,
      el('dl', { class: 'inv-dl' },
        el('dt', null, 'Número'), el('dd', null, numberOf(invoice)),
        el('dt', null, 'Tipo'), el('dd', null, ISSUED_TYPE_LABELS[invoice.invoice_type] ?? invoice.invoice_type),
        isRectificative(invoice.invoice_type) ? el('dt', null, 'Rectifica') : null,
        isRectificative(invoice.invoice_type) ? el('dd', null, `${invoice.rectified.map((r) => fullNumber(r.series ?? '', r.number)).join(', ')} · ${RECTIFICATION_KIND_LABELS[invoice.rectification_kind ?? ''] ?? ''} · ${invoice.rectification_reason ?? ''}`) : null,
        el('dt', null, 'Fecha'), el('dd', null, shortDate(invoice.issue_date) + (invoice.operation_date && invoice.operation_date !== invoice.issue_date ? ` (operación ${shortDate(invoice.operation_date)})` : '')),
        el('dt', null, 'Destinatario'), el('dd', null, recipient),
        el('dt', null, 'Concepto'), el('dd', null, invoice.description),
        el('dt', null, 'Ingreso'), el('dd', null, invoice.income_category ? INCOME_CATEGORY_LABELS[invoice.income_category] : 'Sin categoría'),
        el('dt', null, 'Cobro'), el('dd', null, invoice.payment_status === 'cobrada' ? `Cobrada${invoice.paid_at ? ` el ${shortDate(invoice.paid_at)}` : ''}` : 'Sin cobrar'),
      )),
    block('Líneas', String(lines.length), true, lines.length
      ? el('div', { class: 'list plain-lines', id: 'issuedLines' }, ...lines.map((l) => el('div', { class: 'line-row' },
        el('div', { class: 'line-main' }, el('span', { class: 'line-desc' }, l.description)),
        el('div', { class: 'line-nums' }, el('strong', null, eur(l.net_amount)), el('span', null, l.vat_rate === null ? 'sin IVA' : `IVA ${Number(l.vat_rate)} %`)))))
      : el('p', { class: 'hint' }, 'Sin líneas.')),
    block('Desglose', String(taxes.length), false, taxes.length
      ? el('table', { class: 'inv-table' }, el('tbody', null, ...taxes.map((t) => el('tr', null, el('td', null, `${t.tax.toUpperCase()} ${t.rate === null ? '' : `${Number(t.rate)} %`}`), el('td', { class: 'num' }, eur(Number(t.taxable_base ?? 0))), el('td', { class: 'num' }, eur(t.quota))))))
      : el('p', { class: 'hint' }, 'Calculado desde las líneas.')),
    block('Documento', files.length ? String(files.length) : 'ninguno', true, files.length
      ? renderList({ label: 'Documentos', rows: files.map((f) => ({ id: f.id, title: f.normalized_filename ?? f.original_filename, meta: [formatBytes(Number(f.size_bytes)), f.original_filename], pending: f._pending === true,
        actions: [el('button', { class: 'linkbtn', type: 'button', onclick: () => openFile(client, f.file_id).catch(() => toast('No se pudo abrir el documento.')) }, icon('eye', 16), 'Ver')] })) })
      : el('p', { class: 'hint' }, 'Sin documento.')),
    block('Destino del ingreso', allocations.length ? String(allocations.length) : 'sin asignar', allocations.length > 0 || canEdit,
      allocations.length
        ? el('ul', { class: 'alloc-list', id: 'issuedAllocations' }, ...allocations.map((a) => el('li', null, el('span', null, `${a.target_label} · ${eur(a.allocated_amount)}`),
          canEdit ? el('button', { class: 'x', type: 'button', 'aria-label': `Quitar ${a.target_label}`, onclick: () => void commitSafely(client, [{ op: 'delete', table: ISSUED_ALLOCATIONS, id: a.id, expectedRevision: a.revision }], 'Asignación quitada.') }, '×') : null)))
        : el('p', { class: 'hint' }, 'Sin reserva ni evento asignado.'),
      canEdit && remaining(invoice, allocations) > 0 ? el('div', { class: 'btnrow' }, el('button', { class: 'softbtn', type: 'button', id: 'assignIssued', onclick: () => openIssuedAllocation(ctx, invoice, allocations, () => reopen(invoice.id)) }, icon('plus', 18), 'Asignar a reserva o evento')) : null),
    block('Verifactu', invoice.origin === 'app' ? (invoice.vf_status ?? 'pendiente') : 'otra herramienta', false,
      el('p', { class: 'hint' }, invoice.origin === 'app'
        ? 'Emitida desde la app: registro Verifactu.'
        : `${ISSUED_ORIGIN_LABELS[invoice.origin] ?? invoice.origin}. El registro Verifactu lo hace la herramienta que la expidió; aquí queda en el libro registro de expedidas.`)),
  );
}

// ---------------------------------------------------------------------------
// Destino del ingreso: reserva o evento de Booking (o general), resuelto en la Edge con el token del usuario
// ---------------------------------------------------------------------------
function remaining(invoice: LocalIssuedInvoice, allocations: LocalIssuedAllocation[]): number {
  const used = allocations.reduce((acc, a) => acc + Math.round(Number(a.allocated_amount) * 100), 0);
  return Math.max(0, Math.round(Number(invoice.base_total) * 100) - used) / 100;
}

function openIssuedAllocation(ctx: ViewContext, invoice: LocalIssuedInvoice, allocations: LocalIssuedAllocation[], done: () => void): void {
  const { client } = ctx;
  const rest = remaining(invoice, allocations);
  let kind: 'reservation' | 'event' | 'general' = 'reservation';
  let choice: TargetChoice | null = null;
  const kinds = el('div', { class: 'segmented', role: 'tablist' }, ...([['reservation', 'Reserva'], ['event', 'Evento'], ['general', 'General']] as Array<[typeof kind, string]>).map(([value, label]) =>
    el('button', { type: 'button', role: 'tab', class: value === kind ? 'on' : '', dataset: { kind: value }, onclick: () => { kind = value; choice = null; paintKind(); } }, label)));
  const query = el('input', { type: 'search', id: 'issuedTargetSearch', placeholder: 'Buscar por huésped, código o fecha…', autocomplete: 'off' });
  const results = el('div', { id: 'issuedTargetResults' });
  const chosen = el('p', { class: 'hint', id: 'issuedChosenTarget' });
  const amount = el('input', { type: 'text', inputmode: 'decimal', id: 'issuedAllocAmount', value: String(rest).replace('.', ',') });
  const error = el('p', { class: 'formerror', role: 'alert' });
  let timer: ReturnType<typeof setTimeout> | null = null;

  function paintKind(): void {
    for (const b of Array.from(kinds.querySelectorAll('button'))) b.classList.toggle('on', b.dataset.kind === kind);
    query.hidden = kind === 'general';
    chosen.textContent = kind === 'general' ? 'Ingreso general, sin reserva.' : '';
    replace(results);
    if (kind !== 'general') void search();
  }
  async function search(): Promise<void> {
    if (!navigator.onLine) { replace(results, el('p', { class: 'hint' }, 'Buscar reservas necesita conexión.')); return; }
    try {
      const items = await searchTargets(client, 'booking', query.value.trim(), kind);
      replace(results, items.length ? renderList({ label: 'Destinos', rows: items.map((t) => ({ id: t.id, title: targetLabel(t), meta: [t.code ?? ''], label: `Elegir ${t.label}`,
        onClick: () => { choice = t; chosen.textContent = `Elegido: ${targetLabel(t)}`; } })) }) : el('p', { class: 'hint' }, 'Sin resultados.'));
    } catch (e) {
      replace(results, el('p', { class: 'hint' }, (e as { message?: string })?.message ?? 'No se pudo buscar en Reservas.'));
    }
  }
  query.addEventListener('input', () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void search(), 250); });
  const save = el('button', { class: 'primary', type: 'button', id: 'saveIssuedAllocation', onclick: async () => {
    error.textContent = '';
    const value = parseAmount(amount.value);
    if (value === null || value <= 0) { error.textContent = 'Indica un importe mayor que cero.'; return; }
    if (value > rest + 0.02) { error.textContent = `Solo quedan ${eur(rest)} de base por asignar.`; return; }
    if (kind !== 'general' && !choice) { error.textContent = 'Elige la reserva o el evento.'; return; }
    const fields = kind === 'general'
      ? { issued_invoice_id: invoice.id, target_app: 'general', target_kind: 'general', target_label: 'Ingreso general', allocated_amount: value }
      : { issued_invoice_id: invoice.id, target_app: 'booking', target_kind: kind, target_id: choice!.id, target_label: targetLabel(choice!), target_code: choice!.code, allocated_amount: value };
    if (await commitSafely(client, [{ op: 'insert', table: ISSUED_ALLOCATIONS, id: crypto.randomUUID(), fields }], 'Ingreso asignado.')) { await closeSheet(true); done(); }
  } }, 'Asignar');
  openSheet({
    title: `Asignar ${numberOf(invoice)}`,
    meta: `Base ${eur(invoice.base_total)} · quedan ${eur(rest)}`,
    body: el('div', null, kinds, field('Buscar', query), results, chosen, field('Importe (base)', amount), error),
    foot: [el('button', { class: 'ghost', type: 'button', onclick: async () => { await closeSheet(true); done(); } }, 'Cancelar'), save],
    initialFocus: query,
  });
  paintKind();
}

// ---------------------------------------------------------------------------
// Nueva emitida (registro manual)
// ---------------------------------------------------------------------------
interface LineInputs { row: HTMLElement; description: HTMLInputElement; net: HTMLInputElement; rate: HTMLSelectElement }

export function openNewIssued(ctx: ViewContext, data: IssuedData): void {
  const { client } = ctx;
  const liveSeries = data.series.filter((s) => s.active).sort((a, b) => a.code.localeCompare(b.code));
  const series = select('issuedSeries', [...liveSeries.map((s) => [s.code, s.description ? `${s.code} · ${s.description}` : s.code] as [string, string]), [NEW_SERIES, '+ Nueva serie…']], liveSeries[0]?.code ?? NEW_SERIES);
  const newSeries = el('input', { type: 'text', id: 'issuedNewSeries', maxlength: '20', placeholder: 'A, R, 2026-A…' });
  const newSeriesField = field('Código de la serie nueva', newSeries);
  const syncSeries = () => { newSeriesField.hidden = series.value !== NEW_SERIES; };
  series.addEventListener('change', syncSeries); syncSeries();
  const number = el('input', { type: 'text', id: 'issuedNumber', maxlength: '40', placeholder: '2026-0001' });
  const issueDate = el('input', { type: 'date', id: 'issuedDate', value: todayIso() });
  const operationDate = el('input', { type: 'date', id: 'issuedOperationDate' });
  const type = select('issuedType', ISSUED_TYPES.map((t) => [t, `${t} · ${ISSUED_TYPE_LABELS[t]}`] as [string, string]), 'F1');
  const rectKind = select('issuedRectKind', [['I', RECTIFICATION_KIND_LABELS.I!], ['S', RECTIFICATION_KIND_LABELS.S!]], 'I');
  const rectNumber = el('input', { type: 'text', id: 'issuedRectified', placeholder: 'Número de la factura que rectifica' });
  const rectReason = el('input', { type: 'text', id: 'issuedRectReason', maxlength: '500', placeholder: 'Motivo' });
  const rectFields = el('div', { id: 'issuedRectFields' }, el('div', { class: 'row2' }, field('Rectifica a', rectNumber), field('Tipo de rectificación', rectKind)), field('Motivo', rectReason));
  const recipientName = el('input', { type: 'text', id: 'issuedRecipientName', maxlength: '200', autocomplete: 'organization' });
  const recipientTaxId = el('input', { type: 'text', id: 'issuedRecipientTaxId', maxlength: '40', autocapitalize: 'characters' });
  const description = el('input', { type: 'text', id: 'issuedDescription', maxlength: '500', placeholder: 'Estancia retiro de yoga, 3 noches' });
  const category = select('issuedCategory', [['', 'Sin categoría'], ...INCOME_CATEGORIES.map((c) => [c, INCOME_CATEGORY_LABELS[c]] as [string, string])], null);
  const withholding = el('input', { type: 'text', inputmode: 'decimal', id: 'issuedWithholding', placeholder: '0' });
  const sourceTotal = el('input', { type: 'text', inputmode: 'decimal', id: 'issuedSourceTotal', placeholder: 'Opcional: el total que figura en el documento' });
  const files = el('input', { type: 'file', id: 'issuedFiles', accept: ACCEPT_ATTR, multiple: true });
  const totals = el('p', { class: 'hint', id: 'issuedPreviewTotals' });
  const error = el('p', { class: 'formerror', role: 'alert' });
  const linesHost = el('div', { id: 'issuedLineInputs' });
  const lineInputs: LineInputs[] = [];

  const syncType = () => {
    rectFields.hidden = !isRectificative(type.value);
    recipientName.placeholder = recipientOptional(type.value) ? 'Opcional en simplificadas' : 'Nombre o razón social';
    recipientTaxId.placeholder = recipientOptional(type.value) ? 'Opcional' : 'NIF del cliente';
  };
  type.addEventListener('change', syncType); syncType();

  function addLine(): void {
    const n = lineInputs.length + 1;
    const d = el('input', { type: 'text', maxlength: '500', placeholder: 'Concepto', 'aria-label': `Concepto de la línea ${n}`, dataset: { line: 'description' } });
    const net = el('input', { type: 'text', inputmode: 'decimal', placeholder: 'Base', 'aria-label': `Base de la línea ${n}`, dataset: { line: 'net' } });
    const rate = select('', [['10', 'IVA 10 %'], ['21', 'IVA 21 %'], ['4', 'IVA 4 %'], ['0', 'IVA 0 %'], ['', 'Sin IVA']], '10', { 'aria-label': `IVA de la línea ${n}`, dataset: { line: 'rate' } });
    const row = el('div', { class: 'row2 issued-line' }, d, net, rate);
    lineInputs.push({ row, description: d, net, rate });
    linesHost.append(row);
    preview();
  }

  function draftLines() {
    return lineInputs.map((l, position) => ({ position, description: l.description.value.trim(), net_amount: parseAmount(l.net.value), vat_rate: l.rate.value === '' ? null : Number(l.rate.value) }))
      .filter((l) => l.description || l.net_amount !== null);
  }

  function preview(): void {
    const lines = draftLines().filter((l) => l.net_amount !== null).map((l) => ({ net_amount: l.net_amount!, vat_rate: l.vat_rate, vat_amount: null, surcharge_rate: null, surcharge_amount: null }));
    const breakdown = breakdownFromLines(lines);
    const wh = parseAmount(withholding.value) ?? 0;
    const t = recalculateIssued(lines, [...breakdown.map((b) => ({ tax: 'iva' as const, taxable_base: b.taxable_base, quota: b.quota, surcharge_quota: null })), ...(wh ? [{ tax: 'irpf' as const, taxable_base: null, quota: wh, surcharge_quota: null }] : [])]);
    totals.textContent = `Base ${eur(t.base)} · IVA ${eur(t.quota)}${t.withholding ? ` · retenciones ${eur(t.withholding)}` : ''} · TOTAL ${eur(t.total)}`;
  }

  const save = el('button', { class: 'primary', type: 'submit', id: 'saveIssued', form: 'newIssuedForm' }, 'Registrar factura');
  const form = el('form', { id: 'newIssuedForm', novalidate: true, oninput: () => { guard.dirtyEditor = true; preview(); }, onsubmit: async (e: Event) => {
    e.preventDefault();
    error.textContent = '';
    const seriesCode = series.value === NEW_SERIES ? newSeries.value.trim() : series.value;
    if (!seriesCode) { error.textContent = 'Indica la serie (o crea una nueva).'; newSeries.focus(); return; }
    if (!number.value.trim()) { error.textContent = 'Indica el número de la factura.'; number.focus(); return; }
    if (data.invoices.some((i) => i.series_code.toUpperCase() === seriesCode.toUpperCase() && i.number.trim().toUpperCase() === number.value.trim().toUpperCase())) {
      error.textContent = `Ya está registrada la ${fullNumber(seriesCode, number.value)}. Un número no se repite, ni anulado.`; number.focus(); return;
    }
    if (!issueDate.value) { error.textContent = 'Indica la fecha de expedición.'; issueDate.focus(); return; }
    if (!recipientOptional(type.value) && (!recipientName.value.trim() || !recipientTaxId.value.trim())) { error.textContent = 'Una factura completa lleva nombre y NIF del destinatario.'; recipientName.focus(); return; }
    if (isRectificative(type.value) && (!rectNumber.value.trim() || !rectReason.value.trim())) { error.textContent = 'Una rectificativa indica a qué factura rectifica y el motivo.'; rectNumber.focus(); return; }
    if (!description.value.trim()) { error.textContent = 'Indica el concepto.'; description.focus(); return; }
    const lines = draftLines();
    if (!lines.length || lines.some((l) => !l.description || l.net_amount === null)) { error.textContent = 'Cada línea lleva concepto y base.'; return; }
    const wh = withholding.value.trim() ? parseAmount(withholding.value) : 0;
    if (wh === null) { error.textContent = 'Retención inválida.'; withholding.focus(); return; }
    const source = sourceTotal.value.trim() ? parseAmount(sourceTotal.value) : null;
    if (sourceTotal.value.trim() && source === null) { error.textContent = 'Total inválido.'; sourceTotal.focus(); return; }
    save.disabled = true;
    try {
      const staged = [];
      for (const file of Array.from(files.files ?? [])) staged.push(await stageDocument(client, file));
      const id = crypto.randomUUID();
      const lineRows = lines.map((l) => ({ net_amount: l.net_amount!, vat_rate: l.vat_rate, vat_amount: null, surcharge_rate: null, surcharge_amount: null }));
      const breakdown = breakdownFromLines(lineRows);
      const taxRows = [...breakdown.map((b) => ({ tax: 'iva' as const, taxable_base: b.taxable_base, quota: b.quota, surcharge_quota: null })), ...(wh ? [{ tax: 'irpf' as const, taxable_base: null, quota: wh, surcharge_quota: null }] : [])];
      const t = recalculateIssued(lineRows, taxRows);
      const ops: RowOperation[] = [
        ...(series.value === NEW_SERIES ? [{ op: 'insert', table: ISSUED_SERIES, id: crypto.randomUUID(), fields: { code: seriesCode, kind: isRectificative(type.value) ? 'rectificativa' : type.value === 'F2' ? 'simplificada' : 'ordinaria' } } as RowOperation] : []),
        { op: 'insert', table: ISSUED_INVOICES, id, fields: {
          series_code: seriesCode, number: number.value.trim(), issue_date: issueDate.value, operation_date: operationDate.value || null, invoice_type: type.value,
          ...(isRectificative(type.value) ? { rectification_kind: rectKind.value, rectified: [{ number: rectNumber.value.trim() }], rectification_reason: rectReason.value.trim() } : {}),
          recipient_name: recipientName.value.trim() || null, recipient_tax_id: recipientTaxId.value.trim() || null, recipient_id_type: recipientTaxId.value.trim() ? 'NIF' : null,
          description: description.value.trim(), income_category: category.value || null, source_total: source, origin: 'manual',
          base_total: t.base, quota_total: t.quota, surcharge_total: t.surcharge, withholding_total: t.withholding, total: t.total,
          totals_delta: source === null ? null : Math.round((source - t.total) * 100) / 100,
          review_reason: source !== null && Math.abs(source - t.total) > 0.02 ? 'REVISAR IMPORTES' : null,
        } },
        ...lines.map((l): RowOperation => ({ op: 'insert', table: ISSUED_LINES, id: crypto.randomUUID(), fields: { issued_invoice_id: id, position: l.position, description: l.description, net_amount: l.net_amount, vat_rate: l.vat_rate } })),
        ...taxRows.map((r, position): RowOperation => ({ op: 'insert', table: ISSUED_TAX_LINES, id: crypto.randomUUID(), fields: { issued_invoice_id: id, position, tax: r.tax, rate: r.tax === 'iva' ? breakdown[position]?.rate ?? null : null, taxable_base: r.taxable_base, quota: r.quota, ...(r.tax === 'iva' ? { qualification: 'S1' } : {}) } })),
        ...staged.map((s, i): RowOperation => ({ op: 'insert', table: ISSUED_FILES, id: crypto.randomUUID(), fields: { issued_invoice_id: id, file_id: s.marker, original_filename: s.filename, page_order: i + 1, mime_type: s.mime, size_bytes: s.size, sha256: s.sha256 } })),
      ];
      if (await commitSafely(client, ops, 'Factura emitida registrada.')) { guard.dirtyEditor = false; await closeSheet(true); }
    } catch (err) { error.textContent = err instanceof Error ? err.message : String(err); }
    save.disabled = false;
  } },
    el('div', { class: 'row2' }, field('Serie', series), field('Número', number)),
    newSeriesField,
    el('div', { class: 'row2' }, field('Fecha de expedición', issueDate), field('Fecha de operación', operationDate, 'Solo si es distinta.')),
    field('Tipo', type),
    rectFields,
    el('div', { class: 'row2' }, field('Destinatario', recipientName), field('NIF', recipientTaxId)),
    field('Concepto', description),
    field('Categoría de ingreso', category),
    el('div', { class: 'field' }, el('span', null, 'Líneas'), linesHost, el('button', { class: 'linkbtn', type: 'button', id: 'addIssuedLine', onclick: () => addLine() }, icon('plus', 16), 'Añadir línea')),
    el('div', { class: 'row2' }, field('Retención IRPF (importe)', withholding), field('Total del documento', sourceTotal)),
    totals,
    field('PDF de la factura', files, 'El documento que generó tu herramienta de facturación.'),
    error,
  );
  addLine();
  openSheet({
    title: 'Nueva emitida',
    meta: 'Registro de una factura expedida con otra herramienta. No se envía nada a la AEAT desde aquí.',
    body: form,
    foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void closeSheet() }, 'Cancelar'), save],
    initialFocus: number,
    beforeClose: async () => !guard.dirtyEditor || confirmDialog({ title: 'Hay cambios sin guardar', text: '¿Descartarlos?', confirmLabel: 'Descartar', danger: true }),
    onClose: () => { guard.dirtyEditor = false; },
  });
}
