/**
 * Tasks · peticiones de otras apps y reglas de entrada (docs/tasks/API.md §20). Funciones puras que devuelven el lote:
 * clasificar una petición pendiente crea su tarea con el mismo id (y con su origen) y la marca como enrutada en el mismo
 * lote, que es lo único que el hook acepta para fijar el origen de una tarea fuera de `tasks.request_task`.
 */
import { createTaskOps, nextPosition, type NewId } from './ops.ts';
import { reject, type Dataset, type Operation, type RequestRouteRow, type RequestRow, type Uuid } from './types.ts';

const randomId: NewId = () => crypto.randomUUID();
const live = <T extends { deleted_at: string | null }>(rows: readonly T[]): T[] => rows.filter((r) => !r.deleted_at);
const update = (table: string, row: { id: Uuid; revision: number }, fields: Record<string, unknown>): Operation => ({ op: 'update', table, id: row.id, expectedRevision: row.revision, fields });

/** Peticiones que esperan en «Por clasificar», de un tipo o de todos. */
export function pendingRequests(data: Dataset, kind?: string): RequestRow[] {
  return live(data['tasks.requests']).filter((r) => r.status === 'pending' && (kind === undefined || r.kind === kind));
}

/** «Por clasificar» agrupado por origen y tipo, con el nombre más reciente que mandó quien pide. */
export function requestGroups(data: Dataset): Array<{ source: string; kind: string; label: string | null; items: RequestRow[] }> {
  const groups = new Map<string, { source: string; kind: string; label: string | null; items: RequestRow[] }>();
  for (const r of pendingRequests(data).sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const group = groups.get(r.kind) ?? { source: r.source, kind: r.kind, label: null, items: [] };
    group.items.push(r);
    group.label = r.kind_label ?? group.label;
    groups.set(r.kind, group);
  }
  return [...groups.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

/** La regla viva de un tipo, si la hay. */
export function routeFor(data: Dataset, kind: string): RequestRouteRow | null {
  return live(data['tasks.request_routes']).find((r) => r.kind === kind) ?? null;
}

/**
 * «Mover a…»: crea la tarea de una petición pendiente en un proyecto (con las etiquetas del proyecto, como al crear una
 * tarea en la app) y marca la petición como enrutada. La tarea conserva el origen: referencia, tipo y enlace.
 */
export function classifyRequestOps(data: Dataset, requestId: Uuid, target: { project_id: Uuid; owner_label_id?: Uuid | null }, how: 'manual' | 'rule' = 'manual', newId: NewId = randomId): Operation[] {
  const request = live(data['tasks.requests']).find((r) => r.id === requestId);
  if (!request) reject(404, 'NOT_FOUND', 'No existe esa petición.', { id: requestId });
  if (request!.status !== 'pending') reject(422, 'INVALID_REQUEST', 'Esa petición ya no está por clasificar.', { id: requestId });
  const project = live(data['tasks.projects']).find((p) => p.id === target.project_id);
  if (!project) reject(404, 'NOT_FOUND', 'No existe ese proyecto.', { id: target.project_id });
  if (project!.status === 'archived') reject(422, 'INVALID_TARGET', 'El proyecto está archivado.', { id: project!.id });
  if (data['tasks.tasks'].some((t) => t.id === requestId)) reject(422, 'INVALID_REQUEST', 'Esta petición ya tuvo su tarea: restáurala desde la papelera.', { id: requestId });
  const ops = createTaskOps(data, {
    id: request!.id, project_id: project!.id, parent_id: null, title: request!.title, note: request!.note, priority: request!.priority,
    due: request!.due, owner_label_id: target.owner_label_id ?? null,
  }, newId);
  Object.assign(ops.find((o) => o.table === 'tasks.tasks' && o.op === 'insert')!.fields!, {
    external_ref: request!.external_ref, external_kind: request!.kind, external_url: request!.external_url,
  });
  return [update('tasks.requests', request!, { status: 'routed', routed_by: how }), ...ops];
}

/** «Descartar»: lo que no es trabajo. La app que pidió lo ve como descartado (`tasks.targets`). */
export function dismissRequestOps(data: Dataset, requestId: Uuid): Operation[] {
  const request = pendingRequests(data).find((r) => r.id === requestId);
  if (!request) reject(422, 'INVALID_REQUEST', 'Esa petición ya no está por clasificar.', { id: requestId });
  return [update('tasks.requests', request!, { status: 'dismissed' })];
}

/** Volver a «Por clasificar» una petición descartada. */
export function reopenRequestOps(data: Dataset, requestId: Uuid): Operation[] {
  const request = live(data['tasks.requests']).find((r) => r.id === requestId && r.status === 'dismissed');
  if (!request) reject(422, 'INVALID_REQUEST', 'Solo se recupera una petición descartada.', { id: requestId });
  return [update('tasks.requests', request!, { status: 'pending' })];
}

/** Proyecto destino de una regla: el suyo, o la Entrada de su área. Null si ya no vale (la regla deja de aplicarse). */
export function routeTarget(data: Dataset, route: Pick<RequestRouteRow, 'tab_id' | 'project_id'>): Uuid | null {
  const projects = live(data['tasks.projects']);
  if (!live(data['tasks.tabs']).some((t) => t.id === route.tab_id)) return null;
  const project = route.project_id
    ? projects.find((p) => p.id === route.project_id && p.tab_id === route.tab_id && p.status !== 'archived')
    : projects.find((p) => p.tab_id === route.tab_id && p.system === 'inbox');
  return project?.id ?? null;
}

/** Alta o cambio de la regla de un tipo (una viva por tipo). */
export function saveRouteOps(data: Dataset, input: { kind: string; kind_label?: string | null; tab_id: Uuid; project_id?: Uuid | null; owner_label_id?: Uuid | null }, newId: NewId = randomId): Operation[] {
  const fields = { kind_label: input.kind_label ?? null, tab_id: input.tab_id, project_id: input.project_id ?? null, owner_label_id: input.owner_label_id ?? null };
  if (!routeTarget(data, fields)) reject(422, 'INVALID_ROUTE', 'El destino de la regla no existe o está archivado.');
  const existing = routeFor(data, input.kind);
  if (existing) {
    const changed = Object.fromEntries(Object.entries(fields).filter(([k, v]) => (existing as unknown as Record<string, unknown>)[k] !== v));
    return Object.keys(changed).length ? [update('tasks.request_routes', existing, changed)] : [];
  }
  return [{ op: 'insert', table: 'tasks.request_routes', id: newId(), fields: { kind: input.kind, ...fields, position: nextPosition(live(data['tasks.request_routes'])) } }];
}

/** Quitar la regla de un tipo: lo nuevo de ese tipo vuelve a esperar en «Por clasificar». */
export function deleteRouteOps(data: Dataset, kind: string): Operation[] {
  const route = routeFor(data, kind);
  if (!route) reject(404, 'NOT_FOUND', 'Ese tipo no tiene regla.', { kind });
  return [{ op: 'delete', table: 'tasks.request_routes', id: route!.id, expectedRevision: route!.revision }];
}

/** «Mover también las que esperaban»: clasifica con la regla las pendientes de su tipo, en un solo lote. */
export function routeWaitingOps(data: Dataset, kind: string, newId: NewId = randomId): Operation[] {
  const route = routeFor(data, kind);
  if (!route) reject(404, 'NOT_FOUND', 'Ese tipo no tiene regla.', { kind });
  const projectId = routeTarget(data, route!);
  if (!projectId) reject(422, 'INVALID_ROUTE', 'El destino de la regla ya no existe.', { kind });
  let working = data;
  const ops: Operation[] = [];
  for (const request of pendingRequests(data, kind)) {
    const batch = classifyRequestOps(working, request.id, { project_id: projectId!, owner_label_id: route!.owner_label_id }, 'rule', newId);
    ops.push(...batch);
    // Las posiciones siguientes cuentan con las tareas que ya entran en este lote.
    const inserted = batch.find((o) => o.table === 'tasks.tasks')!;
    working = { ...working, 'tasks.tasks': [...working['tasks.tasks'], { id: inserted.id, ...inserted.fields, deleted_at: null, revision: 1 } as never] };
  }
  return ops;
}
