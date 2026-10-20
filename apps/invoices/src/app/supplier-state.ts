/**
 * Lo que se le debe a cada proveedor (tanda 27, MUELA-070 «Proveedores» y MUELA-023 «extracto»). Proyección pura de sus
 * facturas; sin dependencias (se prueba con node).
 * - «Le debes»: las no anuladas con el pago pendiente. Lo «pagado sin confirmar» cuenta como pagado (decisión de VG) y
 *   se avisa con «n por confirmar».
 * - El extracto: lo próximo (pendientes, por vencimiento) y los movimientos del año (facturas y pagos) con lo que queda
 *   tras cada uno. Un pago sin fecha sale como «pago sin fecha».
 */
import { daysBetween, dayMonth, type Tone } from './work-state.ts';

export interface SupplierInvoice {
  id: string;
  code: string | null;
  object: string;
  status: string;
  invoice_date: string | null;
  due_date: string | null;
  payment_status: string;
  payment_source?: string | null;
  paid_at: string | null;
  calculated_total: number | string | null;
  deleted_at?: string | null;
}

export interface SupplierDebt { owed: number; overdue: number; unconfirmed: number; toResolve: number; yearTotal: number; tone: Tone | null; text: string }

const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);
const live = (i: SupplierInvoice) => !i.deleted_at && i.status !== 'anulada';

export function supplierDebt(invoices: SupplierInvoice[], today: string, money: (n: number) => string): SupplierDebt {
  const mine = invoices.filter(live);
  const pending = mine.filter((i) => i.payment_status === 'pendiente');
  const owed = pending.reduce((s, i) => s + cents(i.calculated_total), 0) / 100;
  const overdue = pending.filter((i) => i.due_date && daysBetween(today, i.due_date) < 0).length;
  const unconfirmed = mine.filter((i) => i.payment_status === 'pagada' && i.payment_source === 'sin_confirmar').length;
  const toResolve = mine.filter((i) => i.status === 'pendiente_datos' || i.status === 'pendiente_revision').length;
  const yearTotal = mine.filter((i) => (i.invoice_date ?? '').slice(0, 4) === today.slice(0, 4)).reduce((s, i) => s + cents(i.calculated_total), 0) / 100;
  const parts = [
    owed > 0.004 ? `Le debes ${money(owed)}` : 'Al día',
    overdue ? (overdue === 1 ? '1 vencida' : `${overdue} vencidas`) : null,
    unconfirmed ? `${unconfirmed} por confirmar` : null,
    toResolve ? `${toResolve} por resolver` : null,
  ].filter(Boolean);
  const tone: Tone | null = overdue ? 'alert' : toResolve || unconfirmed ? 'warn' : owed > 0.004 ? 'warn' : 'ok';
  return { owed, overdue, unconfirmed, toResolve, yearTotal, tone, text: parts.join(' · ') };
}

export interface StatementMove { id: string; date: string | null; label: string; meta: string; amount: number; kind: 'in' | 'doc' | 'due'; chip: { text: string; tone: Tone | null } | null; invoiceId: string }

/** Lo próximo: las pendientes, primero las vencidas y después por vencimiento. */
export function upcomingOf(invoices: SupplierInvoice[], today: string): StatementMove[] {
  return invoices.filter((i) => live(i) && i.payment_status === 'pendiente')
    .sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || (a.invoice_date ?? '').localeCompare(b.invoice_date ?? ''))
    .map((i) => {
      const left = i.due_date ? daysBetween(today, i.due_date) : null;
      return { id: `due-${i.id}`, date: i.due_date, label: `${i.code ?? 'Factura'} · ${i.object}`, invoiceId: i.id, amount: Number(i.calculated_total ?? 0), kind: 'due' as const,
        meta: left === null ? 'sin vencimiento' : left < 0 ? `vencida hace ${-left === 1 ? '1 día' : `${-left} días`}` : left === 0 ? 'vence hoy' : `vence el ${dayMonth(i.due_date!)}`,
        chip: left !== null && left < 0 ? { text: 'Vencida', tone: 'alert' as Tone } : { text: 'Pendiente', tone: 'warn' as Tone } };
    });
}

/** Movimientos del año: cada factura (suma) y cada pago (resta), en orden, con lo que queda tras cada uno. */
export function movesOf(invoices: SupplierInvoice[], year: string, money: (n: number) => string): StatementMove[] {
  type Event = { date: string; order: number; move: Omit<StatementMove, 'meta'>; delta: number };
  const events: Event[] = [];
  for (const i of invoices.filter(live)) {
    if (i.invoice_date && i.invoice_date.slice(0, 4) === year) {
      events.push({ date: i.invoice_date, order: 0, delta: cents(i.calculated_total), move: { id: `doc-${i.id}`, date: i.invoice_date, label: `${i.code ?? 'Factura'} · ${i.object}`, invoiceId: i.id, amount: Number(i.calculated_total ?? 0), kind: 'doc', chip: null } });
    }
    if (i.payment_status === 'pagada' && (i.paid_at ?? i.invoice_date ?? '').slice(0, 4) === year) {
      const unconfirmed = i.payment_source === 'sin_confirmar';
      events.push({ date: i.paid_at ?? i.invoice_date ?? `${year}-12-31`, order: 1, delta: -cents(i.calculated_total), move: { id: `in-${i.id}`, date: i.paid_at, label: i.paid_at ? `Pago de ${i.code ?? 'la factura'}` : `Pago sin fecha de ${i.code ?? 'la factura'}`, invoiceId: i.id,
        amount: Number(i.calculated_total ?? 0), kind: 'in', chip: unconfirmed ? { text: 'Sin confirmar', tone: 'warn' } : { text: 'Pagado', tone: 'ok' } } });
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);
  let balance = 0;
  return events.map((e) => { balance += e.delta; return { ...e.move, meta: `${dayMonth(e.date)} · quedan ${money(Math.max(0, balance) / 100)}` }; });
}
