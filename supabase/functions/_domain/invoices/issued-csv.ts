/**
 * Importación de facturas emitidas desde un CSV (API.md §13.4, ronda 26): el usuario las lleva hoy en un Google Sheet.
 * Lectura de CSV (separador `;`, `,` o tabulador, comillas), mapeo de columnas adivinado por el nombre de la cabecera y
 * editable en la hoja de importación, y conversión de cada fila en una emitida con una línea y su desglose.
 * También es el formato que devuelve ChatGPT con el prompt de emitidas (una fila por factura, cabecera de la plantilla).
 */
import { fromCents, toCents } from './money.ts';
import { INCOME_CATEGORIES, ISSUED_TYPES, fullNumber, type IncomeCategory, type IssuedType } from './issued.ts';

/** Campos que se pueden leer de una columna del CSV. */
export const ISSUED_CSV_FIELDS = [
  'series', 'number', 'issue_date', 'operation_date', 'invoice_type', 'recipient_name', 'recipient_tax_id', 'description', 'income_category',
  'base', 'vat_rate', 'vat_amount', 'withholding', 'total', 'paid',
] as const;
export type IssuedCsvField = (typeof ISSUED_CSV_FIELDS)[number];

export const ISSUED_CSV_FIELD_LABELS: Record<IssuedCsvField, string> = {
  series: 'Serie', number: 'Número', issue_date: 'Fecha de expedición', operation_date: 'Fecha de operación', invoice_type: 'Tipo (F1, F2, R1…)',
  recipient_name: 'Cliente', recipient_tax_id: 'NIF del cliente', description: 'Concepto', income_category: 'Categoría de ingreso',
  base: 'Base imponible', vat_rate: 'Tipo de IVA (%)', vat_amount: 'Cuota de IVA', withholding: 'Retención (importe)', total: 'Total', paid: 'Cobrada (sí/no)',
};

/** Obligatorios para importar una fila. */
export const ISSUED_CSV_REQUIRED: readonly IssuedCsvField[] = ['number', 'issue_date', 'base'];

/** Cabecera de la plantilla (y de lo que pide el prompt de emitidas a ChatGPT). */
export const ISSUED_CSV_TEMPLATE_HEADER = ['serie', 'numero', 'fecha', 'fecha_operacion', 'tipo', 'cliente', 'nif', 'concepto', 'categoria', 'base', 'iva_tipo', 'iva_cuota', 'retencion', 'total', 'cobrada'];

/** Nombres de cabecera habituales por campo (normalizados: minúsculas, sin tildes ni signos). */
const SYNONYMS: Record<IssuedCsvField, string[]> = {
  series: ['serie', 'series', 'seriefactura'],
  number: ['numero', 'num', 'nfactura', 'nofactura', 'numerofactura', 'factura', 'nfra', 'numfactura', 'numeroderfactura', 'invoice', 'invoicenumber'],
  issue_date: ['fecha', 'fechaexpedicion', 'fechafactura', 'fechaemision', 'date', 'fechadeexpedicion'],
  operation_date: ['fechaoperacion', 'fechadeoperacion', 'fechaservicio'],
  invoice_type: ['tipo', 'tipofactura', 'tipodefactura'],
  recipient_name: ['cliente', 'destinatario', 'razonsocial', 'nombre', 'nombrecliente', 'customer'],
  recipient_tax_id: ['nif', 'cif', 'dni', 'nifcliente', 'cifcliente', 'nie', 'vat', 'taxid'],
  description: ['concepto', 'descripcion', 'detalle', 'conceptos', 'description'],
  income_category: ['categoria', 'categoriadeingreso', 'tipoingreso', 'familia'],
  base: ['base', 'baseimponible', 'importesiniva', 'subtotal', 'neto', 'importeneto'],
  vat_rate: ['ivatipo', 'tipoiva', 'iva', 'porcentajeiva', 'tipodeiva'],
  vat_amount: ['ivacuota', 'cuotaiva', 'importeiva', 'cuota', 'iva€', 'ivaimporte'],
  withholding: ['retencion', 'irpf', 'retencionirpf', 'retenciones'],
  total: ['total', 'importetotal', 'totalfactura', 'importe'],
  paid: ['cobrada', 'pagada', 'cobro', 'estadocobro', 'cobrado'],
};

export const normalizeHeader = (value: string) =>
  value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9€]+/g, '');

/** Lee un CSV: detecta el separador por la primera línea y respeta comillas dobles (con `""` como comilla). */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const count = (ch: string) => firstLine.split(ch).length - 1;
  const separator = [';', '\t', ','].sort((a, b) => count(b) - count(a))[0]!;
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]!;
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === separator) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}

export type IssuedCsvMapping = Partial<Record<IssuedCsvField, number>>;

/** Mapeo propuesto por los nombres de la cabecera; con `iva` ambiguo prefiere el tipo si la columna lleva «%» o valores pequeños. */
export function guessMapping(header: string[]): IssuedCsvMapping {
  const normalized = header.map(normalizeHeader);
  const mapping: IssuedCsvMapping = {};
  const used = new Set<number>();
  // Primero coincidencias exactas por orden de especificidad (cuota antes que tipo, número antes que tipo de factura).
  const order: IssuedCsvField[] = ['vat_amount', 'vat_rate', 'operation_date', 'issue_date', 'recipient_tax_id', 'recipient_name', 'series', 'number', 'invoice_type',
    'description', 'income_category', 'base', 'withholding', 'total', 'paid'];
  for (const field of order) {
    const idx = normalized.findIndex((h, i) => !used.has(i) && SYNONYMS[field].includes(h));
    if (idx >= 0) { mapping[field] = idx; used.add(idx); }
  }
  // Después, cabeceras que contienen el nombre (p. ej. «Base imponible (€)»).
  for (const field of order) {
    if (mapping[field] !== undefined) continue;
    const idx = normalized.findIndex((h, i) => !used.has(i) && SYNONYMS[field].some((s) => s.length >= 4 && h.includes(s)));
    if (idx >= 0) { mapping[field] = idx; used.add(idx); }
  }
  return mapping;
}

/** Importe en formato español o inglés: «1.234,56 €», «1234,56», «1,234.56», «-12.5». */
export function parseMoney(value: string | undefined): number | null {
  if (value === undefined) return null;
  let v = value.replace(/[€\s]/g, '').replace(/[^\d,.\-]/g, '');
  if (!v || v === '-') return null;
  const lastComma = v.lastIndexOf(','); const lastDot = v.lastIndexOf('.');
  if (lastComma > lastDot) v = v.replace(/\./g, '').replace(',', '.');
  else if (lastDot > lastComma && lastComma >= 0) v = v.replace(/,/g, '');
  else if (lastComma < 0 && (v.match(/\./g) ?? []).length > 1) v = v.replace(/\./g, '');
  const n = Number(v);
  return Number.isFinite(n) ? fromCents(toCents(n)) : null;
}

/** Fecha `AAAA-MM-DD` desde «06/10/2026», «6-10-26», «2026-10-06» o «2026/10/06». */
export function parseDate(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  let m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  let y: number; let mo: number; let d: number;
  if (m) { y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]); }
  else {
    m = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
    if (!m) return null;
    d = Number(m[1]); mo = Number(m[2]); y = Number(m[3]); if (y < 100) y += 2000;
  }
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Tipo de IVA sugerido por categoría de ingreso: valor de partida editable, no regla fiscal (lo confirma la gestoría). */
export const INCOME_CATEGORY_VAT: Record<IncomeCategory, number> = {
  alojamiento: 10, restauracion: 10, actividades: 21, eventos: 21, tienda: 10, artesania: 21, consultoria: 21, otros: 21,
};

const CATEGORY_SYNONYMS: Record<string, IncomeCategory> = {
  alojamiento: 'alojamiento', hotel: 'alojamiento', hospedaje: 'alojamiento', estancia: 'alojamiento', habitacion: 'alojamiento',
  restauracion: 'restauracion', restaurante: 'restauracion', comida: 'restauracion', cena: 'restauracion', bar: 'restauracion',
  actividades: 'actividades', actividad: 'actividades', taller: 'actividades', clase: 'actividades',
  eventos: 'eventos', evento: 'eventos', retiro: 'eventos',
  tienda: 'tienda', productos: 'tienda', alimentacion: 'tienda', productosalimentarios: 'tienda',
  artesania: 'artesania', artesano: 'artesania',
  consultoria: 'consultoria', consultoriatecnologica: 'consultoria', tecnologia: 'consultoria', it: 'consultoria',
  otros: 'otros', otro: 'otros', varios: 'otros',
};

export function parseCategory(value: string | undefined): IncomeCategory | null {
  if (!value) return null;
  const key = normalizeHeader(value);
  if ((INCOME_CATEGORIES as readonly string[]).includes(key)) return key as IncomeCategory;
  return CATEGORY_SYNONYMS[key] ?? null;
}

function parseType(value: string | undefined): IssuedType | null {
  if (!value) return null;
  const v = value.trim().toUpperCase();
  if ((ISSUED_TYPES as readonly string[]).includes(v)) return v as IssuedType;
  const k = normalizeHeader(value);
  if (k.startsWith('simplific') || k === 'ticket') return 'F2';
  if (k.startsWith('rectific')) return 'R4';
  if (k.startsWith('complet') || k === 'factura' || k === 'ordinaria') return 'F1';
  return null;
}

function parsePaid(value: string | undefined): boolean {
  const k = normalizeHeader(value ?? '');
  return ['si', 's', 'x', 'yes', 'true', '1', 'cobrada', 'cobrado', 'pagada', 'pagado'].includes(k);
}

/** Una fila lista para registrar (o con los motivos por los que no se puede). */
export interface IssuedCsvDraft {
  row: number;
  series_code: string;
  number: string;
  full_number: string;
  issue_date: string | null;
  operation_date: string | null;
  invoice_type: IssuedType;
  recipient_name: string | null;
  recipient_tax_id: string | null;
  description: string;
  income_category: IncomeCategory | null;
  base: number | null;
  vat_rate: number | null;
  vat_amount: number | null;
  withholding: number;
  total: number | null;
  paid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Convierte las filas (sin la cabecera) en borradores. `defaultSeries` se usa si no hay columna de serie; si el número ya
 * empieza por la serie (`A-2026-0001`) no se duplica. Sin tipo, F1 si hay NIF y F2 (simplificada) si no.
 */
export function issuedDrafts(rows: string[][], mapping: IssuedCsvMapping, defaultSeries: string): IssuedCsvDraft[] {
  const get = (r: string[], f: IssuedCsvField) => (mapping[f] === undefined ? undefined : r[mapping[f]!]?.trim() || undefined);
  return rows.map((r, index) => {
    const errors: string[] = []; const warnings: string[] = [];
    const series = get(r, 'series') ?? defaultSeries.trim();
    const number = get(r, 'number') ?? '';
    if (!number) errors.push('Falta el número.');
    if (!series) errors.push('Falta la serie (elige una serie por defecto).');
    const issueDate = parseDate(get(r, 'issue_date'));
    if (!issueDate) errors.push(get(r, 'issue_date') ? `Fecha no reconocida: «${get(r, 'issue_date')}».` : 'Falta la fecha.');
    const operationDate = get(r, 'operation_date') ? parseDate(get(r, 'operation_date')) : null;
    const base = parseMoney(get(r, 'base'));
    if (base === null) errors.push('Falta la base imponible o no es un importe.');
    let vatRate = get(r, 'vat_rate') !== undefined ? parseMoney(get(r, 'vat_rate')!.replace('%', '')) : null;
    const vatAmount = parseMoney(get(r, 'vat_amount'));
    const category = parseCategory(get(r, 'income_category'));
    if (get(r, 'income_category') && !category) warnings.push(`Categoría no reconocida: «${get(r, 'income_category')}».`);
    if (vatRate === null && vatAmount !== null && base) vatRate = Math.round((vatAmount / base) * 1000) / 10;
    if (vatRate === null && vatAmount === null) {
      vatRate = category ? INCOME_CATEGORY_VAT[category] : null;
      if (vatRate !== null) warnings.push(`Sin IVA en la fila: se propone el ${vatRate} % de la categoría.`);
      else errors.push('Falta el IVA (tipo o cuota).');
    }
    const name = get(r, 'recipient_name') ?? null;
    const taxId = get(r, 'recipient_tax_id') ?? null;
    let type = parseType(get(r, 'invoice_type'));
    if (get(r, 'invoice_type') && !type) warnings.push(`Tipo no reconocido: «${get(r, 'invoice_type')}»; se usa ${taxId ? 'F1' : 'F2'}.`);
    if (!type) type = taxId && name ? 'F1' : 'F2';
    if (type.startsWith('R')) errors.push('Las rectificativas se registran a mano (necesitan la factura que rectifican y el motivo).');
    if ((type === 'F1') && (!name || !taxId)) errors.push('Una factura completa (F1) lleva nombre y NIF del cliente.');
    const total = parseMoney(get(r, 'total'));
    const withholding = parseMoney(get(r, 'withholding')) ?? 0;
    const quota = vatAmount ?? (base !== null && vatRate !== null ? fromCents(Math.round(toCents(base) * vatRate / 100)) : null);
    return {
      row: index + 2, series_code: series, number, full_number: series && number ? fullNumber(series, number) : number,
      issue_date: issueDate, operation_date: operationDate, invoice_type: type, recipient_name: name, recipient_tax_id: taxId,
      description: get(r, 'description') ?? 'Factura importada', income_category: category, base, vat_rate: vatRate, vat_amount: vatAmount ?? quota,
      withholding, total, paid: parsePaid(get(r, 'paid')), errors, warnings,
    };
  });
}

/** Prompt para ChatGPT con el PDF de una factura emitida: devuelve una fila CSV con la cabecera de la plantilla. */
export const ISSUED_EXTRACTION_PROMPT = `Lee la factura adjunta (PDF o imagen), que es una factura EMITIDA por mi negocio a un cliente, y devuelve ÚNICAMENTE un bloque CSV separado por punto y coma, con esta cabecera exacta en la primera línea y una línea por factura:

${ISSUED_CSV_TEMPLATE_HEADER.join(';')}

Reglas:
- serie y numero: tal y como aparecen en la factura; si el número ya incluye la serie (por ejemplo A-2026-0001), pon la serie (A) y el número completo.
- fecha y fecha_operacion en formato AAAA-MM-DD; fecha_operacion vacía si es la misma.
- tipo: F1 si es una factura completa con nombre y NIF del cliente, F2 si es simplificada (ticket). Si es rectificativa, escribe R1 y explica en concepto a qué factura rectifica.
- cliente y nif: los del destinatario (no los de mi negocio).
- categoria: una de ${INCOME_CATEGORIES.join(', ')}.
- base, iva_tipo, iva_cuota, retencion y total como números con coma decimal (1234,56), sin símbolo de euro. Si hay varios tipos de IVA, una línea por tipo con la misma serie y número y la base de ese tipo.
- cobrada: si o no, solo si la factura lo indica; si no, vacío.
- No inventes datos ilegibles: deja la celda vacía. No escribas nada fuera del CSV.`;

/** Una emitida a registrar: las filas con la misma serie y número (una por tipo de IVA) forman una sola factura. */
export interface IssuedImportInvoice {
  key: string;
  rows: number[];
  series_code: string;
  number: string;
  full_number: string;
  issue_date: string | null;
  operation_date: string | null;
  invoice_type: IssuedType;
  recipient_name: string | null;
  recipient_tax_id: string | null;
  description: string;
  income_category: IncomeCategory | null;
  lines: Array<{ description: string; net_amount: number; vat_rate: number | null; vat_amount: number | null }>;
  withholding: number;
  source_total: number | null;
  totals: { base: number; quota: number; withholding: number; total: number };
  paid: boolean;
  errors: string[];
  warnings: string[];
}

export function issuedImportPlan(drafts: IssuedCsvDraft[]): IssuedImportInvoice[] {
  const byKey = new Map<string, IssuedImportInvoice>();
  for (const d of drafts) {
    const key = `${d.series_code.toUpperCase()}|${d.number.toUpperCase()}`;
    let inv = byKey.get(key);
    if (!inv) {
      inv = { key, rows: [], series_code: d.series_code, number: d.number, full_number: d.full_number, issue_date: d.issue_date, operation_date: d.operation_date,
        invoice_type: d.invoice_type, recipient_name: d.recipient_name, recipient_tax_id: d.recipient_tax_id, description: d.description, income_category: d.income_category,
        lines: [], withholding: 0, source_total: null, totals: { base: 0, quota: 0, withholding: 0, total: 0 }, paid: false, errors: [], warnings: [] };
      byKey.set(key, inv);
    }
    inv.rows.push(d.row);
    for (const e of d.errors) inv.errors.push(`Fila ${d.row}: ${e}`);
    for (const w of d.warnings) inv.warnings.push(`Fila ${d.row}: ${w}`);
    if (d.base !== null) inv.lines.push({ description: d.description, net_amount: d.base, vat_rate: d.vat_rate, vat_amount: d.vat_amount });
    inv.withholding = fromCents(toCents(inv.withholding) + toCents(d.withholding));
    if (d.total !== null) inv.source_total = inv.source_total === null ? d.total : Math.max(inv.source_total, d.total);
    inv.paid = inv.paid || d.paid;
  }
  for (const inv of byKey.values()) {
    const base = inv.lines.reduce((a, l) => a + toCents(l.net_amount), 0);
    const quota = inv.lines.reduce((a, l) => a + toCents(l.vat_amount ?? 0), 0);
    const w = toCents(inv.withholding);
    inv.totals = { base: fromCents(base), quota: fromCents(quota), withholding: inv.withholding, total: fromCents(base + quota - w) };
    if (inv.source_total !== null && Math.abs(inv.source_total - inv.totals.total) > 0.02) {
      inv.warnings.push(`El total del documento (${inv.source_total.toFixed(2)}) no cuadra con base + IVA − retención (${inv.totals.total.toFixed(2)}): quedará en «Revisar importes».`);
    }
  }
  return [...byKey.values()];
}

/** Operaciones de fila para registrar una emitida importada (sin red también); el servidor recalcula los totales igual. */
export function issuedImportOperations(inv: IssuedImportInvoice, options: { id: string; uuid: () => string; tool: string; files?: Array<{ file_id: unknown; original_filename: string; mime_type: string; size_bytes: number; sha256: string }> }) {
  const { id, uuid } = options;
  const delta = inv.source_total === null ? null : fromCents(toCents(inv.source_total) - toCents(inv.totals.total));
  const ops: Array<{ op: 'insert'; table: string; id: string; fields: Record<string, unknown> }> = [{
    op: 'insert', table: 'invoices.issued_invoices', id, fields: {
      series_code: inv.series_code, number: inv.number, issue_date: inv.issue_date, operation_date: inv.operation_date, invoice_type: inv.invoice_type,
      recipient_name: inv.recipient_name, recipient_tax_id: inv.recipient_tax_id, recipient_id_type: inv.recipient_tax_id ? 'NIF' : null,
      description: inv.description, income_category: inv.income_category, origin: 'importada', external_tool: options.tool, external_id: `${inv.series_code}|${inv.number}`,
      base_total: inv.totals.base, quota_total: inv.totals.quota, surcharge_total: 0, withholding_total: inv.totals.withholding, total: inv.totals.total,
      source_total: inv.source_total, totals_delta: delta, review_reason: delta !== null && Math.abs(delta) > 0.02 ? 'REVISAR IMPORTES' : null,
      payment_status: inv.paid ? 'cobrada' : 'pendiente',
    },
  }];
  inv.lines.forEach((l, position) => ops.push({ op: 'insert', table: 'invoices.issued_invoice_lines', id: uuid(), fields: { issued_invoice_id: id, position, description: l.description, net_amount: l.net_amount, vat_rate: l.vat_rate, vat_amount: l.vat_amount } }));
  const byRate = new Map<string, { rate: number | null; base: number; quota: number }>();
  for (const l of inv.lines) {
    const k = String(l.vat_rate ?? ''); const g = byRate.get(k) ?? { rate: l.vat_rate, base: 0, quota: 0 };
    g.base += toCents(l.net_amount); g.quota += toCents(l.vat_amount ?? 0); byRate.set(k, g);
  }
  let position = 0;
  for (const g of byRate.values()) ops.push({ op: 'insert', table: 'invoices.issued_tax_lines', id: uuid(), fields: { issued_invoice_id: id, position: position++, tax: 'iva', rate: g.rate, taxable_base: fromCents(g.base), quota: fromCents(g.quota), qualification: 'S1' } });
  if (inv.withholding) ops.push({ op: 'insert', table: 'invoices.issued_tax_lines', id: uuid(), fields: { issued_invoice_id: id, position: position++, tax: 'irpf', taxable_base: null, quota: inv.withholding } });
  (options.files ?? []).forEach((f, i) => ops.push({ op: 'insert', table: 'invoices.issued_invoice_files', id: uuid(), fields: { issued_invoice_id: id, file_id: f.file_id, original_filename: f.original_filename, page_order: i + 1, mime_type: f.mime_type, size_bytes: f.size_bytes, sha256: f.sha256 } }));
  return ops;
}
