/**
 * Tasks · propuestas del outsider (O1, pasos 3; docs/tasks/API.md §31; migración 0329). Funciones puras que construyen
 * el lote de una sugerencia del núcleo (contrato §3.10) desde el modelo en memoria, y lo rehacen al aprobar:
 * - 'tarea' (Tarea nueva): la tarea con lo que hereda de su proyecto (`createTaskOps`) y, si acaso, una foto como adjunto.
 * - 'anadido' (Añadido a una tarea): un paso (tarea hija) o una línea más en la nota.
 * El servidor lo vuelve a comprobar al proponer (`tasks.suggestion_check`) y, al aprobar, como commit de quien aprueba.
 */
import { createTaskOps, type NewId } from './ops.ts';
import type { Dataset, Operation, Uuid } from './types.ts';

export const SUGGESTION_KINDS = { tarea: 'Tarea nueva', anadido: 'Añadido a una tarea' } as const;
export type SuggestionKind = keyof typeof SUGGESTION_KINDS;

/** Lo que la interfaz guarda en `detail` para pintar la propuesta y rehacer el lote al aprobar. */
export type SuggestionDetail =
  | { kind: 'tarea'; title: string; note: string; projectId: Uuid; tabId: Uuid; projectTitle: string; photo?: { name: string } | null }
  | { kind: 'anadido'; mode: 'step' | 'note'; taskId: Uuid; taskTitle: string; projectId: Uuid; tabId: Uuid; text: string };

/** Foto ya subida y verificada (`POST uploads` + `verify`) por quien propone. */
export interface SuggestionPhoto { fileId: Uuid; name: string; mime: string; size: number; sha256: string }

const randomId: NewId = () => crypto.randomUUID();
const TITLE_MAX = 1000;
const NOTE_MAX = 20000;

function fail(message: string): never { throw new Error(message); }

function liveProject(data: Dataset, projectId: Uuid) {
  const project = data['tasks.projects'].find((p) => p.id === projectId && !p.deleted_at);
  if (!project || project.status === 'archived') fail('Ese proyecto ya no está disponible.');
  return project;
}

function liveTask(data: Dataset, taskId: Uuid) {
  const task = data['tasks.tasks'].find((t) => t.id === taskId && !t.deleted_at);
  if (!task) fail('Esa tarea ya no está disponible.');
  return task;
}

function cleanTitle(title: string): string {
  const text = title.trim();
  if (!text) fail('Escribe un título.');
  if (text.length > TITLE_MAX) fail('El título es demasiado largo.');
  return text;
}

/** Tarea nueva en un proyecto, como la crearía la interfaz, con la foto como adjunto. Sin dependencias ni campos de más. */
export function suggestTaskOps(data: Dataset, input: { projectId: Uuid; title: string; note?: string; id?: Uuid; photo?: SuggestionPhoto | null }, newId: NewId = randomId): Operation[] {
  const project = liveProject(data, input.projectId);
  const note = (input.note ?? '').trim();
  if (note.length > NOTE_MAX) fail('La nota es demasiado larga.');
  const id = input.id ?? newId();
  const ops = createTaskOps(data, { id, project_id: project.id, title: cleanTitle(input.title), note }, newId);
  if (input.photo) {
    const p = input.photo;
    ops.push({ op: 'insert', table: 'tasks.attachments', id: newId(), fields: { tab_id: project.tab_id, project_id: project.id, task_id: id, name: p.name, mime: p.mime, size: p.size, sha256: p.sha256, file_id: p.fileId, position: 1024 } });
  }
  return ops;
}

/** Un paso nuevo (tarea hija) de una tarea, con lo heredado de su proyecto (y la madre hecha vuelve a pendiente). */
export function suggestStepOps(data: Dataset, input: { taskId: Uuid; title: string }, newId: NewId = randomId): Operation[] {
  const parent = liveTask(data, input.taskId);
  return createTaskOps(data, { project_id: parent.project_id, parent_id: parent.id, title: cleanTitle(input.title) }, newId);
}

/** Una línea más al final de la nota de una tarea. */
export function suggestNoteOps(data: Dataset, input: { taskId: Uuid; line: string }): Operation[] {
  const task = liveTask(data, input.taskId);
  const line = input.line.trim();
  if (!line) fail('Escribe la línea que quieres añadir.');
  const note = task.note ? `${task.note.replace(/\s+$/, '')}\n${line}` : line;
  if (note.length > NOTE_MAX) fail('La nota quedaría demasiado larga.');
  return [{ op: 'update', table: 'tasks.tasks', id: task.id, expectedRevision: task.revision, fields: { note } }];
}

/**
 * Lote para aprobar, rehecho con lo que hay ahora (quien aprueba ve el espejo al día):
 * - 'tarea' en otro proyecto (destino editable): la misma tarea, con lo que hereda el proyecto nuevo y la misma foto.
 * - 'anadido' de nota: la línea sobre la nota actual (si alguien la cambió, el lote original ya no encajaría).
 * Devuelve `null` si vale el lote original.
 */
export function approvalOps(data: Dataset, detail: SuggestionDetail | null | undefined, operations: readonly Operation[], options: { projectId?: Uuid | null } = {}, newId: NewId = randomId): Operation[] | null {
  if (!detail) return null;
  if (detail.kind === 'tarea') {
    const target = options.projectId;
    if (!target || target === detail.projectId) return null;
    const task = operations.find((o) => o.op === 'insert' && o.table === 'tasks.tasks');
    const photo = operations.find((o) => o.op === 'insert' && o.table === 'tasks.attachments');
    const f = (photo?.fields ?? null) as Record<string, any> | null;
    return suggestTaskOps(data, {
      id: task?.id, projectId: target, title: detail.title, note: detail.note,
      photo: f ? { fileId: f.file_id, name: f.name, mime: f.mime, size: Number(f.size), sha256: f.sha256 } : null,
    }, newId);
  }
  if (detail.kind === 'anadido' && detail.mode === 'note') {
    const current = data['tasks.tasks'].find((t) => t.id === detail.taskId && !t.deleted_at);
    const proposed = operations.find((o) => o.op === 'update' && o.table === 'tasks.tasks' && o.id === detail.taskId);
    if (!current || !proposed || proposed.expectedRevision === current.revision) return null;
    return suggestNoteOps(data, { taskId: detail.taskId, line: detail.text });
  }
  return null;
}
