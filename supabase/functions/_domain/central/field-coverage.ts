/**
 * Ikisai Central · Revisor › cobertura de campos (decisiones de VG del 27-10). Declarar la utilidad campo a campo es inviable:
 * la pantalla enseña, por defecto, solo los **candidatos** (los que el núcleo marca así: sin cobertura de Flow, sin uso en
 * 30 días y sin estimado de la app que los proteja), agrupados por app y pantalla. La utilidad se **hereda** del estimado de
 * la app (frecuencia y audiencia de su catálogo de uso) y del uso real; Dirección actúa por grupo («dejar», «revisar más
 * tarde», «retirar»), una sola vez, y puede declarar una excepción por pantalla (`central.field_group_reviews`, 1522).
 * Las clases `direct` y `automatic` salen de Flow (`flow.anchor_coverage_read`); el resto, del núcleo (`core.field_coverage`).
 * Solo metadatos, nunca valores.
 */

export const FIELD_COVERAGE_READ = 'flow.anchor_coverage_read';
export const FIELD_GROUP_REVIEWS_TABLE = 'central.field_group_reviews';
export const GROUP_DECISIONS = ['dejar', 'revisar_mas_tarde', 'retirar'] as const;
export type GroupDecision = typeof GROUP_DECISIONS[number];
export const GROUP_DECISION_LABELS: Record<GroupDecision, string> = { dejar: 'Dejar', revisar_mas_tarde: 'Revisar más tarde', retirar: 'Retirar' };
export const UTILITY_FREQUENCIES = ['diaria', 'semanal', 'mensual', 'ocasional'] as const;

/** ¿Revisa la cobertura? Dirección: el owner, o un editor con `scopes.direccion = true` (el mismo ámbito que la revisión semanal). */
export function canDeclareUtility(membership: { role: string; scopes?: unknown } | null | undefined): boolean {
  if (!membership) return false;
  if (membership.role === 'owner') return true;
  return membership.role === 'editor' && (membership.scopes as { direccion?: unknown } | null | undefined)?.direccion === true;
}

/** Un campo de `core.field_coverage`. `estimate`, `candidate` y `activations30d` los añade el núcleo (VG, 27-10). */
export interface CoreCoverageField {
  fieldId: string;
  app: string;
  screen?: string | null;
  screenLabel?: string | null;
  anchorId?: string | null;
  label?: string | null;
  entity?: string | null;
  prop?: string | null;
  required?: string | null;
  capabilities?: Array<{ id: string; app?: string; how?: string }>;
  used?: boolean;
  duplicates?: string[];
  class?: string;
  estimate?: { frequency?: string | null; audience?: string | null } | null;
  candidate?: boolean | null;
  activations30d?: number | null;
}
/** `flow.anchor_coverage_read`: anclajes usados por pasos y reglas con lo que observan. */
export interface FlowAnchor { anchor_id: string; app?: string; uses: Array<{ flow_key: string; flow_name: string; step?: string | null }> }
export interface FlowRule { id: string; name: string; observes: Array<{ app: string; entity: string; prop: string }> }
export interface GroupReview { app: string; screen: string; decision?: string | null; audience?: string | null; frequency?: string | null; note?: string | null; deleted_at?: string | null }

/** Lo que pinta la pieza del kit: el vínculo de un campo con recorridos, capacidades o reglas. */
export interface FieldLink { fieldId: string; via: 'direct' | 'indirect' | 'automatic'; flows: Array<{ id: string; name: string }>; capabilities?: string[] }

/**
 * Los vínculos de cada campo: `direct` si su anclaje (o su id) lo usa un paso; `indirect` si alguna capacidad lo lee o lo
 * escribe; `automatic` si una regla de Flow observa su `entity.prop` en su app. Los automatismos propios de una app no
 * cuentan aquí (son uso propio).
 */
export function fieldLinks(fields: readonly CoreCoverageField[], anchors: readonly FlowAnchor[], rules: readonly FlowRule[]): FieldLink[] {
  const byAnchor = new Map(anchors.map((a) => [a.anchor_id, a]));
  const out: FieldLink[] = [];
  for (const f of fields) {
    const anchor = byAnchor.get(f.anchorId ?? '') ?? byAnchor.get(f.fieldId);
    if (anchor) out.push({ fieldId: f.fieldId, via: 'direct', flows: [...new Map(anchor.uses.map((u) => [u.flow_key, { id: u.flow_key, name: u.flow_name }])).values()] });
    if (f.capabilities?.length) out.push({ fieldId: f.fieldId, via: 'indirect', flows: [], capabilities: f.capabilities.map((c) => c.id) });
    if (f.entity && f.prop) {
      const watching = rules.filter((r) => r.observes.some((o) => o.app === f.app && o.entity === f.entity && o.prop === f.prop));
      if (watching.length) out.push({ fieldId: f.fieldId, via: 'automatic', flows: watching.map((r) => ({ id: r.id, name: r.name })) });
    }
  }
  return out;
}

/**
 * ¿Es candidato? Lo dice el núcleo (`candidate`). Si aún no lo da, la misma regla: sin cobertura de Flow (ni paso, ni
 * capacidad, ni regla), sin uso en 30 días y sin estimado de la app que lo proteja.
 */
export function isCandidate(f: CoreCoverageField, linked: ReadonlySet<string>): boolean {
  if (typeof f.candidate === 'boolean') return f.candidate;
  const estimated = !!(f.estimate?.frequency || f.estimate?.audience);
  return !linked.has(f.fieldId) && !f.used && !(f.activations30d && f.activations30d > 0) && !estimated;
}

/** «booking.ficha_reserva» → «Ficha reserva» (si el núcleo no trae la etiqueta de la pantalla en lenguaje de persona). */
export function screenName(f: Pick<CoreCoverageField, 'screen' | 'screenLabel' | 'fieldId'>): string {
  if (f.screenLabel?.trim()) return f.screenLabel.trim();
  const raw = (f.screen ?? f.fieldId.split('.').slice(0, 2).join('.')).split('.').pop() ?? '';
  const text = raw.replace(/[_-]+/g, ' ').trim();
  return text ? text[0]!.toUpperCase() + text.slice(1) : 'Sin pantalla';
}

export interface CandidateGroup { app: string; screen: string; label: string; fields: CoreCoverageField[] }

/** Los candidatos agrupados por app y pantalla, cada app con sus pantallas ordenadas por cuántos campos tienen. */
export function candidateGroups(fields: readonly CoreCoverageField[], links: readonly FieldLink[]): CandidateGroup[] {
  const linked = new Set(links.map((l) => l.fieldId));
  const groups = new Map<string, CandidateGroup>();
  for (const f of fields) {
    if (!isCandidate(f, linked)) continue;
    const screen = f.screen ?? f.fieldId.split('.').slice(0, 2).join('.');
    const key = `${f.app}|${screen}`;
    if (!groups.has(key)) groups.set(key, { app: f.app, screen, label: screenName(f), fields: [] });
    groups.get(key)!.fields.push(f);
  }
  return [...groups.values()].sort((a, b) => a.app.localeCompare(b.app) || b.fields.length - a.fields.length || a.label.localeCompare(b.label, 'es'));
}

/** «12 campos en 3 pantallas». */
export function candidatesSummary(groups: readonly CandidateGroup[]): string {
  const n = groups.reduce((s, g) => s + g.fields.length, 0);
  return `${n} ${n === 1 ? 'campo' : 'campos'} en ${groups.length} ${groups.length === 1 ? 'pantalla' : 'pantallas'}`;
}

/** La utilidad heredada de un campo: la excepción de su pantalla, si Dirección la declaró; si no, el estimado de su app y su uso. */
export function inheritedUtility(f: CoreCoverageField, review?: GroupReview | null): string | null {
  const audience = review?.audience?.trim() || f.estimate?.audience?.trim() || null;
  const frequency = review?.frequency || f.estimate?.frequency || null;
  const use = typeof f.activations30d === 'number' ? (f.activations30d === 1 ? '1 uso en 30 días' : `${f.activations30d} usos en 30 días`) : null;
  const parts = [audience, frequency, use].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}
