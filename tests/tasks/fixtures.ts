/** Datos sintéticos para las pruebas de Tasks: uuid deterministas y constructores de filas. */
import { emptyDataset, type Dataset, type LabelRow, type FamilyRow, type ProjectRow, type TabRow, type TaskDependencyRow, type TaskLabelRow, type TaskRow } from '../../supabase/functions/_domain/tasks/mod.ts';

/** uuid v4 determinista a partir de un número: legible en los fallos. */
export function uid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** Generador de ids consecutivos para las funciones que crean filas. */
export function counter(start = 1000): () => string {
  let n = start;
  return () => uid(n++);
}

const base = (id: string) => ({ id, revision: 1, created_at: '2026-10-06T08:00:00.000Z', updated_at: '2026-10-06T08:00:00.000Z', updated_by: null, deleted_at: null as string | null });

export const TAB = uid(1);
export const OTHER_TAB = uid(2);

export function tab(id: string, name = 'Área'): TabRow {
  return { ...base(id), name, color: null, position: 1024 };
}
export function project(id: string, extra: Partial<ProjectRow> = {}): ProjectRow {
  return { ...base(id), tab_id: TAB, title: 'Proyecto', note: '', status: 'active', priority: 'normal', due: null, owner_label_id: null, color: null, budget: null, position: 1024, system: null, ...extra };
}
export function task(id: string, projectId: string, extra: Partial<TaskRow> = {}): TaskRow {
  return { ...base(id), tab_id: TAB, project_id: projectId, parent_id: null, title: 'Tarea', note: '', done: false, done_at: null, priority: 'normal', due: null, owner_label_id: null, cost: null, position: 1024, ...extra };
}
export function dependency(id: string, taskRow: TaskRow, dependsOn: string, extra: Partial<TaskDependencyRow> = {}): TaskDependencyRow {
  return { ...base(id), tab_id: taskRow.tab_id, project_id: taskRow.project_id, task_id: taskRow.id, depends_on_id: dependsOn, position: 1024, ...extra };
}
export function family(id: string, extra: Partial<FamilyRow> = {}): FamilyRow {
  return { ...base(id), tab_id: TAB, name: 'Fase', color: '#6b7b54', archived: false, position: 1024, system_key: null, ...extra };
}
export function label(id: string, familyId: string, extra: Partial<LabelRow> = {}): LabelRow {
  return { ...base(id), tab_id: TAB, family_id: familyId, parent_id: null, name: 'Etiqueta', archived: false, archived_before_family: null, position: 1024, ...extra };
}
export function taskLabel(id: string, taskRow: TaskRow, labelId: string, extra: Partial<TaskLabelRow> = {}): TaskLabelRow {
  return { ...base(id), tab_id: taskRow.tab_id, project_id: taskRow.project_id, task_id: taskRow.id, label_id: labelId, ...extra };
}

export function dataset(parts: Partial<Dataset>): Dataset {
  return { ...emptyDataset(), ...parts };
}

/**
 * Simula una identidad de servicio de Core (migraciones 0067 y 0068: perfil `kind = 'service'` con `service_name` y
 * pertenencia `tasks` `editor`), para probar `worker/requests/task` antes de que exista.
 * Si la 0067 ya está aplicada, solo añade el perfil.
 */
export async function simulateServiceIdentity(db: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, id: string, service = 'feedback'): Promise<void> {
  await db.query(`alter table core.profiles drop constraint if exists profiles_kind_check`);
  await db.query(`alter table core.profiles add column if not exists service_name text`);
  await db.query('insert into auth.users (id, email) values ($1, $2) on conflict do nothing', [id, `${id}@service.invalid`]);
  await db.query(`insert into core.profiles (user_id, display_name, kind, service_name) values ($1, $2, 'service', $3)`, [id, `${service} (sistema)`, service]);
  await db.query(`insert into core.memberships (app, user_id, role) values ('tasks', $1, 'editor')`, [id]);
}
