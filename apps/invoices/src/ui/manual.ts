/**
 * «Rellenar a mano» (9-10-2026, petición del usuario vía Core): para una factura en «Pendiente de datos» que no se pudo
 * leer, los datos esenciales en una sola hoja: proveedor por NIF (con alta rápida), número, fecha, base por tipo de IVA,
 * cuota, retención y total del documento, con el cuadre en vivo. «Guardar y validar» valida en el mismo lote y aprende la
 * plantilla del proveedor con lo confirmado (si el documento tiene texto), para que la próxima factura se lea sola.
 */
import type { RowOperation } from '@ikisai/sync-client';
import { closeSheet, confirmDialog, el, openSheet, replace } from '@ikisai/ui-kit';
import { validSpanishTaxId, type PartialInvoice, type ReadLevel } from '@ikisai/domain-invoices';
import { CATEGORIES, CATEGORY_LABELS, INVOICES, INVOICE_LINES, SUPPLIERS, TAX_LINES, type LocalInvoice } from '../app/client.ts';
import { eur, parseAmount, type Mirror } from '../app/data.ts';
import { guard } from '../app/guard.ts';
import { usage } from '../app/usage.ts';
import { commitSafely, field, select } from './common.ts';
import { readingPanel } from './reading.ts';
import type { ViewContext } from './shell.ts';

const RATES: Array<[string, string]> = [['21', 'IVA 21 %'], ['10', 'IVA 10 %'], ['4', 'IVA 4 %'], ['0', 'IVA 0 % / exenta']];
const WITHHOLDINGS: Array<[string, string]> = [['', 'Sin retención'], ['15', 'IRPF 15 %'], ['7', 'IRPF 7 %'], ['19', 'IRPF 19 %'], ['otro', 'Otra (importe)']];
const cents = (v: number) => Math.round(v * 100);
const money = (v: number | null) => (v === null ? '' : String(v).replace('.', ','));

/** Lo que leyó «Leer PDF» sin llegar a una factura completa: rellena lo vacío y se enseña arriba, con el texto. */
export interface ManualPrefill { read: ReadLevel; found: PartialInvoice; message: string; text: string | null }

export function openManualEntry(ctx: ViewContext, mirror: Mirror, invoice: LocalInvoice, validate: (invoiceId: string) => Promise<void>, prefill?: ManualPrefill): void {
  const { client } = ctx;
  const current = mirror.supplierById.get(invoice.supplier_id);
  const placeholder = current?.slug === 'sin_identificar';
  // --- Proveedor por NIF (o elegido de la lista), con alta rápida
  const taxId = el('input', { 'data-feedback-id': 'invoices.facturas.manual.nif', 'data-feedback-label': 'NIF del proveedor', type: 'text', id: 'manualTaxId', maxlength: '20', autocapitalize: 'characters', placeholder: 'B12345674', value: placeholder ? '' : current?.tax_id ?? '' });
  const name = el('input', { 'data-feedback-id': 'invoices.facturas.manual.nombre', 'data-feedback-label': 'Nombre del proveedor', type: 'text', id: 'manualName', maxlength: '160', placeholder: 'Nombre o razón social', value: placeholder ? '' : current?.name ?? '' });
  const supplierNote = el('p', { class: 'hint', id: 'manualSupplierNote' });
  const findByTaxId = () => {
    const id = validSpanishTaxId(taxId.value) ?? taxId.value.replace(/[\s.-]/g, '').toUpperCase();
    return id ? mirror.suppliers.find((s) => !s.deleted_at && s.slug !== 'sin_identificar' && (s.tax_id ?? '').replace(/[\s.-]/g, '').toUpperCase() === id) ?? null : null;
  };
  const syncSupplier = () => {
    const found = findByTaxId();
    if (found) { name.value = found.name; name.disabled = true; replace(supplierNote, `Proveedor conocido: ${found.name}.`); if (!category.value && found.default_category) category.value = found.default_category; }
    else { name.disabled = false; replace(supplierNote, taxId.value.trim() ? (validSpanishTaxId(taxId.value) ? 'Proveedor nuevo: se dará de alta con este NIF.' : 'Ese NIF no parece válido; revísalo.') : 'Escribe el NIF: si ya existe, se elige solo.'); }
  };
  // --- Datos de la factura
  const number = el('input', { 'data-feedback-id': 'invoices.facturas.manual.numero', 'data-feedback-label': 'Número de factura', type: 'text', id: 'manualNumber', maxlength: '64', value: invoice.invoice_number ?? '' });
  const date = el('input', { 'data-feedback-id': 'invoices.facturas.manual.fecha', 'data-feedback-label': 'Fecha de la factura', type: 'date', id: 'manualDate', value: invoice.invoice_date ?? '' });
  const category = select('manualCategory', [['', 'Elige categoría'], ...CATEGORIES.map((c) => [c, CATEGORY_LABELS[c]] as [string, string])], invoice.expense_category ?? null, { 'data-feedback-id': 'invoices.facturas.manual.categoria', 'data-feedback-label': 'Categoría de gasto' });
  // --- Bases por tipo de IVA (la cuota se calcula y se puede corregir)
  type Row = { base: HTMLInputElement; rate: HTMLSelectElement; quota: HTMLInputElement; touched: boolean };
  const rows: Row[] = [];
  const rowsHost = el('div', { id: 'manualRows' });
  const addRow = (rate = '21') => {
    const row: Row = {
      base: el('input', { 'data-feedback-ignore': '', type: 'text', inputmode: 'decimal', placeholder: 'Base', 'aria-label': `Base imponible ${rows.length + 1}` }),
      rate: select('', RATES, rate, { 'data-feedback-ignore': '', 'aria-label': `Tipo de IVA ${rows.length + 1}` }),
      quota: el('input', { 'data-feedback-ignore': '', type: 'text', inputmode: 'decimal', placeholder: 'Cuota', 'aria-label': `Cuota de IVA ${rows.length + 1}` }),
      touched: false,
    };
    const autoQuota = () => { if (row.touched) return; const b = parseAmount(row.base.value); row.quota.value = b === null ? '' : money(Math.round(b * Number(row.rate.value)) / 100); };
    row.base.addEventListener('input', () => { autoQuota(); paint(); });
    row.rate.addEventListener('change', () => { autoQuota(); paint(); });
    row.quota.addEventListener('input', () => { row.touched = true; paint(); });
    rows.push(row);
    rowsHost.appendChild(el('div', { class: 'row3 manual-row' }, row.base, row.rate, row.quota));
  };
  addRow();
  const withholdingKind = select('manualWithholding', WITHHOLDINGS, '', { 'data-feedback-id': 'invoices.facturas.manual.retencion', 'data-feedback-label': 'Retención' });
  const withholdingAmount = el('input', { 'data-feedback-ignore': '', type: 'text', inputmode: 'decimal', id: 'manualWithholdingAmount', placeholder: 'Importe retenido', hidden: true });
  const total = el('input', { 'data-feedback-id': 'invoices.facturas.manual.total', 'data-feedback-label': 'Total de la factura', type: 'text', inputmode: 'decimal', id: 'manualTotal', placeholder: 'Total que imprime la factura', value: money(invoice.source_total === null ? null : Number(invoice.source_total)) });
  const cuadre = el('div', { class: 'banner info', id: 'manualCuadre', role: 'status' });
  const error = el('p', { class: 'formerror', role: 'alert' });

  /** Bases, cuotas, retención y total calculado, en céntimos. */
  function figures() {
    const lines = rows.map((r) => ({ base: parseAmount(r.base.value), rate: Number(r.rate.value), quota: parseAmount(r.quota.value) })).filter((r) => r.base !== null) as Array<{ base: number; rate: number; quota: number | null }>;
    const base = lines.reduce((n, r) => n + cents(r.base), 0);
    const vat = lines.reduce((n, r) => n + cents(r.quota ?? Math.round(r.base * r.rate) / 100), 0);
    const kind = withholdingKind.value;
    const withholding = kind === '' ? 0 : kind === 'otro' ? cents(parseAmount(withholdingAmount.value) ?? 0) : Math.round(base * Number(kind) / 100);
    return { lines, base, vat, withholding, calculated: base + vat - withholding, declared: parseAmount(total.value) };
  }
  function paint(): void {
    withholdingAmount.hidden = withholdingKind.value !== 'otro';
    const f = figures();
    const fmt = (c: number) => eur(c / 100);
    const diff = f.declared === null ? null : cents(f.declared) - f.calculated;
    cuadre.className = `banner ${diff === null ? 'info' : Math.abs(diff) <= 2 ? 'ok' : 'warn'}`;
    replace(cuadre, el('span', null, `Base ${fmt(f.base)} + IVA ${fmt(f.vat)}${f.withholding ? ` − retención ${fmt(f.withholding)}` : ''} = ${fmt(f.calculated)}`,
      diff === null ? ' · escribe el total de la factura para comprobarlo.' : Math.abs(diff) <= 2 ? ' · ✓ cuadra con el total.' : ` · no cuadra con el total (diferencia ${fmt(diff)}).`));
  }
  // Lectura parcial (fase 0): lo encontrado rellena lo vacío; lo que falta queda en blanco y lo dice el aviso de arriba.
  if (prefill) {
    const f = prefill.found;
    if (!taxId.value && f.supplier_tax_id) taxId.value = f.supplier_tax_id;
    if (!name.value && f.supplier_name) name.value = f.supplier_name;
    if (!number.value && f.invoice_number) number.value = f.invoice_number;
    if (!date.value && f.invoice_date) date.value = f.invoice_date;
    if (!total.value && f.total !== null) total.value = money(f.total);
    const bases = f.vat.length && f.vat.every((v) => v.base !== null) ? f.vat : f.base !== null ? [{ rate: f.vat.length === 1 ? f.vat[0]!.rate : 21, base: f.base, quota: f.vat.length === 1 ? f.vat[0]!.quota : null }] : [];
    bases.forEach((v, i) => {
      if (i > 0) addRow();
      const row = rows[i]!;
      if (RATES.some(([r]) => r === String(v.rate))) row.rate.value = String(v.rate);
      row.base.value = money(v.base);
      if (v.quota !== null) { row.quota.value = money(v.quota); row.touched = true; }
    });
    if (f.withholding) {
      withholdingKind.value = f.withholding.rate !== null && WITHHOLDINGS.some(([r]) => r === String(f.withholding!.rate)) ? String(f.withholding.rate) : 'otro';
      withholdingAmount.value = money(f.withholding.amount);
    }
  }
  [total, withholdingAmount].forEach((i) => i.addEventListener('input', paint));
  withholdingKind.addEventListener('change', paint);
  taxId.addEventListener('input', syncSupplier);
  syncSupplier(); paint();

  async function save(andValidate: boolean): Promise<void> {
    error.textContent = '';
    const f = figures();
    const known = findByTaxId();
    if (!known && !name.value.trim()) { error.textContent = 'Escribe el NIF o el nombre del proveedor.'; taxId.focus(); return; }
    if (!date.value) { error.textContent = 'Indica la fecha de la factura.'; date.focus(); return; }
    if (!f.lines.length) { error.textContent = 'Escribe al menos una base imponible.'; rows[0]!.base.focus(); return; }
    if (andValidate && !category.value) { error.textContent = 'Elige la categoría de gasto para validar.'; category.focus(); return; }
    const supplierId = known?.id ?? crypto.randomUUID();
    const vatByRate = new Map<number, { base: number; quota: number }>();
    for (const l of f.lines) { const q = l.quota ?? Math.round(l.base * l.rate) / 100; const g = vatByRate.get(l.rate) ?? { base: 0, quota: 0 }; vatByRate.set(l.rate, { base: g.base + cents(l.base), quota: g.quota + cents(q) }); }
    const oldLines = (mirror.linesByInvoice.get(invoice.id) ?? []).filter((l) => !l.deleted_at);
    const oldTaxes = (mirror.taxesByInvoice.get(invoice.id) ?? []).filter((t) => !t.deleted_at);
    const ops: RowOperation[] = [
      ...(known ? [] : [{ op: 'insert', table: SUPPLIERS, id: supplierId, fields: { name: name.value.trim(), tax_id: validSpanishTaxId(taxId.value) ?? (taxId.value.trim() || null) } } as RowOperation]),
      ...oldLines.map((l): RowOperation => ({ op: 'delete', table: INVOICE_LINES, id: l.id, expectedRevision: l.revision })),
      ...oldTaxes.map((t): RowOperation => ({ op: 'delete', table: TAX_LINES, id: t.id, expectedRevision: t.revision })),
      { op: 'update', table: INVOICES, id: invoice.id, expectedRevision: invoice.revision, fields: {
        supplier_id: supplierId, invoice_number: number.value.trim() || null, invoice_date: date.value, source_total: f.declared, expense_category: category.value || null,
      } },
      ...[...vatByRate.entries()].map(([rate, v], i): RowOperation => ({ op: 'insert', table: INVOICE_LINES, id: crypto.randomUUID(), fields: {
        invoice_id: invoice.id, position: i, description: `Base al ${rate} % según documento`, net_amount: v.base / 100, vat_rate: rate, vat_amount: v.quota / 100 } })),
      ...[...vatByRate.entries()].map(([rate, v], i): RowOperation => ({ op: 'insert', table: TAX_LINES, id: crypto.randomUUID(), fields: {
        invoice_id: invoice.id, position: i, tax_type: 'iva', rate, taxable_base: v.base / 100, amount: v.quota / 100 } })),
      ...(f.withholding ? [{ op: 'insert', table: TAX_LINES, id: crypto.randomUUID(), fields: {
        invoice_id: invoice.id, position: vatByRate.size, tax_type: 'irpf', rate: withholdingKind.value === 'otro' ? null : Number(withholdingKind.value), taxable_base: withholdingKind.value === 'otro' ? null : f.base / 100, amount: f.withholding / 100 } } as RowOperation] : []),
    ];
    const ok = await commitSafely(client, ops, andValidate ? 'Datos guardados.' : 'Datos guardados: queda pendiente de revisión.');
    usage.track('invoices.facturas.manual', ok ? 'success' : 'error');
    if (!ok) return;
    guard.dirtyEditor = false;
    await closeSheet(true);
    if (andValidate) await validate(invoice.id);
  }

  openSheet({
    title: 'Rellenar a mano',
    meta: 'Los datos esenciales de la factura. Al validar, Finance aprende dónde están en el PDF de este proveedor para leer solas las siguientes.',
    body: el('div', { 'data-feedback-id': 'invoices.facturas.manual', 'data-feedback-label': 'Rellenar a mano', oninput: () => { guard.dirtyEditor = true; } },
      prefill ? readingPanel(prefill) : null,
      el('div', { class: 'row2' }, field('NIF del proveedor', taxId), field('Proveedor', name)), supplierNote,
      el('div', { class: 'row2' }, field('Número de factura', number), field('Fecha de la factura', date)),
      el('p', { class: 'hint' }, 'Base imponible, tipo de IVA y cuota (se calcula; corrígela si la factura dice otra cosa):'),
      rowsHost,
      el('p', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'invoices.facturas.manual.otro_tipo', 'data-feedback-label': 'Otro tipo de IVA', class: 'linkbtn', type: 'button', id: 'manualAddRow', onclick: () => { addRow('10'); paint(); } }, '+ Otro tipo de IVA')),
      el('div', { class: 'row2' }, field('Retención', withholdingKind), withholdingAmount),
      field('Total de la factura', total, 'Lo que imprime la factura: se compara con el cálculo (tolerancia 0,02 €).'),
      cuadre,
      field('Categoría de gasto', category),
      error),
    foot: [
      el('button', { 'data-feedback-id': 'invoices.facturas.manual.guardar', 'data-feedback-label': 'Guardar', class: 'ghost', type: 'button', id: 'manualSave', onclick: () => void save(false) }, 'Guardar'),
      el('button', { 'data-feedback-id': 'invoices.facturas.manual.guardar_validar', 'data-feedback-label': 'Guardar y validar', class: 'primary', type: 'button', id: 'manualSaveValidate', onclick: () => void save(true) }, 'Guardar y validar'),
    ],
    initialFocus: taxId,
    beforeClose: async () => !guard.dirtyEditor || confirmDialog({ title: 'Hay datos sin guardar', text: '¿Descartarlos?', confirmLabel: 'Descartar', danger: true }),
    onClose: () => { guard.dirtyEditor = false; },
  });
}
