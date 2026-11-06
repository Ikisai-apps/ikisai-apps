/**
 * Acceso por proyecto (decisión de VG del 26-10, migración 0902): ámbitos del núcleo, `core.memberships.scopes =
 * { "projects": [uuid…] }`. El owner (Dirección) ve todos; el resto, solo los proyectos de sus ámbitos.
 * La misma regla la aplica la base de datos al escribir (`flow.in_scope`).
 */
export interface ScopedMembership { role: string; scopes?: unknown }

/** Proyectos de la persona; `null` = todos (owner). */
export function scopedProjects(membership: ScopedMembership | null | undefined): string[] | null {
  if (!membership) return [];
  if (membership.role === 'owner') return null;
  const list = (membership.scopes as { projects?: unknown } | null | undefined)?.projects;
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
}

/** Tablas de Flow que no son de un proyecto (recorridos, 0919): las ve quien tenga el rol de lectura de su registro. */
const GLOBAL_TABLES = new Set(['flow.definitions', 'flow.definition_versions', 'flow.definition_steps']);

/** Flujos que este dispositivo quiere en su espejo (fl-22, `X-Ikisai-Scope`): `null` = todos los que vea la persona. */
export function deviceProjects(device: Record<string, unknown> | null | undefined): string[] | null {
  const list = device?.projects;
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : null;
}

/**
 * ¿Ve esta fila de Flow? Proyectos por su id; el resto, por su `project_id`. Lo que no es de Flow no se filtra aquí.
 * Con ámbito de dispositivo (fl-22) solo baja lo de esos flujos (también para el owner), menos la lista de flujos, que se ve
 * entera para poder elegir. Nunca amplía lo que permiten los ámbitos de la persona.
 */
export function visibleRow(table: string, row: Record<string, unknown>, membership: ScopedMembership | null | undefined, device?: Record<string, unknown> | null): boolean {
  if (!table.startsWith('flow.') || GLOBAL_TABLES.has(table)) return true;
  const projects = scopedProjects(membership);
  const project = table === 'flow.projects' ? row.id : row.project_id;
  if (projects !== null && !(typeof project === 'string' && projects.includes(project))) return false;
  const chosen = table === 'flow.projects' ? null : deviceProjects(device);
  return chosen === null || (typeof project === 'string' && chosen.includes(project));
}
