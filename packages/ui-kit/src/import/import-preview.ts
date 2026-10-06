/**
 * Hoja de importación de un documento estructurado (JSON `ikisai.invoice.v1`): origen del texto, errores de formato,
 * previsualización de líneas e impuestos y cuadre de totales con tolerancia. El kit no conoce el dominio: recibe el
 * documento ya validado y el recálculo hechos por la app (`@ikisai/domain-invoices`) y solo los pinta.
 */
import { el, replace, type Child } from '../dom.ts';
import { icon } from '../icons.ts';
import { openSheet, type Sheet } from '../overlay/sheet.ts';

/** Forma mínima del documento (compatible con `ImportDocument` del dominio de Invoices). */
export interface ImportPreviewDocument {
  invoice: { invoice_date: string; supplier_name: string; supplier_tax_id?: string | null; invoice_number?: string | null; object: string; currency: string };
  lines: Array<{ description: string; quantity?: number | null; unit?: string | null; unit_price?: number | null; discount_amount?: number | null; net_amount: number; vat_rate?: number | null; vat_amount?: number | null; confidence?: number | null }>;
  taxes: Array<{ tax_type: string; rate?: number | null; taxable_base?: number | null; amount: number }>;
  document_totals: { base: number; vat: number; withholding: number; total: number };
  extraction_notes?: string | null;
  overall_confidence?: number | null;
}

/** Forma mínima del recálculo (compatible con `Recalculation` del dominio de Invoices). */
export interface ImportPreviewRecalc {
  calculated_base: number;
  calculated_vat: number;
  calculated_other: number;
  calculated_withholding: number;
  calculated_total: number;
  totals_delta: number | null;
  within_tolerance: boolean | null;
  taxes_derived?: boolean;
  warnings: Array<{ code: string; message: string; line?: number }>;
}

export interface SchemaErrorLike {
  path: string;
  reason: string;
}

export type ImportParseResult<D> = { ok: true; document: D } | { ok: false; errors: SchemaErrorLike[] };

export const TAX_TYPE_LABELS: Record<string, string> = { iva: 'IVA', irpf: 'IRPF', otra_retencion: 'Otra retención', otro: 'Otro' };

/** Importe con moneda a la española: `1.234,56 €`. */
export function formatMoney(value: number | null | undefined, currency = 'EUR', locale = 'es-ES'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function cents(value: number): number {
  return Math.round(Math.abs(value) * 100 + 1e-9) * (value < 0 ? -1 : 1);
}

/** Errores de formato del JSON, hasta `limit`. */
export function renderSchemaErrors(errors: SchemaErrorLike[], limit = 8): HTMLElement {
  return el('div', { class: 'banner alert imp-errors', role: 'alert' },
    icon('warn', 18),
    el('div', null,
      el('strong', null, 'El JSON no cumple el formato esperado'),
      el('ul', null, ...errors.slice(0, limit).map((e) => el('li', null, el('code', null, e.path), ' · ', e.reason)), errors.length > limit ? el('li', null, `y ${errors.length - limit} más`) : null),
    ),
  );
}

/** Cabecera del documento: proveedor, fecha, número, objeto y confianza. */
export function renderImportHeader(doc: ImportPreviewDocument): HTMLElement {
  const confidence = doc.overall_confidence ?? null;
  return el('div', { class: 'imp-head' },
    el('dl', { class: 'kv' },
      el('dt', null, 'Proveedor'), el('dd', null, doc.invoice.supplier_name, doc.invoice.supplier_tax_id ? el('span', { class: 'muted' }, ` · ${doc.invoice.supplier_tax_id}`) : null),
      el('dt', null, 'Fecha'), el('dd', null, doc.invoice.invoice_date),
      el('dt', null, 'Número'), el('dd', null, doc.invoice.invoice_number ?? '—'),
      el('dt', null, 'Objeto'), el('dd', null, doc.invoice.object),
    ),
    confidence !== null ? el('span', { class: `chip ${confidence >= 0.9 ? 'ok' : confidence >= 0.7 ? '' : 'alert'}`, title: 'Confianza de la extracción' }, el('span', null, `Confianza ${Math.round(confidence * 100)} %`)) : null,
  );
}

/** Tabla de líneas; las que tienen aviso en el recálculo se marcan. */
export function renderImportLines(doc: ImportPreviewDocument, recalc?: ImportPreviewRecalc | null): HTMLElement {
  const flagged = new Set((recalc?.warnings ?? []).filter((w) => typeof w.line === 'number').map((w) => w.line));
  const currency = doc.invoice.currency;
  if (!doc.lines.length) return el('p', { class: 'hint' }, 'El documento no trae artículos.');
  return el('table', { class: 'table imp-lines' },
    el('thead', null, el('tr', null, el('th', null, 'Descripción'), el('th', { class: 'num' }, 'Cant.'), el('th', { class: 'num' }, 'Precio'), el('th', { class: 'num' }, 'Neto'), el('th', { class: 'num' }, 'IVA'))),
    el('tbody', null, ...doc.lines.map((l, i) => el('tr', { class: flagged.has(i) ? 'bad' : '', dataset: { line: String(i) } },
      el('td', null, l.description, l.confidence != null && l.confidence < 0.7 ? el('span', { class: 'chip alert small' }, el('span', null, 'dudosa')) : null),
      el('td', { class: 'num' }, l.quantity == null ? '—' : `${l.quantity} ${l.unit ?? ''}`.trim()),
      el('td', { class: 'num' }, l.unit_price == null ? '—' : formatMoney(l.unit_price, currency)),
      el('td', { class: 'num' }, formatMoney(l.net_amount, currency)),
      el('td', { class: 'num' }, l.vat_rate == null ? '—' : `${l.vat_rate} %`),
    ))),
  );
}

export function renderImportTaxes(doc: ImportPreviewDocument, recalc?: ImportPreviewRecalc | null): HTMLElement {
  const currency = doc.invoice.currency;
  if (!doc.taxes.length) return el('p', { class: 'hint' }, recalc?.taxes_derived ? 'Sin desglose en el documento: el IVA se deriva de los artículos.' : 'Sin desglose de impuestos.');
  return el('table', { class: 'table imp-taxes' },
    el('thead', null, el('tr', null, el('th', null, 'Impuesto'), el('th', { class: 'num' }, 'Tipo'), el('th', { class: 'num' }, 'Base'), el('th', { class: 'num' }, 'Importe'))),
    el('tbody', null, ...doc.taxes.map((t) => el('tr', null,
      el('td', null, TAX_TYPE_LABELS[t.tax_type] ?? t.tax_type),
      el('td', { class: 'num' }, t.rate == null ? '—' : `${t.rate} %`),
      el('td', { class: 'num' }, t.taxable_base == null ? '—' : formatMoney(t.taxable_base, currency)),
      el('td', { class: 'num' }, formatMoney(t.amount, currency)),
    ))),
  );
}

export interface ReconciliationOptions {
  toleranceEur?: number;
  /** Texto del veredicto cuando cuadra / no cuadra. */
  okText?: string;
  badText?: (delta: number) => string;
}

/** Cuadre: calculado frente a documento, con diferencia por fila y veredicto dentro o fuera de tolerancia. */
export function renderImportReconciliation(doc: ImportPreviewDocument, recalc: ImportPreviewRecalc, options: ReconciliationOptions = {}): HTMLElement {
  const tolerance = options.toleranceEur ?? 0.02;
  const currency = doc.invoice.currency;
  const row = (label: string, calc: number, declared: number) => {
    const diff = calc - declared;
    const bad = Math.abs(cents(calc) - cents(declared)) > cents(tolerance);
    return el('tr', { class: bad ? 'bad' : '', dataset: { row: label.toLowerCase() } },
      el('th', { scope: 'row' }, label),
      el('td', { class: 'num' }, formatMoney(calc, currency)),
      el('td', { class: 'num' }, formatMoney(declared, currency)),
      el('td', { class: 'num diff' }, bad ? formatMoney(diff, currency) : '✓'),
    );
  };
  const delta = recalc.totals_delta ?? 0;
  const ok = recalc.within_tolerance !== false;
  return el('div', { class: 'imp-reconcile' },
    el('table', { class: 'table imp-cuadre' },
      el('thead', null, el('tr', null, el('th'), el('th', { class: 'num' }, 'Calculado'), el('th', { class: 'num' }, 'Documento'), el('th', { class: 'num' }, 'Diferencia'))),
      el('tbody', null,
        row('Base', recalc.calculated_base, doc.document_totals.base),
        row('IVA', recalc.calculated_vat + recalc.calculated_other, doc.document_totals.vat),
        row('Retenciones', recalc.calculated_withholding, doc.document_totals.withholding),
        row('Total', recalc.calculated_total, doc.document_totals.total),
      ),
    ),
    el('p', { class: `imp-verdict ${ok ? 'ok' : 'bad'}`, role: 'status', dataset: { verdict: ok ? 'ok' : 'bad' } },
      icon(ok ? 'check' : 'warn', 18),
      el('span', null, ok ? (options.okText ?? `Cuadra dentro de la tolerancia de ${formatMoney(tolerance, currency)}.`) : (options.badText ? options.badText(delta) : `REVISAR IMPORTES: diferencia de ${formatMoney(delta, currency)} entre el documento y el cálculo. Se importará como pendiente de revisión.`)),
    ),
    recalc.warnings.filter((w) => w.code !== 'TOTALS_MISMATCH').length
      ? el('ul', { class: 'imp-warnings' }, ...recalc.warnings.filter((w) => w.code !== 'TOTALS_MISMATCH').map((w) => el('li', null, w.message)))
      : null,
    doc.extraction_notes ? el('p', { class: 'hint' }, 'Notas de la extracción: ', doc.extraction_notes) : null,
  );
}

export interface JsonSourceOptions {
  onText: (text: string) => void;
  placeholder?: string;
  /** Acepta archivos `.json` además del pegado; por defecto sí. */
  file?: boolean;
  id?: string;
}

export interface JsonSource {
  element: HTMLElement;
  textarea: HTMLTextAreaElement;
  setText(text: string): void;
}

/** Origen del JSON: pegar, subir archivo o leer del portapapeles. */
export function createJsonSource(options: JsonSourceOptions): JsonSource {
  const id = options.id ?? 'importJson';
  const textarea = el('textarea', { id, rows: '6', placeholder: options.placeholder ?? 'Pega aquí el JSON…', spellcheck: 'false', 'aria-label': 'JSON a importar' });
  const file = options.file === false ? null : el('input', { type: 'file', accept: 'application/json,.json', id: `${id}File`, 'aria-label': 'Archivo JSON' });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const emit = () => options.onText(textarea.value);
  textarea.addEventListener('input', () => { if (timer) clearTimeout(timer); timer = setTimeout(emit, 250); });
  textarea.addEventListener('paste', () => setTimeout(emit, 0));
  file?.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    textarea.value = await f.text();
    emit();
  });
  const paste = typeof navigator !== 'undefined' && navigator.clipboard?.readText
    ? el('button', { class: 'ghost small', type: 'button', onclick: async () => { try { textarea.value = await navigator.clipboard.readText(); emit(); } catch { textarea.focus(); } } }, icon('attach', 16), 'Pegar del portapapeles')
    : null;
  const element = el('div', { class: 'imp-source' },
    el('label', { class: 'field' }, el('span', null, 'JSON del documento'), textarea),
    el('div', { class: 'btnrow' }, paste, file ? el('label', { class: 'ghost small imp-file' }, icon('upload', 16), 'Subir archivo .json', file) : null),
  );
  return { element, textarea, setText(text) { textarea.value = text; emit(); } };
}

export interface ImportSheetOptions<D extends ImportPreviewDocument> {
  title?: string;
  /** Valida el texto (por ejemplo `parseImportDocument` del dominio). */
  parse: (text: string) => ImportParseResult<D>;
  /** Recálculo y cuadre del documento (`recalculate` del dominio). */
  recalculate: (document: D) => ImportPreviewRecalc;
  /** Campos propios de la app (proveedor, categoría…) que se muestran sobre el cuadre; se vuelven a pedir con cada documento válido. */
  fields?: (document: D, recalc: ImportPreviewRecalc) => Child;
  /** Avisos propios (duplicados…) sobre la previsualización. */
  notices?: (document: D, recalc: ImportPreviewRecalc) => Child;
  /** Importa; si lanza, el error se muestra en la hoja. */
  onImport: (document: D, recalc: ImportPreviewRecalc) => Promise<void> | void;
  importLabel?: string;
  /** JSON inicial (por ejemplo, el que llega por «compartir»). */
  initialText?: string;
  toleranceEur?: number;
  onClose?: () => void;
}

export interface ImportSheet<D> {
  sheet: Sheet;
  /** Documento válido actual o `null`. */
  current(): D | null;
  setText(text: string): void;
}

/** Hoja completa de importación: origen → errores o previsualización → importar. */
export function openImportSheet<D extends ImportPreviewDocument>(options: ImportSheetOptions<D>): ImportSheet<D> {
  let document: D | null = null;
  let recalc: ImportPreviewRecalc | null = null;
  const preview = el('div', { class: 'imp-preview', id: 'importPreview' });
  const error = el('p', { class: 'formerror', role: 'alert' });
  const confirm = el('button', { class: 'primary', type: 'button', id: 'confirmImport', disabled: true }, options.importLabel ?? 'Importar');
  const source = createJsonSource({ onText: handle, placeholder: 'Pega aquí el JSON que devolvió la extracción…' });

  function handle(text: string): void {
    error.textContent = '';
    if (!text.trim()) { document = null; recalc = null; confirm.disabled = true; replace(preview, el('p', { class: 'hint' }, 'Pega o sube el JSON para ver la previsualización.')); return; }
    const result = options.parse(text);
    if (!result.ok) { document = null; recalc = null; confirm.disabled = true; replace(preview, renderSchemaErrors(result.errors)); return; }
    document = result.document;
    recalc = options.recalculate(document);
    confirm.disabled = false;
    replace(preview,
      options.notices?.(document, recalc) ?? null,
      renderImportHeader(document),
      options.fields?.(document, recalc) ?? null,
      el('h3', { class: 'imp-sub' }, `Artículos (${document.lines.length})`), renderImportLines(document, recalc),
      el('h3', { class: 'imp-sub' }, 'Impuestos'), renderImportTaxes(document, recalc),
      el('h3', { class: 'imp-sub' }, 'Cuadre'), renderImportReconciliation(document, recalc, { toleranceEur: options.toleranceEur }),
    );
  }

  confirm.addEventListener('click', async () => {
    if (!document || !recalc) return;
    confirm.disabled = true;
    try {
      await options.onImport(document, recalc);
    } catch (e) {
      error.textContent = (e as Error).message || 'No se pudo importar.';
      confirm.disabled = false;
    }
  });

  const sheet = openSheet({
    title: options.title ?? 'Importar documento',
    body: el('div', { class: 'imp' }, source.element, preview, error),
    foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void sheet.close() }, 'Cancelar'), confirm],
    onClose: () => options.onClose?.(),
  });
  handle(options.initialText ?? '');
  if (options.initialText) source.setText(options.initialText);
  return { sheet, current: () => document, setText: (text) => source.setText(text) };
}
