/**
 * Ikisai Central · fichas de agente (migración 1520; propuesta en MUELA/equipo/feedback/central/FICHA_AGENTE.md).
 * La ficha se apoya en la cuenta de agente del núcleo y añade quién responde por él, qué hace, en qué trabaja y quién le
 * sigue. Los ámbitos se leen de las pertenencias del núcleo. Solo el owner de Central la cambia.
 */

export const AGENTS_TABLE = 'central.agents';

/** Ids del Avance de Flow (1524): el proyecto y el carril, tal como los usa Flow en sus enlaces. */
export const FLOW_PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const FLOW_LANE_ID = /^[a-z][a-z0-9_]{1,30}$/;

/** El carril del agente en el Avance de Flow, o `null` si falta el proyecto o el carril. */
export function flowLaneUrl(a: { flow_project?: string | null; flow_lane?: string | null }): string | null {
  if (!a.flow_project || !a.flow_lane || !FLOW_PROJECT_ID.test(a.flow_project) || !FLOW_LANE_ID.test(a.flow_lane)) return null;
  return `https://flow.ikisai.com/#/p/${encodeURIComponent(a.flow_project)}/avance?carril=${encodeURIComponent(a.flow_lane)}`;
}

/** La ficha del agente en Central, para que el Avance de Flow la enlace. */
export const agentCardUrl = (id: string) => `https://central.ikisai.com/#/accesos/agentes?agente=${encodeURIComponent(id)}`;

/** Quién responde por el agente: una persona de Central (por defecto) o una entidad de servicio (decisión de VG, 27-10). */
export const RESPONSIBLE_KINDS = ['person', 'service'] as const;
export type ResponsibleKind = typeof RESPONSIBLE_KINDS[number];
export const RESPONSIBLE_KIND_LABELS: Record<ResponsibleKind, string> = { person: 'Una persona', service: 'Una entidad de servicio' };

export interface AgentRow {
  id: string;
  display_name: string;
  user_id?: string | null;
  responsible_kind?: ResponsibleKind | null;
  responsible_person_id?: string | null;
  responsible_service?: string | null;
  active?: boolean | null;
  successor_id?: string | null;
}

/** ¿Tiene responsable? Sin él, el agente no se activa (check `agents_active_responsible`). */
export function hasResponsible(row: Pick<AgentRow, 'responsible_kind' | 'responsible_person_id' | 'responsible_service'>): boolean {
  return (row.responsible_kind ?? 'person') === 'service' ? !!row.responsible_service?.trim() : !!row.responsible_person_id;
}

/** La cadena de sustitutos desde un agente (sin el propio), cortada si vuelve sobre sí misma. */
export function successorChain(agents: readonly AgentRow[], id: string): AgentRow[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const out: AgentRow[] = [];
  const seen = new Set([id]);
  for (let next = byId.get(id)?.successor_id; next && !seen.has(next); next = byId.get(next)?.successor_id) {
    seen.add(next);
    const row = byId.get(next);
    if (!row) break;
    out.push(row);
  }
  return out;
}

/**
 * Propuestas del agente sobre su propia ficha (vg-51, decisión de VG del 28-10; análisis en
 * MUELA/equipo/feedback/central/PROPUESTAS_AGENTE.md). El agente propone por `core.proposals` y decide su responsable:
 * la persona responsable, si tiene cuenta; si el responsable es una entidad de servicio (o la persona no tiene cuenta), el
 * owner de Central (`null`: decide el owner, como siempre).
 * Central no admite agentes (Core, 28-10): el agente prepara la propuesta desde su propia app con su cuenta y la dirige a
 * Central (`target_app = 'central'`, núcleo 0119). Al llegar, Central la valida con `agentProposalIssue` y fija el decisor con
 * `proposalDecider` (`decider_user_id`).
 */
export const CENTRAL_TARGET_APP = 'central';
export const AGENT_PROPOSABLE_FIELDS = ['mission', 'work_areas', 'notes'] as const;

/** Quién decide una propuesta del agente: la cuenta de la persona responsable, o `null` (el owner de Central). */
export function proposalDecider(agent: Pick<AgentRow, 'responsible_kind' | 'responsible_person_id'>, people: ReadonlyArray<{ id: string; user_id?: string | null; active?: boolean | null; deleted_at?: string | null }>): string | null {
  if ((agent.responsible_kind ?? 'person') !== 'person' || !agent.responsible_person_id) return null;
  const person = people.find((p) => p.id === agent.responsible_person_id && !p.deleted_at && p.active !== false);
  return person?.user_id ?? null;
}

/**
 * ¿Puede proponer el agente estas operaciones? Solo actualizar su propia ficha y solo misión, dónde trabaja y notas. Devuelve
 * el motivo si no, o `null` si vale.
 */
export function agentProposalIssue(operations: ReadonlyArray<{ op: string; table?: string; id?: string; fields?: Record<string, unknown> }>, agentUserId: string, agents: readonly AgentRow[]): string | null {
  const own = agents.find((a) => a.user_id === agentUserId);
  if (!own) return 'el agente no tiene ficha en Central';
  for (const o of operations) {
    if (o.table !== AGENTS_TABLE || o.op !== 'update' || o.id !== own.id) return 'un agente solo propone cambios en su propia ficha';
    const extra = Object.keys(o.fields ?? {}).filter((f) => !(AGENT_PROPOSABLE_FIELDS as readonly string[]).includes(f));
    if (extra.length) return `un agente no propone cambiar ${extra.join(', ')}`;
  }
  return null;
}
