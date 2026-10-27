/**
 * Ingresos y gastos de otras apps (0244, API.md §17): lo que pintan «Ingresos y gastos de apps», la vista «Evento» y la
 * baldosa de Inicio. Sin DOM: se prueba con node (tests/invoices/app-entries-state.test.ts).
 *
 * El resultado de un evento va **sin IVA**, porque lo asignado de las facturas es base:
 * - ingresos: los apuntes de ingreso de apps con ese `event_id` y lo asignado al evento de las emitidas registradas;
 * - gastos: lo asignado al evento de las facturas recibidas validadas o archivadas, y los apuntes de gasto de apps;
 * - las recibidas asignadas que aún no están validadas no cuentan, pero se dicen.
 */

export interface EntryLike {
  id: string;
  source_app: string;
  source_ref: string;
  kind: 'income' | 'expense';
  /** 0245: sin valor (filas antiguas en el dispositivo), fiscal. */
  nature?: 'fiscal' | 'process';
  entry_date: string;
  description: string;
  amount_cents: number;
  net_cents: number;
  tax_cents: number;
  tax_rate: number;
  event_id: string | null;
  deleted_at: string | null;
}

export interface AllocationLike { id: string; invoice_line_id: string; target_app: string; target_kind: string; target_id: string | null; target_label: string | null; allocated_amount: number; deleted_at: string | null }
export interface LineLike { id: string; invoice_id: string; deleted_at: string | null }
export interface InvoiceLike { id: string; code: string | null; status: string; object: string | null; invoice_date: string | null; supplier_id: string; deleted_at: string | null }
export interface IssuedAllocationLike { id: string; issued_invoice_id: string; target_app: string; target_kind: string; target_id: string | null; target_label: string | null; allocated_amount: number; deleted_at: string | null }
export interface IssuedLike { id: string; full_number: string | null; status: string; description: string | null; issue_date: string | null; deleted_at: string | null }

export interface EventSources {
  entries: EntryLike[];
  allocations: AllocationLike[];
  lines: LineLike[];
  invoices: InvoiceLike[];
  issuedAllocations: IssuedAllocationLike[];
  issued: IssuedLike[];
}

export interface EventMove { kind: 'app' | 'invoice' | 'issued'; id: string; date: string | null; title: string; cents: number; sign: 1 | -1; /** Apunte de proceso (informativo). */ process?: boolean }

export interface EventResult {
  eventId: string;
  /** Rótulo guardado en las asignaciones («Retiro de octubre · 2026-10-30»); null si solo hay apuntes de apps. */
  label: string | null;
  incomeCents: number;
  expenseCents: number;
  resultCents: number;
  /** Desglose de las cuatro fuentes, en céntimos sin IVA. */
  appIncomeCents: number; issuedIncomeCents: number; invoiceExpenseCents: number; appExpenseCents: number;
  /** Recibidas asignadas al evento todavía sin validar: no cuentan. */
  pendingInvoices: number;
  moves: EventMove[];
}

const APP_NAMES: Record<string, string> = { flow: 'Flow', tasks: 'Tasks', food: 'Food', booking: 'Booking', central: 'Central', guests: 'Guests', organizers: 'Organizers' };
export const appName = (id: string): string => APP_NAMES[id] ?? (id ? id[0]!.toUpperCase() + id.slice(1) : '');

const cents = (euros: number | null | undefined): number => Math.round(Number(euros ?? 0) * 100);
const isEvent = <T extends { target_app: string; target_kind: string; target_id: string | null; deleted_at: string | null }>(a: T): a is T & { target_id: string } =>
  !a.deleted_at && a.target_app === 'booking' && a.target_kind === 'event' && !!a.target_id;
const COUNTED_RECEIVED = new Set(['validada', 'archivada']);
const COUNTED_ISSUED = new Set(['registrada', 'emitida', 'rectificada']);

export const liveEntries = <T extends EntryLike>(entries: T[]): T[] => entries.filter((e) => !e.deleted_at);
/** Fiscal (va a la gestoría y tiene justificante) o de proceso (informativo). Sin valor, fiscal. */
export const isFiscal = (e: { nature?: string | null }): boolean => (e.nature ?? 'fiscal') === 'fiscal';

/** Todos los eventos con algo (apuntes de apps o asignaciones), el más reciente primero. */
export function eventResults(src: EventSources): EventResult[] {
  const byId = new Map<string, EventResult>();
  const of = (eventId: string, label: string | null): EventResult => {
    let r = byId.get(eventId);
    if (!r) {
      r = { eventId, label: null, incomeCents: 0, expenseCents: 0, resultCents: 0, appIncomeCents: 0, issuedIncomeCents: 0, invoiceExpenseCents: 0, appExpenseCents: 0, pendingInvoices: 0, moves: [] };
      byId.set(eventId, r);
    }
    if (!r.label && label) r.label = label;
    return r;
  };
  for (const e of liveEntries(src.entries)) {
    if (!e.event_id) continue;
    const r = of(e.event_id, null);
    if (e.kind === 'income') r.appIncomeCents += e.net_cents; else r.appExpenseCents += e.net_cents;
    r.moves.push({ kind: 'app', id: e.id, date: e.entry_date, title: `${e.description} · ${appName(e.source_app)}`, cents: e.net_cents, sign: e.kind === 'income' ? 1 : -1, process: !isFiscal(e) });
  }
  const lineById = new Map(src.lines.filter((l) => !l.deleted_at).map((l) => [l.id, l]));
  const invoiceById = new Map(src.invoices.filter((i) => !i.deleted_at).map((i) => [i.id, i]));
  const pendingSeen = new Map<string, Set<string>>();
  for (const a of src.allocations) {
    if (!isEvent(a)) continue;
    const invoice = invoiceById.get(lineById.get(a.invoice_line_id)?.invoice_id ?? '');
    if (!invoice || invoice.status === 'anulada') continue;
    const r = of(a.target_id, a.target_label);
    if (!COUNTED_RECEIVED.has(invoice.status)) {
      const seen = pendingSeen.get(a.target_id) ?? new Set<string>();
      if (!seen.has(invoice.id)) { seen.add(invoice.id); r.pendingInvoices += 1; }
      pendingSeen.set(a.target_id, seen);
      continue;
    }
    const amount = cents(a.allocated_amount);
    r.invoiceExpenseCents += amount;
    const existing = r.moves.find((m) => m.kind === 'invoice' && m.id === invoice.id);
    if (existing) existing.cents += amount;
    else r.moves.push({ kind: 'invoice', id: invoice.id, date: invoice.invoice_date, title: [invoice.code, invoice.object].filter(Boolean).join(' · ') || 'Factura recibida', cents: amount, sign: -1 });
  }
  const issuedById = new Map(src.issued.filter((i) => !i.deleted_at).map((i) => [i.id, i]));
  for (const a of src.issuedAllocations) {
    if (!isEvent(a)) continue;
    const issued = issuedById.get(a.issued_invoice_id);
    if (!issued || !COUNTED_ISSUED.has(issued.status)) continue;
    const r = of(a.target_id, a.target_label);
    const amount = cents(a.allocated_amount);
    r.issuedIncomeCents += amount;
    const existing = r.moves.find((m) => m.kind === 'issued' && m.id === issued.id);
    if (existing) existing.cents += amount;
    else r.moves.push({ kind: 'issued', id: issued.id, date: issued.issue_date, title: [issued.full_number, issued.description].filter(Boolean).join(' · ') || 'Factura emitida', cents: amount, sign: 1 });
  }
  for (const r of byId.values()) {
    r.incomeCents = r.appIncomeCents + r.issuedIncomeCents;
    r.expenseCents = r.invoiceExpenseCents + r.appExpenseCents;
    r.resultCents = r.incomeCents - r.expenseCents;
    r.moves.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || b.sign - a.sign || a.title.localeCompare(b.title, 'es'));
  }
  const last = (r: EventResult) => r.moves.reduce((max, m) => ((m.date ?? '') > max ? (m.date ?? '') : max), '');
  return [...byId.values()].sort((a, b) => last(b).localeCompare(last(a)) || a.eventId.localeCompare(b.eventId));
}

/** Cifras de la lista y de la baldosa (con IVA): ingresos y gastos (todos), lo fiscal, lo de proceso y lo que no tiene evento. */
export function entriesTotals(entries: EntryLike[]): { count: number; incomeCents: number; expenseCents: number; fiscalIncomeCents: number; process: number; withoutEvent: number } {
  const live = liveEntries(entries);
  const sum = (list: EntryLike[], kind: EntryLike['kind']) => list.filter((e) => e.kind === kind).reduce((n, e) => n + Number(e.amount_cents), 0);
  return { count: live.length, incomeCents: sum(live, 'income'), expenseCents: sum(live, 'expense'), fiscalIncomeCents: sum(live.filter(isFiscal), 'income'),
    process: live.filter((e) => !isFiscal(e)).length, withoutEvent: live.filter((e) => !e.event_id).length };
}

/** ¿Está el apunte en una entrega ya entregada a la gestoría? (misma regla que `invoices.app_entry_delivered`). */
export function entryDelivered(entryId: string, exports: Array<{ status: string; deleted_at: string | null; manifest?: { app_entries?: Array<{ id: string }> } | null }>): boolean {
  return exports.some((e) => !e.deleted_at && e.status === 'entregada' && (e.manifest?.app_entries ?? []).some((x) => x.id === entryId));
}

/** Resumen del periodo en euros, la misma cuenta que `invoices.app_entries_summary_for` (0245): solo lo fiscal; lo de proceso, aparte. */
export function appEntriesSummary(entries: EntryLike[], range: { from: string; to: string }): {
  income: { count: number; base: number; quota: number; total: number; quota_by_rate: Array<{ rate: number; base: number; quota: number }> };
  expense: { count: number; base: number; quota: number; total: number };
  process: { count: number; income: number; expense: number };
} {
  const inRange = liveEntries(entries).filter((e) => e.entry_date >= range.from && e.entry_date <= range.to);
  const live = inRange.filter(isFiscal);
  const proc = inRange.filter((e) => !isFiscal(e));
  const sum = (list: EntryLike[], k: 'net_cents' | 'tax_cents' | 'amount_cents') => list.reduce((n, e) => n + Number(e[k]), 0) / 100;
  const inc = live.filter((e) => e.kind === 'income');
  const exp = live.filter((e) => e.kind === 'expense');
  const rates = new Map<number, EntryLike[]>();
  for (const e of inc) rates.set(Number(e.tax_rate), [...(rates.get(Number(e.tax_rate)) ?? []), e]);
  return {
    income: { count: inc.length, base: sum(inc, 'net_cents'), quota: sum(inc, 'tax_cents'), total: sum(inc, 'amount_cents'),
      quota_by_rate: [...rates.entries()].sort(([a], [b]) => a - b).map(([rate, list]) => ({ rate, base: sum(list, 'net_cents'), quota: sum(list, 'tax_cents') })) },
    expense: { count: exp.length, base: sum(exp, 'net_cents'), quota: sum(exp, 'tax_cents'), total: sum(exp, 'amount_cents') },
    process: { count: proc.length, income: sum(proc.filter((e) => e.kind === 'income'), 'amount_cents'), expense: sum(proc.filter((e) => e.kind === 'expense'), 'amount_cents') },
  };
}
