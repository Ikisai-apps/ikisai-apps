/**
 * «Arqueo del día» (encargo de VG por Core, 27-10, para el sábado): lo cobrado en el día por medio de cobro, sumando la
 * barra y la caja (Flow) y el alojamiento de recepción (Booking), con las devoluciones aparte y el total a cuadrar en
 * caja. Sin DOM ni dependencias: se prueba con node (tests/invoices/cash-count.test.ts).
 *
 * De dónde sale cada cifra (apuntes de ingreso de apps de ese día, fiscales y de proceso):
 * - un importe positivo en `methods` es lo cobrado con ese medio;
 * - uno negativo es lo devuelto con ese medio (así manda Booking una devolución, 1403): va aparte, no se resta a escondidas;
 * - `pending_refunds_cents` de Flow son devoluciones aún por hacer: se enseñan como aviso, no están en caja;
 * - el cierre del día de Flow ya no lleva lo enviado antes como cobro fiscal (Core/Finance, 27-10), así que nada se cuenta dos veces.
 * Lo que va a caja es el neto por medio; el efectivo que tiene que haber es el neto en metálico.
 */
import { methodLabel } from './day-receipt.ts';

export interface CashEntry {
  id: string;
  source_app: string;
  source_ref: string;
  kind: 'income' | 'expense';
  entry_date: string;
  amount_cents: number;
  pending_refunds_cents?: number | null;
  methods: Record<string, number> | null;
  deleted_at: string | null;
}

export interface CashMethod { key: string; label: string; collectedCents: number; refundedCents: number; netCents: number }
export interface CashSource { key: 'bar' | 'stay' | 'other'; label: string; count: number; netCents: number }

export interface CashCount {
  day: string;
  methods: CashMethod[];
  sources: CashSource[];
  collectedCents: number;
  refundedCents: number;
  /** Total a cuadrar en caja: cobrado menos devuelto, todos los medios. */
  netCents: number;
  /** El efectivo que tiene que haber (neto en metálico). */
  cashCents: number;
  /** Devoluciones anotadas en la barra que aún no se han hecho (no salen de caja todavía). */
  pendingRefundsCents: number;
  /** Cobros del día que entran en el arqueo. Los que llegan sin medios de cobro van a «Sin medio». */
  entries: number;
}

const ORDER = ['cash', 'bizum', 'card', 'bitcoin', 'transfer'];
const SOURCE_LABELS: Record<CashSource['key'], string> = { bar: 'Barra y caja (Flow)', stay: 'Alojamiento en recepción', other: 'Otros cobros de apps' };

const sourceOf = (e: CashEntry): CashSource['key'] => (e.source_app === 'flow' ? 'bar' : e.source_ref.startsWith('booking:stay:') ? 'stay' : 'other');

export function dayCashCount(entries: CashEntry[], day: string): CashCount {
  const of = entries.filter((e) => !e.deleted_at && e.kind === 'income' && e.entry_date === day);
  const byMethod = new Map<string, CashMethod>();
  const method = (key: string) => {
    let m = byMethod.get(key);
    if (!m) { m = { key, label: key === 'none' ? 'Sin medio' : methodLabel(key), collectedCents: 0, refundedCents: 0, netCents: 0 }; byMethod.set(key, m); }
    return m;
  };
  const sources = new Map<CashSource['key'], CashSource>();
  let pendingRefundsCents = 0;
  for (const e of of) {
    const list = Object.entries(e.methods ?? {}).map(([k, v]) => [k, Number(v) || 0] as const).filter(([, v]) => v !== 0);
    if (!list.length) {
      // Sin medios: el importe entero, sin saber cómo se cobró
      const m = method('none');
      if (e.amount_cents >= 0) m.collectedCents += Number(e.amount_cents); else m.refundedCents += -Number(e.amount_cents);
    }
    for (const [k, v] of list) {
      const m = method(k);
      if (v > 0) m.collectedCents += v; else m.refundedCents += -v;
    }
    const sk = sourceOf(e);
    const s = sources.get(sk) ?? { key: sk, label: SOURCE_LABELS[sk], count: 0, netCents: 0 };
    s.count += 1; s.netCents += Number(e.amount_cents);
    sources.set(sk, s);
    pendingRefundsCents += Number(e.pending_refunds_cents ?? 0);
  }
  const methods = [...byMethod.values()].map((m) => ({ ...m, netCents: m.collectedCents - m.refundedCents }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.label.localeCompare(b.label, 'es'));
  const collectedCents = methods.reduce((n, m) => n + m.collectedCents, 0);
  const refundedCents = methods.reduce((n, m) => n + m.refundedCents, 0);
  return {
    day, methods, sources: (['bar', 'stay', 'other'] as const).map((k) => sources.get(k)).filter((s): s is CashSource => !!s),
    collectedCents, refundedCents, netCents: collectedCents - refundedCents,
    cashCents: methods.find((m) => m.key === 'cash')?.netCents ?? 0,
    pendingRefundsCents, entries: of.length,
  };
}

function rank(key: string): number {
  const i = ORDER.indexOf(key);
  return key === 'none' ? 99 : i === -1 ? 50 : i;
}
