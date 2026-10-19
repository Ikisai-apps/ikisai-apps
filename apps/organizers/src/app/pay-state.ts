/**
 * El extracto de Pagos (pasada única, zona 2). Puro, con prueba de Node: lo que queda por pagar, lo próximo (la señal y
 * el saldo que faltan) y los movimientos (cada factura y cada pago recibido), para `renderMoneyBreakdown` en modo
 * `statement` del kit.
 * - Lo pagado sale solo de Finance (`collected`); lo contratado, de Booking (`contract`). `balanceOf` no cambia.
 * - El saldo **nunca lleva fecha**: su plazo es interno de Ikisai (aclaración del usuario, 8-10-2026).
 * - Sin «Atrasado»: es una regla sin validar con Finance.
 * - Una factura cobrada sin `collected_at` no sale como pago (las cifras siguen bien). Una rectificativa nunca es un pago.
 * - Sin dependencias del navegador: los textos se traducen con el `t` que se pase y los importes y días, con `money` y `day`.
 */
import type { Contract, PortalInvoice, PortalMoney } from './api.ts';
import { balanceOf } from './quote.ts';

type Tr = (spanish: string, vars?: Record<string, string | number>) => string;

export interface StatementMove {
  id: string;
  date: string | null;
  label: string;
  /** Línea secundaria ya escrita; `purpose` es el concepto del cobro de la factura, para su rótulo. */
  meta: string;
  purpose?: PortalInvoice['purpose'];
  amount: number;
  kind: 'in' | 'doc' | 'due';
  chip: { text: string; tone: 'ok' | 'warn' } | null;
  /** La factura que abre la línea (solo en `doc`). */
  invoice?: PortalInvoice;
}

export interface Statement {
  hasContract: boolean;
  total: number;
  contracted: number;
  collected: number;
  upcoming: StatementMove[];
  moves: StatementMove[];
}

export interface StatementFormat {
  t: Tr;
  money: (n: number) => string;
  /** `YYYY-MM-DD` → «12 de marzo». */
  day: (date: string) => string;
}

const isRectification = (inv: PortalInvoice) => inv.type.startsWith('R');

export function statementOf(contract: Contract | null, m: PortalMoney, format: StatementFormat): Statement {
  const { t, money, day } = format;
  const collected = Number(m.totals.collected) || 0;
  const b = contract ? balanceOf(contract, collected) : null;
  const PURPOSE: Record<string, string> = { senal: t('Señal'), saldo: t('Saldo'), extras: t('Extras') };

  const upcoming: StatementMove[] = [];
  if (b) {
    let accumulated = 0;
    for (const d of b.due) {
      accumulated += d.amount;
      if (d.paid) continue;
      const pending = Math.max(0, Math.min(d.amount, Math.round((accumulated - collected) * 100) / 100));
      if (d.kind === 'senal') {
        const paidHere = Math.round((d.amount - pending) * 100) / 100;
        const meta = [d.date ? t('antes del {fecha}', { fecha: day(d.date) }) : null,
          paidHere > 0 ? t('Pagado {a} de {b}', { a: money(paidHere), b: money(d.amount) }) : null].filter(Boolean).join(' · ');
        upcoming.push({ id: 'senal', date: null, label: t('Señal'), meta, amount: pending, kind: 'due', chip: { text: t('Pendiente'), tone: 'warn' } });
      } else {
        // Nunca con fecha: si ya hay una factura de saldo sin cobrar, cuándo se envió; si no, cuándo llegará.
        const sent = m.invoices.filter((inv) => inv.purpose === 'saldo' && !inv.collected && !isRectification(inv)).sort((x, y) => y.issue_date.localeCompare(x.issue_date))[0];
        const meta = sent ? t('factura enviada el {fecha}', { fecha: day(sent.issue_date.slice(0, 10)) }) : t('cuando te llegue la factura');
        upcoming.push({ id: 'saldo', date: null, label: t('Saldo'), meta, amount: pending, kind: 'due', chip: { text: t('Pendiente'), tone: 'warn' } });
      }
    }
  }

  const moves: StatementMove[] = [];
  for (const inv of m.invoices) {
    const rect = isRectification(inv);
    moves.push({
      id: inv.id, date: inv.issue_date.slice(0, 10),
      label: rect ? t('Rectificativa {numero}', { numero: inv.number }) : t('Factura {numero}', { numero: inv.number }),
      meta: [day(inv.issue_date.slice(0, 10)), inv.rectifies?.length ? t('rectifica {numeros}', { numeros: inv.rectifies.join(', ') }) : null].filter(Boolean).join(' · '),
      purpose: inv.purpose ?? null, amount: Number(inv.total) || 0, kind: 'doc',
      chip: inv.collected ? { text: t('Cobrada'), tone: 'ok' } : { text: t('Pendiente'), tone: 'warn' }, invoice: inv,
    });
  }
  // Pagos recibidos, en orden de cobro para ir restando de lo contratado.
  const paid = m.invoices.filter((inv) => !isRectification(inv) && inv.collected && inv.collected_at)
    .sort((x, y) => x.collected_at!.localeCompare(y.collected_at!));
  let running = 0;
  for (const inv of paid) {
    const amount = Number(inv.total) || 0;
    running += amount;
    const purpose = inv.purpose ? PURPOSE[inv.purpose] : undefined;
    moves.push({
      id: `pago-${inv.id}`, date: inv.collected_at!.slice(0, 10),
      label: purpose ? t('Pago recibido · {concepto}', { concepto: purpose }) : t('Pago recibido'),
      meta: [day(inv.collected_at!.slice(0, 10)), b ? t('te quedan {importe}', { importe: money(Math.max(0, Math.round((b.contracted - running) * 100) / 100)) }) : null].filter(Boolean).join(' · '),
      amount, kind: 'in', chip: null,
    });
  }
  // De lo más reciente a lo más antiguo; el mismo día, el pago antes que su factura.
  moves.sort((x, y) => (y.date ?? '').localeCompare(x.date ?? '') || (x.kind === 'in' ? -1 : 0) - (y.kind === 'in' ? -1 : 0));

  return {
    hasContract: !!b,
    total: b ? b.balance : Number(m.totals.pending) || 0,
    contracted: b?.contracted ?? 0,
    collected,
    upcoming,
    moves,
  };
}
