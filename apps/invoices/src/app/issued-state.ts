/**
 * Estado de trabajo de las emitidas (tanda 27, MUELA-070 «Emitidas»): proyección pura de `status`, `payment_status`,
 * `sent_at` (0240) y las entregas, sin estado nuevo. Sin dependencias (se prueba con node).
 * - Recorrido: Emitida · Enviada · Por cobrar · Cobrada · En gestoría. Sin `sent_at`, se queda en «Emitida · sin enviar».
 *   Borrador y anulada: parado.
 * - La antigüedad («más de 30 días») cuenta desde el envío o, si no se envió, desde la emisión. Una emitida no tiene
 *   vencimiento en Finance: no se dice «vencida».
 * - Buzones: Por cobrar · Cobradas · Borradores · Todas (sin anuladas) · Más (Anuladas, Revisar importes).
 * - Lo que debe cada cliente, con la regla de `reservationCollected` (0222): sin borradores ni anuladas, las rectificativas
 *   restan.
 */
import { daysBetween, dayMonth, worse, type Tone } from './work-state.ts';

export interface IssuedWork {
  id: string;
  status: string;
  payment_status: string | null;
  paid_at: string | null;
  payment_method?: string | null;
  sent_at?: string | null;
  issue_date: string;
  total: number | string | null;
  invoice_type: string;
  review_reason?: string | null;
  recipient_name?: string | null;
  recipient_tax_id?: string | null;
}

export const ISSUED_STAGES = [
  { key: 'emitida', label: 'Emitida' },
  { key: 'enviada', label: 'Enviada' },
  { key: 'por_cobrar', label: 'Por cobrar' },
  { key: 'cobrada', label: 'Cobrada' },
  { key: 'gestoria', label: 'En gestoría' },
] as const;
export type IssuedStage = (typeof ISSUED_STAGES)[number]['key'];

/** Más de estos días sin cobrar es «antigua». */
export const OLD_DAYS = 30;
const num = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const live = (i: IssuedWork) => i.status !== 'borrador' && i.status !== 'anulada';

export interface IssuedState { stage: IssuedStage | null; bad: IssuedStage[]; caption: string; tone: Tone | null; old: boolean; unsent: boolean; owed: number }

export function issuedState(invoice: IssuedWork, inExport: boolean, today: string, methodLabel: (m: string) => string = (m) => m): IssuedState {
  if (invoice.status === 'borrador') return { stage: null, bad: [], caption: 'Borrador sin número: se numera al emitir.', tone: 'warn', old: false, unsent: false, owed: 0 };
  if (invoice.status === 'anulada') return { stage: null, bad: [], caption: 'Anulada: fuera de los resúmenes.', tone: null, old: false, unsent: false, owed: 0 };
  const total = num(invoice.total);
  if (invoice.payment_status === 'cobrada') {
    const parts = [invoice.paid_at ? `cobrada el ${dayMonth(invoice.paid_at)}` : 'cobrada', invoice.payment_method ? methodLabel(invoice.payment_method) : null].filter(Boolean);
    return { stage: inExport ? 'gestoria' : 'cobrada', bad: [], caption: `${inExport ? 'En gestoría · ' : ''}${cap(parts.join(' · '))}`, tone: 'ok', old: false, unsent: false, owed: 0 };
  }
  // Una rectificativa que resta no se cobra: se descuenta de lo que debe el cliente
  if (total <= 0) return { stage: inExport ? 'gestoria' : 'cobrada', bad: [], caption: `Rectificativa: resta de lo que te deben${inExport ? ' · en gestoría' : ''}`, tone: 'ok', old: false, unsent: false, owed: total };
  const sent = invoice.sent_at ?? null;
  const age = daysBetween(sent ?? invoice.issue_date, today);
  const old = age > OLD_DAYS;
  const bad: IssuedStage[] = [];
  let tone: Tone | null = 'warn';
  let caption: string;
  if (sent) caption = `Por cobrar · enviada ${age <= 0 ? 'hoy' : `hace ${age === 1 ? '1 día' : `${age} días`}`}`;
  else { caption = `Emitida · sin enviar${age > 0 ? ` (emitida hace ${age === 1 ? '1 día' : `${age} días`})` : ''}`; bad.push('enviada'); }
  if (old) { bad.push('por_cobrar'); tone = worse(tone, 'alert'); caption += ` · más de ${OLD_DAYS} días`; }
  if (invoice.review_reason === 'REVISAR IMPORTES') { caption += ' · revisa los importes'; tone = 'alert'; }
  return { stage: sent ? 'por_cobrar' : 'emitida', bad, caption, tone, old, unsent: !sent, owed: total };
}
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export const ISSUED_BOXES = [
  { key: 'por_cobrar', label: 'Por cobrar' },
  { key: 'cobradas', label: 'Cobradas' },
  { key: 'borradores', label: 'Borradores' },
  { key: 'todas', label: 'Todas' },
] as const;
export const MORE_ISSUED_BOXES = [{ key: 'anulada', label: 'Anuladas' }, { key: 'revisar', label: 'Revisar importes' }] as const;
export type IssuedBox = (typeof ISSUED_BOXES)[number]['key'] | (typeof MORE_ISSUED_BOXES)[number]['key'];

export function inIssuedBox(box: IssuedBox, i: IssuedWork): boolean {
  switch (box) {
    case 'por_cobrar': return live(i) && i.payment_status !== 'cobrada' && num(i.total) > 0;
    case 'cobradas': return live(i) && i.payment_status === 'cobrada';
    case 'borradores': return i.status === 'borrador';
    case 'todas': return i.status !== 'anulada';
    case 'anulada': return i.status === 'anulada';
    case 'revisar': return live(i) && i.review_reason === 'REVISAR IMPORTES';
  }
}
/** El filtro de antes (`#issuedFilter`) y su buzón. */
export function issuedBoxFromFilter(filter: string): IssuedBox | null {
  return ({ activas: 'todas', borradores: 'borradores', anulada: 'anulada', pendientes: 'por_cobrar', revisar: 'revisar', por_cobrar: 'por_cobrar', cobradas: 'cobradas', todas: 'todas' } as Record<string, IssuedBox>)[filter] ?? null;
}

export interface ClientGroup<R extends { invoice: IssuedWork; state: IssuedState }> { key: string; name: string; rows: R[]; owed: number; old: number; drafts: number; tone: Tone | null }

/** Clave del cliente: su NIF o, sin NIF, su nombre. */
export function clientKey(i: IssuedWork): string {
  return (i.recipient_tax_id?.trim().toUpperCase() || i.recipient_name?.trim().toLowerCase() || '—');
}

/** Por cliente: primero lo que más debe; dentro, por fecha, de la más nueva a la más antigua. */
export function clientGroups<R extends { invoice: IssuedWork; state: IssuedState }>(rows: R[]): ClientGroup<R>[] {
  const by = new Map<string, R[]>();
  for (const r of rows) by.set(clientKey(r.invoice), [...(by.get(clientKey(r.invoice)) ?? []), r]);
  return [...by.entries()].map(([key, list]) => ({
    key,
    name: list.find((r) => r.invoice.recipient_name)?.invoice.recipient_name ?? 'Sin destinatario',
    rows: list.sort((a, b) => b.invoice.issue_date.localeCompare(a.invoice.issue_date)),
    owed: Math.round(list.reduce((s, r) => s + r.state.owed * 100, 0)) / 100,
    old: list.filter((r) => r.state.old).length,
    drafts: list.filter((r) => r.invoice.status === 'borrador').length,
    tone: list.reduce<Tone | null>((t, r) => worse(t, r.state.tone === 'ok' ? null : r.state.tone), null),
  })).sort((a, b) => b.owed - a.owed || b.old - a.old || a.name.localeCompare(b.name, 'es'));
}

/** «Te debe 5.376,00 € · 1 de más de 30 días · 1 borrador», o «Al día». */
export function clientSummary(g: ClientGroup<{ invoice: IssuedWork; state: IssuedState }>, money: (n: number) => string): string {
  const parts = [
    g.owed > 0.004 ? `Te debe ${money(g.owed)}` : null,
    g.old ? `${g.old} de más de ${OLD_DAYS} días` : null,
    g.drafts ? (g.drafts === 1 ? '1 borrador' : `${g.drafts} borradores`) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Al día';
}
