/**
 * Tasks · riesgo de un lote enviado por un agente (docs/tasks/AGENTES.md §3.1). El núcleo ya exige aprobación para
 * cualquier `delete`, cualquier `call` y los lotes de 10 filas o más; aquí se añade lo que solo sabe el dominio:
 *
 * - **Archivar** un proyecto, una familia o una etiqueta exige aprobación aunque sea una sola fila: saca de la vista
 *   todo lo que cuelga de ella.
 * - **Alcance real**: un lote corto puede afectar a mucho más de lo que nombra (archivar un proyecto con 40 tareas,
 *   borrar un área entera). `affectedEstimate` cuenta las filas vivas que quedan afectadas, para que el umbral del
 *   núcleo se aplique sobre el alcance y no sobre el número de operaciones.
 *
 * Es una función pura: la Edge le pasa las filas que necesita (`needsData` dice cuándo hace falta leerlas).
 */
import type { Dataset, Operation, Uuid } from './types.ts';

export interface TasksAgentRisk {
  required: boolean;
  reasons: string[];
  affectedEstimate: number;
}

type Rows = Pick<Dataset, 'tasks.tasks' | 'tasks.labels' | 'tasks.projects'>;

const isTrue = (value: unknown) => value === true;
const live = <T extends { deleted_at: string | null }>(rows: readonly T[]): T[] => rows.filter((row) => !row.deleted_at);

/** Si el lote contiene algo cuyo alcance hay que contar con datos (archivar o borrar contenedores). */
export function riskNeedsData(operations: readonly Operation[]): boolean {
  return operations.some((op) =>
    (op.op === 'update' && op.table === 'tasks.projects' && op.fields?.status === 'archived')
    || (op.op === 'update' && op.table === 'tasks.families' && isTrue(op.fields?.archived))
    || (op.op === 'delete' && (op.table === 'tasks.tabs' || op.table === 'tasks.projects' || op.table === 'tasks.tasks')));
}

/** Riesgo de dominio de un lote. Sin `data`, solo las razones (el alcance se queda en las filas nombradas). */
export function tasksAgentRisk(operations: readonly Operation[], data?: Rows): TasksAgentRisk {
  const reasons: string[] = [];
  const affected = new Set<string>();
  for (const op of operations) if (op.table && op.id) affected.add(`${op.table}|${op.id}`);
  let required = false;

  const tasks = data ? live(data['tasks.tasks']) : [];
  const labels = data ? live(data['tasks.labels']) : [];
  const projects = data ? live(data['tasks.projects']) : [];
  const addTasks = (filter: (task: { id: Uuid; project_id: Uuid; parent_id: Uuid | null; tab_id: Uuid }) => boolean) => {
    for (const task of tasks) if (filter(task)) affected.add(`tasks.tasks|${task.id}`);
  };

  for (const op of operations) {
    if (op.op === 'update' && op.table === 'tasks.projects' && op.fields?.status === 'archived') {
      required = true;
      reasons.push(`archive:project:${op.id}`);
      addTasks((task) => task.project_id === op.id);
    } else if (op.op === 'update' && op.table === 'tasks.families' && isTrue(op.fields?.archived)) {
      required = true;
      reasons.push(`archive:family:${op.id}`);
      for (const label of labels) if (label.family_id === op.id) affected.add(`tasks.labels|${label.id}`);
    } else if (op.op === 'update' && op.table === 'tasks.labels' && isTrue(op.fields?.archived)) {
      required = true;
      reasons.push(`archive:label:${op.id}`);
    } else if (op.op === 'delete' && op.table === 'tasks.tabs') {
      reasons.push(`delete:tab:${op.id}`);
      for (const project of projects) if (project.tab_id === op.id) affected.add(`tasks.projects|${project.id}`);
      addTasks((task) => task.tab_id === op.id);
    } else if (op.op === 'delete' && op.table === 'tasks.projects') {
      reasons.push(`delete:project:${op.id}`);
      addTasks((task) => task.project_id === op.id);
    } else if (op.op === 'delete' && op.table === 'tasks.tasks') {
      addTasks((task) => task.parent_id === op.id);
    }
  }
  return { required, reasons, affectedEstimate: affected.size };
}
