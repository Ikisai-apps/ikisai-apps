/**
 * Ikisai Central · Revisión › Uso y cobertura (visión V0.2 aprobada por VG, 27-10; docs/central/API.md §2.17).
 * Une, por app, pantalla y función o campo: el uso de 30 días por audiencia (`GET usage/review`, núcleo 0071), el inventario
 * de campos de UI-kit (lo no instrumentado) y, cuando existan, los recorridos de Flow en los que participa. El estado nunca
 * decide nada: lo no instrumentado es desconocido, no inútil. Las decisiones (mantener, simplificar, integrar, retirar) son
 * siempre de una persona y se guardan en `central.coverage_decisions` (migración 1517).
 */

export const COVERAGE_DECISIONS_TABLE = 'central.coverage_decisions';
export const COVERAGE_DECISIONS = ['mantener', 'simplificar', 'integrar', 'retirar'] as const;
export type CoverageDecision = typeof COVERAGE_DECISIONS[number];
export const COVERAGE_DECISION_LABELS: Record<CoverageDecision, string> = { mantener: 'Mantener', simplificar: 'Simplificar', integrar: 'Integrar', retirar: 'Retirar' };

/**
 * Estado de cobertura, en el orden en que conviene mirarlo:
 *  · `nadie_llega`: instrumentado y nadie lo ha visto en 30 días;
 *  · `se_ve_sin_uso`: se ve, pero nadie lo usa;
 *  · `sin_instrumentar`: está en el inventario y no mide nada (desconocido, no inútil);
 *  · `usado_fuera`: se usa, fuera de cualquier recorrido;
 *  · `requerido`: lo pide al menos un recorrido de Flow.
 */
export const COVERAGE_STATES = ['nadie_llega', 'se_ve_sin_uso', 'sin_instrumentar', 'usado_fuera', 'requerido'] as const;
export type CoverageState = typeof COVERAGE_STATES[number];
export const COVERAGE_STATE_LABELS: Record<CoverageState, string> = {
  nadie_llega: 'Nadie llega', se_ve_sin_uso: 'Se ve, no se usa', sin_instrumentar: 'Sin instrumentar (desconocido)',
  usado_fuera: 'Usado fuera de recorridos', requerido: 'Requerido por recorridos',
};

export interface UsageNumbersLike { exposures?: number; activations?: number; successes?: number; people?: number }
/** Lo que se usa de `GET usage/review` (y, cuando llegue, del inventario de UI-kit con `instrumented: false`). */
export interface CoverageSource {
  app: string; featureId: string; label: string; kind?: string | null; parent?: string | null; screen?: string | null;
  instrumented?: boolean;
  last30?: UsageNumbersLike & { target?: UsageNumbersLike; others?: UsageNumbersLike };
}
export interface CoverageDecisionRow { id: string; revision: number; feature_id: string; app: string; decision: string; note?: string | null; deleted_at?: string | null }

export interface CoverageRow {
  app: string; featureId: string; label: string; kind: string | null; screen: string;
  /** Usos (activaciones) en 30 días: de su audiencia, de otros y personas distintas. Sin datos, ceros. */
  uses: { target: number; others: number; total: number; people: number; exposures: number };
  flows: string[];
  state: CoverageState;
  decision: CoverageDecisionRow | null;
}

/** La pantalla de una función: la que diga el inventario o, si no, las dos primeras partes de su id («central.persona»). */
export function screenOf(source: Pick<CoverageSource, 'featureId' | 'screen'>): string {
  if (source.screen) return source.screen;
  const parts = source.featureId.split('.');
  return parts.slice(0, Math.min(2, parts.length)).join('.');
}

export function coverageState(source: CoverageSource, flows: readonly string[]): CoverageState {
  if (source.instrumented === false) return 'sin_instrumentar';
  if (flows.length) return 'requerido';
  if ((source.last30?.activations ?? 0) > 0) return 'usado_fuera';
  if ((source.last30?.exposures ?? 0) > 0) return 'se_ve_sin_uso';
  return 'nadie_llega';
}

/**
 * Filas de cobertura: una por función (la misma que llegue por uso e inventario, una sola vez; manda la instrumentada), con
 * sus recorridos y su decisión viva. Orden: por app (el de `apps`), estado según `COVERAGE_STATES`, pantalla y nombre.
 */
export function coverageRows(
  sources: readonly CoverageSource[],
  flowsOf: (featureId: string) => readonly string[],
  decisions: readonly CoverageDecisionRow[],
  apps: readonly string[] = [],
): CoverageRow[] {
  const byId = new Map<string, CoverageSource>();
  for (const s of sources) {
    const prev = byId.get(s.featureId);
    if (!prev || (prev.instrumented === false && s.instrumented !== false)) byId.set(s.featureId, s);
  }
  const alive = decisions.filter((d) => !d.deleted_at);
  const rows = [...byId.values()].map((s): CoverageRow => {
    const flows = [...flowsOf(s.featureId)];
    const l = s.last30 ?? {};
    return {
      app: s.app, featureId: s.featureId, label: s.label, kind: s.kind ?? null, screen: screenOf(s), flows,
      uses: { target: l.target?.activations ?? 0, others: l.others?.activations ?? 0, total: l.activations ?? 0, people: l.people ?? 0, exposures: l.exposures ?? 0 },
      state: coverageState(s, flows),
      decision: alive.find((d) => d.feature_id === s.featureId) ?? null,
    };
  });
  const appIndex = (a: string) => { const i = apps.indexOf(a); return i < 0 ? apps.length : i; };
  return rows.sort((a, b) => appIndex(a.app) - appIndex(b.app) || a.app.localeCompare(b.app)
    || COVERAGE_STATES.indexOf(a.state) - COVERAGE_STATES.indexOf(b.state)
    || a.screen.localeCompare(b.screen) || a.label.localeCompare(b.label, 'es'));
}

/** Recuento por estado (todos, también a cero), para las chips. */
export function coverageCounts(rows: readonly CoverageRow[]): Record<CoverageState, number> {
  const out = Object.fromEntries(COVERAGE_STATES.map((s) => [s, 0])) as Record<CoverageState, number>;
  for (const r of rows) out[r.state] += 1;
  return out;
}

/**
 * Inventario de campos de UI-kit (en el `feature-catalog.json` de cada release; lo carga Core y lo sirve en
 * `GET usage/inventory?app=all`, petición P15). `fields` lleva `anchorId` = el id de uso (también está en `features` como
 * `field`); `fieldsUninstrumented`, los campos sin `data-field-id`.
 */
export interface FieldInventory {
  fields?: Array<{ fieldId: string; app: string; screen?: string | null; route?: string | null; anchorId?: string | null; label?: string | null; type?: string | null }>;
  fieldsUninstrumented?: Array<{ app: string; screen?: string | null; file?: string | null; line?: number | null; tag?: string | null; type?: string | null; anchorId?: string | null; label?: string | null }>;
}

/** El inventario como fuentes de cobertura: lo inventariado cuenta como instrumentado; lo demás, «sin instrumentar». */
export function inventorySources(inventory: FieldInventory | null | undefined): CoverageSource[] {
  if (!inventory) return [];
  const screen = (app: string, s?: string | null) => (s ? `${app}.${s}` : null);
  return [
    ...(inventory.fields ?? []).map((f): CoverageSource => ({
      app: f.app, featureId: f.anchorId || f.fieldId, label: f.label || f.fieldId, kind: 'field', screen: screen(f.app, f.screen), instrumented: true,
    })),
    ...(inventory.fieldsUninstrumented ?? []).map((f): CoverageSource => ({
      app: f.app, featureId: f.anchorId || `${f.app}:${f.file ?? '?'}:${f.line ?? 0}`, label: f.label || f.tag || 'Campo sin nombre', kind: 'field',
      screen: screen(f.app, f.screen) ?? `${f.app}.(sin pantalla)`, instrumented: false,
    })),
  ];
}
