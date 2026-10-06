/**
 * Tasks · jerarquía, finalización calculada, bloqueo y ciclos (docs/tasks/API.md §2.3, §4.2 d–e).
 * Mismas reglas que el hook SQL `tasks.validate_batch`; aquí sirven para pintar y para validar sin red.
 */
import type { ProjectRow, TaskDependencyRow, TaskRow } from './types.ts';

export interface GraphInput {
  tasks: readonly TaskRow[];
  projects: readonly ProjectRow[];
  dependencies: readonly TaskDependencyRow[];
}

export interface TaskStatus {
  /** Hecha: su `done`, o todas sus hijas vivas hechas si es un contenedor. */
  done: boolean;
  /** Tiene hijas vivas: su `done` almacenado se ignora. */
  container: boolean;
  /** Condiciones incumplidas (ids de tarea), propias, heredadas del padre y de sus hijas pendientes. Vacío si está hecha. */
  blockedBy: string[];
}

interface Index {
  tasks: Map<string, TaskRow>;
  liveChildren: Map<string, TaskRow[]>;
  deps: Map<string, string[]>;
  deletedProjects: Set<string>;
}

function index(input: GraphInput): Index {
  const tasks = new Map(input.tasks.map((t) => [t.id, t]));
  const liveChildren = new Map<string, TaskRow[]>();
  for (const t of input.tasks) {
    if (!t.parent_id || t.deleted_at) continue;
    const list = liveChildren.get(t.parent_id);
    if (list) list.push(t); else liveChildren.set(t.parent_id, [t]);
  }
  const deps = new Map<string, string[]>();
  for (const d of [...input.dependencies].sort((a, b) => a.position - b.position)) {
    if (d.deleted_at) continue;
    const list = deps.get(d.task_id);
    if (list) list.push(d.depends_on_id); else deps.set(d.task_id, [d.depends_on_id]);
  }
  const deletedProjects = new Set(input.projects.filter((p) => p.deleted_at).map((p) => p.id));
  return { tasks, liveChildren, deps, deletedProjects };
}

/** Dependencias efectivas: las propias más las de su padre. */
function effective(task: TaskRow, ix: Index): string[] {
  const own = ix.deps.get(task.id) ?? [];
  const inherited = task.parent_id ? ix.deps.get(task.parent_id) ?? [] : [];
  return [...new Set([...own, ...inherited])];
}

function doneOf(task: TaskRow, ix: Index): boolean {
  const children = ix.liveChildren.get(task.id);
  return children?.length ? children.every((c) => c.done) : task.done;
}

function unmet(dependencyId: string, ix: Index): boolean {
  const target = ix.tasks.get(dependencyId);
  return !target || !!target.deleted_at || ix.deletedProjects.has(target.project_id) || !doneOf(target, ix);
}

/** Estado calculado de cada tarea. Una condición ausente del conjunto (oculta por ámbitos) cuenta como incumplida. */
export function statuses(input: GraphInput): Map<string, TaskStatus> {
  const ix = index(input);
  const out = new Map<string, TaskStatus>();
  for (const task of input.tasks) {
    const children = ix.liveChildren.get(task.id) ?? [];
    const done = doneOf(task, ix);
    const blocked = new Set<string>();
    if (!done) {
      for (const subject of [task, ...children.filter((c) => !c.done)]) {
        for (const dep of effective(subject, ix)) if (unmet(dep, ix)) blocked.add(dep);
      }
    }
    out.set(task.id, { done, container: children.length > 0, blockedBy: [...blocked] });
  }
  return out;
}

/** Condiciones que impiden marcar como hecha una tarea hoja (regla `TASK_BLOCKED`). */
export function completionBlockers(taskId: string, input: GraphInput): string[] {
  const ix = index(input);
  const task = ix.tasks.get(taskId);
  return task ? effective(task, ix).filter((dep) => unmet(dep, ix)) : [];
}

/**
 * Busca un ciclo en el grafo de un conjunto de tareas: tarea → cada dependencia efectiva, y padre → hija.
 * Incluye los ciclos inducidos por la jerarquía (padre → su hija, hija → su padre). Devuelve los ids del ciclo o null.
 */
export function findCycle(input: Pick<GraphInput, 'tasks' | 'dependencies'>): string[] | null {
  const ix = index({ ...input, projects: [] });
  const edges = new Map<string, Set<string>>();
  for (const task of input.tasks) edges.set(task.id, new Set());
  for (const task of input.tasks) {
    for (const dep of effective(task, ix)) if (edges.has(dep)) edges.get(task.id)!.add(dep);
    if (task.parent_id && edges.has(task.parent_id)) edges.get(task.parent_id)!.add(task.id);
  }
  const state = new Map<string, 1 | 2>();
  for (const start of edges.keys()) {
    if (state.has(start)) continue;
    const path: string[] = [];
    const stack: Array<{ node: string; exit: boolean }> = [{ node: start, exit: false }];
    while (stack.length) {
      const { node, exit } = stack.pop()!;
      if (exit) { state.set(node, 2); path.pop(); continue; }
      if (state.get(node) === 2) continue;
      if (state.get(node) === 1) return path.slice(path.indexOf(node)).concat(node);
      state.set(node, 1);
      path.push(node);
      stack.push({ node, exit: true });
      for (const next of edges.get(node)!) {
        if (state.get(next) === 1) return path.slice(path.indexOf(next)).concat(next);
        if (state.get(next) !== 2) stack.push({ node: next, exit: false });
      }
    }
  }
  return null;
}

/** Filas del proyecto borradas en el mismo lote que la tarea (comparten `deleted_at`): su «lote de borrado». */
export function deleteBatch(task: TaskRow, tasks: readonly TaskRow[]): TaskRow[] {
  if (!task.deleted_at) return [];
  return tasks.filter((t) => t.project_id === task.project_id && t.deleted_at === task.deleted_at);
}
