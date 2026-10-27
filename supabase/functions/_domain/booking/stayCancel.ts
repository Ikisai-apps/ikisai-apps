/**
 * Política de cancelación de las noches pagadas en línea (VG, vg-38; migración 1419): se devuelve el 100 % hasta 7 días
 * antes de la llegada, la mitad hasta 48 h antes y nada después. Si la casa cancela el evento, siempre el 100 %.
 * La llegada cuenta desde las 00:00 (Europe/Madrid) del primer día. La base hace el mismo cálculo
 * (`booking.stay_cancel_quote_of`); esto es para que recepción vea la propuesta sin preguntar.
 */
export type StayCancelTier = 'full' | 'half' | 'none' | 'event_cancelled';

export function stayCancelPercent(fromDate: string, now: Date = new Date(), eventCancelled = false): { percent: 0 | 50 | 100; tier: StayCancelTier } {
  if (eventCancelled) return { percent: 100, tier: 'event_cancelled' };
  const arrival = madridMidnight(fromDate);
  const hoursLeft = (arrival - now.getTime()) / 3_600_000;
  if (hoursLeft >= 7 * 24) return { percent: 100, tier: 'full' };
  if (hoursLeft >= 48) return { percent: 50, tier: 'half' };
  return { percent: 0, tier: 'none' };
}

/** Lo que toca devolver de lo pagado, descontando lo ya devuelto (nunca negativo). */
export function stayCancelRefund(paidCents: number, alreadyRefundedCents: number, percent: number): number {
  return Math.max(0, Math.floor((paidCents * percent) / 100) - alreadyRefundedCents);
}

/** Las 00:00 de ese día en Madrid, en milisegundos (sin librerías: horario de verano europeo). */
function madridMidnight(day: string): number {
  const [y, m, d] = day.slice(0, 10).split('-').map(Number) as [number, number, number];
  const utc = Date.UTC(y, m - 1, d);
  // horario de verano: del último domingo de marzo al último domingo de octubre (cambio a la 01:00 UTC)
  const lastSunday = (month: number) => { const last = new Date(Date.UTC(y, month + 1, 0)); return Date.UTC(y, month, last.getUTCDate() - last.getUTCDay()); };
  const summer = utc > lastSunday(2) && utc <= lastSunday(9);
  return utc - (summer ? 2 : 1) * 3_600_000;
}
