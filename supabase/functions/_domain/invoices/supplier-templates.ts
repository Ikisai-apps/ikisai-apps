/**
 * Plantillas por proveedor aprendidas de confirmaciones (API.md §6.9, fase 3). Sin IA: se aprende **solo** de facturas
 * confirmadas (el servidor lo impone: una plantilla solo se escribe en el lote que valida una factura de ese proveedor).
 *
 * - Huella del formato: palabras sin cifras de las 40 primeras líneas de la página 1; se compara por Jaccard (≥ 0,6).
 * - Aprender: cada valor confirmado se busca en el texto en sus formas posibles; si aparece en un solo sitio, se guarda la
 *   etiqueta que lo precede en la línea (o la línea de encima) y la relación. Lo ambiguo no se aprende.
 * - Usar: se localiza la etiqueta y se toma el valor; confianza según la evidencia (≤ 0,5 mientras «aprendiendo»).
 * - Una factura anómala no cambia una etiqueta; tres fallos seguidos retiran esa regla; otro formato, otra versión.
 */
import { applyItemTable, ITEMS_KEY, learnItemsFromConfirmation, type ConfirmedItem, type ItemTableRule } from './item-table.ts';
import { fromCents, toCents } from './money.ts';
import { amountsIn, datesIn, extractFromPdfText, linesFromItems, validSpanishTaxId, type FieldProvenance, type PdfExtraction, type PdfExtractOptions, type PdfLine, type PdfTextItem } from './pdf-extract.ts';

export type TemplateFieldKind = 'date' | 'money' | 'tax_id' | 'text';
export interface TemplateRule {
  anchor: { text: string; variants: string[] };
  relation: 'same_line_right' | 'below';
  page: number;
  kind: TemplateFieldKind;
  pattern: string | null;
  hits: number;
  misses: number;
  streak_misses: number;
  retired?: boolean;
}
export interface TemplateLike {
  id: string;
  supplier_id: string;
  version: number;
  status: 'aprendiendo' | 'activa' | 'retirada';
  layout_tokens: string[];
  layout_hash: string;
  fields: Record<string, TemplateRule>;
  confirmations: number;
  uses: number;
  full_hits: number;
  revision?: number;
  deleted_at?: string | null;
}

/** Valores confirmados de una factura (los que la plantilla puede aprender). `vat` por tipo: cuota. */
export interface ConfirmedValues {
  invoice_number?: string | null;
  invoice_date?: string | null;
  supplier_tax_id?: string | null;
  base?: number | null;
  total?: number | null;
  withholding?: number | null;
  vat?: Record<string, number>;
}

export const SIMILARITY_THRESHOLD = 0.6;
const RELIABLE_CONFIRMATIONS = 2;
const RETIRE_AFTER_MISSES = 3;
/** También se retira si falla mucho aunque no sea seguido: más del 40 % de fallos tras 5 usos (fase 2). */
const RETIRE_MIN_USES = 5;
const RETIRE_MISS_RATIO = 0.4;

export const normText = (text: string) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Huella del formato
// ---------------------------------------------------------------------------
export function layoutTokens(lines: PdfLine[]): string[] {
  const words = new Set<string>();
  for (const line of lines.filter((l) => l.page === 1).slice(0, 40)) {
    for (const w of normText(line.text).split(/[^a-zñ]+/)) if (w.length >= 3 && w.length <= 30) words.add(w);
  }
  return [...words].sort();
}

/**
 * Huella estable (9-10-2026): la misma, sin las líneas con importes (las filas de artículos cambian de una factura a otra).
 * Las plantillas nuevas la guardan; al elegir se compara con las dos y vale la mejor (las antiguas guardaban la completa).
 */
export function stableLayoutTokens(lines: PdfLine[]): string[] {
  return layoutTokens(lines.filter((l) => !amountsIn(l.text).length));
}

export async function layoutHash(tokens: string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tokens.join('\n')));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function jaccard(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  const sa = new Set(a); const sb = new Set(b);
  let inter = 0; for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** La plantilla no retirada más parecida del proveedor, si llega al umbral. */
export function chooseTemplate<T extends TemplateLike>(templates: T[], supplierId: string, tokens: string[], stable?: string[]): { template: T; similarity: number } | null {
  let best: { template: T; similarity: number } | null = null;
  for (const t of templates) {
    if (t.deleted_at || t.status === 'retirada' || t.supplier_id !== supplierId) continue;
    const similarity = Math.max(jaccard(t.layout_tokens, tokens), stable ? jaccard(t.layout_tokens, stable) : 0);
    if (similarity >= SIMILARITY_THRESHOLD && (!best || similarity > best.similarity)) best = { template: t, similarity };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Formas de un valor y búsqueda en el texto
// ---------------------------------------------------------------------------
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function moneyForms(v: number): string[] {
  const cents = Math.abs(toCents(v));
  const int = Math.floor(cents / 100); const dec = String(cents % 100).padStart(2, '0');
  const grouped = String(int).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return [...new Set([`${grouped},${dec}`, `${int},${dec}`, `${int}.${dec}`, `${String(int).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`])];
}

function dateForms(iso: string): string[] {
  const [y, m, d] = iso.split('-');
  const dd = d!; const mm = m!; const di = String(Number(d)); const mi = String(Number(m)); const yy = y!.slice(2);
  return [`${dd}/${mm}/${y}`, `${di}/${mi}/${y}`, `${dd}-${mm}-${y}`, `${di}-${mi}-${y}`, `${dd}.${mm}.${y}`, `${y}-${mm}-${dd}`, `${dd}/${mm}/${yy}`, `${di} de ${MONTHS[Number(m) - 1]} de ${y}`];
}

function formsOf(kind: TemplateFieldKind, value: string | number): string[] {
  if (kind === 'money') return moneyForms(Number(value));
  if (kind === 'date') return dateForms(String(value));
  if (kind === 'tax_id') { const v = String(value).toUpperCase(); return [v, `${v[0]}-${v.slice(1)}`, `${v.slice(0, 1)}-${v.slice(1, 8)}-${v.slice(8)}`]; }
  return [String(value)];
}

/** Dónde aparece un valor: línea y posición del texto. Solo cuenta si la forma no está pegada a otras cifras. */
function occurrences(lines: PdfLine[], kind: TemplateFieldKind, value: string | number): Array<{ line: PdfLine; index: number; form: string }> {
  const out: Array<{ line: PdfLine; index: number; form: string }> = [];
  const forms = formsOf(kind, value);
  for (const line of lines) {
    const lower = kind === 'date' ? normText(line.text) : line.text;
    for (const form of forms) {
      let from = 0;
      for (let i = lower.indexOf(kind === 'date' ? normText(form) : form, from); i >= 0; i = lower.indexOf(kind === 'date' ? normText(form) : form, from)) {
        const before = lower[i - 1] ?? ' '; const after = lower[i + form.length] ?? ' ';
        if (!/[\d.,]/.test(before) && !/\d/.test(after) && !(/[.,]/.test(after) && /\d/.test(lower[i + form.length + 1] ?? ''))) {
          if (!out.some((o) => o.line === line)) out.push({ line, index: i, form });
        }
        from = i + 1;
      }
    }
  }
  return out;
}

/** Etiqueta: lo que precede al valor en la línea (hasta 4 palabras con letras) o, si no hay, la línea de encima. */
function anchorFor(lines: PdfLine[], occ: { line: PdfLine; index: number }): { text: string; relation: TemplateRule['relation'] } | null {
  const before = normText(occ.line.text.slice(0, occ.index)).replace(/[:\-–—#º°]+\s*$/, '').trim();
  const words = before.split(' ').filter(Boolean).slice(-4).join(' ');
  if (/[a-zñ]{2}/.test(words)) return { text: words, relation: 'same_line_right' };
  const idx = lines.indexOf(occ.line);
  const prev = idx > 0 && lines[idx - 1]!.page === occ.line.page ? lines[idx - 1]! : null;
  if (prev) { const t = normText(prev.text).split(' ').slice(-4).join(' '); if (/[a-zñ]{2}/.test(t)) return { text: t, relation: 'below' }; }
  return null;
}

/** Forma del número de factura generalizada: cifras por \d, el resto literal. */
export function patternFor(value: string): string {
  return '^' + value.replace(/[.*+?^${}()|[\]\\/]/g, (c) => '\\' + c).replace(/\d+/g, (d) => `\\d{${d.length}}`) + '$';
}

// ---------------------------------------------------------------------------
// Aplicar
// ---------------------------------------------------------------------------
function findAnchorLine(lines: PdfLine[], rule: TemplateRule): { line: PdfLine; rest: string; text: string } | null {
  for (const text of [rule.anchor.text, ...rule.anchor.variants]) {
    for (const line of lines) {
      const n = normText(line.text);
      const i = n.indexOf(text);
      if (i < 0) continue;
      if (rule.relation === 'same_line_right') return { line, rest: line.text.slice(Math.min(line.text.length, i + text.length)), text };
      const idx = lines.indexOf(line);
      const next = lines[idx + 1];
      if (next && next.page === line.page) return { line: next, rest: next.text, text };
    }
  }
  return null;
}

function readValue(rule: TemplateRule, rest: string): string | number | null {
  if (rule.kind === 'money') { const a = amountsIn(rest); return a.length ? a[0]! : null; }
  if (rule.kind === 'date') { const d = datesIn(rest); return d.length ? d[0]! : null; }
  if (rule.kind === 'tax_id') { for (const m of rest.matchAll(/[A-Z0-9-]{9,12}/gi)) { const v = validSpanishTaxId(m[0]); if (v) return v; } return null; }
  const re = rule.pattern ? new RegExp(rule.pattern.replace(/^\^/, '').replace(/\$$/, '')) : /[A-Z0-9][A-Z0-9\-/.]{0,30}/i;
  const m = rest.match(re);
  return m ? m[0] : null;
}

export function ruleConfidence(template: TemplateLike, rule: TemplateRule): number {
  const ratio = rule.hits + rule.misses ? rule.hits / (rule.hits + rule.misses) : 0.5;
  if (template.status === 'aprendiendo' || template.confirmations < RELIABLE_CONFIRMATIONS) return Math.min(0.5, 0.4 + 0.1 * ratio);
  return Math.round(Math.min(0.95, 0.6 + 0.07 * template.confirmations) * ratio * 100) / 100;
}

export interface TemplateApplication {
  values: ConfirmedValues;
  provenance: Record<string, FieldProvenance>;
}

const PROVENANCE_KEY: Record<string, string> = {
  invoice_number: 'invoice.invoice_number', invoice_date: 'invoice.invoice_date', supplier_tax_id: 'invoice.supplier_tax_id',
  base: 'document_totals.base', total: 'document_totals.total', withholding: 'document_totals.withholding',
};

/** La tabla de artículos aprendida de una plantilla (se guarda en `fields.__items`). */
export function itemsRuleOf(template: { fields: Record<string, unknown> }): ItemTableRule | null {
  const r = template.fields[ITEMS_KEY] as ItemTableRule | undefined;
  return r && r.kind === 'items_table' ? r : null;
}

export function applyTemplate(lines: PdfLine[], template: TemplateLike): TemplateApplication {
  const values: ConfirmedValues = {}; const provenance: Record<string, FieldProvenance> = {};
  for (const [field, rule] of Object.entries(template.fields)) {
    if (field === ITEMS_KEY || rule.retired) continue;
    const found = findAnchorLine(lines, rule);
    if (!found) continue;
    const value = readValue(rule, found.rest);
    if (value === null) continue;
    if (rule.kind === 'text' && rule.pattern && !new RegExp(rule.pattern).test(String(value))) continue;
    const prov: FieldProvenance = { method: 'supplier_template', text: found.line.text, page: found.line.page, x: Math.round(found.line.x), y: Math.round(found.line.y), confidence: ruleConfidence(template, rule) };
    if (field.startsWith('vat:')) { values.vat = { ...(values.vat ?? {}), [field.slice(4)]: Number(value) }; provenance[`document_totals.vat:${field.slice(4)}`] = prov; continue; }
    (values as Record<string, unknown>)[field] = value;
    if (PROVENANCE_KEY[field]) provenance[PROVENANCE_KEY[field]!] = prov;
  }
  return { values, provenance };
}

// ---------------------------------------------------------------------------
// Aprender (al confirmar)
// ---------------------------------------------------------------------------
const FIELD_KINDS: Record<string, TemplateFieldKind> = { invoice_number: 'text', invoice_date: 'date', supplier_tax_id: 'tax_id', base: 'money', total: 'money', withholding: 'money' };
/** Etiquetas esperables por campo, para desempatar cuando un importe aparece en varias líneas. */
const LABEL_HINT: Record<string, RegExp> = { base: /base|neto|subtotal/, total: /total/, withholding: /irpf|retenc/, invoice_date: /fecha/, invoice_number: /factura|n[ºo°]|numero|fra/, supplier_tax_id: /c\.?i\.?f|n\.?i\.?f|nie|vat/ };

function confirmedEntries(confirmed: ConfirmedValues): Array<[string, TemplateFieldKind, string | number]> {
  const out: Array<[string, TemplateFieldKind, string | number]> = [];
  for (const [field, kind] of Object.entries(FIELD_KINDS)) {
    const v = (confirmed as Record<string, unknown>)[field];
    if (v !== null && v !== undefined && v !== '' && !(kind === 'money' && Number(v) === 0)) out.push([field, kind, v as string | number]);
  }
  for (const [rate, quota] of Object.entries(confirmed.vat ?? {})) if (Number(quota)) out.push([`vat:${rate}`, 'money', quota]);
  return out;
}

/** Regla nueva para un valor confirmado, o `null` si no aparece en el texto o es ambiguo. */
export function learnRule(lines: PdfLine[], field: string, kind: TemplateFieldKind, value: string | number): TemplateRule | null {
  let occ = occurrences(lines, kind, value);
  if (occ.length > 1) {
    const hint = field.startsWith('vat:') ? /iva|i\.v\.a|igic/ : LABEL_HINT[field];
    const filtered = hint ? occ.filter((o) => hint.test(normText(o.line.text.slice(0, o.index)))) : [];
    if (filtered.length !== 1) return null;
    occ = filtered;
  }
  if (occ.length !== 1) return null;
  const anchor = anchorFor(lines, occ[0]!);
  if (!anchor) return null;
  return { anchor: { text: anchor.text, variants: [] }, relation: anchor.relation, page: occ[0]!.line.page, kind, pattern: kind === 'text' ? patternFor(String(value)) : null, hits: 1, misses: 0, streak_misses: 0 };
}

const same = (kind: TemplateFieldKind, a: unknown, b: unknown) => (kind === 'money' ? Math.abs(Number(a) - Number(b)) <= 0.005 : String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase());

export interface TemplateLearning {
  /** Plantilla resultante (nueva o actualizada) para escribirla en el lote de la validación. */
  template: Omit<TemplateLike, 'id' | 'revision' | 'deleted_at'> & { id: string | null };
  isNew: boolean;
  learned: string[];
  hits: string[];
  misses: string[];
}

/**
 * Lo que una confirmación enseña. Con plantilla parecida: aciertos y fallos por regla (sin cambiar la etiqueta por una
 * sola factura), variantes de etiqueta y reglas nuevas para lo que faltaba. Sin plantilla parecida: versión nueva.
 */
export async function learnFromConfirmation(input: {
  lines: PdfLine[]; confirmed: ConfirmedValues; supplierId: string; invoiceId: string; templates: TemplateLike[];
  /** Artículos de la factura validada: si están en el PDF, la plantilla aprende la tabla (item-table.ts). */
  items?: ConfirmedItem[];
}): Promise<TemplateLearning | null> {
  const full = layoutTokens(input.lines);
  const stable = stableLayoutTokens(input.lines);
  const tokens = stable.length >= 3 ? stable : full;
  if (!full.length) return null;
  const chosen = chooseTemplate(input.templates, input.supplierId, full, tokens);
  const entries = confirmedEntries(input.confirmed);
  const learned: string[] = []; const hits: string[] = []; const misses: string[] = [];
  /** La tabla de artículos: acierto, fallo o regla nueva (no cuenta como fallo si el documento no tiene artículos). */
  const learnItems = (fields: Record<string, TemplateRule>) => {
    if (!input.items?.length) return;
    const r = learnItemsFromConfirmation(input.lines, input.items, itemsRuleOf({ fields }));
    if (r.rule) (fields as Record<string, unknown>)[ITEMS_KEY] = r.rule;
    if (r.outcome === 'learned') learned.push('items'); else if (r.outcome === 'hit') hits.push('items'); else if (r.outcome === 'miss') misses.push('items');
  };
  if (!chosen) {
    const fields: Record<string, TemplateRule> = {};
    for (const [field, kind, value] of entries) { const rule = learnRule(input.lines, field, kind, value); if (rule) { fields[field] = rule; learned.push(field); } }
    learnItems(fields);
    if (!learned.length) return null;
    const version = Math.max(0, ...input.templates.filter((t) => t.supplier_id === input.supplierId).map((t) => t.version)) + 1;
    return { isNew: true, learned, hits, misses, template: { id: null, supplier_id: input.supplierId, version, status: 'aprendiendo', layout_tokens: tokens, layout_hash: await layoutHash(tokens), fields, confirmations: 1, uses: 0, full_hits: 0 } };
  }
  const t = chosen.template;
  const applied = applyTemplate(input.lines, t);
  const fields: Record<string, TemplateRule> = JSON.parse(JSON.stringify(t.fields));
  for (const [field, kind, value] of entries) {
    const rule = fields[field];
    if (!rule || rule.retired) {
      const fresh = learnRule(input.lines, field, kind, value);
      if (fresh) { fields[field] = fresh; learned.push(field); }
      continue;
    }
    const proposed = field.startsWith('vat:') ? applied.values.vat?.[field.slice(4)] : (applied.values as Record<string, unknown>)[field];
    if (proposed !== undefined && same(kind, proposed, value)) { rule.hits++; rule.streak_misses = 0; hits.push(field); continue; }
    // Si lo confirmado no está en el documento (p. ej. una fecha que el usuario eligió conservar), la plantilla no podía
    // leerlo: no cuenta como fallo (decisión de Core, ronda 35).
    if (!occurrences(input.lines, kind, value).length) continue;
    rule.misses++; rule.streak_misses++; misses.push(field);
    // Una factura anómala no cambia la etiqueta; si el valor está junto a otra etiqueta, se guarda como variante.
    const elsewhere = learnRule(input.lines, field, kind, value);
    if (elsewhere && elsewhere.relation === rule.relation && elsewhere.anchor.text !== rule.anchor.text && !rule.anchor.variants.includes(elsewhere.anchor.text) && rule.anchor.variants.length < 5) {
      rule.anchor.variants.push(elsewhere.anchor.text);
    }
    if (rule.streak_misses >= RETIRE_AFTER_MISSES || (rule.hits + rule.misses >= RETIRE_MIN_USES && rule.misses / (rule.hits + rule.misses) > RETIRE_MISS_RATIO)) rule.retired = true;
  }
  learnItems(fields);
  const confirmations = t.confirmations + 1;
  return {
    isNew: false, learned, hits, misses,
    template: {
      id: t.id, supplier_id: t.supplier_id, version: t.version, status: t.status === 'aprendiendo' && confirmations >= RELIABLE_CONFIRMATIONS ? 'activa' : t.status,
      layout_tokens: t.layout_tokens, layout_hash: t.layout_hash, fields, confirmations, uses: t.uses + 1, full_hits: t.full_hits + (misses.length === 0 && hits.length > 0 ? 1 : 0),
    },
  };
}

/** Operación de fila para el lote de `invoices.validate` (el hook SQL exige que vayan juntas). */
export function templateOperation(learning: TemplateLearning, current: { revision: number } | null, invoiceId: string, newId: string) {
  const t = learning.template;
  const fields = { supplier_id: t.supplier_id, version: t.version, status: t.status, layout_tokens: t.layout_tokens, layout_hash: t.layout_hash, fields: t.fields, confirmations: t.confirmations, uses: t.uses, full_hits: t.full_hits, last_confirmed_invoice_id: invoiceId };
  return learning.isNew || !t.id || !current
    ? { op: 'insert' as const, table: 'invoices.supplier_templates', id: newId, fields }
    : { op: 'update' as const, table: 'invoices.supplier_templates', id: t.id, expectedRevision: current.revision, fields: { status: fields.status, fields: fields.fields, confirmations: fields.confirmations, uses: fields.uses, full_hits: fields.full_hits, last_confirmed_invoice_id: invoiceId } };
}

/** Valores confirmados de una factura validada: lo que hay en la ficha (cabecera, impuestos y totales recalculados). */
export function confirmedFromInvoice(invoice: { invoice_number: string | null; invoice_date: string | null; calculated_base: number; calculated_total: number; calculated_withholding: number; source_total: number | null },
  supplierTaxId: string | null, taxes: Array<{ tax_type: string; rate: number | null; amount: number; deleted_at?: string | null }>): ConfirmedValues {
  const vat: Record<string, number> = {};
  for (const t of taxes) if (!t.deleted_at && t.tax_type === 'iva' && t.rate !== null) vat[String(Number(t.rate))] = fromCents(toCents(Number(vat[String(Number(t.rate))] ?? 0)) + toCents(Number(t.amount)));
  return {
    invoice_number: invoice.invoice_number, invoice_date: invoice.invoice_date, supplier_tax_id: supplierTaxId,
    base: Number(invoice.calculated_base), total: Number(invoice.source_total ?? invoice.calculated_total), withholding: Number(invoice.calculated_withholding) || null, vat,
  };
}

// ---------------------------------------------------------------------------
// «Leer PDF» con plantillas: proveedor por NIF, plantilla más parecida y reglas genéricas para lo que falte
// ---------------------------------------------------------------------------
export interface TemplateExtraction extends PdfExtraction {
  template: { id: string; version: number; status: TemplateLike['status']; confirmations: number; similarity: number } | null;
  supplierId: string | null;
  lines: PdfLine[];
}

/**
 * Ranking de plantillas sin depender del NIF (fase 2, 9-10-2026): si el NIF del documento no es de un proveedor conocido,
 * se puntúan las plantillas activas de todos los proveedores con evidencia determinista:
 * 0,5 · huella del formato (la mejor entre la completa y la estable) + 0,2 · etiquetas de sus reglas presentes en el
 * documento + 0,2 · nombre del proveedor en el texto + 0,1 · NIF (aquí, 0). Gana la primera si pasa de 0,7 y saca 0,1 a la
 * segunda. El proveedor que sale así va como «revísalo»; nunca se da de alta un proveedor solo por parecido.
 */
export const RANK_THRESHOLD = 0.7;
export const RANK_MARGIN = 0.1;
export function rankTemplates<T extends TemplateLike>(templates: T[], lines: PdfLine[], suppliers: Array<{ id?: string; name: string }>): Array<{ template: T; score: number; similarity: number }> {
  const full = layoutTokens(lines);
  const stable = stableLayoutTokens(lines);
  const text = normText(lines.map((l) => l.text).join(' '));
  const names = new Map(suppliers.filter((s) => s.id).map((s) => [s.id!, normText(s.name).replace(/\b(?:s\.?\s?l\.?\s?u?|s\.?\s?a\.?\s?u?|s\.?\s?coop)\.?$/, '').trim()]));
  const out: Array<{ template: T; score: number; similarity: number }> = [];
  for (const t of templates) {
    if (t.deleted_at || t.status !== 'activa') continue;
    const similarity = Math.max(jaccard(t.layout_tokens, full), stable.length >= 3 ? jaccard(t.layout_tokens, stable) : 0);
    const anchors = Object.entries(t.fields).filter(([k, r]) => k !== ITEMS_KEY && !r.retired).map(([, r]) => normText(r.anchor.text)).filter((a) => a.length >= 3);
    const labels = anchors.length ? anchors.filter((a) => text.includes(a)).length / anchors.length : 0;
    const name = names.get(t.supplier_id);
    const nameHit = name && name.length >= 4 && text.includes(name) ? 1 : 0;
    out.push({ template: t, similarity, score: Math.round((0.5 * similarity + 0.2 * labels + 0.2 * nameHit) * 100) / 100 });
  }
  return out.sort((a, b) => b.score - a.score);
}

export function extractWithTemplates(items: PdfTextItem[], options: PdfExtractOptions & { templates?: TemplateLike[]; fallbackSupplierId?: string | null } = {}): TemplateExtraction {
  const lines = linesFromItems(items);
  const byTaxId = new Map((options.suppliers ?? []).filter((s) => s.id && s.tax_id).map((s) => [validSpanishTaxId(s.tax_id!) ?? s.tax_id!.toUpperCase(), s.id!]));
  let supplierId: string | null = null;
  for (const line of lines) {
    for (const m of line.text.matchAll(/[A-Z0-9][A-Z0-9-]{7,12}/gi)) { const id = validSpanishTaxId(m[0]); if (id && byTaxId.has(id)) { supplierId = byTaxId.get(id)!; break; } }
    if (supplierId) break;
  }
  supplierId = supplierId ?? options.fallbackSupplierId ?? null;
  // Sin proveedor por NIF: la plantilla más parecida de cualquier proveedor, si gana con claridad.
  let ranked: { template: TemplateLike; score: number; similarity: number } | null = null;
  if (!supplierId && options.templates?.length) {
    const r = rankTemplates(options.templates, lines, options.suppliers ?? []);
    if (r[0] && r[0].score >= RANK_THRESHOLD && (!r[1] || r[0].score - r[1].score >= RANK_MARGIN)) { ranked = r[0]; supplierId = r[0].template.supplier_id; }
  }
  const chosen = ranked ? { template: ranked.template, similarity: ranked.similarity } : supplierId && options.templates?.length ? chooseTemplate(options.templates, supplierId, layoutTokens(lines), (() => { const st = stableLayoutTokens(lines); return st.length >= 3 ? st : undefined; })()) : null;
  const applied = chosen ? applyTemplate(lines, chosen.template) : null;
  // Artículos con la tabla aprendida (si la hay y no está retirada).
  const itemsRule = chosen ? itemsRuleOf(chosen.template) : null;
  const read = itemsRule && !itemsRule.retired ? applyItemTable(lines, itemsRule) : [];
  const itemsConfidence = chosen ? Math.min(0.9, ruleConfidence(chosen.template, { hits: itemsRule?.hits ?? 0, misses: itemsRule?.misses ?? 0 } as TemplateRule)) : 0;
  const rankedSupplier = ranked ? (options.suppliers ?? []).find((s) => s.id === ranked!.template.supplier_id) ?? null : null;
  const result = extractFromPdfText(items, { ...options, ...(applied ? { templateValues: applied } : {}), ...(read.length ? { templateItems: { items: read, confidence: itemsConfidence } } : {}),
    ...(rankedSupplier && !options.fallback?.supplier_name ? { fallback: { ...(options.fallback ?? {}), supplier_name: rankedSupplier.name, supplier_tax_id: rankedSupplier.tax_id ?? null } } : {}) });
  // Proveedor reconocido solo por el formato: «revísalo», con la procedencia de la plantilla.
  if (rankedSupplier) {
    if (result.provenance['invoice.supplier_name']?.method === 'manual') {
      result.provenance['invoice.supplier_name'] = { method: 'supplier_template', text: `Formato parecido al de ${rankedSupplier.name} (sin su NIF en el documento): revísalo`, page: null, x: null, y: null, confidence: 0.5 };
      result.found.supplier_name = rankedSupplier.name;
    }
    result.warnings.push(`El proveedor se ha reconocido por el formato de sus facturas (${rankedSupplier.name}), no por su NIF: revísalo.`);
  }
  return {
    ...result, lines, supplierId,
    template: chosen ? { id: chosen.template.id, version: chosen.template.version, status: chosen.template.status, confirmations: chosen.template.confirmations, similarity: Math.round(chosen.similarity * 100) / 100 } : null,
  };
}
