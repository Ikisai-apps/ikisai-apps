/**
 * Ikisai Central · revisión semanal de Dirección (C01, migración 1521; decisiones de VG del 27-10). Una revisión por semana
 * ISO; al cerrarla, la foto de los indicadores en crítico o en atención. La preparan el owner y los editores con el ámbito
 * `direccion`. Los OKR, después.
 */

export const WEEKLY_REVIEWS_TABLE = 'central.weekly_reviews';
export const WEEKLY_ITEMS_TABLE = 'central.weekly_review_items';
export const WEEKLY_STATUSES = ['abierta', 'cerrada'] as const;
export type WeeklyStatus = typeof WEEKLY_STATUSES[number];

/** ¿Prepara la revisión? El owner, o un editor con `scopes.direccion = true`. */
export function canPrepareReview(membership: { role: string; scopes?: unknown } | null | undefined): boolean {
  if (!membership) return false;
  if (membership.role === 'owner') return true;
  return membership.role === 'editor' && (membership.scopes as { direccion?: unknown } | null | undefined)?.direccion === true;
}

/** Semana ISO de una fecha `AAAA-MM-DD`: `2026-W44`. */
export function isoWeek(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // lunes = 0
  d.setUTCDate(d.getUTCDate() - day + 3); // el jueves de esa semana decide el año
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** «Semana 44 de 2026». */
export function formatWeek(week: string): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  return m ? `Semana ${Number(m[2])} de ${m[1]}` : week;
}

export interface WeeklyKpi { app: string; kpi: string; label: string; period: string; value: number | null; unit: string; target: number | null; state: string | null }

/** Lo que entra en la foto: los indicadores en crítico o en atención, primero los críticos y después por app y etiqueta. */
export function weeklySnapshot<T extends WeeklyKpi>(items: readonly T[]): T[] {
  const rank = (s: string | null) => (s === 'critico' ? 0 : 1);
  return items.filter((i) => i.state === 'critico' || i.state === 'atencion')
    .sort((a, b) => rank(a.state) - rank(b.state) || a.app.localeCompare(b.app) || a.label.localeCompare(b.label, 'es'));
}

/** La nota de la semana anterior para el mismo indicador (la última revisión cerrada antes de `week` que lo tenga). */
export function previousNote(reviews: ReadonlyArray<{ id: string; week: string; status: string }>, items: ReadonlyArray<{ review_id: string; kpi: string; note?: string | null }>, week: string, kpi: string): string | null {
  const before = reviews.filter((r) => r.status === 'cerrada' && r.week < week).sort((a, b) => b.week.localeCompare(a.week));
  for (const r of before) {
    const hit = items.find((i) => i.review_id === r.id && i.kpi === kpi && i.note?.trim());
    if (hit) return hit.note!.trim();
  }
  return null;
}
