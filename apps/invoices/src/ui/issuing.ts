/**
 * Emitir facturas desde Finance (API.md §14, PR 2): borrador, «Emitir», documento imprimible con los datos obligatorios
 * y los ajustes de series y del registro VERI*FACTU.
 *
 * El número lo asigna el servidor al emitir (invoices.issue); sin red, la emisión se encola y el número llega al
 * sincronizar. Una emitida no se edita: se rectifica (PR 3). El envío a la AEAT está apagado y no se construye aún.
 */
import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import { closeSheet, confirmDialog, createPrintView, el, icon, openSheet, replace, toast } from '@ikisai/ui-kit';
import {
  INCOME_CATEGORIES, INCOME_CATEGORY_LABELS, INCOME_CATEGORY_VAT, ISSUE_MISSING_LABELS, ISSUED_TYPE_LABELS,
  formatIssuedNumber, issueMissing, type IncomeCategory, type IssuedAddress, type IssuedDocument, type IssuerSnapshot,
} from '@ikisai/domain-invoices';
import { ISSUED_INVOICES, ISSUED_LINES, ISSUED_SERIES, describeError, type LocalIssuedInvoice, type LocalIssuedLine, type LocalIssuedSeries } from '../app/client.ts';
import { eur, parseAmount, shortDate, todayIso } from '../app/data.ts';
import { guard } from '../app/guard.ts';
import { commitSafely, field, select } from './common.ts';
import { MISSING_ENTITY, fetchEntity, issuerLines, numberOf, type IssuedData } from './issued.ts';
import type { ViewContext } from './shell.ts';

const RECIPIENT_KIND_LABELS: Record<string, string> = { empresa: 'Empresa', profesional: 'Profesional (autónomo)', particular: 'Particular' };
const DEFAULT_FORMAT = '{serie}{año}-{n:4}';

export function emissionSeries(data: IssuedData, kind: LocalIssuedSeries['kind'] = 'ordinaria'): LocalIssuedSeries[] {
  return data.series.filter((s) => !s.deleted_at && s.mode === 'emision' && s.active && !s.closed_at && s.kind === kind).sort((a, b) => a.code.localeCompare(b.code));
}

/** El número que recibiría la siguiente emisión (orientativo: lo decide el servidor). */
export function nextNumber(series: LocalIssuedSeries): string {
  const year = Number(todayIso().slice(0, 4));
  const n = series.yearly && series.counter_year !== year ? 1 : Number(series.counter_last ?? 0) + 1;
  return formatIssuedNumber(series.format, series.code, year, n);
}

const isOwner = (client: SyncClient) => client.bootstrap()?.membership.role === 'owner';

// ---------------------------------------------------------------------------
// Borrador
// ---------------------------------------------------------------------------
interface DraftLineInputs { row: HTMLElement; description: HTMLInputElement; quantity: HTMLInputElement; price: HTMLInputElement; rate: HTMLSelectElement }

export function openInvoiceDraft(ctx: ViewContext, data: IssuedData, draft?: LocalIssuedInvoice): void {
  const { client } = ctx;
  // Un borrador de rectificativa conserva su tipo, su serie y lo que rectifica (lo crea invoices.rectify).
  const rectificative = !!draft && /^R[1-5]$/.test(draft.invoice_type);
  const seriesList = emissionSeries(data, rectificative ? 'rectificativa' : 'ordinaria');
  if (!seriesList.length) {
    toast(rectificative ? 'Falta una serie de rectificativas.' : 'Primero crea una serie de facturas.');
    openIssuingSettings(ctx, data);
    return;
  }
  const a: IssuedAddress = draft?.recipient_address ?? {};
  const series = select('draftSeries', seriesList.map((s) => [s.code, `${s.code} · siguiente ${nextNumber(s)}`] as [string, string]), draft?.series_code ?? seriesList[0]!.code);
  const kind = select('draftRecipientKind', Object.entries(RECIPIENT_KIND_LABELS), draft?.recipient_kind ?? 'empresa');
  const name = el('input', { type: 'text', id: 'draftRecipientName', maxlength: '200', autocomplete: 'organization', value: draft?.recipient_name ?? '' });
  const taxId = el('input', { type: 'text', id: 'draftRecipientTaxId', maxlength: '40', autocapitalize: 'characters', value: draft?.recipient_tax_id ?? '' });
  const line = el('input', { type: 'text', id: 'draftAddressLine', maxlength: '200', autocomplete: 'street-address', value: a.line ?? '' });
  const postal = el('input', { type: 'text', id: 'draftPostalCode', maxlength: '12', autocomplete: 'postal-code', value: a.postal_code ?? '' });
  const city = el('input', { type: 'text', id: 'draftCity', maxlength: '80', value: a.city ?? '' });
  const province = el('input', { type: 'text', id: 'draftProvince', maxlength: '80', value: a.province ?? '' });
  const country = el('input', { type: 'text', id: 'draftCountry', maxlength: '2', autocapitalize: 'characters', value: a.country ?? draft?.recipient_country ?? 'ES' });
  const addressNote = el('span', { class: 'hint', id: 'draftAddressNote' });
  const description = el('input', { type: 'text', id: 'draftDescription', maxlength: '500', placeholder: 'Estancia retiro de yoga, 3 noches', value: draft?.description ?? '' });
  const operationDate = el('input', { type: 'date', id: 'draftOperationDate', value: draft?.operation_date ?? '' });
  const category = select('draftCategory', [['', 'Sin categoría'], ...INCOME_CATEGORIES.map((c) => [c, `${INCOME_CATEGORY_LABELS[c]} · IVA ${INCOME_CATEGORY_VAT[c]} %`] as [string, string])], draft?.income_category ?? null);
  const totals = el('p', { class: 'hint', id: 'draftTotals' });
  const error = el('p', { class: 'formerror', role: 'alert' });
  const linesHost = el('div', { id: 'draftLineInputs' });
  const lineInputs: DraftLineInputs[] = [];

  const syncKind = () => {
    addressNote.textContent = kind.value === 'particular' ? 'Opcional para un particular.' : 'Obligatorio: la factura lleva el domicilio del destinatario.';
  };
  kind.addEventListener('change', syncKind); syncKind();
  category.addEventListener('change', () => {
    const suggested = category.value ? INCOME_CATEGORY_VAT[category.value as IncomeCategory] : null;
    if (suggested === null || suggested === undefined) return;
    for (const l of lineInputs) if (!l.rate.dataset.touched) l.rate.value = String(suggested);
    preview();
  });

  function addLine(initial?: LocalIssuedLine): void {
    const n = lineInputs.length + 1;
    const d = el('input', { type: 'text', maxlength: '500', placeholder: 'Concepto', 'aria-label': `Concepto de la línea ${n}`, value: initial?.description ?? '' });
    const q = el('input', { type: 'text', inputmode: 'decimal', placeholder: 'Cant.', 'aria-label': `Cantidad de la línea ${n}`, value: initial?.quantity === null || initial?.quantity === undefined ? '1' : String(initial.quantity).replace('.', ',') });
    const p = el('input', { type: 'text', inputmode: 'decimal', placeholder: 'Precio sin IVA', 'aria-label': `Precio de la línea ${n}`,
      value: initial ? String(initial.unit_price ?? initial.net_amount).replace('.', ',') : '' });
    const suggested = initial ? (initial.vat_rate === null ? '' : String(Number(initial.vat_rate))) : category.value ? String(INCOME_CATEGORY_VAT[category.value as IncomeCategory]) : '10';
    const rate = select('', [['10', 'IVA 10 %'], ['21', 'IVA 21 %'], ['4', 'IVA 4 %'], ['0', 'IVA 0 %']], suggested, { 'aria-label': `IVA de la línea ${n}` });
    rate.addEventListener('change', () => { rate.dataset.touched = '1'; });
    if (initial) rate.dataset.touched = '1';
    const row = el('div', { class: 'draft-line' }, d, q, p, rate);
    lineInputs.push({ row, description: d, quantity: q, price: p, rate });
    linesHost.append(row);
    preview();
  }

  function lines() {
    return lineInputs.map((l, position) => {
      const quantity = parseAmount(l.quantity.value) ?? 1;
      const price = parseAmount(l.price.value);
      return { position, description: l.description.value.trim(), quantity, unit_price: price, net_amount: price === null ? null : Math.round(quantity * price * 100) / 100, vat_rate: Number(l.rate.value) };
    }).filter((l) => l.description || l.unit_price !== null);
  }

  function preview(): void {
    let base = 0; const byRate = new Map<number, number>();
    for (const l of lines()) { if (l.net_amount === null) continue; base += l.net_amount; byRate.set(l.vat_rate, (byRate.get(l.vat_rate) ?? 0) + l.net_amount); }
    const quota = [...byRate.entries()].reduce((acc, [rate, net]) => acc + Math.round(net * rate) / 100, 0);
    totals.textContent = `Base ${eur(base)} · IVA ${eur(quota)} · TOTAL ${eur(base + quota)}`;
    return;
  }

  const save = el('button', { class: 'primary', type: 'submit', id: 'saveDraft', form: 'draftForm' }, draft ? 'Guardar borrador' : 'Crear borrador');
  const rectInfo = rectificative
    ? el('div', { class: 'banner info', id: 'draftRectInfo' }, icon('info', 18), el('span', null,
      `Rectifica a ${draft!.rectified.map((r) => (r as { full_number?: string }).full_number ?? r.number).join(', ')} · ${draft!.rectification_kind === 'S' ? 'por sustitución' : 'por diferencias'} · ${draft!.rectification_reason ?? ''}. `
      + (draft!.rectification_kind === 'S' ? 'Escribe las líneas correctas.' : 'Las líneas van en negativo: deja solo lo que se devuelve o corrige.')))
    : null;
  const form = el('form', { id: 'draftForm', novalidate: true, oninput: () => { guard.dirtyEditor = true; preview(); }, onsubmit: async (e: Event) => {
    e.preventDefault();
    error.textContent = '';
    if (!description.value.trim()) { error.textContent = 'Indica el concepto de la factura.'; description.focus(); return; }
    const ls = lines();
    if (!ls.length || ls.some((l) => !l.description || l.net_amount === null)) { error.textContent = 'Cada línea lleva concepto y precio.'; return; }
    if (country.value.trim() && !/^[A-Za-z]{2}$/.test(country.value.trim())) { error.textContent = 'El país va en dos letras (ES, FR…).'; country.focus(); return; }
    const address = { line: line.value.trim() || null, postal_code: postal.value.trim() || null, city: city.value.trim() || null, province: province.value.trim() || null, country: country.value.trim().toUpperCase() || null };
    const hasAddress = Object.values(address).some((v) => v && v !== 'ES');
    const recipientCountry = address.country ?? 'ES';
    const id = draft?.id ?? crypto.randomUUID();
    const fields = {
      series_code: series.value, invoice_type: rectificative ? draft!.invoice_type : 'F1', recipient_kind: kind.value,
      recipient_name: name.value.trim() || null, recipient_tax_id: taxId.value.trim().toUpperCase() || null,
      recipient_id_type: taxId.value.trim() ? (recipientCountry === 'ES' ? 'NIF' : '02') : null, recipient_country: recipientCountry,
      recipient_address: hasAddress ? address : null, description: description.value.trim(), operation_date: operationDate.value || null,
      income_category: category.value || null,
    };
    const ops: RowOperation[] = draft
      ? [
        ...(data.linesBy.get(draft.id) ?? []).map((l): RowOperation => ({ op: 'delete', table: ISSUED_LINES, id: l.id, expectedRevision: l.revision })),
        { op: 'update', table: ISSUED_INVOICES, id, expectedRevision: draft.revision, fields },
      ]
      : [{ op: 'insert', table: ISSUED_INVOICES, id, fields: { ...fields, status: 'borrador', issue_date: todayIso() } }];
    ops.push(...ls.map((l): RowOperation => ({ op: 'insert', table: ISSUED_LINES, id: crypto.randomUUID(), fields: {
      issued_invoice_id: id, position: l.position, description: l.description, quantity: l.quantity, unit_price: l.unit_price, net_amount: l.net_amount, vat_rate: l.vat_rate } })));
    save.disabled = true;
    if (await commitSafely(client, ops, draft ? 'Borrador guardado.' : 'Borrador creado. Revísalo y pulsa «Emitir».')) { guard.dirtyEditor = false; await closeSheet(true); }
    save.disabled = false;
  } },
    rectInfo,
    field('Serie', series, 'El número se asigna al emitir, nunca antes.'),
    field('Destinatario', kind),
    el('div', { class: 'row2' }, field('Nombre o razón social', name), field('NIF', taxId)),
    el('div', { class: 'field' }, el('span', null, 'Domicilio'), line, el('div', { class: 'row3' }, postal, city, province), country, addressNote),
    field('Concepto', description),
    el('div', { class: 'row2' }, field('Fecha de la operación', operationDate, 'Solo si no es la de hoy (por ejemplo, la salida).'), field('Categoría de ingreso', category)),
    el('div', { class: 'field' }, el('span', null, 'Líneas (precio sin IVA)'), linesHost, el('button', { class: 'linkbtn', type: 'button', id: 'addDraftLine', onclick: () => addLine() }, icon('plus', 16), 'Añadir línea')),
    totals,
    error,
  );
  postal.placeholder = 'C. P.'; city.placeholder = 'Ciudad'; province.placeholder = 'Provincia'; line.placeholder = 'Calle y número'; country.placeholder = 'País (ES)';
  const existing = draft ? data.linesBy.get(draft.id) ?? [] : [];
  if (existing.length) for (const l of existing) addLine(l); else addLine();
  openSheet({
    title: draft ? 'Editar borrador' : 'Nueva factura',
    meta: 'Borrador: se guarda sin número y se puede cambiar hasta que lo emitas.',
    body: form,
    foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void closeSheet() }, 'Cancelar'), save],
    initialFocus: name,
    beforeClose: async () => !guard.dirtyEditor || confirmDialog({ title: 'Hay cambios sin guardar', text: '¿Descartarlos?', confirmLabel: 'Descartar', danger: true }),
    onClose: () => { guard.dirtyEditor = false; },
  });
}

export async function deleteDraft(client: SyncClient, invoice: LocalIssuedInvoice, data: IssuedData): Promise<void> {
  const ok = await confirmDialog({ title: '¿Borrar el borrador?', text: 'Un borrador no es una factura: se borra sin dejar número ocupado.', confirmLabel: 'Borrar', danger: true });
  if (!ok) return;
  await commitSafely(client, [
    ...(data.linesBy.get(invoice.id) ?? []).map((l): RowOperation => ({ op: 'delete', table: ISSUED_LINES, id: l.id, expectedRevision: l.revision })),
    { op: 'delete', table: ISSUED_INVOICES, id: invoice.id, expectedRevision: invoice.revision },
  ], 'Borrador borrado.');
  await closeSheet(true);
}

function issueErrorText(error: unknown): string {
  const e = error as { code?: string; details?: { missing?: string[] } };
  if (e?.code === 'ISSUE_MISSING_DATA' && Array.isArray(e.details?.missing)) {
    return `Para emitir falta ${e.details!.missing!.map((m) => ISSUE_MISSING_LABELS[m] ?? m).join(', ')}.`;
  }
  if (e?.code === 'ENTITY_MISSING') return `${MISSING_ENTITY}: el emisor es obligatorio.`;
  return describeError(error);
}

export async function issueDraft(ctx: ViewContext, invoice: LocalIssuedInvoice, data: IssuedData): Promise<void> {
  const { client } = ctx;
  const lines = data.linesBy.get(invoice.id) ?? [];
  const missing = issueMissing(invoice, lines.length);
  if (missing.length) { toast(`Para emitir falta ${missing.map((m) => ISSUE_MISSING_LABELS[m] ?? m).join(', ')}. Edita el borrador.`); return; }
  const online = navigator.onLine;
  const { entity } = await fetchEntity(client);
  if (online && !entity) { toast(`${MISSING_ENTITY}: el emisor es obligatorio en una factura.`); return; }
  const series = data.series.find((s) => s.code.toUpperCase() === invoice.series_code.toUpperCase());
  const ok = await confirmDialog({
    title: `¿Emitir la factura a ${invoice.recipient_name ?? 'este cliente'}?`,
    text: el('div', null,
      el('p', null, `Recibirá el número ${series ? nextNumber(series) : 'siguiente de la serie'} (lo confirma el servidor) y la fecha de hoy. Total ${eur(invoice.total)}.`),
      el('p', null, 'Después no se podrá editar ni borrar: para corregirla habrá que hacer una rectificativa.'),
      online ? null : el('p', null, 'Sin conexión: se emitirá al conectar.')),
    confirmLabel: 'Emitir',
  });
  if (!ok) return;
  try {
    await client.commit([{ op: 'call', procedure: 'invoices.issue', args: { id: invoice.id, expectedRevision: invoice.revision } }]);
    toast(client.status().network === 'offline' ? 'Se emitirá al conectar.' : 'Factura emitida.');
  } catch (error) {
    toast(issueErrorText(error));
  }
}

// ---------------------------------------------------------------------------
// Documento: la factura emitida (desde `document`, congelado) o la vista previa de un borrador
// ---------------------------------------------------------------------------
function draftDocument(invoice: LocalIssuedInvoice, data: IssuedData, issuer: IssuerSnapshot | null): IssuedDocument {
  const lines = data.linesBy.get(invoice.id) ?? [];
  const byRate = new Map<number | null, number>();
  for (const l of lines) byRate.set(l.vat_rate === null ? null : Number(l.vat_rate), (byRate.get(l.vat_rate === null ? null : Number(l.vat_rate)) ?? 0) + Number(l.net_amount));
  const breakdown = [...byRate.entries()].map(([rate, base]) => ({ tax: 'iva', rate, base: Math.round(base * 100) / 100, quota: Math.round(base * (rate ?? 0)) / 100, exemption: null, surcharge_rate: null, surcharge_quota: null }));
  const base = breakdown.reduce((acc, b) => acc + b.base, 0); const quota = breakdown.reduce((acc, b) => acc + b.quota, 0);
  return {
    full_number: '', series: invoice.series_code, number: '', issue_date: todayIso(), operation_date: invoice.operation_date, invoice_type: invoice.invoice_type,
    issuer: issuer ?? ({ legal_name: MISSING_ENTITY, tax_id: '', address_line: '', postal_code: '', city: '', country: 'ES' } as IssuerSnapshot),
    recipient: { name: invoice.recipient_name, tax_id: invoice.recipient_tax_id, id_type: invoice.recipient_id_type, country: invoice.recipient_country, address: invoice.recipient_address, kind: invoice.recipient_kind },
    description: invoice.description,
    lines: lines.map((l) => ({ position: l.position, description: l.description, quantity: l.quantity, unit: l.unit, unit_price: l.unit_price, discount_amount: l.discount_amount,
      net_amount: Number(l.net_amount), tax: l.tax, vat_rate: l.vat_rate, vat_amount: l.vat_amount })),
    breakdown, withholdings: [], prices_include_vat: invoice.prices_include_vat,
    totals: { base, quota, surcharge: 0, withholding: 0, total: base + quota, vf_amount: base + quota },
    rectification: /^R[1-5]$/.test(invoice.invoice_type) ? { kind: invoice.rectification_kind, rectified: invoice.rectified, reason: invoice.rectification_reason,
      base: invoice.rectified_base, quota: invoice.rectified_quota } : null,
    currency: invoice.currency, issued_at: '',
  };
}

const RECTIFY_REASONS: Array<[string, string]> = [
  ['R4', 'Resto de causas (error en importes, descuento, devolución…)'],
  ['R1', 'Error fundado en derecho o art. 80 Uno, Dos y Seis de la Ley del IVA'],
  ['R2', 'Concurso de acreedores del cliente (art. 80 Tres)'],
  ['R3', 'Crédito incobrable (art. 80 Cuatro)'],
];

/** «Rectificar» una emitida desde Finance: crea el borrador de rectificativa en el servidor (invoices.rectify). */
export async function rectifyIssued(ctx: ViewContext, invoice: LocalIssuedInvoice, data: IssuedData): Promise<void> {
  const { client } = ctx;
  if (!emissionSeries(data, 'rectificativa').length) { toast('Falta una serie de rectificativas.'); openIssuingSettings(ctx, data); return; }
  const kind = select('rectifyKind', [['I', 'Por diferencias: solo lo que cambia (por defecto)'], ['S', 'Por sustitución: la factura entera corregida']], 'I');
  const code = select('rectifyCode', RECTIFY_REASONS, 'R4');
  const reason = el('input', { type: 'text', id: 'rectifyReason', maxlength: '400', placeholder: 'Devolución de una noche, NIF erróneo…' });
  const ok = await confirmDialog({ title: `Rectificar ${numberOf(invoice)}`, text: el('div', null,
    el('p', null, 'Se crea un borrador de rectificativa con las líneas de esta factura. Revísalo y emítelo; al emitirlo, esta queda como rectificada.'),
    field('Tipo', kind), invoice.invoice_type === 'F2' ? null : field('Causa', code), field('Motivo', reason)), confirmLabel: 'Crear rectificativa' });
  if (!ok) return;
  if (!reason.value.trim()) { toast('Indica el motivo de la rectificación.'); return; }
  try {
    await client.commit([{ op: 'call', procedure: 'invoices.rectify', args: { id: invoice.id, kind: kind.value, reason_code: code.value, reason: reason.value.trim() } }]);
    toast(client.status().network === 'offline' ? 'La rectificativa se creará al conectar.' : 'Borrador de rectificativa creado: revísalo y emítelo.');
    await closeSheet(true);
  } catch (error) {
    toast(describeError(error));
  }
}

const addressText = (a: IssuedAddress | null | undefined) => (a ? [a.line, [a.postal_code, a.city].filter(Boolean).join(' '), a.province, a.country && a.country !== 'ES' ? a.country : null].filter(Boolean).join(', ') : '');
const num = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(Number(v)).replace('.', ','));

export async function openInvoiceDocument(ctx: ViewContext, invoice: LocalIssuedInvoice, data: IssuedData): Promise<void> {
  const isDraft = invoice.status === 'borrador';
  const doc = invoice.document ?? draftDocument(invoice, data, isDraft ? (await fetchEntity(ctx.client)).entity : invoice.issuer);
  const r = doc.recipient;
  const body = el('div', { class: 'issued-print' },
    el('div', { class: 'issued-print-parties' },
      el('div', { id: 'docIssuer' }, el('small', null, 'Emisor'), ...issuerLines(doc.issuer).map((l, i) => (i === 0 ? el('strong', null, l) : el('div', null, l)))),
      el('div', { id: 'docRecipient' }, el('small', null, 'Destinatario'), el('strong', null, r.name ?? 'Sin destinatario'),
        r.tax_id ? el('div', null, `NIF ${r.tax_id}`) : null, addressText(r.address) ? el('div', null, addressText(r.address)) : null)),
    doc.rectification ? el('p', { id: 'docRectification' }, `Factura rectificativa ${doc.rectification.kind === 'S' ? 'por sustitución' : 'por diferencias'} de `
      + `${(doc.rectification.rectified as Array<{ full_number?: string; number?: string; issue_date?: string }>).map((r) => `${r.full_number ?? r.number}${r.issue_date ? ` (${shortDate(r.issue_date)})` : ''}`).join(', ')}. Motivo: ${doc.rectification.reason ?? ''}.`
      + (doc.rectification.kind === 'S' && doc.rectification.base !== null ? ` Base rectificada ${eur(doc.rectification.base)}, cuota rectificada ${eur(doc.rectification.quota ?? 0)}.` : '')) : null,
    el('p', null, doc.description),
    el('table', { class: 'inv-table', id: 'docLines' },
      el('thead', null, el('tr', null, el('th', null, 'Concepto'), el('th', { class: 'num' }, 'Cant.'), el('th', { class: 'num' }, 'Precio'), el('th', { class: 'num' }, 'Dto.'),
        el('th', { class: 'num' }, 'Base'), el('th', { class: 'num' }, 'IVA'))),
      el('tbody', null, ...doc.lines.map((l) => el('tr', null, el('td', null, l.description), el('td', { class: 'num' }, num(l.quantity)), el('td', { class: 'num' }, l.unit_price === null ? '' : eur(l.unit_price)),
        el('td', { class: 'num' }, l.discount_amount ? eur(l.discount_amount) : ''), el('td', { class: 'num' }, eur(l.net_amount)), el('td', { class: 'num' }, l.vat_rate === null ? '—' : `${num(l.vat_rate)} %`))))),
    el('table', { class: 'inv-table', id: 'docBreakdown' },
      el('thead', null, el('tr', null, el('th', null, 'Impuesto'), el('th', { class: 'num' }, 'Base imponible'), el('th', { class: 'num' }, 'Cuota'))),
      el('tbody', null, ...doc.breakdown.map((b) => el('tr', null,
        el('td', null, b.exemption ? `${b.tax.toUpperCase()} exento (${b.exemption})` : `${b.tax.toUpperCase()} ${num(b.rate)} %`), el('td', { class: 'num' }, eur(b.base)), el('td', { class: 'num' }, eur(b.quota)))))),
    el('div', { class: 'inv-totals', id: 'docTotals' },
      el('div', null, el('span', null, 'Base imponible'), el('strong', null, eur(doc.totals.base))),
      el('div', null, el('span', null, 'IVA'), el('strong', null, eur(doc.totals.quota + doc.totals.surcharge))),
      doc.totals.withholding ? el('div', null, el('span', null, 'Retención IRPF'), el('strong', null, `−${eur(doc.totals.withholding)}`)) : null,
      el('div', { class: 'total' }, el('span', null, 'TOTAL'), el('strong', null, eur(doc.totals.total)))));
  const meta = [`Fecha de expedición: ${isDraft ? 'al emitir' : shortDate(doc.issue_date)}`];
  if (doc.operation_date && doc.operation_date !== doc.issue_date) meta.push(`Fecha de la operación: ${shortDate(doc.operation_date)}`);
  // QR tributario y leyenda VERI*FACTU: solo con el envío encendido (§14.5). Hoy está apagado, así que no se imprimen.
  const view = createPrintView({
    brand: { appName: doc.issuer.trade_name || doc.issuer.legal_name, line: doc.issuer.trade_name ? doc.issuer.legal_name : undefined },
    title: isDraft ? 'Borrador de factura' : `Factura ${doc.full_number}`,
    subtitle: (ISSUED_TYPE_LABELS as Record<string, string>)[doc.invoice_type] ?? doc.invoice_type,
    meta,
    draft: isDraft ? 'BORRADOR · SIN VALOR' : false,
    intro: body,
    sections: [],
    notes: doc.breakdown.some((b) => b.exemption) ? 'Operación exenta del IVA según la mención indicada en el desglose.' : undefined,
    runningFoot: isDraft ? 'Borrador sin número' : `${doc.issuer.legal_name} · NIF ${doc.issuer.tax_id} · Factura ${doc.full_number}`,
  }, { printLabel: 'Imprimir / Guardar PDF' });
  openSheet({ title: isDraft ? 'Vista previa del borrador' : `Factura ${doc.full_number}`, body: el('div', { id: 'issuedDocumentView' }, view.element),
    foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void closeSheet() }, 'Cerrar')] });
}

// ---------------------------------------------------------------------------
// Ajustes: series de emisión, cierre de series de registro y estado del registro VERI*FACTU
// ---------------------------------------------------------------------------
export function openIssuingSettings(ctx: ViewContext, data: IssuedData): void {
  const { client } = ctx;
  const owner = isOwner(client);
  const canEdit = client.bootstrap()?.membership.role !== 'reader';
  const live = data.series.filter((s) => !s.deleted_at);
  const emission = live.filter((s) => s.mode === 'emision');
  const registro = live.filter((s) => s.mode !== 'emision');
  const vfState = el('p', { class: 'hint', id: 'vfSending' }, 'Comprobando el registro VERI*FACTU…');
  void client.api<{ settings: { sending: string; locked_until: string | null } | null }>('/read/invoices.vf_records_of', { json: { issued_invoice_id: null } })
    .then((r) => {
      const sending = r.settings?.sending ?? 'apagado';
      replace(vfState, sending === 'apagado'
        ? 'Envío a la AEAT: apagado. Cada factura emitida guarda su registro con la huella encadenada, pero no se envía nada ni se imprime el QR. El envío se encenderá aquí (solo el owner) cuando se acerque la fecha obligatoria.'
        : `Envío a la AEAT: ${sending}${r.settings?.locked_until ? `, hasta el ${shortDate(r.settings.locked_until)}` : ''}.`);
    })
    .catch(() => replace(vfState, 'Sin conexión: el estado del registro se verá al conectar.'));

  function createRow(kind: 'ordinaria' | 'rectificativa', suggested: string, label: string): HTMLElement | null {
    if (!canEdit || emission.some((s) => s.kind === kind && s.active && !s.closed_at)) return null;
    const code = el('input', { type: 'text', id: `newSeries-${kind}`, maxlength: '10', value: suggested, 'aria-label': `Código de la serie de ${label}` });
    const button = el('button', { class: 'softbtn', type: 'button', id: `createSeries-${kind}`, onclick: async () => {
      const c = code.value.trim().toUpperCase();
      if (!/^[A-Z0-9-]{1,10}$/.test(c)) { toast('El código lleva letras, cifras o guiones.'); return; }
      if (live.some((s) => s.code.toUpperCase() === c)) { toast(`Ya existe la serie ${c}.`); return; }
      if (await commitSafely(client, [{ op: 'insert', table: ISSUED_SERIES, id: crypto.randomUUID(), fields: { code: c, kind, mode: 'emision', format: DEFAULT_FORMAT, yearly: true, description: label } }],
        `Serie ${c} creada.`)) await closeSheet(true);
    } }, icon('plus', 16), `Crear serie de ${label}`);
    return el('div', { class: 'row2' }, code, button);
  }

  async function closeSeries(s: LocalIssuedSeries): Promise<void> {
    const last = el('input', { type: 'text', id: 'closeSeriesLast', maxlength: '40', placeholder: '2026-0123' });
    const ok = await confirmDialog({ title: `¿Cerrar la serie ${s.code}?`, text: el('div', null,
      el('p', null, 'No admitirá más facturas, ni registradas ni importadas. Indica el último número que se emitió con ella.'), field('Último número', last)),
      confirmLabel: 'Cerrar serie', danger: true });
    if (!ok) return;
    if (!last.value.trim()) { toast('Indica el último número.'); return; }
    if (await commitSafely(client, [{ op: 'call', procedure: 'invoices.close_series', args: { code: s.code, last_number: last.value.trim() } }], `Serie ${s.code} cerrada.`)) await closeSheet(true);
  }

  const body = el('div', { id: 'issuingSettings' },
    el('h3', null, 'Series de emisión'),
    emission.length
      ? el('ul', { class: 'plain', id: 'emissionSeries' }, ...emission.map((s) => el('li', { dataset: { series: s.code } },
        el('strong', null, s.code), ` · ${s.kind === 'rectificativa' ? 'rectificativas' : 'facturas'} · siguiente ${nextNumber(s)}`,
        s.closed_at ? ` · cerrada en ${s.closed_last_number}` : '')))
      : el('p', { class: 'hint' }, 'Aún no hay series de emisión. Crea una para facturas y otra para rectificativas: el número tiene la forma F2026-0001, reinicia cada año y no cambia una vez emitida la primera.'),
    createRow('ordinaria', 'F', 'facturas'),
    createRow('rectificativa', 'R', 'rectificativas'),
    registro.length ? el('h3', null, 'Series de registro (otra herramienta)') : null,
    registro.length ? el('ul', { class: 'plain', id: 'registroSeries' }, ...registro.map((s) => el('li', null, el('strong', null, s.code),
      s.closed_at ? ` · cerrada en ${s.closed_last_number}` : ' · abierta',
      owner && !s.closed_at ? el('button', { class: 'linkbtn', type: 'button', id: `closeSeries-${s.code}`, onclick: () => void closeSeries(s) }, 'Cerrar serie') : null))) : null,
    el('h3', null, 'Registro VERI*FACTU'),
    vfState,
  );
  openSheet({ title: 'Series y VERI*FACTU', body, foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void closeSheet() }, 'Cerrar')] });
}

/** Resumen del registro VERI*FACTU de una emitida desde Finance, para la ficha. */
export function verifactuSummary(invoice: LocalIssuedInvoice): string {
  if (invoice.status === 'borrador') return 'Borrador: el registro de alta se genera al emitir.';
  if (!invoice.vf_hash) return 'Sin registro.';
  const sending = invoice.vf_status === 'no_enviar' ? 'Envío a la AEAT apagado: el registro queda guardado, sin enviar.' : `Envío: ${invoice.vf_status}.`;
  return `Registro de alta guardado${invoice.vf_first_record ? ' (primero de la cadena)' : ''}. Huella ${invoice.vf_hash.slice(0, 12)}…. ${sending}`;
}

