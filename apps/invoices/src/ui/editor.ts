/**
 * «Datos de la factura» en la propia ficha (petición del usuario, 9-10-2026): lo leído del documento pintado y editable
 * allí mismo, con «leído», «revísalo» o «falta» junto a cada dato. Sustituye a la hoja «Rellenar a mano».
 *
 * - Número, fecha, total del documento, categoría y proveedor (por NIF, con alta rápida) se guardan solos al cambiarlos.
 * - Los importes (base por tipo de IVA, cuota y retención) se guardan con «Guardar importes»: rehacen las líneas.
 * - «Leer de nuevo el PDF» (o «Leer PDF») pinta lo leído encima, resalta lo que cambia y «Guardar lo leído» lo aplica de
 *   una vez. Mientras haya algo sin guardar, la ficha no se repinta (guard.dirtyEditor).
 */
import type { RowOperation } from '@ikisai/sync-client';
import { confirmDialog, el, replace, toast } from '@ikisai/ui-kit';
import { validSpanishTaxId, type FieldProvenance } from '@ikisai/domain-invoices';
import { CATEGORIES, CATEGORY_LABELS, INVOICES, INVOICE_LINES, SUPPLIERS, TAX_LINES, type LocalInvoice } from '../app/client.ts';
import { eur, loadMirror, parseAmount, supplierName, type Mirror } from '../app/data.ts';
import { guard } from '../app/guard.ts';
import { commitSafely, field, select } from './common.ts';
import { readingPanel } from './reading.ts';
import type { ManualPrefill } from './manual.ts';
import type { ViewContext } from './shell.ts';

const RATES: Array<[string, string]> = [['21', 'IVA 21 %'], ['10', 'IVA 10 %'], ['4', 'IVA 4 %'], ['0', 'IVA 0 % / exenta']];
const WITHHOLDINGS: Array<[string, string]> = [['', 'Sin retención'], ['15', 'IRPF 15 %'], ['7', 'IRPF 7 %'], ['19', 'IRPF 19 %'], ['otro', 'Otra (importe)']];
const cents = (v: number) => Math.round(v * 100);
const money = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(Number(v)).replace('.', ','));
const GENERIC_LINE = /seg[uú]n documento$/i;

export interface InvoiceEditor {
  element: HTMLElement;
  /** Pinta lo leído: `empty` solo rellena lo vacío; `replace` pone lo leído y resalta lo que cambia (sin guardar). */
  fill(prefill: ManualPrefill, mode: 'empty' | 'replace'): void;
  /** Hay importes o lo leído sin guardar. */
  dirty(): boolean;
}

export function createInvoiceEditor(ctx: ViewContext, mirror: Mirror, invoice: LocalInvoice, opts: { onReread?: () => void }): InvoiceEditor {
  const { client } = ctx;
  const current = mirror.supplierById.get(invoice.supplier_id);
  const placeholder = current?.slug === 'sin_identificar';
  const provenance = ((invoice.import_meta as { provenance?: Record<string, FieldProvenance> } | null)?.provenance ?? {}) as Record<string, FieldProvenance>;
  const taxes = (mirror.taxesByInvoice.get(invoice.id) ?? []).filter((t) => !t.deleted_at);
  const lines = (mirror.linesByInvoice.get(invoice.id) ?? []).filter((l) => !l.deleted_at);
  let pendingFill = false;
  let amountsDirty = false;
  const markDirty = () => { guard.dirtyEditor = pendingFill || amountsDirty; amountsBar.hidden = !amountsDirty || pendingFill; fillBar.hidden = !pendingFill; };

  /** «leído» / «revísalo» / «falta» junto a la etiqueta. */
  const badge = (key: string | null, value: () => string): HTMLElement => {
    const span = el('span', { class: 'chip', 'data-feedback-ignore': '' });
    const paintBadge = () => {
      const p = key ? provenance[key] : undefined;
      if (!value().trim()) { span.className = 'chip warn'; span.textContent = 'falta'; return; }
      if (!p || p.method === 'manual') { span.className = 'chip'; span.hidden = true; return; }
      span.hidden = false;
      span.className = p.confidence >= 0.8 ? 'chip ok' : 'chip warn';
      span.textContent = p.confidence >= 0.8 ? 'leído' : 'revísalo';
      span.title = p.text ? `Leído: «${p.text.slice(0, 80)}»` : '';
    };
    paintBadge();
    (span as HTMLElement & { repaint?: () => void }).repaint = paintBadge;
    return span;
  };

  // --- Guardar un campo al cambiarlo: en orden y con la revisión al día (sin fusiones automáticas entre autoguardados,
  // que saldrían como «cambios de otra persona»).
  let queue: Promise<unknown> = Promise.resolve();
  /** La factura con la revisión del servidor: espera (hasta 5 s, con red) a que se confirme lo anterior. */
  async function freshInvoice(): Promise<LocalInvoice> {
    const until = Date.now() + 5000;
    while (client.status().pendingCommands && navigator.onLine && Date.now() < until) await new Promise((r) => setTimeout(r, 120));
    return (await loadMirror(client)).invoices.find((i) => i.id === invoice.id) ?? invoice;
  }
  function saveField(fields: Record<string, unknown>, message = 'Guardado.'): Promise<unknown> {
    if (pendingFill) return Promise.resolve(); // lo leído se guarda todo junto con «Guardar lo leído»
    queue = queue.then(async () => {
      const fresh = await freshInvoice();
      await commitSafely(client, [{ op: 'update', table: INVOICES, id: invoice.id, expectedRevision: fresh.revision, fields }], message);
    }).catch(() => undefined);
    return queue;
  }

  // --- Proveedor por NIF (o el de la factura), con alta rápida
  const taxId = el('input', { 'data-feedback-id': 'invoices.facturas.manual.nif', 'data-feedback-label': 'NIF del proveedor', type: 'text', id: 'manualTaxId', maxlength: '20', autocapitalize: 'characters', placeholder: 'B12345674', value: placeholder ? '' : current?.tax_id ?? '' });
  const name = el('input', { 'data-feedback-id': 'invoices.facturas.manual.nombre', 'data-feedback-label': 'Nombre del proveedor', type: 'text', id: 'manualName', maxlength: '160', placeholder: 'Nombre o razón social', value: placeholder ? '' : current?.name ?? '' });
  const supplierNote = el('p', { class: 'hint', id: 'manualSupplierNote' });
  const findByTaxId = () => {
    const id = validSpanishTaxId(taxId.value) ?? taxId.value.replace(/[\s.-]/g, '').toUpperCase();
    return id ? mirror.suppliers.find((s) => !s.deleted_at && s.slug !== 'sin_identificar' && (s.tax_id ?? '').replace(/[\s.-]/g, '').toUpperCase() === id) ?? null : null;
  };
  let nameFromKnown = !placeholder && !!current;
  const syncSupplier = () => {
    const found = findByTaxId();
    // Un NIF que ya no es el del proveedor conocido: su nombre no vale para el nuevo (se escribe).
    if (!found && nameFromKnown) { name.value = ''; nameFromKnown = false; }
    if (found) { nameFromKnown = true; name.value = found.name; name.disabled = true; replace(supplierNote, `Proveedor conocido: ${supplierName(found)}.`); }
    else { name.disabled = false; replace(supplierNote, taxId.value.trim() ? (validSpanishTaxId(taxId.value) ? 'Proveedor nuevo: se dará de alta con este NIF y nombre.' : 'Ese NIF no parece válido; revísalo.') : 'Escribe el NIF: si ya existe, se elige solo.'); }
  };
  /** Operaciones para poner el proveedor que dicen NIF y nombre (o ninguna si no cambia o no se puede). */
  let created: string | null = null;
  const supplierOps = (): { ops: RowOperation[]; supplierId: string | null } => {
    if (created) return { ops: [], supplierId: null };
    const known = findByTaxId();
    if (known) return { ops: [], supplierId: known.id === invoice.supplier_id ? null : known.id };
    const nif = validSpanishTaxId(taxId.value);
    if (!nif || !name.value.trim()) return { ops: [], supplierId: null };
    const id = crypto.randomUUID();
    return { ops: [{ op: 'insert', table: SUPPLIERS, id, fields: { name: name.value.trim(), tax_id: nif } }], supplierId: id };
  };
  const saveSupplier = () => (queue = queue.then(async () => {
    if (pendingFill) return;
    const { ops, supplierId } = supplierOps();
    if (!supplierId) return;
    const fresh = await freshInvoice();
    const owner = mirror.supplierById.get(supplierId);
    await commitSafely(client, [...ops, { op: 'update', table: INVOICES, id: invoice.id, expectedRevision: fresh.revision, fields: {
      supplier_id: supplierId, ...(!invoice.expense_category && owner?.default_category ? { expense_category: owner.default_category } : {}) } }], 'Proveedor guardado.');
    created = supplierId;
  }).catch(() => undefined));
  taxId.addEventListener('input', syncSupplier);
  taxId.addEventListener('change', () => void saveSupplier());
  name.addEventListener('change', () => void saveSupplier());

  // --- Cabecera
  const number = el('input', { 'data-feedback-id': 'invoices.facturas.manual.numero', 'data-feedback-label': 'Número de factura', type: 'text', id: 'manualNumber', maxlength: '64', value: invoice.invoice_number ?? '' });
  const date = el('input', { 'data-feedback-id': 'invoices.facturas.manual.fecha', 'data-feedback-label': 'Fecha de la factura', type: 'date', id: 'manualDate', value: invoice.invoice_date ?? '' });
  const total = el('input', { 'data-feedback-id': 'invoices.facturas.manual.total', 'data-feedback-label': 'Total de la factura', type: 'text', inputmode: 'decimal', id: 'manualTotal', placeholder: 'Total que imprime la factura', value: money(invoice.source_total === null ? null : Number(invoice.source_total)) });
  const category = select('manualCategory', [['', 'Elige categoría'], ...CATEGORIES.map((c) => [c, CATEGORY_LABELS[c]] as [string, string])], invoice.expense_category ?? null, { 'data-feedback-id': 'invoices.facturas.manual.categoria', 'data-feedback-label': 'Categoría de gasto' });
  number.addEventListener('change', () => void saveField({ invoice_number: number.value.trim() || null }, 'Número guardado.'));
  date.addEventListener('change', () => void saveField({ invoice_date: date.value || null }, 'Fecha guardada.'));
  total.addEventListener('change', () => { const v = parseAmount(total.value); if (total.value.trim() && v === null) { toast('Importe inválido.'); return; } void saveField({ source_total: v }, 'Total guardado.'); });
  category.addEventListener('change', () => void saveField({ expense_category: category.value || null }, 'Categoría guardada.'));

  // --- Importes: base por tipo de IVA (cuota calculada y corregible) y retención
  type Row = { base: HTMLInputElement; rate: HTMLSelectElement; quota: HTMLInputElement; touched: boolean };
  const rows: Row[] = [];
  const rowsHost = el('div', { id: 'manualRows' });
  const onAmounts = () => { if (!pendingFill) amountsDirty = true; markDirty(); paint(); };
  const addRow = (rate = '21') => {
    const row: Row = {
      base: el('input', { 'data-feedback-ignore': '', type: 'text', inputmode: 'decimal', placeholder: 'Base', 'aria-label': `Base imponible ${rows.length + 1}` }),
      rate: select('', RATES, rate, { 'data-feedback-ignore': '', 'aria-label': `Tipo de IVA ${rows.length + 1}` }),
      quota: el('input', { 'data-feedback-ignore': '', type: 'text', inputmode: 'decimal', placeholder: 'Cuota', 'aria-label': `Cuota de IVA ${rows.length + 1}` }),
      touched: false,
    };
    const autoQuota = () => { if (row.touched) return; const b = parseAmount(row.base.value); row.quota.value = b === null ? '' : money(Math.round(b * Number(row.rate.value)) / 100); };
    row.base.addEventListener('input', () => { autoQuota(); onAmounts(); });
    row.rate.addEventListener('change', () => { autoQuota(); onAmounts(); });
    row.quota.addEventListener('input', () => { row.touched = true; onAmounts(); });
    rows.push(row);
    rowsHost.appendChild(el('div', { class: 'row3 manual-row' }, row.base, row.rate, row.quota));
    return row;
  };
  const withholdingKind = select('manualWithholding', WITHHOLDINGS, '', { 'data-feedback-id': 'invoices.facturas.manual.retencion', 'data-feedback-label': 'Retención' });
  const withholdingAmount = el('input', { 'data-feedback-ignore': '', type: 'text', inputmode: 'decimal', id: 'manualWithholdingAmount', placeholder: 'Importe retenido', hidden: true });
  withholdingKind.addEventListener('change', onAmounts);
  withholdingAmount.addEventListener('input', onAmounts);
  total.addEventListener('input', () => paint());

  /** Los importes que tiene ahora la factura (impuestos; si no hay, las líneas por tipo). */
  function loadAmounts(): void {
    replace(rowsHost); rows.length = 0;
    const iva = taxes.filter((t) => t.tax_type === 'iva');
    const fromTaxes = iva.map((t) => ({ rate: t.rate === null ? 21 : Number(t.rate), base: t.taxable_base === null ? null : Number(t.taxable_base), quota: Number(t.amount) }));
    const byRate = new Map<number, { base: number; quota: number }>();
    if (!fromTaxes.length) for (const l of lines) { const r = l.vat_rate === null ? 21 : Number(l.vat_rate); const g = byRate.get(r) ?? { base: 0, quota: 0 }; byRate.set(r, { base: g.base + Number(l.net_amount), quota: g.quota + Number(l.vat_amount ?? 0) }); }
    const list = fromTaxes.length ? fromTaxes : [...byRate.entries()].map(([rate, v]) => ({ rate, base: Math.round(v.base * 100) / 100, quota: Math.round(v.quota * 100) / 100 }));
    if (!list.length) addRow();
    for (const v of list) {
      const row = addRow(RATES.some(([r]) => r === String(v.rate)) ? String(v.rate) : '21');
      row.base.value = money(v.base); row.quota.value = money(v.quota); row.touched = true;
    }
    const irpf = taxes.find((t) => t.tax_type === 'irpf' || t.tax_type === 'otra_retencion');
    if (irpf) {
      withholdingKind.value = irpf.rate !== null && WITHHOLDINGS.some(([r]) => r === String(Number(irpf.rate))) ? String(Number(irpf.rate)) : 'otro';
      withholdingAmount.value = money(Number(irpf.amount));
    } else { withholdingKind.value = ''; withholdingAmount.value = ''; }
  }

  const cuadre = el('div', { class: 'banner info', id: 'manualCuadre', role: 'status' });
  function figures() {
    const ls = rows.map((r) => ({ base: parseAmount(r.base.value), rate: Number(r.rate.value), quota: parseAmount(r.quota.value) })).filter((r) => r.base !== null) as Array<{ base: number; rate: number; quota: number | null }>;
    const base = ls.reduce((n, r) => n + cents(r.base), 0);
    const vat = ls.reduce((n, r) => n + cents(r.quota ?? Math.round(r.base * r.rate) / 100), 0);
    const kind = withholdingKind.value;
    const withholding = kind === '' ? 0 : kind === 'otro' ? cents(parseAmount(withholdingAmount.value) ?? 0) : Math.round(base * Number(kind) / 100);
    return { lines: ls, base, vat, withholding, calculated: base + vat - withholding, declared: parseAmount(total.value) };
  }
  function paint(): void {
    withholdingAmount.hidden = withholdingKind.value !== 'otro';
    const f = figures();
    const fmt = (c: number) => eur(c / 100);
    const diff = f.declared === null ? null : cents(f.declared) - f.calculated;
    cuadre.className = `banner ${diff === null ? 'info' : Math.abs(diff) <= 2 ? 'ok' : 'warn'}`;
    replace(cuadre, el('span', null, `Base ${fmt(f.base)} + IVA ${fmt(f.vat)}${f.withholding ? ` − retención ${fmt(f.withholding)}` : ''} = ${fmt(f.calculated)}`,
      diff === null ? ' · escribe el total de la factura para comprobarlo.' : Math.abs(diff) <= 2 ? ' · ✓ cuadra con el total.' : ` · no cuadra con el total (diferencia ${fmt(diff)}).`));
    for (const b of badges) (b as HTMLElement & { repaint?: () => void }).repaint?.();
  }

  /** Operaciones que rehacen líneas e impuestos con los importes del formulario (o null si no hay base). */
  async function amountOps(): Promise<RowOperation[] | null> {
    const f = figures();
    if (!f.lines.length) { toast('Escribe al menos una base imponible.'); rows[0]?.base.focus(); return null; }
    const articles = lines.filter((l) => !GENERIC_LINE.test(l.description));
    if (articles.length && !(await confirmDialog({ title: 'Sustituir los artículos', text: `La factura tiene ${articles.length} artículo${articles.length === 1 ? '' : 's'}. Guardar los importes los cambia por una línea por tipo de IVA.`, confirmLabel: 'Guardar importes' }))) return null;
    const vatByRate = new Map<number, { base: number; quota: number }>();
    for (const l of f.lines) { const q = l.quota ?? Math.round(l.base * l.rate) / 100; const g = vatByRate.get(l.rate) ?? { base: 0, quota: 0 }; vatByRate.set(l.rate, { base: g.base + cents(l.base), quota: g.quota + cents(q) }); }
    return [
      ...lines.map((l): RowOperation => ({ op: 'delete', table: INVOICE_LINES, id: l.id, expectedRevision: l.revision })),
      ...taxes.map((t): RowOperation => ({ op: 'delete', table: TAX_LINES, id: t.id, expectedRevision: t.revision })),
      ...[...vatByRate.entries()].map(([rate, v], i): RowOperation => ({ op: 'insert', table: INVOICE_LINES, id: crypto.randomUUID(), fields: {
        invoice_id: invoice.id, position: i, description: `Base al ${rate} % según documento`, net_amount: v.base / 100, vat_rate: rate, vat_amount: v.quota / 100 } })),
      ...[...vatByRate.entries()].map(([rate, v], i): RowOperation => ({ op: 'insert', table: TAX_LINES, id: crypto.randomUUID(), fields: {
        invoice_id: invoice.id, position: i, tax_type: 'iva', rate, taxable_base: v.base / 100, amount: v.quota / 100 } })),
      ...(f.withholding ? [{ op: 'insert', table: TAX_LINES, id: crypto.randomUUID(), fields: {
        invoice_id: invoice.id, position: vatByRate.size, tax_type: 'irpf', rate: withholdingKind.value === 'otro' ? null : Number(withholdingKind.value), taxable_base: withholdingKind.value === 'otro' ? null : f.base / 100, amount: f.withholding / 100 } } as RowOperation] : []),
    ];
  }

  const saveAmounts = el('button', { 'data-feedback-id': 'invoices.facturas.manual.guardar_importes', 'data-feedback-label': 'Guardar importes', class: 'primary small', type: 'button', id: 'saveAmounts', onclick: async () => {
    const ops = await amountOps();
    if (!ops) return;
    await queue;
    if (await commitSafely(client, ops, 'Importes guardados.')) { amountsDirty = false; markDirty(); }
  } }, 'Guardar importes');
  const discardAmounts = el('button', { 'data-feedback-id': 'invoices.facturas.manual.descartar_importes', 'data-feedback-label': 'Descartar cambios de importes', class: 'linkbtn', type: 'button', onclick: () => { loadAmounts(); amountsDirty = false; markDirty(); paint(); } }, 'Descartar');
  const amountsBar = el('p', { class: 'btnrow', id: 'manualAmountsBar', hidden: true }, saveAmounts, discardAmounts, el('span', { class: 'hint' }, 'Los importes cambiados aún no se han guardado.'));

  // --- Lo leído del PDF, todo junto
  const readingHost = el('div', { id: 'editorReading' });
  const saveRead = el('button', { 'data-feedback-id': 'invoices.facturas.manual.guardar_leido', 'data-feedback-label': 'Guardar lo leído', class: 'primary small', type: 'button', id: 'saveRead', onclick: async () => {
    const amounts = await amountOps();
    if (!amounts) return;
    const sup = supplierOps();
    await queue;
    const fresh = await freshInvoice();
    const fields: Record<string, unknown> = { invoice_number: number.value.trim() || null, invoice_date: date.value || null, source_total: parseAmount(total.value), ...(sup.supplierId ? { supplier_id: sup.supplierId } : {}) };
    if (await commitSafely(client, [...sup.ops, { op: 'update', table: INVOICES, id: invoice.id, expectedRevision: fresh.revision, fields }, ...amounts], 'Datos leídos guardados.')) {
      pendingFill = false; amountsDirty = false; markDirty(); replace(readingHost);
    }
  } }, 'Guardar lo leído');
  const discardRead = el('button', { 'data-feedback-id': 'invoices.facturas.manual.descartar_leido', 'data-feedback-label': 'Descartar lo leído', class: 'linkbtn', type: 'button', onclick: () => {
    pendingFill = false; amountsDirty = false; markDirty(); replace(readingHost);
    number.value = invoice.invoice_number ?? ''; date.value = invoice.invoice_date ?? ''; total.value = money(invoice.source_total === null ? null : Number(invoice.source_total));
    taxId.value = placeholder ? '' : current?.tax_id ?? ''; name.value = placeholder ? '' : current?.name ?? ''; syncSupplier(); loadAmounts(); paint();
  } }, 'Descartar');
  const fillBar = el('p', { class: 'btnrow', id: 'manualFillBar', hidden: true }, saveRead, discardRead, el('span', { class: 'hint' }, 'Revisa lo leído (resaltado) y guárdalo.'));
  const reread = opts.onReread ? el('button', { 'data-feedback-id': 'invoices.facturas.manual.volver_a_leer', 'data-feedback-label': 'Leer de nuevo el PDF', class: 'softbtn small', type: 'button', id: 'rereadPdf', onclick: opts.onReread }, 'Leer de nuevo el PDF') : null;

  const badges: HTMLElement[] = [];
  const b = (key: string | null, value: () => string) => { const x = badge(key, value); badges.push(x); return x; };
  const element = el('div', { 'data-feedback-id': 'invoices.facturas.manual', 'data-feedback-label': 'Datos de la factura', id: 'invoiceEditor' },
    readingHost,
    el('div', { class: 'row2' },
      field('NIF del proveedor', taxId), field('Proveedor', name)),
    supplierNote,
    el('div', { class: 'row2' }, field('Número de factura', number), field('Fecha de la factura', date)),
    el('p', { class: 'hint' }, 'Base imponible, tipo de IVA y cuota (se calcula; corrígela si la factura dice otra cosa):', ' ', b('document_totals.base', () => rows.map((r) => r.base.value).join(''))),
    rowsHost,
    el('p', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'invoices.facturas.manual.otro_tipo', 'data-feedback-label': 'Otro tipo de IVA', class: 'linkbtn', type: 'button', id: 'manualAddRow', onclick: () => { addRow('10'); onAmounts(); } }, '+ Otro tipo de IVA')),
    el('div', { class: 'row2' }, field('Retención', withholdingKind), withholdingAmount),
    field('Total de la factura', total, 'Lo que imprime la factura: se compara con el cálculo (tolerancia 0,02 €).'),
    cuadre,
    amountsBar,
    field('Categoría de gasto', category),
    fillBar,
    reread ? el('p', { class: 'btnrow' }, reread, el('span', { class: 'hint' }, 'Pinta aquí lo que se lee del documento para revisarlo antes de guardarlo.')) : null,
  );
  // Etiquetas con su marca de lectura (las de `field` se ponen aquí para llevar el chip)
  const setLabel = (input: HTMLElement, _text: string, key: string | null, value: () => string) => { const span = input.closest('label')?.querySelector(':scope > span'); if (span) span.append(' ', b(key, value)); };
  setLabel(taxId, 'NIF del proveedor', 'invoice.supplier_tax_id', () => taxId.value);
  setLabel(name, 'Proveedor', 'invoice.supplier_name', () => name.value);
  setLabel(number, 'Número de factura', 'invoice.invoice_number', () => number.value);
  setLabel(date, 'Fecha de la factura', 'invoice.invoice_date', () => date.value);
  setLabel(total, 'Total de la factura', 'document_totals.total', () => total.value);
  setLabel(category, 'Categoría de gasto', null, () => category.value);
  [taxId, name, number, date, total, category].forEach((i) => i.addEventListener('input', paint));
  category.addEventListener('change', paint);

  loadAmounts();
  syncSupplier();
  paint();

  function fill(prefill: ManualPrefill, mode: 'empty' | 'replace'): void {
    const f = prefill.found;
    const set = (input: HTMLInputElement, value: string | null | undefined) => {
      if (value === null || value === undefined || value === '') return;
      if (mode === 'empty' && input.value) return;
      if (input.value !== value) { input.value = value; input.classList.add('needs-attention'); }
    };
    set(taxId, f.supplier_tax_id); syncSupplier();
    if (!name.disabled) set(name, f.supplier_name);
    set(number, f.invoice_number); set(date, f.invoice_date); set(total, f.total === null ? null : money(f.total));
    const bases = f.vat.length && f.vat.every((v) => v.base !== null) ? f.vat : f.base !== null ? [{ rate: f.vat.length === 1 ? f.vat[0]!.rate : 21, base: f.base, quota: f.vat.length === 1 ? f.vat[0]!.quota : null }] : [];
    const hasAmounts = rows.some((r) => r.base.value.trim());
    if (bases.length && (mode === 'replace' || !hasAmounts)) {
      replace(rowsHost); rows.length = 0;
      for (const v of bases) {
        const row = addRow(RATES.some(([r]) => r === String(v.rate)) ? String(v.rate) : '21');
        row.base.value = money(v.base);
        if (v.quota !== null) { row.quota.value = money(v.quota); row.touched = true; } else row.quota.value = money(Math.round(Number(v.base) * v.rate) / 100);
        row.base.classList.add('needs-attention');
      }
      if (f.withholding) {
        withholdingKind.value = f.withholding.rate !== null && WITHHOLDINGS.some(([r]) => r === String(f.withholding!.rate)) ? String(f.withholding.rate) : 'otro';
        withholdingAmount.value = money(f.withholding.amount);
      }
    }
    replace(readingHost, readingPanel(prefill, { fields: false }));
    pendingFill = true; markDirty(); paint();
  }

  return { element, fill, dirty: () => pendingFill || amountsDirty };
}
