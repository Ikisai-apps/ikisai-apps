/**
 * Central · «Lo que urge» de Inicio (MUELA-004, firmado en la 069 y confirmado por VG en la 089): una sola cola con los
 * vencimientos (obligaciones, documentos clave y, para quien la ve, documentación de personas) y los avisos de las apps
 * (indicadores del panel en crítico o en atención), en el orden de `centralAttention` del 004, sin cambios:
 *
 *   1. lo que bloquea la operación (un vencimiento con «Bloquea la operación», vencido o por vencer);
 *   2. los indicadores en crítico;
 *   3. lo vencido;
 *   4. los indicadores en atención;
 *   5. lo que vence pronto.
 *
 * Desempates que el 004 no dice (decisión de Core Sevilla, Bloque 2): dentro de los vencimientos, primero la fecha más
 * antigua y después el título; dentro de los indicadores, el orden de las apps del panel (`ATTENTION_APP_ORDER`) y
 * después la etiqueta. Sin duplicados: cada cosa entra una vez por su clave (`due:<origen>:<id>` o `kpi:<indicador>`).
 * Función pura: el dispositivo la calcula con lo que ya tiene (el espejo y la última lectura del panel).
 */
import type { DueItem } from './compliance.ts';
import type { KpiState } from './kpis.ts';

export interface AttentionKpi {
  app: string;
  kpi: string;
  label: string;
  state: KpiState;
  value: number | null;
  unit: string;
  period: string;
  link: string | null;
}

export type AttentionRank = 1 | 2 | 3 | 4 | 5;
export const ATTENTION_RANK_LABELS: Record<AttentionRank, string> = {
  1: 'Bloquea la operación', 2: 'Crítico', 3: 'Vencido', 4: 'Pide atención', 5: 'Vence pronto',
};

export type AttentionItem =
  | { key: string; kind: 'due'; rank: AttentionRank; due: DueItem }
  | { key: string; kind: 'kpi'; rank: AttentionRank; kpi: AttentionKpi };

/** Orden de las apps en los desempates de indicadores (el del panel de Dirección). */
export const ATTENTION_APP_ORDER = ['central', 'invoices', 'booking', 'tasks', 'food', 'resources', 'guests', 'organizers'];

export function dueRank(d: Pick<DueItem, 'blocksOperation' | 'state'>): AttentionRank {
  if (d.blocksOperation) return 1;
  return d.state === 'vencido' ? 3 : 5;
}

/** La cola de Inicio. `kpis`: lo que enseña cada tarjeta del panel (el periodo en curso de cada indicador). */
export function centralAttention(due: readonly DueItem[], kpis: readonly AttentionKpi[] = []): AttentionItem[] {
  const seen = new Set<string>();
  const out: AttentionItem[] = [];
  for (const d of due) {
    const key = `due:${d.source}:${d.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, kind: 'due', rank: dueRank(d), due: d });
  }
  for (const k of kpis) {
    if (k.state !== 'critico' && k.state !== 'atencion') continue;
    const key = `kpi:${k.kpi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, kind: 'kpi', rank: k.state === 'critico' ? 2 : 4, kpi: k });
  }
  const appIndex = (app: string) => { const i = ATTENTION_APP_ORDER.indexOf(app); return i < 0 ? ATTENTION_APP_ORDER.length : i; };
  return out.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.kind === 'due' && b.kind === 'due') return a.due.dueOn.localeCompare(b.due.dueOn) || a.due.title.localeCompare(b.due.title, 'es');
    if (a.kind === 'kpi' && b.kind === 'kpi') return appIndex(a.kpi.app) - appIndex(b.kpi.app) || a.kpi.label.localeCompare(b.kpi.label, 'es');
    // El mismo rango solo junta vencimientos con vencimientos o indicadores con indicadores; por si acaso, primero el vencimiento.
    return a.kind === 'due' ? -1 : 1;
  });
}

/** «3 urgen: 1 bloquea · 1 crítico · 1 vence pronto». */
export function attentionSummary(items: readonly AttentionItem[]): string {
  const count = (r: AttentionRank) => items.filter((i) => i.rank === r).length;
  const parts = [
    count(1) ? `${count(1)} ${count(1) === 1 ? 'bloquea' : 'bloquean'}` : '',
    count(2) ? `${count(2)} ${count(2) === 1 ? 'crítico' : 'críticos'}` : '',
    count(3) ? `${count(3)} ${count(3) === 1 ? 'vencido' : 'vencidos'}` : '',
    count(4) ? `${count(4)} en atención` : '',
    count(5) ? `${count(5)} ${count(5) === 1 ? 'vence pronto' : 'vencen pronto'}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}
