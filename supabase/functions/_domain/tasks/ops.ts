/**
 * Tasks · operaciones compuestas (docs/tasks/API.md §3.1). Todo lo que hace la interfaz son operaciones de fila:
 * estas funciones puras construyen las cascadas y el hook SQL las verifica. Máximo una operación por (tabla, id).
 */
import { FAMILY_DEFAULTS, INBOX_TITLE, POSITION_STEP, type Dataset, type Operation, type Priority, type TaskRow, type Uuid } from './types.ts';

export type NewId = () => Uuid;
const randomId: NewId = () => crypto.randomUUID();

const live = <T extends { deleted_at: string | null }>(rows: readonly T[]): T[] => rows.filter((r) => !r.deleted_at);
const insert = (table: string, id: Uuid, fields: Record<string, unknown>): Operation => ({ op: 'insert', table, id, fields });
const update = (table: string, row: { id: Uuid; revision: number }, fields: Record<string, unknown>): Operation => ({ op: 'update', table, id: row.id, expectedRevision: row.revision, fields });
const remove = (table: string, row: { id: Uuid; revision: number }): Operation => ({ op: 'delete', table, id: row.id, expectedRevision: row.revision });
const restore = (table: string, row: { id: Uuid; revision: number }): Operation => ({ op: 'restore', table, id: row.id, expectedRevision: row.revision });

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`No existe ${what}`);
  return value;
}

/** Siguiente posición al final de una lista ordenada manualmente. */
export function nextPosition(rows: ReadonlyArray<{ position: number }>): number {
  return Math.max(0, ...rows.map((r) => r.position || 0)) + POSITION_STEP;
}

/** Área nueva: el área, su Entrada protegida y las cinco familias por defecto, en un lote. */
export function createTabOps(input: { id?: Uuid; name: string; color?: string | null; position: number; inboxId?: Uuid }, newId: NewId = randomId): Operation[] {
  const id = input.id ?? newId();
  return [
    insert('tasks.tabs', id, { name: input.name, color: input.color ?? null, position: input.position }),
    insert('tasks.projects', input.inboxId ?? newId(), { tab_id: id, title: INBOX_TITLE, system: 'inbox', status: 'active', position: POSITION_STEP }),
    ...FAMILY_DEFAULTS.map((f, i) => insert('tasks.families', newId(), { tab_id: id, name: f.name, color: f.color, system_key: f.system_key, position: (i + 1) * POSITION_STEP })),
  ];
}

export interface NewTask {
  id?: Uuid;
  project_id: Uuid;
  parent_id?: Uuid | null;
  title: string;
  note?: string;
  done?: boolean;
  priority?: Priority;
  due?: string | null;
  owner_label_id?: Uuid | null;
  cost?: number | null;
  position?: number;
  /** Etiquetas elegidas; si no se indican, hereda las propias del proyecto. */
  labelIds?: Uuid[];
  dependsOnIds?: Uuid[];
}

/** Tarea nueva con sus etiquetas (las elegidas o las propias del proyecto) y dependencias. */
export function createTaskOps(data: Dataset, input: NewTask, newId: NewId = randomId): Operation[] {
  const project = must(data['tasks.projects'].find((p) => p.id === input.project_id), 'el proyecto');
  const id = input.id ?? newId();
  const siblings = data['tasks.tasks'].filter((t) => t.project_id === project.id);
  const labels = input.labelIds ?? live(data['tasks.project_labels']).filter((l) => l.project_id === project.id).map((l) => l.label_id);
  const ops: Operation[] = [];
  const parent = input.parent_id ? must(data['tasks.tasks'].find((t) => t.id === input.parent_id), 'la tarea padre') : null;
  // Un padre hecho que recibe su primera hija viva vuelve a pendiente: su `done` deja de contar y no debe reaparecer.
  if (parent && parent.done && !live(siblings).some((t) => t.parent_id === parent.id)) ops.push(update('tasks.tasks', parent, { done: false }));
  ops.push(insert('tasks.tasks', id, {
    tab_id: project.tab_id, project_id: project.id, parent_id: input.parent_id ?? null, title: input.title, note: input.note ?? '',
    done: input.done ?? false, priority: input.priority ?? 'normal', due: input.due ?? null, owner_label_id: input.owner_label_id ?? null,
    cost: input.cost ?? null, position: input.position ?? nextPosition(siblings),
  }));
  for (const label of new Set(labels)) ops.push(insert('tasks.task_labels', newId(), { tab_id: project.tab_id, project_id: project.id, task_id: id, label_id: label }));
  [...new Set(input.dependsOnIds ?? [])].forEach((dep, i) => ops.push(insert('tasks.task_dependencies', newId(), {
    tab_id: project.tab_id, project_id: project.id, task_id: id, depends_on_id: dep, position: (i + 1) * POSITION_STEP,
  })));
  return ops;
}

function liveChildren(data: Dataset, taskId: Uuid): TaskRow[] {
  return live(data['tasks.tasks']).filter((t) => t.parent_id === taskId);
}

/** Completar o reabrir: en un contenedor se actualiza cada hija viva; nunca el padre. */
export function setTaskDoneOps(data: Dataset, taskId: Uuid, done: boolean): Operation[] {
  const task = must(data['tasks.tasks'].find((t) => t.id === taskId), 'la tarea');
  const children = liveChildren(data, taskId);
  return (children.length ? children : [task]).filter((t) => t.done !== done).map((t) => update('tasks.tasks', t, { done }));
}

/** Mover a otro proyecto de la misma área: la tarea, sus hijas y las filas que llevan `project_id` desnormalizado. */
export function moveTaskOps(data: Dataset, taskId: Uuid, target: { project_id: Uuid; position?: number; parent_id?: Uuid | null }): Operation[] {
  const task = must(data['tasks.tasks'].find((t) => t.id === taskId), 'la tarea');
  const project = must(data['tasks.projects'].find((p) => p.id === target.project_id), 'el proyecto de destino');
  const children = data['tasks.tasks'].filter((t) => t.parent_id === taskId);
  const fields: Record<string, unknown> = {};
  const changesProject = task.project_id !== project.id;
  if (changesProject) fields.project_id = project.id;
  if (target.position !== undefined) fields.position = target.position;
  else if (changesProject) fields.position = nextPosition(data['tasks.tasks'].filter((t) => t.project_id === project.id));
  if (target.parent_id !== undefined && target.parent_id !== task.parent_id) fields.parent_id = target.parent_id;
  const ops: Operation[] = Object.keys(fields).length ? [update('tasks.tasks', task, fields)] : [];
  if (!changesProject) return ops;
  const moved = new Set([task.id, ...children.map((c) => c.id)]);
  for (const child of children) ops.push(update('tasks.tasks', child, { project_id: project.id }));
  for (const row of data['tasks.task_labels']) if (moved.has(row.task_id)) ops.push(update('tasks.task_labels', row, { project_id: project.id }));
  for (const row of data['tasks.task_dependencies']) if (moved.has(row.task_id)) ops.push(update('tasks.task_dependencies', row, { project_id: project.id }));
  for (const row of data['tasks.attachments']) if (row.task_id && moved.has(row.task_id)) ops.push(update('tasks.attachments', row, { project_id: project.id }));
  return ops;
}

/** Borrar una tarea y sus hijas vivas: comparten `deleted_at`, que hace de lote de borrado. */
export function deleteTaskOps(data: Dataset, taskId: Uuid): Operation[] {
  const task = must(data['tasks.tasks'].find((t) => t.id === taskId), 'la tarea');
  if (task.deleted_at) return [];
  return [task, ...liveChildren(data, taskId)].map((t) => remove('tasks.tasks', t));
}

/** Restaurar una tarea: su lote de borrado (mismo `deleted_at` en su proyecto) y, si es hija, su padre. */
export function restoreTaskOps(data: Dataset, taskId: Uuid): Operation[] {
  const tasks = data['tasks.tasks'];
  const task = must(tasks.find((t) => t.id === taskId), 'la tarea');
  if (!task.deleted_at) return [];
  const batch = new Map<Uuid, TaskRow>([[task.id, task]]);
  for (const t of tasks) if (t.project_id === task.project_id && t.deleted_at === task.deleted_at && (t.parent_id === task.id || t.id === task.parent_id)) batch.set(t.id, t);
  const parent = task.parent_id ? tasks.find((t) => t.id === task.parent_id) : undefined;
  if (parent?.deleted_at) batch.set(parent.id, parent);
  return [...batch.values()].map((t) => restore('tasks.tasks', t));
}

/** Archivar o reactivar una familia arrastra a sus etiquetas, recordando su estado previo. */
export function archiveFamilyOps(data: Dataset, familyId: Uuid, archived: boolean): Operation[] {
  const family = must(data['tasks.families'].find((f) => f.id === familyId), 'la familia');
  if (family.archived === archived) return [];
  const ops = [update('tasks.families', family, { archived })];
  for (const label of data['tasks.labels'].filter((l) => l.family_id === familyId && !l.deleted_at)) {
    if (archived) ops.push(update('tasks.labels', label, { archived: true, archived_before_family: label.archived }));
    else ops.push(update('tasks.labels', label, { archived: label.archived_before_family ?? false, archived_before_family: null }));
  }
  return ops;
}

interface BridgeRow { id: Uuid; revision: number; deleted_at: string | null }

/** Lleva un conjunto de filas puente al conjunto deseado: restaura la fila borrada si existe, inserta si no, borra lo que sobra. */
function reconcile<R extends BridgeRow>(table: string, rows: readonly R[], keyOf: (row: R) => Uuid, wanted: readonly Uuid[], fieldsFor: (key: Uuid, index: number) => Record<string, unknown>, newId: NewId): Operation[] {
  const ops: Operation[] = [];
  const want = [...new Set(wanted)];
  const byKey = new Map<Uuid, R>();
  for (const row of rows) {
    const current = byKey.get(keyOf(row));
    if (!current || (current.deleted_at && !row.deleted_at)) byKey.set(keyOf(row), row);
  }
  want.forEach((key, index) => {
    const row = byKey.get(key);
    if (!row) ops.push(insert(table, newId(), fieldsFor(key, index)));
    else if (row.deleted_at) ops.push(restore(table, row));
  });
  for (const [key, row] of byKey) if (!row.deleted_at && !want.includes(key)) ops.push(remove(table, row));
  return ops;
}

export function setTaskLabelsOps(data: Dataset, taskId: Uuid, labelIds: readonly Uuid[], newId: NewId = randomId): Operation[] {
  const task = must(data['tasks.tasks'].find((t) => t.id === taskId), 'la tarea');
  return reconcile('tasks.task_labels', data['tasks.task_labels'].filter((r) => r.task_id === taskId), (r) => r.label_id, labelIds,
    (label) => ({ tab_id: task.tab_id, project_id: task.project_id, task_id: taskId, label_id: label }), newId);
}

export function setProjectLabelsOps(data: Dataset, projectId: Uuid, labelIds: readonly Uuid[], newId: NewId = randomId): Operation[] {
  const project = must(data['tasks.projects'].find((p) => p.id === projectId), 'el proyecto');
  return reconcile('tasks.project_labels', data['tasks.project_labels'].filter((r) => r.project_id === projectId), (r) => r.label_id, labelIds,
    (label) => ({ tab_id: project.tab_id, project_id: projectId, label_id: label }), newId);
}

export function setDependenciesOps(data: Dataset, taskId: Uuid, dependsOnIds: readonly Uuid[], newId: NewId = randomId): Operation[] {
  const task = must(data['tasks.tasks'].find((t) => t.id === taskId), 'la tarea');
  return reconcile('tasks.task_dependencies', data['tasks.task_dependencies'].filter((r) => r.task_id === taskId), (r) => r.depends_on_id, dependsOnIds,
    (dep, index) => ({ tab_id: task.tab_id, project_id: task.project_id, task_id: taskId, depends_on_id: dep, position: (index + 1) * POSITION_STEP }), newId);
}

/** Trocea un lote grande en lotes de hasta `size` operaciones conservando el orden (padres antes que hijas, puentes al final). */
export function chunkOperations(operations: readonly Operation[], size = 500): Operation[][] {
  const out: Operation[][] = [];
  for (let i = 0; i < operations.length; i += size) out.push(operations.slice(i, i + size));
  return out;
}

/** Aplica operaciones de fila a un conjunto de datos en memoria (previsualización y validación local sin red). */
export function applyOperations(data: Dataset, operations: readonly Operation[], now: string = new Date().toISOString()): Dataset {
  const next = Object.fromEntries(Object.entries(data).map(([table, rows]) => [table, [...rows]])) as unknown as Dataset;
  for (const op of operations) {
    if (op.op === 'call' || !op.table || !(op.table in next)) continue;
    const rows = (next as unknown as Record<string, Array<Record<string, unknown>>>)[op.table]!;
    const at = rows.findIndex((r) => r.id === op.id);
    if (op.op === 'insert') {
      if (at < 0) rows.push({ revision: 0, created_at: now, updated_at: now, updated_by: null, deleted_at: null, ...op.fields, id: op.id });
    } else if (at >= 0) {
      const row = rows[at]!;
      rows[at] = op.op === 'update' ? { ...row, ...op.fields, updated_at: now }
        : { ...row, deleted_at: op.op === 'delete' ? now : null, updated_at: now };
    }
  }
  return next;
}
