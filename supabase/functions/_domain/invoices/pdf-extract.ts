/**
 * Extracción determinista del texto de un PDF (ronda 29, fase 2). Sin IA: reglas por etiquetas habituales en español
 * sobre las líneas de texto con posición que da PDF.js en el navegador. El resultado es un `ikisai.invoice.v1` con
 * **procedencia por campo** (método, texto original, página, posición y confianza 0–1): nada inferido se presenta como
 * verificado, y lo que no se lee no se inventa (si falta la fecha o los importes, no hay resultado utilizable).
 */
import { fromCents, toCents } from './money.ts';
import { parseMoney } from './issued-csv.ts';
import { validateImportDocument, type ImportDocument } from './import-v1.schema.ts';

export interface PdfTextItem { str: string; page: number; x: number; y: number; w?: number; h?: number }
/** Celda de una línea: trozo separado del siguiente por un hueco grande (columnas de una tabla). */
export interface PdfCell { text: string; x: number; x2: number }
export interface PdfLine { text: string; page: number; x: number; y: number; cells?: PdfCell[] }

export type ProvenanceMethod = 'pdf_text' | 'supplier_template' | 'external_ai' | 'manual' | 'ocr';
export interface FieldProvenance { method: ProvenanceMethod; text: string | null; page: number | null; x: number | null; y: number | null; confidence: number }

/**
 * Lo que el lector ha encontrado aunque no llegue a una factura completa (fase 0 de REVISION_LECTOR, 9-10-2026): un PDF
 * con texto nunca termina sin información. Los importes, en euros; `null` si no se ha identificado.
 */
export interface PartialInvoice {
  supplier_name: string | null;
  supplier_tax_id: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  base: number | null;
  vat: Array<{ rate: number; base: number | null; quota: number }>;
  withholding: { amount: number; rate: number | null } | null;
  total: number | null;
  iban: string | null;
}
/** `no_text`: escaneado o foto · `partial`: texto leído, faltan datos · `sufficient`: hay un `ikisai.invoice.v1` completo. */
export type ReadLevel = 'no_text' | 'partial' | 'sufficient';
export interface ReadStats { pages: number; items: number; chars: number }

export interface PdfExtraction {
  /** Hay texto suficiente en el PDF; si no, es un escaneado o una foto. */
  hasText: boolean;
  read: ReadLevel;
  /** Lo encontrado, también cuando falta algo esencial. */
  found: PartialInvoice;
  stats: ReadStats;
  /** Fecha e importes leídos: el documento sirve para la vista previa. */
  ok: boolean;
  document: ImportDocument | null;
  provenance: Record<string, FieldProvenance>;
  missing: string[];
  warnings: string[];
  iban: string | null;
}

// ---------------------------------------------------------------------------
// Líneas
// ---------------------------------------------------------------------------
const LEGAL_FORM = /\b(?:s\.?\s?l\.?\s?u\.?|s\.?\s?a\.?\s?u\.?|s\.?\s?l\.?|s\.?\s?a\.?|s\.?\s?coop\.?|sociedad (?:limitada|an[oó]nima))(?=[\s,.·|]|$)/i;
/** Palabras cortas de verdad en nombres españoles: no son trozos de una palabra partida. */
const PARTICLES = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'i', 'en', 'sl', 'sa', 'cb', 'sc', 'slu', 'sau']);

/**
 * Nombre de proveedor limpio (FVR_2026_005, 9-10-2026): el primer bloque de la línea (lo que va tras 3 espacios es otra
 * columna, p. ej. «Cliente»), cortado tras la forma jurídica, sin etiquetas de cliente al final, y con las palabras que el
 * PDF parte en trozos de una o dos letras («JI M ÉN EZ» → «JIMÉNEZ») unidas.
 */
export function cleanSupplierName(raw: string): string {
  let name = raw.split(/\s{3,}/).find((p) => LEGAL_FORM.test(p)) ?? raw.split(/\s{3,}/)[0] ?? raw;
  const legal = name.match(new RegExp(`^(.*?${LEGAL_FORM.source})`, 'i'));
  if (legal) name = legal[1]!;
  name = name.replace(/\s+(?:cliente|destinatario|datos del cliente|facturar a)\b.*$/i, '');
  const tokens = name.trim().split(/\s+/);
  const short = (t: string) => t.replace(/[^\p{L}]/gu, '').length <= 2 && !PARTICLES.has(t.toLowerCase().replace(/\./g, ''));
  if (tokens.filter(short).length >= 2) {
    // Se unen entre sí las rachas de trozos cortos seguidos («JI M ÉN EZ» → «JIMÉNEZ», «FI RM A» → «FIRMA»).
    // Dentro de una racha, una palabra que ya parece completa (-EZ, -AZ, -OZ, -ES, -AS, -OS) cierra y empieza otra.
    const out: string[] = [];
    let run = false;
    for (const t of tokens) {
      const current = out[out.length - 1] ?? '';
      const closes = current.length >= 4 && /(?:ez|az|oz|es|as|os)$/i.test(current);
      if (short(t) && run && !closes) out[out.length - 1] += t;
      else out.push(t);
      run = short(t);
    }
    name = out.join(' ');
  }
  return name.replace(/[\s·|,;:-]+$/, '').trim().slice(0, 120);
}

/** El texto trae palabras partidas en trozos de una o dos letras (espaciado roto del PDF). */
function brokenSpacing(raw: string): boolean {
  return raw.split(/\s{3,}/)[0]!.trim().split(/\s+/).filter((t) => t.replace(/[^\p{L}]/gu, '').length <= 2 && !PARTICLES.has(t.toLowerCase().replace(/\./g, ''))).length >= 2;
}

/** Agrupa los fragmentos por página y altura (de arriba abajo) y los une de izquierda a derecha. */
export function linesFromItems(items: PdfTextItem[]): PdfLine[] {
  const lines: Array<PdfLine & { parts: PdfTextItem[] }> = [];
  const sorted = items.filter((i) => i.str.trim()).sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  for (const item of sorted) {
    const tolerance = Math.max(2, (item.h ?? 10) * 0.5);
    const line = lines.find((l) => l.page === item.page && Math.abs(l.y - item.y) <= tolerance);
    if (line) line.parts.push(item); else lines.push({ text: '', page: item.page, x: item.x, y: item.y, parts: [item] });
  }
  // Segunda pasada (FVR_2026_005): un fragmento que cayó en una línea pero está más cerca de otra (un importe 1 punto
  // más alto que su etiqueta «IVA 21%») pasa a la más cercana. La altura de cada línea es la de su primer fragmento.
  for (const line of lines) {
    for (const item of [...line.parts]) {
      if (item === line.parts[0]) continue;
      const tolerance = Math.max(2, (item.h ?? 10) * 0.5);
      const best = lines.filter((l) => l !== line && l.page === item.page && Math.abs(l.y - item.y) <= tolerance && Math.abs(l.y - item.y) < Math.abs(line.y - item.y))
        .sort((a, b) => Math.abs(a.y - item.y) - Math.abs(b.y - item.y))[0];
      if (best) { line.parts.splice(line.parts.indexOf(item), 1); best.parts.push(item); }
    }
  }
  return lines.map((l) => {
    const parts = l.parts.sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd: number | null = null;
    const cells: PdfCell[] = [];
    for (const p of parts) {
      const gap = prevEnd === null ? 0 : p.x - prevEnd;
      const end = p.x + (p.w ?? p.str.length * (p.h ?? 10) * 0.5);
      const wide = gap > (p.h ?? 10) * 1.5;
      text += prevEnd === null ? p.str : (wide ? '   ' : gap > 0.5 ? ' ' : '') + p.str;
      if (prevEnd === null || wide) cells.push({ text: p.str, x: p.x, x2: end });
      else { const c = cells[cells.length - 1]!; c.text += (gap > 0.5 ? ' ' : '') + p.str; c.x2 = end; }
      prevEnd = end;
    }
    return { text: text.replace(/\s+$/, ''), page: l.page, x: parts[0]!.x, y: l.y, cells: cells.map((c) => ({ ...c, text: c.text.trim() })) };
  });
}

// ---------------------------------------------------------------------------
// Identificadores fiscales e IBAN
// ---------------------------------------------------------------------------
const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

/** NIF (DNI), NIE o CIF español con dígito de control válido. Normaliza a mayúsculas sin separadores. */
export function validSpanishTaxId(raw: string): string | null {
  const v = raw.toUpperCase().replace(/[\s.-]/g, '').replace(/^ES(?=[A-Z0-9]{9}$)/, '');
  if (/^\d{8}[A-Z]$/.test(v)) return DNI_LETTERS[Number(v.slice(0, 8)) % 23] === v[8] ? v : null;
  if (/^[XYZ]\d{7}[A-Z]$/.test(v)) {
    const n = Number(String('XYZ'.indexOf(v[0]!)) + v.slice(1, 8));
    return DNI_LETTERS[n % 23] === v[8] ? v : null;
  }
  if (/^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(v)) {
    const digits = v.slice(1, 8).split('').map(Number);
    let sum = 0;
    digits.forEach((d, i) => { if (i % 2 === 0) { const x = d * 2; sum += Math.floor(x / 10) + (x % 10); } else sum += d; });
    const control = (10 - (sum % 10)) % 10;
    const letter = 'JABCDEFGHI'[control]!;
    const c = v[8]!;
    if ('PQRSNW'.includes(v[0]!) || v[1] === '0' && v[2] === '0') return c === letter ? v : null;
    if ('ABEH'.includes(v[0]!)) return c === String(control) ? v : null;
    return c === String(control) || c === letter ? v : null;
  }
  return null;
}

// Con separadores habituales: «B12345674», «B-12.345.674», «B 12345674», «12.345.678-Z», «ESB12345674».
const TAX_ID_CANDIDATE = /\b(?:ES[\s-]?)?([A-Z][\s.-]?(?:\d[\s.]?){7}[0-9A-J]|(?:\d[\s.]?){8}[\s-]?[A-Z]|[XYZ][\s.-]?(?:\d[\s.]?){7}[A-Z])\b/gi;

export function validIban(raw: string): string | null {
  const v = raw.toUpperCase().replace(/\s/g, '');
  if (!/^ES\d{22}$/.test(v)) return null;
  const rearranged = v.slice(4) + v.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rest = 0;
  for (const ch of numeric) rest = (rest * 10 + Number(ch)) % 97;
  return rest === 1 ? v : null;
}

// ---------------------------------------------------------------------------
// Fechas e importes
// ---------------------------------------------------------------------------
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** Fechas de una línea, en orden: «06/10/2026», «6-10-26», «2026-10-06», «6 de octubre de 2026». */
export function datesIn(text: string): string[] {
  const out: string[] = [];
  const push = (y: number, m: number, d: number) => {
    if (y < 100) y += 2000;
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d && y >= 2000 && y <= 2100) out.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  };
  for (const m of text.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) push(Number(m[1]), Number(m[2]), Number(m[3]));
  for (const m of text.matchAll(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/g)) push(Number(m[3]), Number(m[2]), Number(m[1]));
  const lower = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  for (const m of lower.matchAll(/\b(\d{1,2})\s+de\s+([a-z]+)\s+(?:de\s+)?(\d{4})\b/g)) {
    const month = MONTHS.indexOf(m[2]!.replace('setiembre', 'septiembre'));
    if (month >= 0) push(Number(m[3]), month + 1, Number(m[1]));
  }
  return out;
}

const AMOUNT = /-?\d{1,3}(?:[.\s]\d{3})+(?:,\d{1,2})?|-?\d+,\d{1,2}|-?\d+\.\d{2}(?!\d)|-?\d+(?=\s*(?:€|eur\b))/gi;

/** Importes de una línea (sin porcentajes ni fechas), en orden. */
export function amountsIn(text: string): number[] {
  const clean = text.replace(/\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/g, ' ').replace(/\b\d{1,2}(?:[.,]\d+)?\s*%/g, ' ');
  const out: number[] = [];
  for (const m of clean.matchAll(AMOUNT)) { const v = parseMoney(m[0]); if (v !== null) out.push(v); }
  return out;
}

const norm = (text: string) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// ---------------------------------------------------------------------------
// Importes en tablas y en líneas con varias etiquetas (9-10-2026, facturas reales que no se leían)
// ---------------------------------------------------------------------------
type ColumnKind = 'base' | 'rate' | 'quota' | 'total' | 'withholding' | 'ignore';

/** Qué es una etiqueta de columna de una tabla de importes (líneas de factura o pie). */
function columnKind(text: string): ColumnKind | null {
  const t = norm(text);
  if (/\b(?:irpf|retencion|ret\.)/.test(t)) return 'withholding';
  if (/(?:incl\.?|incluido|con)\s*(?:el\s+)?iva|\bt\.?t\.?i\b|\bt\.?i\.?i\b|total\s+(?:factura|a pagar)/.test(t)) return 'total';
  if (/sin\s+(?:iva|impuestos)|\btotal\s+s\.?\s?i\b|base|subtotal|\bneto\b|importe neto/.test(t)) return 'base';
  if (/recargo|r\.?\s?e\.?$|dto|descu|cantidad|unid|precio|ref|designa|descrip|concepto|fecha/.test(t)) return 'ignore';
  if (/%|\btipo\b|\btasa\b|\bporc/.test(t)) return /iva|igic|ipsi|impuesto|%|tipo|tasa/.test(t) ? 'rate' : null;
  if (/\b(?:cuota|importe iva|iva|igic|ipsi)\b/.test(t)) return 'quota';
  // «Importe» a secas es el de cada línea (no el total): sin etiqueta, la columna no cuenta.
  if (/\btotal\b/.test(t)) return 'total';
  return null;
}

/** Varias etiquetas de columna dentro de un mismo trozo («Total SI (EUR) Total IVA Total TTI (EUR)»), en orden. */
const COLUMN_LABEL = /(?:tasa|tipo|%)\s*(?:de\s+)?(?:iva|igic|ipsi)(?:\s*\/\s*(?:iva|igic|ipsi))*|(?:iva|igic)\s*%|total\s+(?:t\.?t\.?i|t\.?i\.?i)\b(?:\s*\(eur\))?|precio\s+incl\.?\s*iva|total\s+s\.?\s?i\b(?:\s*\(eur\))?|base imponible|precio sin iva|total\s+(?:iva|igic|ipsi)(?:\s*\/\s*(?:iva|igic|ipsi))*|cuota(?:\s+iva)?|irpf|retenci[oó]n|\btotal\b/gi;
function labelsInOrder(text: string): ColumnKind[] {
  // «Retención IRPF» o «IVA %» son una sola columna: etiquetas seguidas del mismo tipo cuentan una vez.
  return [...text.matchAll(COLUMN_LABEL)].map((m) => columnKind(m[0]) ?? 'ignore').filter((k, i, all) => i === 0 || k !== all[i - 1]);
}

const DATE_CELL = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/;

/**
 * Tablas de importes (pie o líneas de factura): una cabecera con etiquetas y debajo filas con cifras. Cada fila se
 * reparte entre las columnas (por posición, o por orden si una celda lleva varias etiquetas) y las filas se SUMAN por
 * tipo de IVA (una tabla de líneas trae varias filas del mismo tipo). Una fila igual a la suma de las anteriores es la de
 * totales y cierra la tabla. El resultado son líneas «con etiqueta» que entiende la regla de siempre.
 */
export function tableAmountLines(lines: PdfLine[]): PdfLine[] {
  const out: PdfLine[] = [];
  lines.forEach((header, index) => {
    const cells = header.cells ?? [];
    if (!cells.length || amountsIn(header.text).length) return;
    const perCell = cells.map((c) => labelsInOrder(c.text));
    const byOrder = perCell.some((k) => k.length > 1);
    const kinds = byOrder ? perCell.flat() : cells.map((c) => columnKind(c.text));
    const useful = kinds.filter((k) => k && k !== 'ignore');
    if (useful.length < 2 || !useful.some((k) => k === 'base' || k === 'total')) return;
    const sums = new Map<number | null, { base: number; quota: number }>();
    let total = 0; let withholding = 0; let rowsUsed = 0;
    for (const row of lines.slice(index + 1, index + 40)) {
      if (row.page !== header.page) break;
      const numeric = (row.cells ?? []).filter((c) => /\d/.test(c.text) && !DATE_CELL.test(c.text.trim()));
      if (numeric.length < 2) { if (rowsUsed) break; continue; }
      const values: Partial<Record<ColumnKind, number>> = {};
      let rate: number | null = null;
      const pct = row.text.match(/(\d{1,2}(?:[.,]\d{1,2})?)\s*%/);
      if (pct) rate = Number(pct[1]!.replace(',', '.'));
      if (byOrder) {
        const amountKinds = kinds.filter((k): k is ColumnKind => !!k && k !== 'ignore' && k !== 'rate');
        const amounts = amountsIn(row.text);
        if (amounts.length < amountKinds.length) { if (rowsUsed) break; continue; }
        amounts.slice(-amountKinds.length).forEach((v, i) => { values[amountKinds[i]!] = v; });
      } else {
        for (const cell of numeric) {
          const centre = (cell.x + cell.x2) / 2;
          let best = -1; let distance = Infinity;
          cells.forEach((h, i) => {
            if (!kinds[i]) return;
            const overlap = Math.min(cell.x2, h.x2) - Math.max(cell.x, h.x);
            const d = overlap > 0 ? 0 : Math.abs(centre - (h.x + h.x2) / 2);
            if (d < distance) { distance = d; best = i; }
          });
          const kind = best >= 0 ? kinds[best] : null;
          if (!kind || kind === 'ignore') continue;
          if (kind === 'rate') { const r = cell.text.match(/\d{1,2}(?:[.,]\d+)?/); if (r) rate = Number(r[0].replace(',', '.')); continue; }
          const v = amountsIn(cell.text)[0];
          // Dos cifras bajo la misma columna (cabecera «Base imponible Descuento» en una celda): manda la primera.
          if (v !== undefined && values[kind] === undefined) values[kind] = v;
        }
      }
      if (values.base === undefined && values.total === undefined && values.quota === undefined) { if (rowsUsed) break; continue; }
      // Una fila que repite la suma de las anteriores es la de totales: cierra la tabla.
      const sumBase = [...sums.values()].reduce((n, v) => n + v.base, 0);
      if (rowsUsed && sumBase && values.base !== undefined && Math.abs(Math.round(values.base * 100) - sumBase) <= 1) break;
      const g = sums.get(rate) ?? { base: 0, quota: 0 };
      sums.set(rate, { base: g.base + Math.round((values.base ?? 0) * 100), quota: g.quota + Math.round((values.quota ?? 0) * 100) });
      total += Math.round((values.total ?? 0) * 100);
      withholding += Math.round((values.withholding ?? 0) * 100);
      rowsUsed += 1;
    }
    if (!rowsUsed) return;
    const at = (text: string): PdfLine => ({ text, page: header.page, x: header.x, y: header.y });
    const money = (c: number) => (c / 100).toFixed(2).replace('.', ',');
    const base = [...sums.values()].reduce((n, v) => n + v.base, 0);
    if (base) out.push(at(`Base imponible ${money(base)}`));
    for (const [rate, v] of sums) if (rate !== null && v.quota) out.push(at(`IVA ${rate} % ${money(v.base)} ${money(v.quota)}`));
    if (withholding) out.push(at(`Retención ${money(withholding)}`));
    if (total) out.push(at(`Total ${money(total)}`));
  });
  return out;
}

const LABEL = /(base imponible|base|subtotal|importe neto|total (?:factura|a pagar|documento)|total|(?:cuota\s+)?(?:i\.?v\.?a\.?|igic)[^%\d]{0,12}\d{1,2}(?:[.,]\d+)?\s*%|irpf[^%\d]{0,12}\d{0,2}(?:[.,]\d+)?\s*%?|retenci[oó]n[^%\d]{0,12}\d{0,2}(?:[.,]\d+)?\s*%?)/gi;

/** Una línea con varias etiquetas («Base imponible: 1.234,56 · IVA 10 %: 123,46 · TOTAL: 1.358,02») en un trozo por etiqueta. */
export function splitLabelledLine(line: PdfLine): PdfLine[] {
  const marks = [...line.text.matchAll(LABEL)];
  if (marks.length < 2) return [];
  return marks.map((m, i) => ({ text: line.text.slice(m.index!, i + 1 < marks.length ? marks[i + 1]!.index : undefined).replace(/[·|;]+\s*$/, ''), page: line.page, x: line.x, y: line.y }))
    .filter((l) => amountsIn(l.text).length);
}

// ---------------------------------------------------------------------------
// Extracción
// ---------------------------------------------------------------------------
/** Artículos leídos con la tabla aprendida de la plantilla (item-table.ts). */
export interface TemplateItems { items: Array<{ description: string; quantity: number | null; unit_price: number | null; net_amount: number; page: number; text: string }>; confidence: number }

export interface PdfExtractOptions {
  templateItems?: TemplateItems;
  /** Proveedores conocidos (por NIF): si uno aparece en el documento, se usa su nombre. */
  suppliers?: Array<{ id?: string; name: string; tax_id: string | null }>;
  /** NIF propios (del negocio) que no pueden ser el proveedor. */
  ownTaxIds?: string[];
  /** Datos de la factura pendiente, si se lee sobre ella: nombre de proveedor y objeto de partida. */
  fallback?: { supplier_name?: string | null; supplier_tax_id?: string | null; object?: string | null };
  /**
   * Lo que propone la plantilla del proveedor (fase 3, `applyTemplate`): sustituye a la regla genérica en esos campos y
   * conserva su procedencia (`supplier_template`). El resto sigue con las reglas genéricas.
   */
  templateValues?: {
    values: { invoice_number?: string | null; invoice_date?: string | null; base?: number | null; total?: number | null; withholding?: number | null; vat?: Record<string, number> };
    provenance: Record<string, FieldProvenance>;
  };
}

export function extractFromPdfText(items: PdfTextItem[], options: PdfExtractOptions = {}): PdfExtraction {
  const lines = linesFromItems(items);
  const textChars = lines.reduce((n, l) => n + l.text.replace(/\s/g, '').length, 0);
  const provenance: Record<string, FieldProvenance> = {};
  const warnings: string[] = [];
  const missing: string[] = [];
  const from = (line: PdfLine, confidence: number): FieldProvenance => ({ method: 'pdf_text', text: line.text, page: line.page, x: Math.round(line.x), y: Math.round(line.y), confidence });
  const stats = readStats(items);
  if (textChars < 40) return { hasText: false, read: 'no_text', found: emptyPartial(), stats, ok: false, document: null, provenance, missing: ['texto'], warnings: ['El PDF no tiene texto (escaneado o foto).'], iban: null };

  // Proveedor: un NIF válido que coincida con un proveedor conocido; si no, el primero que no sea propio.
  const own = new Set((options.ownTaxIds ?? []).map((t) => validSpanishTaxId(t) ?? t.toUpperCase()));
  const known = new Map((options.suppliers ?? []).filter((s) => s.tax_id).map((s) => [validSpanishTaxId(s.tax_id!) ?? s.tax_id!.toUpperCase(), s.name]));
  const taxIds: Array<{ id: string; line: PdfLine }> = [];
  for (const line of lines) for (const m of line.text.matchAll(TAX_ID_CANDIDATE)) { const id = validSpanishTaxId(m[0]); if (id && !own.has(id) && !taxIds.some((t) => t.id === id)) taxIds.push({ id, line }); }
  let supplierTaxId: string | null = null; let supplierName: string | null = null;
  // El NIF de una línea de cliente o destinatario no es el del proveedor (si hay otro).
  const customerLine = (l: PdfLine) => /\b(?:cliente|destinatario|facturar a|datos del cliente|customer|bill to)\b/.test(norm(l.text));
  // Quien factura casi siempre es una sociedad: con un CIF de sociedad y un NIF de persona, gana el CIF.
  const company = (id: string) => /^[ABCDEFGHJNPQRSUVW]/.test(id);
  if (taxIds.length > 1) taxIds.sort((a, b) => Number(customerLine(a.line)) - Number(customerLine(b.line)) || Number(company(b.id)) - Number(company(a.id)));
  const knownHit = taxIds.find((t) => known.has(t.id));
  if (knownHit) {
    supplierTaxId = knownHit.id; supplierName = known.get(knownHit.id)!;
    provenance['invoice.supplier_tax_id'] = from(knownHit.line, 0.95);
    provenance['invoice.supplier_name'] = { ...from(knownHit.line, 0.9), text: `Proveedor conocido con NIF ${knownHit.id}` };
  } else if (taxIds.length) {
    const first = taxIds[0]!;
    supplierTaxId = first.id;
    provenance['invoice.supplier_tax_id'] = from(first.line, taxIds.length === 1 ? 0.8 : 0.55);
    if (taxIds.length > 1) warnings.push(`Hay ${taxIds.length} NIF en el documento; se propone ${first.id} como proveedor. Comprueba que no sea el tuyo.`);
    // Nombre: lo que precede a la etiqueta del NIF en la misma línea, o la línea anterior.
    const before = first.line.text.split(/\b(?:c\.?i\.?f\.?|n\.?i\.?f\.?|nie|vat)\b/i)[0]!.replace(/[:\s-]+$/, '').trim();
    const idx = lines.indexOf(first.line);
    const previous = idx > 0 && lines[idx - 1]!.page === first.line.page ? lines[idx - 1]! : null;
    // Un nombre no lleva cifras ni parece una dirección; si lo de antes del NIF lo parece, se prueba la línea de arriba.
    const looksLikeName = (t: string) => /[a-záéíóúñ]{3}/i.test(t) && !/\d/.test(t) && !/^(?:c\/|calle|avda|avenida|plaza|pza|paseo|ctra|carretera|pol[ií]gono)\b/i.test(t.trim());
    // En un pie legal («Empresa S.L.U. Avenida…, N.I.F. B-…»), el trozo con la forma jurídica, cortado tras ella.
    const legalPart = first.line.text.split(/\s*[\/|·]\s*|,\s+|\s{3,}/).map((part) => part.match(/^(.{2,80}?\b(?:S\.?\s?L\.?\s?U\.?|S\.?\s?A\.?\s?U\.?|S\.?\s?L\.?|S\.?\s?A\.?|S\.?\s?Coop\.?))(?=\s|$|\.)/i)?.[1]).find((n) => n && /[a-záéíóúñ]{3}/i.test(n));
    const candidate = legalPart ? legalPart.trim() : looksLikeName(before) && !before.includes(first.id) ? before : previous && looksLikeName(previous.text) ? previous.text.trim() : null;
    if (candidate) { supplierName = cleanSupplierName(candidate); if (brokenSpacing(candidate)) warnings.push(`El nombre del proveedor viene con letras sueltas en el PDF; se ha leído «${supplierName}»: revísalo.`); provenance['invoice.supplier_name'] = from(legalPart || candidate === before || !previous ? first.line : previous, legalPart ? 0.7 : 0.5); }
  }
  // Sin nombre junto al NIF: la razón social de la cabecera (S.L., S.A., S.L.U., S. Coop.…) que no sea la del cliente.
  if (!supplierName || supplierName === options.fallback?.supplier_name) {
    const legal = /\b(?:s\.?\s?l\.?\s?u?\.?|s\.?\s?a\.?\s?u?\.?|s\.?\s?coop\.?|sociedad (?:limitada|anonima)|s\.?\s?c\.?|c\.?\s?b\.?)(?=[\s,.·|]|$)/i;
    const head = lines.filter((l) => l.page === 1).slice(0, 15).find((l) => legal.test(l.text) && !customerLine(l));
    if (head) {
      const name = head.text.split(/\s{3,}|·|\||\b(?:c\.?i\.?f\.?|n\.?i\.?f\.?)\b/i).find((part) => legal.test(part))?.replace(/[\s:·|,;-]+$/, '').trim();
      if (name && /[a-záéíóúñ]{3}/i.test(name)) { supplierName = cleanSupplierName(name); provenance['invoice.supplier_name'] = from(head, 0.55); }
    }
  }
  if (!supplierName && options.fallback?.supplier_name) {
    supplierName = options.fallback.supplier_name;
    if (!supplierTaxId && options.fallback.supplier_tax_id) supplierTaxId = options.fallback.supplier_tax_id;
    provenance['invoice.supplier_name'] = { method: 'manual', text: 'Proveedor de la factura pendiente', page: null, x: null, y: null, confidence: 0.7 };
  }
  if (!supplierName) { supplierName = 'Proveedor sin identificar'; provenance['invoice.supplier_name'] = { method: 'manual', text: null, page: null, x: null, y: null, confidence: 0 }; missing.push('proveedor'); }

  // Fecha: la de una línea con «fecha» (de factura, emisión o expedición); si no, la primera del documento.
  let invoiceDate: string | null = null;
  const dateLabel = lines.find((l) => /\bfecha\b/.test(norm(l.text)) && !/vencim|venc\.|operaci|entrega|pedido|albar/.test(norm(l.text)) && datesIn(l.text).length);
  // La que sigue a «Fecha» (también en una línea con «Vencimiento» u otras fechas después).
  const labelled = lines.map((l) => ({ l, m: l.text.match(/\bfecha(?:\s+(?:de\s+)?(?:factura|emisi[oó]n|expedici[oó]n))?\s*[:.]?\s*([0-9]{1,4}[-/.][0-9]{1,2}[-/.][0-9]{2,4}|[0-9]{1,2}\s+de\s+[a-záéíóú]+\s+(?:de\s+)?[0-9]{4})/i) }))
    .find((x) => x.m && datesIn(x.m[1]!).length && !/(?:vencim|venc\.|operaci|entrega|pedido|albar)\S*\s*$/i.test(x.l.text.slice(0, x.m.index)));
  if (dateLabel) { invoiceDate = datesIn(dateLabel.text)[0]!; provenance['invoice.invoice_date'] = from(dateLabel, 0.9); }
  else if (labelled) { invoiceDate = datesIn(labelled.m![1]!)[0]!; provenance['invoice.invoice_date'] = from(labelled.l, 0.85); }
  else {
    const any = lines.find((l) => datesIn(l.text).length);
    if (any) { invoiceDate = datesIn(any.text)[0]!; provenance['invoice.invoice_date'] = from(any, 0.5); warnings.push('La fecha es la primera del documento: compruébala.'); }
  }
  const tv = options.templateValues;
  const tp = (key: string) => tv?.provenance[key];
  const tline = (key: string): PdfLine => { const p = tp(key)!; return { text: p.text ?? '', page: p.page ?? 1, x: p.x ?? 0, y: p.y ?? 0 }; };
  if (tv?.values.invoice_date && tp('invoice.invoice_date')) { invoiceDate = tv.values.invoice_date; provenance['invoice.invoice_date'] = tp('invoice.invoice_date')!; }
  if (!invoiceDate) missing.push('fecha');

  // Número de factura por etiqueta
  let invoiceNumber: string | null = null;
  for (const line of lines) {
    const m = line.text.match(/(?:n[º°o]\.?\s*(?:de\s+)?factura|n[úu]mero\s+(?:de\s+)?factura|factura\s*(?:n[º°o]\.?|n[úu]m\.?|n[úu]mero|#)|fra\.?\s*n[º°o]\.?|invoice\s*(?:no\.?|number|#))\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/._]{0,30})/i)
      ?? line.text.match(/^\s*factura\s+([A-Z0-9][A-Z0-9\-/._]{3,30})\s*$/i);
    if (m && /\d/.test(m[1]!)) { invoiceNumber = m[1]!.replace(/[.]+$/, ''); provenance['invoice.invoice_number'] = from(line, 0.85); break; }
  }
  // Respaldo: «Número: …» o «Nº: …» suelto (la palabra «Factura» va en otra línea), salvo pedido, albarán, cliente o cuenta.
  if (!invoiceNumber) {
    for (const line of lines) {
      const m = line.text.match(/(?:^|\s{2,}|·)\s*(?:n[úu]mero|n[º°o]\.?|n\.\s?º|num\.?)\s*[:.]\s*([A-Z0-9][A-Z0-9\-/.]{0,30})/i);
      if (m && /\d/.test(m[1]!) && !/pedido|albar|cliente|cuenta|iban|tel|nif|cif/i.test(line.text.slice(Math.max(0, (m.index ?? 0) - 25), (m.index ?? 0) + 12))) {
        invoiceNumber = m[1]!.replace(/[.]+$/, ''); provenance['invoice.invoice_number'] = from(line, 0.65); break;
      }
    }
  }
  if (tv?.values.invoice_number && tp('invoice.invoice_number')) { invoiceNumber = tv.values.invoice_number; provenance['invoice.invoice_number'] = tp('invoice.invoice_number')!; }

  // Importes por etiqueta
  const vatByRate = new Map<number, { base: number | null; quota: number; line: PdfLine }>();
  let base: { v: number; line: PdfLine } | null = null;
  /** La base salió de una etiqueta «Base imponible»: un «Subtotal» o «Neto» (antes de descuentos) ya no la pisa. */
  let baseLabelled = false;
  let total: { v: number; line: PdfLine } | null = null;
  let withholding: { v: number; rate: number | null; line: PdfLine } | null = null;
  const fromTable = tableAmountLines(lines);
  const amountLines = [...lines.filter((l) => !splitLabelledLine(l).length), ...lines.flatMap(splitLabelledLine), ...fromTable];
  for (const line of amountLines) {
    const t = norm(line.text);
    const amounts = amountsIn(line.text);
    if (!amounts.length) continue;
    const vat = t.match(/\b(?:i\.?v\.?a\.?|igic)\b[^%\d]{0,12}(\d{1,2}(?:[.,]\d+)?)\s*%/);
    const irpf = t.match(/\b(?:irpf|retencion|ret\.)\b[^%\d]{0,12}(\d{1,2}(?:[.,]\d+)?)?\s*%?/);
    if (irpf) { withholding = { v: Math.abs(amounts[amounts.length - 1]!), rate: irpf[1] ? Number(irpf[1].replace(',', '.')) : null, line }; continue; }
    if (vat && !/\btotal\b/.test(t.replace(/total\s+(?:iva|cuota)/, ''))) {
      const rate = Number(vat[1]!.replace(',', '.'));
      vatByRate.set(rate, { base: amounts.length >= 2 ? amounts[amounts.length - 2]! : null, quota: amounts[amounts.length - 1]!, line });
      continue;
    }
    if (/\b(?:base imponible|base\b|subtotal|importe neto|total neto|neto)|sin (?:iva|impuestos)|\btotal s\.?\s?i\b/.test(t) && !/total (?:factura|a pagar)/.test(t)) {
      // Solo una «Base imponible» impresa en el documento (no la que se arma con las columnas de la tabla de artículos).
      const labelled = /\bbase imponible\b/.test(t) && !fromTable.includes(line);
      if (labelled || !baseLabelled) { base = { v: amounts[amounts.length - 1]!, line }; baseLabelled ||= labelled; }
      continue;
    }
    if ((/\btotal\b/.test(t) || /(?:incl\.?|incluido)\s*(?:el\s+)?iva|\bt\.?t\.?i\b/.test(t)) && !/\b(?:sub ?total|total (?:iva|base|neto|cuota|bruto))\b/.test(t)) {
      const v = amounts[amounts.length - 1]!;
      if (!total || v >= total.v) total = { v, line };
    }
  }
  // Plantilla del proveedor: sustituye a lo genérico en los importes que haya leído.
  if (tv?.values.base !== undefined && tv.values.base !== null && tp('document_totals.base')) base = { v: tv.values.base, line: tline('document_totals.base') };
  if (tv?.values.total !== undefined && tv.values.total !== null && tp('document_totals.total')) total = { v: tv.values.total, line: tline('document_totals.total') };
  if (tv?.values.withholding && tp('document_totals.withholding')) withholding = { v: tv.values.withholding, rate: withholding?.rate ?? null, line: tline('document_totals.withholding') };
  for (const [rate, quota] of Object.entries(tv?.values.vat ?? {})) {
    if (!tp(`document_totals.vat:${rate}`)) continue;
    vatByRate.set(Number(rate), { base: vatByRate.get(Number(rate))?.base ?? null, quota, line: tline(`document_totals.vat:${rate}`) });
  }
  const vatTotal = [...vatByRate.values()].reduce((a, v) => a + toCents(v.quota), 0);
  const w = withholding ? toCents(withholding.v) : 0;
  let baseCents = base ? toCents(base.v) : null;
  if (baseCents === null && vatByRate.size && [...vatByRate.values()].every((v) => v.base !== null)) baseCents = [...vatByRate.values()].reduce((a, v) => a + toCents(v.base!), 0);
  // Deducida del total: vale para la factura completa, pero no es una base «encontrada» si no hay ningún IVA.
  const baseFromTotalOnly = baseCents === null && !!total && !vatByRate.size;
  if (baseCents === null && total) baseCents = toCents(total.v) - vatTotal + w;
  if (base) provenance['document_totals.base'] = from(base.line, 0.85);
  else if (baseCents !== null) provenance['document_totals.base'] = { method: 'pdf_text', text: 'Calculada desde los tipos de IVA o el total', page: null, x: null, y: null, confidence: 0.5 };
  if (vatByRate.size) provenance['document_totals.vat'] = from([...vatByRate.values()][0]!.line, 0.8);
  if (withholding) provenance['document_totals.withholding'] = from(withholding.line, 0.8);
  let totalCents = total ? toCents(total.v) : baseCents !== null ? baseCents + vatTotal - w : null;
  if (total) provenance['document_totals.total'] = from(total.line, 0.85);
  else if (totalCents !== null) { provenance['document_totals.total'] = { method: 'pdf_text', text: 'Calculado: base + IVA − retención', page: null, x: null, y: null, confidence: 0.4 }; warnings.push('No aparece el total: se ha calculado.'); }
  if (baseCents === null || totalCents === null) missing.push('importes');
  // La procedencia de lo leído por la plantilla manda sobre la genérica (mismo valor, otra fuente y otra confianza).
  for (const key of ['document_totals.base', 'document_totals.total', 'document_totals.withholding']) if (tp(key) && provenance[key]?.method === 'pdf_text') provenance[key] = tp(key)!;
  const tplVat = Object.keys(tv?.values.vat ?? {}).map((r) => tp(`document_totals.vat:${r}`)).filter(Boolean) as FieldProvenance[];
  if (tplVat.length) provenance['document_totals.vat'] = tplVat.reduce((a, b) => (a.confidence <= b.confidence ? a : b));

  let iban: string | null = null;
  for (const line of lines) { const m = line.text.match(/\bES\d{2}(?:\s?\d{4}){5}\b/i); if (m && validIban(m[0])) { iban = validIban(m[0]); break; } }

  // Lo encontrado, con o sin factura completa. El nombre solo si sale del documento (no el de la factura pendiente).
  const nameMethod = provenance['invoice.supplier_name'];
  const found: PartialInvoice = {
    supplier_name: nameMethod && nameMethod.method !== 'manual' ? supplierName : null,
    supplier_tax_id: provenance['invoice.supplier_tax_id'] ? supplierTaxId : null,
    invoice_number: invoiceNumber, invoice_date: invoiceDate,
    base: baseCents === null || baseFromTotalOnly ? null : fromCents(baseCents),
    vat: [...vatByRate.entries()].sort((a, b) => a[0] - b[0]).map(([rate, v]) => ({ rate, base: v.base, quota: v.quota })),
    withholding: withholding ? { amount: withholding.v, rate: withholding.rate } : null,
    total: totalCents === null ? null : fromCents(totalCents),
    iban,
  };
  if (missing.includes('fecha') || missing.includes('importes')) {
    return { hasText: true, read: 'partial', found, stats, ok: false, document: null, provenance, missing, warnings, iban };
  }
  // Líneas: una por tipo de IVA con su base (o una sola con la base si no hay desglose).
  const rates = [...vatByRate.entries()].sort((a, b) => a[0] - b[0]);
  // Artículos de la tabla aprendida (si la plantilla la tiene): solo si suman la base y hay un único tipo de IVA; los
  // totales no se tocan. Si no cuadran, las líneas por tipo de IVA de siempre y un aviso.
  const ti = options.templateItems;
  let itemLines: ImportDocument['lines'] | null = null;
  if (ti?.items.length) {
    const sum = ti.items.reduce((n, it) => n + toCents(it.net_amount), 0);
    if (Math.abs(sum - baseCents!) > 2) warnings.push(`Los ${ti.items.length} artículos leídos con la plantilla suman ${fromCents(sum).toFixed(2).replace('.', ',')} € y la base es ${fromCents(baseCents!).toFixed(2).replace('.', ',')} €: se dejan las líneas por tipo de IVA. Revisa los artículos.`);
    else if (rates.length > 1) warnings.push(`Hay ${rates.length} tipos de IVA: los artículos leídos con la plantilla no se usan (no se sabe el tipo de cada uno).`);
    else {
      const rate = rates.length === 1 ? rates[0]![0] : null;
      itemLines = ti.items.map((it) => ({ description: it.description.slice(0, 500), quantity: it.quantity, unit: null, unit_price: it.unit_price, discount_amount: null, net_amount: it.net_amount,
        vat_rate: rate, vat_amount: rate === null ? null : fromCents(Math.round(toCents(it.net_amount) * rate / 100)), gross_amount: null, suggested_item_type: null, suggested_match_name: null, confidence: ti.confidence, notes: null }));
      provenance['lines'] = { method: 'supplier_template', text: `${ti.items.length} artículos de la tabla aprendida`, page: ti.items[0]!.page, x: null, y: null, confidence: ti.confidence };
    }
  }
  const docLines = itemLines ?? (rates.length && rates.every(([, v]) => v.base !== null)
    ? rates.map(([rate, v]) => ({ description: `Base al ${rate} % según documento`, quantity: null, unit: null, unit_price: null, discount_amount: null, net_amount: v.base!, vat_rate: rate, vat_amount: v.quota, gross_amount: null, suggested_item_type: null, suggested_match_name: null, confidence: 0.6, notes: null }))
    : [{ description: 'Importe según documento', quantity: null, unit: null, unit_price: null, discount_amount: null, net_amount: fromCents(baseCents!), vat_rate: rates.length === 1 ? rates[0]![0] : null, vat_amount: rates.length === 1 ? rates[0]![1].quota : null, gross_amount: null, suggested_item_type: null, suggested_match_name: null, confidence: 0.5, notes: null }]);
  const document = {
    schema_version: 'ikisai.invoice.v1',
    invoice: {
      invoice_date: invoiceDate!, supplier_name: supplierName, supplier_tax_id: supplierTaxId, invoice_number: invoiceNumber,
      object: (options.fallback?.object ?? '').trim() || 'compra', currency: 'EUR', deductibility_suggestion: 'pendiente_revision', notes: null,
    },
    lines: docLines,
    taxes: [
      ...rates.map(([rate, v]) => ({ tax_type: 'iva', rate, taxable_base: v.base, amount: v.quota, notes: null })),
      ...(withholding ? [{ tax_type: 'irpf', rate: withholding.rate, taxable_base: null, amount: withholding.v, notes: null }] : []),
    ],
    document_totals: { base: fromCents(baseCents!), vat: fromCents(vatTotal), withholding: fromCents(w), total: fromCents(totalCents!) },
    extraction_notes: ['Leído del texto del PDF con reglas: revisa cada dato antes de importar.', iban ? `IBAN del documento: ${iban}.` : null, ...warnings].filter(Boolean).join(' '),
    overall_confidence: Math.min(...Object.values(provenance).map((p) => p.confidence), 1),
  };
  if (!options.fallback?.object) provenance['invoice.object'] = { method: 'manual', text: 'Objeto por defecto: escríbelo en la vista previa', page: null, x: null, y: null, confidence: 0 };
  const validation = validateImportDocument(document);
  if (!validation.ok) return { hasText: true, read: 'partial', found, stats, ok: false, document: null, provenance, missing: ['formato'], warnings: [...warnings, ...validation.errors.map((e) => `${e.path}: ${e.reason}`)], iban };
  return { hasText: true, read: 'sufficient', found, stats, ok: true, document: validation.document, provenance, missing, warnings, iban };
}

// ---------------------------------------------------------------------------
// Lectura parcial (fase 0, 9-10-2026): estadísticas, texto legible y mensaje honesto
// ---------------------------------------------------------------------------
export function emptyPartial(): PartialInvoice {
  return { supplier_name: null, supplier_tax_id: null, invoice_number: null, invoice_date: null, base: null, vat: [], withholding: null, total: null, iban: null };
}

/** Páginas con texto, fragmentos y caracteres (sin espacios): el diagnóstico sin contenido. */
export function readStats(items: PdfTextItem[]): ReadStats {
  return { pages: items.reduce((n, it) => Math.max(n, it.page), 0), items: items.length, chars: items.reduce((n, it) => n + it.str.replace(/\s/g, '').length, 0) };
}

/** El texto leído, legible: por líneas (como las ve el lector), con una marca por página. Para verlo y copiarlo. */
export function readingText(items: PdfTextItem[], maxChars = 60_000): string {
  const lines = linesFromItems(items);
  const pages = new Set(lines.map((l) => l.page)).size;
  const out: string[] = [];
  let page = 0;
  for (const line of lines) {
    if (line.page !== page) { page = line.page; if (pages > 1) out.push(`${out.length ? '\n' : ''}— Página ${page} —`); }
    out.push(line.text);
  }
  const text = out.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text;
}

const joinEs = (parts: string[]) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}`);

/** Qué falta, en palabras («la fecha», «el IVA»…), a partir de lo encontrado. */
export function missingLabels(found: PartialInvoice): string[] {
  const out: string[] = [];
  if (!found.supplier_name && !found.supplier_tax_id) out.push('el proveedor');
  if (!found.invoice_date) out.push('la fecha');
  if (found.base === null) out.push('la base');
  if (!found.vat.length && found.base === null) out.push('el IVA');
  if (found.total === null) out.push('el total');
  return out;
}

/** Qué se ha encontrado, en palabras («proveedor, número y total»). */
export function foundLabels(found: PartialInvoice): string[] {
  const out: string[] = [];
  if (found.supplier_name || found.supplier_tax_id) out.push('proveedor');
  if (found.invoice_number) out.push('número');
  if (found.invoice_date) out.push('fecha');
  if (found.base !== null) out.push('base');
  if (found.vat.length) out.push('IVA');
  if (found.total !== null) out.push('total');
  return out;
}

/** Mensaje honesto para la persona: nunca «sin texto» si lo hay. */
export function readingMessage(x: Pick<PdfExtraction, 'read' | 'found' | 'stats' | 'missing'>): string {
  if (x.read === 'no_text') return 'Este PDF no contiene texto legible. Parece un documento escaneado o una foto: usa «Leer con IA» o complétalo a mano.';
  if (x.read === 'sufficient') return 'Lectura completa. Revisa los datos antes de validar.';
  const got = foundLabels(x.found);
  const lack = missingLabels(x.found);
  const shape = `${x.stats.pages} pág., ${x.stats.chars} caracteres`;
  if (x.missing.includes('formato') && !lack.length) return `He leído el PDF (${shape}) y encontrado ${joinEs(got)}, pero los datos no cuadran entre sí: revísalos.`;
  if (!got.length) return `He leído el texto del PDF (${shape}), pero no he identificado ningún dato de la factura.`;
  return `He leído el PDF (${shape}) y encontrado ${joinEs(got)}, pero no he identificado ${joinEs(lack.length ? lack : ['algún dato'])}.`;
}

/** Duplicado blando: misma fecha y total (y mismo proveedor si se conoce) que otra factura no anulada. */
export function softDuplicate<T extends { id: string; supplier_id: string; invoice_date: string | null; calculated_total: number; source_total: number | null; status: string; deleted_at: string | null }>(
  invoices: T[], candidate: { supplier_id: string | null; invoice_date: string; total: number }, excludeId?: string | null,
): T | null {
  return invoices.find((i) => !i.deleted_at && i.status !== 'anulada' && i.id !== excludeId && i.invoice_date === candidate.invoice_date
    && (!candidate.supplier_id || i.supplier_id === candidate.supplier_id)
    && [i.calculated_total, i.source_total].some((t) => t !== null && Math.abs(Number(t) - candidate.total) <= 0.02)) ?? null;
}
