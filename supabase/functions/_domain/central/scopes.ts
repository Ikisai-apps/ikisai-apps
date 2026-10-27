/**
 * Ikisai Central · ámbitos por app en la ficha de persona (encargo de VG del 27-10, vía Core; docs/central/API.md §2.16).
 * Hoy, Flow: a qué proyectos entra una persona, en `core.memberships.scopes.projects` (Flow 0902). El propietario de Flow
 * ve todo; el resto, solo sus proyectos. La lista de proyectos la publica Flow en `flow.projects_projection`.
 */

/** Lectura de Flow con sus proyectos vivos (la abre Flow a Central con `core.allow_read`). */
export const FLOW_PROJECTS_READ = 'flow.projects_projection';

export interface FlowProject {
  id: string;
  name: string;
  status?: string | null;
  starts_on?: string | null;
  ends_on?: string | null;
  test_mode?: boolean | null;
}

/** Los proyectos de Flow de unos ámbitos (`null` si no dicen nada de proyectos). */
export function flowProjectsOf(scopes: unknown): string[] | null {
  const projects = (scopes as { projects?: unknown } | null | undefined)?.projects;
  return Array.isArray(projects) ? projects.filter((x): x is string => typeof x === 'string') : null;
}

/** Los mismos ámbitos con otros proyectos: el resto de claves se conserva; sin repetidos y en el orden dado. */
export function withFlowProjects(scopes: unknown, ids: readonly string[]): Record<string, unknown> {
  const base = scopes && typeof scopes === 'object' && !Array.isArray(scopes) ? { ...(scopes as Record<string, unknown>) } : {};
  return { ...base, projects: [...new Set(ids)] };
}

/** El más actual arriba: los que siguen abiertos primero, y dentro, por fecha de inicio (los más cercanos antes); luego los cerrados. */
export function sortFlowProjects<T extends FlowProject>(projects: readonly T[], today: string): T[] {
  const open = (p: FlowProject) => p.status !== 'closed' && !(p.ends_on && p.ends_on < today);
  return [...projects].sort((a, b) =>
    Number(open(b)) - Number(open(a))
    || (open(a) ? (a.starts_on ?? '9999').localeCompare(b.starts_on ?? '9999') : (b.starts_on ?? '').localeCompare(a.starts_on ?? ''))
    || a.name.localeCompare(b.name, 'es'));
}

/** «Todos los proyectos (propietario)», «Ningún proyecto» o los nombres («Barra · Evento de octubre y 1 más»). */
export function flowScopeSummary(role: string, scopes: unknown, projects: readonly FlowProject[]): string {
  if (role === 'owner') return 'Todos los proyectos (propietario)';
  const ids = flowProjectsOf(scopes) ?? [];
  if (!ids.length) return 'Ningún proyecto';
  const names = ids.map((id) => projects.find((p) => p.id === id)?.name ?? 'un proyecto que ya no está');
  return names.length <= 2 ? names.join(' y ') : `${names.slice(0, 2).join(', ')} y ${names.length - 2} más`;
}
