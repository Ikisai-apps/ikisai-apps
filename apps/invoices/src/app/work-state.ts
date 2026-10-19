/**
 * Estado de trabajo de las facturas recibidas (tanda 27, MUELA-032/036/070): proyección pura de `status`,
 * `payment_status`, `payment_source`, `due_date`, el documento y las entregas, sin estado nuevo. La usan Inicio y la lista.
 * - Recorrido: Llega · Por resolver · Validada · Pagada · En gestoría. «Pagada» solo con el pago confirmado (o leído del
 *   documento); «pagada sin confirmar» lleva «!» y lo dice la frase. Anulada = parado. Archivada, ya pasada a la gestoría
 *   y rectificativa van como etiqueta.
 * - Etiquetas: todas las de hoy, de la más grave a la menos; la lista enseña dos y «+n».
 * - Sin dependencias (se prueba con node): lo que falta llega ya en palabras.
 * - Buzones: Por resolver (con «Sin datos» y «Por revisar») · Sin pagar · Validadas · Todas · Más. Los `?filtro=` de
 *   siempre llevan a su buzón.
 */

export type Tone = 'alert' | 'warn' | 'ok';
const RANK: Record<Tone, number> = { alert: 3, warn: 2, ok: 1 };
export function worse(a: Tone | null, b: Tone | null): Tone | null {
  if (!a) return b;
  if (!b) return a;
  return RANK[b] > RANK[a] ? b : a;
}

/** Lo que la proyección necesita de una factura (las columnas del espejo). */
export interface WorkInvoice {
  id: string;
  supplier_id: string;
  status: 'pendiente_datos' | 'pendiente_revision' | 'validada' | 'archivada' | 'anulada';
  review_reason: string | null;
  payment_status: 'pendiente' | 'pagada';
  payment_source: string | null;
  paid_at: string | null;
  due_date: string | null;
  invoice_date: string | null;
  invoice_kind?: string | null;
  rectifies_invoice_id?: string | null;
  rectification_without_original?: boolean | null;
  delivered_elsewhere?: boolean | null;
  drive_file_id?: string | null;
  calculated_total?: number | string | null;
}

/** Lo que se sabe de la factura fuera de su fila. */
export interface WorkFacts {
  hasOriginal: boolean;
  /** Lo que falta para validar, en palabras (`MISSING_LABELS` de `missingOf`), solo si está por resolver. */
  missing: string[];
  /** Está en una entrega a la gestoría. */
  inExport: boolean;
  /** Trimestre de su fecha si se declara en uno posterior («3T»), o null. */
  late: string | null;
}

export const INVOICE_STAGES = [
  { key: 'llega', label: 'Llega' },
  { key: 'por_resolver', label: 'Por resolver' },
  { key: 'validada', label: 'Validada' },
  { key: 'pagada', label: 'Pagada' },
  { key: 'gestoria', label: 'En gestoría' },
] as const;
export type InvoiceStage = (typeof INVOICE_STAGES)[number]['key'];
const STAGE_LABEL = Object.fromEntries(INVOICE_STAGES.map((s) => [s.key, s.label])) as Record<InvoiceStage, string>;

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------
const DAY = 86_400_000;
const at = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
/** Días de `from` a `to` (fechas `AAAA-MM-DD`). */
export function daysBetween(from: string, to: string): number {
  return Math.round((at(to) - at(from)) / DAY);
}
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
export function dayMonth(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
}
const days = (n: number) => (n === 1 ? '1 día' : `${n} días`);

// ---------------------------------------------------------------------------
// Pago en palabras
// ---------------------------------------------------------------------------
export interface PayState {
  kind: 'paid' | 'unconfirmed' | 'overdue' | 'due' | 'unpaid' | 'none';
  text: string;
  tone: Tone | null;
  /** Pago confirmado por una persona o leído del documento. */
  confirmed: boolean;
}

/** «Pagada», «Pago sin confirmar», «Vencida hace 13 días», «Vence el 24 oct», «Sin pagar». */
export function payState(invoice: WorkInvoice, today: string): PayState {
  if (invoice.status === 'anulada') return { kind: 'none', text: '', tone: null, confirmed: false };
  if (invoice.payment_status === 'pagada') {
    if (invoice.payment_source === 'sin_confirmar') return { kind: 'unconfirmed', text: 'Pago sin confirmar', tone: 'warn', confirmed: false };
    return { kind: 'paid', text: invoice.paid_at ? `Pagada el ${dayMonth(invoice.paid_at)}` : 'Pagada', tone: 'ok', confirmed: true };
  }
  if (invoice.due_date) {
    const left = daysBetween(today, invoice.due_date);
    if (left < 0) return { kind: 'overdue', text: `Vencida hace ${days(-left)}`, tone: 'alert', confirmed: false };
    return { kind: 'due', text: left === 0 ? 'Vence hoy' : `Vence el ${dayMonth(invoice.due_date)}`, tone: left <= 7 ? 'warn' : null, confirmed: false };
  }
  return { kind: 'unpaid', text: 'Sin pagar', tone: null, confirmed: false };
}

// ---------------------------------------------------------------------------
// Etiquetas
// ---------------------------------------------------------------------------
export interface WorkLabel {
  text: string;
  /** Clase del chip: `alert`, `warn`, `ok`, `trash` o '' (neutro). */
  kind: 'alert' | 'warn' | 'ok' | 'trash' | '';
}
const LABEL_RANK: Record<WorkLabel['kind'], number> = { alert: 4, warn: 3, '': 2, ok: 1, trash: 0 };

/** Todas las etiquetas de hoy, de la más grave a la menos (la lista enseña dos y «+n»). */
export function invoiceLabels(invoice: WorkInvoice, facts: WorkFacts, today: string): WorkLabel[] {
  const out: WorkLabel[] = [];
  const pay = payState(invoice, today);
  if (invoice.status === 'anulada') out.push({ text: 'Anulada', kind: 'trash' });
  if (invoice.status === 'pendiente_revision' && invoice.review_reason === 'REVISAR IMPORTES') out.push({ text: 'Revisar importes', kind: 'alert' });
  if (!facts.hasOriginal && invoice.status !== 'anulada') out.push({ text: 'Sin documento', kind: 'alert' });
  if (pay.kind === 'overdue') out.push({ text: pay.text, kind: 'alert' });
  if (pay.kind === 'unconfirmed') out.push({ text: 'Pagada (sin confirmar)', kind: 'warn' });
  if (invoice.invoice_kind === 'rectificativa') {
    const linked = !!invoice.rectifies_invoice_id || !!invoice.rectification_without_original;
    out.push({ text: linked ? 'Rectificativa' : 'Rectificativa sin enlazar', kind: linked ? '' : 'warn' });
  }
  if (facts.late && invoice.status !== 'anulada') out.push({ text: `Atrasada (${facts.late})`, kind: 'warn' });
  if (invoice.delivered_elsewhere) out.push({ text: 'Ya pasada a la gestoría', kind: '' });
  if (invoice.status === 'archivada') out.push({ text: 'Archivada', kind: 'ok' });
  if (pay.kind === 'paid') out.push({ text: 'Pagada', kind: 'ok' });
  return out.map((l, i) => ({ l, i })).sort((a, b) => LABEL_RANK[b.l.kind] - LABEL_RANK[a.l.kind] || a.i - b.i).map((x) => x.l);
}

// ---------------------------------------------------------------------------
// Recorrido de la factura
// ---------------------------------------------------------------------------
export interface WorkState {
  /** Etapa actual; null si está parada (anulada). */
  stage: InvoiceStage | null;
  /** Etapas con «!». */
  bad: InvoiceStage[];
  /** La frase: «Por resolver · falta la categoría», «Validada · vencida hace 13 días». */
  caption: string;
  /** Lo que pide: alert > warn > ok (null = nada que decir). */
  tone: Tone | null;
  /** Está lista para confirmar (por revisar, sin nada que falte ni importes por revisar). */
  ready: boolean;
  pay: PayState;
}

export function workState(invoice: WorkInvoice, facts: WorkFacts, today: string): WorkState {
  const pay = payState(invoice, today);
  if (invoice.status === 'anulada') return { stage: null, bad: [], caption: 'Anulada: fuera de los resúmenes y de la gestoría.', tone: null, ready: false, pay };
  const details: string[] = [];
  const bad: InvoiceStage[] = [];
  let stage: InvoiceStage;
  let tone: Tone | null = null;
  let ready = false;
  if (invoice.status === 'pendiente_datos') {
    stage = 'llega';
    details.push(facts.hasOriginal ? 'sin datos: léela o rellénala' : 'sin datos ni documento');
    tone = 'warn';
  } else if (invoice.status === 'pendiente_revision') {
    stage = 'por_resolver';
    if (invoice.review_reason === 'REVISAR IMPORTES') { details.push('revisa los importes'); tone = 'alert'; bad.push('por_resolver'); }
    else if (facts.missing.length) { details.push(`falta ${facts.missing.join(', ')}`); tone = 'warn'; bad.push('por_resolver'); }
    else { details.push('lista para confirmar'); tone = 'warn'; ready = true; }
  } else if (facts.inExport) {
    stage = 'gestoria';
    tone = 'ok';
  } else if (pay.confirmed) {
    stage = 'pagada';
    tone = 'ok';
  } else {
    stage = 'validada';
    tone = 'ok';
  }
  // El pago, siempre dicho cuando no está confirmado
  if (pay.kind === 'unconfirmed') { details.push('pago sin confirmar'); bad.push('pagada'); tone = worse(tone, 'warn'); }
  else if (pay.kind === 'overdue') { details.push(pay.text.toLowerCase()); bad.push('pagada'); tone = 'alert'; }
  else if (pay.kind === 'due' && stage !== 'llega' && stage !== 'por_resolver') { details.push(pay.text.toLowerCase()); tone = worse(tone, pay.tone); }
  else if (pay.kind === 'unpaid' && (stage === 'validada' || stage === 'gestoria')) details.push('sin pagar');
  if (!facts.hasOriginal && stage !== 'llega') { details.push('sin documento'); tone = 'alert'; }
  return { stage, bad, caption: [STAGE_LABEL[stage], ...details].join(' · '), tone, ready, pay };
}

// ---------------------------------------------------------------------------
// Buzones
// ---------------------------------------------------------------------------
export const MAILBOXES = [
  { key: 'por_resolver', label: 'Por resolver' },
  { key: 'sin_pagar', label: 'Sin pagar' },
  { key: 'validadas', label: 'Validadas' },
  { key: 'todas', label: 'Todas' },
] as const;
export const MORE_MAILBOXES = [
  { key: 'drive', label: 'Llegadas por Drive' },
  { key: 'rect_sin_enlazar', label: 'Rectificativas sin enlazar' },
  { key: 'sin_documento', label: 'Sin documento' },
  { key: 'archivada', label: 'Archivadas' },
  { key: 'anulada', label: 'Anuladas' },
] as const;
export type Mailbox = (typeof MAILBOXES)[number]['key'] | (typeof MORE_MAILBOXES)[number]['key'];
/** Pastillas dentro de «Por resolver». */
export const RESOLVE_PILLS = [{ key: 'sin_datos', label: 'Sin datos' }, { key: 'por_revisar', label: 'Por revisar' }] as const;
export type ResolvePill = (typeof RESOLVE_PILLS)[number]['key'];

export function inMailbox(box: Mailbox, invoice: WorkInvoice, hasOriginal: boolean, pill: ResolvePill | null = null): boolean {
  switch (box) {
    case 'por_resolver':
      if (pill === 'sin_datos') return invoice.status === 'pendiente_datos';
      if (pill === 'por_revisar') return invoice.status === 'pendiente_revision';
      return invoice.status === 'pendiente_datos' || invoice.status === 'pendiente_revision';
    case 'sin_pagar': return invoice.status !== 'anulada' && invoice.payment_status === 'pendiente';
    case 'validadas': return invoice.status === 'validada';
    case 'todas': return invoice.status !== 'anulada';
    case 'drive': return !!invoice.drive_file_id && (invoice.status === 'pendiente_datos' || invoice.status === 'pendiente_revision');
    case 'rect_sin_enlazar': return invoice.status !== 'anulada' && invoice.invoice_kind === 'rectificativa' && !invoice.rectifies_invoice_id && !invoice.rectification_without_original;
    case 'sin_documento': return invoice.status !== 'anulada' && !hasOriginal;
    case 'archivada': return invoice.status === 'archivada';
    case 'anulada': return invoice.status === 'anulada';
  }
}

/** Los `?filtro=` de siempre (Inicio, Gestoría, otras apps) y su buzón. */
export function mailboxFromFilter(filter: string): { box: Mailbox; pill: ResolvePill | null } | null {
  const map: Record<string, { box: Mailbox; pill: ResolvePill | null }> = {
    pendiente_datos: { box: 'por_resolver', pill: 'sin_datos' },
    pendiente_revision: { box: 'por_resolver', pill: 'por_revisar' },
    por_resolver: { box: 'por_resolver', pill: null },
    sin_pagar: { box: 'sin_pagar', pill: null },
    validada: { box: 'validadas', pill: null },
    activas: { box: 'todas', pill: null },
    drive: { box: 'drive', pill: null },
    rect_sin_enlazar: { box: 'rect_sin_enlazar', pill: null },
    sin_documento: { box: 'sin_documento', pill: null },
    archivada: { box: 'archivada', pill: null },
    anulada: { box: 'anulada', pill: null },
  };
  return map[filter] ?? null;
}

// ---------------------------------------------------------------------------
// Grupos por proveedor
// ---------------------------------------------------------------------------
export interface WorkRow<T extends WorkInvoice = WorkInvoice> { invoice: T; state: WorkState }
export interface SupplierGroup<T extends WorkInvoice = WorkInvoice> {
  supplierId: string;
  rows: WorkRow<T>[];
  tone: Tone | null;
  overdue: number;
  toResolve: number;
  unpaid: number;
  /** Total de las facturas del grupo (sin anuladas). */
  total: number;
}

const num = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v));

/**
 * Agrupa por proveedor: primero los que piden algo (vencidas, por resolver, sin pagar), después por nombre. Dentro, por
 * fecha, de la más nueva a la más antigua (la fecha se ve en cada factura).
 */
export function supplierGroups<T extends WorkInvoice>(rows: WorkRow<T>[], nameOf: (supplierId: string) => string): SupplierGroup<T>[] {
  const by = new Map<string, WorkRow<T>[]>();
  for (const r of rows) by.set(r.invoice.supplier_id, [...(by.get(r.invoice.supplier_id) ?? []), r]);
  const groups = [...by.entries()].map(([supplierId, list]) => {
    const live = list.filter((r) => r.invoice.status !== 'anulada');
    return {
      supplierId,
      rows: list.sort((a, b) => (b.invoice.invoice_date ?? '').localeCompare(a.invoice.invoice_date ?? '')),
      tone: list.reduce<Tone | null>((t, r) => worse(t, r.state.tone === 'ok' ? null : r.state.tone), null) ?? (live.length ? 'ok' : null),
      overdue: live.filter((r) => r.state.pay.kind === 'overdue').length,
      toResolve: live.filter((r) => r.invoice.status === 'pendiente_datos' || r.invoice.status === 'pendiente_revision').length,
      unpaid: Math.round(live.filter((r) => r.invoice.payment_status === 'pendiente').reduce((s, r) => s + num(r.invoice.calculated_total) * 100, 0)) / 100,
      total: Math.round(live.reduce((s, r) => s + num(r.invoice.calculated_total) * 100, 0)) / 100,
    };
  });
  return groups.sort((a, b) => b.overdue - a.overdue || b.toResolve - a.toResolve || Number(b.unpaid > 0) - Number(a.unpaid > 0)
    || nameOf(a.supplierId).localeCompare(nameOf(b.supplierId), 'es'));
}

/** «2 por resolver · 1 vencida · Sin pagar 899,37 €», o «Al día». */
export function groupSummary(group: SupplierGroup, money: (n: number) => string): string {
  const parts = [
    group.toResolve ? `${group.toResolve} por resolver` : null,
    group.overdue ? (group.overdue === 1 ? '1 vencida' : `${group.overdue} vencidas`) : null,
    group.unpaid > 0 ? `Sin pagar ${money(group.unpaid)}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Al día';
}

// ---------------------------------------------------------------------------
// Inicio: una a una
// ---------------------------------------------------------------------------
/** La cola de Inicio: las por resolver, primero las listas para confirmar, después las que piden algo; las más antiguas antes. */
export function homeQueue<T extends WorkInvoice>(rows: WorkRow<T>[]): WorkRow<T>[] {
  const order = (r: WorkRow<T>) => (r.state.ready ? 0 : r.invoice.status === 'pendiente_revision' ? 1 : 2);
  return rows.filter((r) => r.invoice.status === 'pendiente_datos' || r.invoice.status === 'pendiente_revision')
    .sort((a, b) => order(a) - order(b) || (a.invoice.invoice_date ?? '9999').localeCompare(b.invoice.invoice_date ?? '9999') || a.invoice.id.localeCompare(b.invoice.id));
}
