/**
 * Tasks · ámbitos (docs/tasks/API.md §5). `core.memberships.scopes` es opaco para el núcleo:
 *   "*" | null                 toda la app
 *   ["<tabId>", …]             áreas completas (forma heredada)
 *   { tabs: [...], projects: { "<tabId>": ["<projectId>", …] } }
 * Cualquier otra forma equivale a no tener acceso. Las mismas reglas están en SQL (`tasks.scope_full`, `tasks.scope_project`).
 */
import type { Role, TableName } from './types.ts';

export type Scopes = unknown;

interface ScopeObject { tabs?: unknown; projects?: unknown }

function asObject(scopes: Scopes): ScopeObject | null {
  return scopes !== null && typeof scopes === 'object' && !Array.isArray(scopes) ? (scopes as ScopeObject) : null;
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

/** Acceso a toda la app, incluidas las áreas futuras. */
export function allAccess(scopes: Scopes): boolean {
  return scopes === null || scopes === undefined || scopes === '*';
}

/** Acceso al área completa. */
export function fullTab(scopes: Scopes, tabId: string): boolean {
  if (allAccess(scopes)) return true;
  if (Array.isArray(scopes)) return list(scopes).includes(tabId);
  return list(asObject(scopes)?.tabs).includes(tabId);
}

/** Proyectos sueltos concedidos en un área (vacío si el acceso es por área completa o no hay acceso). */
export function grantedProjects(scopes: Scopes, tabId: string): string[] {
  const projects = asObject(scopes)?.projects;
  if (projects === null || typeof projects !== 'object' || Array.isArray(projects)) return [];
  return list((projects as Record<string, unknown>)[tabId]);
}

/** Acceso a un proyecto: por área completa o por concesión directa. */
export function canProject(scopes: Scopes, tabId: string, projectId: string): boolean {
  return fullTab(scopes, tabId) || grantedProjects(scopes, tabId).includes(projectId);
}

/** Algún acceso al área: completa o al menos un proyecto. */
export function someTab(scopes: Scopes, tabId: string): boolean {
  return fullTab(scopes, tabId) || grantedProjects(scopes, tabId).length > 0;
}

/** Administrador: propietario humano con acceso a toda la app. */
export function isAdministrator(member: { role: Role; scopes: Scopes; kind?: string }): boolean {
  return member.role === 'owner' && allAccess(member.scopes) && (member.kind ?? 'human') === 'human';
}

/** Visibilidad de una fila para unos ámbitos. Función pura de la fila: `tab_id` y `project_id` viajan desnormalizados. */
export function visibleRow(table: TableName | string, row: Record<string, unknown>, scopes: Scopes): boolean {
  const tab = String(row.tab_id ?? '');
  switch (table) {
    case 'tasks.tabs':
      return someTab(scopes, String(row.id ?? ''));
    case 'tasks.families':
    case 'tasks.labels':
      // El catálogo General (tab_id nulo, FB_2026_023) lo ve cualquiera con acceso a Tasks.
      return row.tab_id == null || someTab(scopes, tab);
    case 'tasks.saved_views':
      return fullTab(scopes, tab);
    case 'tasks.projects':
      return canProject(scopes, tab, String(row.id ?? ''));
    case 'tasks.tasks':
    case 'tasks.project_labels':
    case 'tasks.task_labels':
    case 'tasks.task_dependencies':
    case 'tasks.attachments':
      return canProject(scopes, tab, String(row.project_id ?? ''));
    // Compras (§18.4): el almacén y los planes, con el área entera; las solicitudes, como su proyecto (sin él, el área entera).
    case 'tasks.supply_items':
    case 'tasks.supply_movements':
    case 'tasks.purchase_plans':
    case 'tasks.purchase_plan_stops':
      return fullTab(scopes, tab);
    case 'tasks.purchase_requests':
      return row.project_id ? canProject(scopes, tab, String(row.project_id)) : fullTab(scopes, tab);
    // Entradas (§20): las reglas, con el área entera; las peticiones no tienen área: con acceso a toda la app.
    case 'tasks.request_routes':
      return fullTab(scopes, tab);
    case 'tasks.requests':
      return allAccess(scopes);
    default:
      return false;
  }
}

/** Hook `visible` de `tasks-api`. */
export function visible(table: string, row: Record<string, unknown>, ctx: { membership: { scopes: Scopes } }): boolean {
  return visibleRow(table, row, ctx.membership.scopes);
}
