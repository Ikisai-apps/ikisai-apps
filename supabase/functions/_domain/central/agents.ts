/**
 * Ikisai Central · fichas de agente (migración 1520; propuesta en MUELA/equipo/feedback/central/FICHA_AGENTE.md).
 * La ficha se apoya en la cuenta de agente del núcleo y añade quién responde por él, qué hace, en qué trabaja y quién le
 * sigue. Los ámbitos se leen de las pertenencias del núcleo. Solo el owner de Central la cambia.
 */

export const AGENTS_TABLE = 'central.agents';

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
