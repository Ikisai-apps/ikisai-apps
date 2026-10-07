/**
 * Ikisai Central · dirección (C01; docs/central/API.md §7.2): contrato común de KPIs y su estado frente a objetivos.
 * Cada app publica `<schema>.central_kpi_projection` con las columnas de `KpiRow`; Central no copia datos: lee al abrir.
 */

export const KPI_TARGETS_TABLE = 'central.kpi_targets';

/** Apps que pueden publicar KPIs, en el orden del panel, con el nombre de su proyección. */
export const KPI_SOURCES: ReadonlyArray<{ app: string; projection: string }> = [
  { app: 'central', projection: 'central.central_kpi_projection' },
  { app: 'booking', projection: 'booking.central_kpi_projection' },
  { app: 'invoices', projection: 'invoices.central_kpi_projection' },
  { app: 'tasks', projection: 'tasks.central_kpi_projection' },
  { app: 'food', projection: 'food.central_kpi_projection' },
];

export const KPI_UNITS = ['count', 'pct', 'eur', 'days', 'persons', 'nights'] as const;
export type KpiUnit = typeof KPI_UNITS[number];

/** Fila del contrato `<schema>.central_kpi_projection`. */
export interface KpiRow {
  kpi: string;
  label: string;
  value: number | null;
  unit: KpiUnit | string;
  period: string;
  period_start: string | null;
  period_end: string | null;
  direction: 'up' | 'down' | null;
  link: string | null;
  computed_at: string;
}

export interface KpiTarget {
  kpi: string;
  period: string;
  target: number | null;
  warn_at: number | null;
  critical_at: number | null;
  direction: 'up' | 'down';
}

export type KpiState = 'ok' | 'atencion' | 'critico' | null;

/** Importes agregados del negocio (`unit = 'eur'`): solo owner y editor de Central (ronda 8 de Core); un lector ve el resto. */
export function canSeeKpi(unit: string, role: string): boolean {
  return unit !== 'eur' || role === 'owner' || role === 'editor';
}

/** Objetivo aplicable: el del periodo exacto, si no el del año del periodo, si no el general (`*`). */
export function targetFor(targets: readonly KpiTarget[], kpi: string, period: string): KpiTarget | null {
  const mine = targets.filter((t) => t.kpi === kpi);
  return mine.find((t) => t.period === period) ?? mine.find((t) => period.startsWith(t.period) && t.period !== '*') ?? mine.find((t) => t.period === '*') ?? null;
}

/**
 * Estado de C01 (`ok`, `atencion`, `critico`) según los umbrales y el sentido: con `up` (más es mejor) está mal por
 * debajo del umbral; con `down`, por encima. Sin umbrales ni valor, sin estado.
 */
export function kpiState(value: number | null, target: KpiTarget | null): KpiState {
  if (value === null || !target || (target.warn_at === null && target.critical_at === null)) return null;
  const worse = (limit: number) => (target.direction === 'up' ? value < limit : value > limit);
  if (target.critical_at !== null && worse(target.critical_at)) return 'critico';
  if (target.warn_at !== null && worse(target.warn_at)) return 'atencion';
  return 'ok';
}

/** Valor legible en español según la unidad. */
export function formatKpi(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const n = (digits: number) => new Intl.NumberFormat('es-ES', { maximumFractionDigits: digits }).format(value);
  switch (unit) {
    case 'pct': return `${n(1)} %`;
    case 'eur': return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(value);
    case 'days': return `${n(0)} ${value === 1 ? 'día' : 'días'}`;
    case 'persons': return `${n(0)} ${value === 1 ? 'persona' : 'personas'}`;
    case 'nights': return `${n(0)} ${value === 1 ? 'noche' : 'noches'}`;
    default: return n(2);
  }
}

/** Periodo legible: `actual`, `2026-10` → «octubre de 2026», `2026T4` → «4.º trimestre de 2026», `2026`. */
export function formatPeriod(period: string): string {
  if (period === 'actual') return 'hoy';
  const month = period.match(/^(\d{4})-(\d{2})$/);
  if (month) return new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(Number(month[1]), Number(month[2]) - 1, 1)));
  const quarter = period.match(/^(\d{4})T([1-4])$/);
  if (quarter) return `${quarter[2]}.º trimestre de ${quarter[1]}`;
  return period;
}
