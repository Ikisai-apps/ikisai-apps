/**
 * Tasks · puente entre las filas `tasks.*` y el modelo anidado que usa la interfaz heredada (docs/tasks/API.md §13.1).
 *
 * La interfaz muta `state.tabs` (área → familias, etiquetas, vistas, proyectos → tareas) y llama a `save()`.
 * `compose` construye ese modelo desde el espejo local; `decompose` compara el modelo editado con las filas y
 * devuelve las operaciones de fila que llevan unas a otro, con las cascadas que antes aplicaba el servidor
 * (borrado y restauración por lote, archivo de familia, hijas de un contenedor).
 */
import { statuses } from './graph.ts';
import { fullTab, type Scopes } from './scopes.ts';
import { POSITION_STEP, reject, type AttachmentRow, type Dataset, type LabelRow, type Operation, type Priority, type ProjectStatus, type TaskRow, type Uuid } from './types.ts';

export interface LegacyAttachment { id: Uuid; name: string; mime?: string; size?: number; sha256?: string; url?: string }
export interface LegacyFamily { id: Uuid; name: string; color: string; archived: boolean; system: string | null; version: number }
export interface LegacyLabel { id: Uuid; text: string; family: Uuid; parent: Uuid | null; archived: boolean; beforeFamilyArchive?: boolean; version: number }
export interface LegacyView { id: Uuid; name: string; search: string; filters: Record<string, string[]>; groupBy: string; deleted: boolean; version: number }
export interface LegacyTask {
  id: Uuid; text: string; note: string; done: boolean; priority: Priority; due: string; labels: Uuid[]; owner: Uuid | null; parentId: Uuid | null;
  order: number; attachments: LegacyAttachment[]; deleted: boolean; deletedAt: string | null; deleteBatch: string | null; dependsOn: Uuid[]; cost: number | null;
  version: number; updatedAt: string;
  /** Calculados al componer; `decompose` los ignora. */
  blocked?: boolean; blockedBy?: Uuid[]; hiddenBlockers?: number;
}
export interface LegacyProject {
  id: Uuid; title: string; note: string; status: ProjectStatus; priority: Priority; due: string; ownLabels: Uuid[]; owner: Uuid | null;
  attachments: LegacyAttachment[]; deleted: boolean; deletedAt: string | null; order: number; color: string | null; budget: number | null;
  system: 'inbox' | null; version: number; updatedAt: string; tasks: LegacyTask[];
}
export interface LegacyTab {
  id: Uuid; name: string; color: string | null; deleted: boolean; version: number; updatedAt: string;
  /** Acceso por proyecto: sin catálogo editable ni vistas. */
  restricted?: boolean;
  families: LegacyFamily[]; labels: LegacyLabel[]; projects: LegacyProject[]; views: LegacyView[];
}

export interface ComposeOptions {
  /** Ámbitos del usuario, para marcar las áreas `restricted`. */
  scopes?: Scopes;
  /** Respuesta de `GET blockers`: condiciones ocultas incumplidas por tarea. Sin ella, toda condición ausente cuenta como incumplida. */
  hiddenBlockers?: Record<Uuid, number>;
}

const byPosition = <T extends { position: number; id: string }>(a: T, b: T) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byCreation = <T extends { created_at: string; id: string }>(a: T, b: T) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1);
const live = <T extends { deleted_at: string | null }>(rows: readonly T[]): T[] => rows.filter((r) => !r.deleted_at);

function group<T>(rows: readonly T[], key: (row: T) => string | null): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (k === null) continue;
    const list = map.get(k);
    if (list) list.push(row); else map.set(k, [row]);
  }
  return map;
}

const attachment = (row: AttachmentRow): LegacyAttachment => ({ id: row.id, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256, url: `/api/v1/attachments/${row.id}` });

/** Modelo anidado a partir de las filas del espejo (incluida la papelera de áreas, proyectos, tareas y vistas). */
export function compose(data: Dataset, options: ComposeOptions = {}): LegacyTab[] {
  const info = statuses({ tasks: data['tasks.tasks'], projects: data['tasks.projects'], dependencies: data['tasks.task_dependencies'] });
  const known = new Set(data['tasks.tasks'].map((t) => t.id));
  const families = group(live(data['tasks.families']), (f) => f.tab_id);
  const labels = group(live(data['tasks.labels']), (l) => l.tab_id);
  const views = group(data['tasks.saved_views'], (v) => v.tab_id);
  const projects = group(data['tasks.projects'], (p) => p.tab_id);
  const tasks = group(data['tasks.tasks'], (t) => t.project_id);
  const projectLabels = group(live(data['tasks.project_labels']), (l) => l.project_id);
  const taskLabels = group(live(data['tasks.task_labels']), (l) => l.task_id);
  const dependencies = group(live(data['tasks.task_dependencies']), (d) => d.task_id);
  const projectFiles = group(live(data['tasks.attachments']).filter((a) => !a.task_id), (a) => a.project_id);
  const taskFiles = group(live(data['tasks.attachments']), (a) => a.task_id);

  return [...data['tasks.tabs']].sort(byPosition).map((tab) => ({
    id: tab.id, name: tab.name, color: tab.color, deleted: !!tab.deleted_at, version: tab.revision, updatedAt: tab.updated_at,
    ...(options.scopes !== undefined && !fullTab(options.scopes, tab.id) ? { restricted: true } : {}),
    families: (families.get(tab.id) ?? []).sort(byPosition).map((f) => ({ id: f.id, name: f.name, color: f.color, archived: f.archived, system: f.system_key, version: f.revision })),
    labels: (labels.get(tab.id) ?? []).sort(byPosition).map((l) => ({
      id: l.id, text: l.name, family: l.family_id, parent: l.parent_id, archived: l.archived,
      ...(l.archived_before_family === null ? {} : { beforeFamilyArchive: l.archived_before_family }), version: l.revision,
    })),
    views: (views.get(tab.id) ?? []).sort(byPosition).map((v) => ({ id: v.id, name: v.name, search: v.search, filters: v.filters, groupBy: v.group_by, deleted: !!v.deleted_at, version: v.revision })),
    projects: (projects.get(tab.id) ?? []).sort(byPosition).map((p) => ({
      id: p.id, title: p.title, note: p.note, status: p.status, priority: p.priority, due: p.due ?? '', owner: p.owner_label_id,
      ownLabels: (projectLabels.get(p.id) ?? []).sort(byCreation).map((l) => l.label_id),
      attachments: (projectFiles.get(p.id) ?? []).sort(byPosition).map(attachment),
      deleted: !!p.deleted_at, deletedAt: p.deleted_at, order: p.position, color: p.color, budget: p.budget, system: p.system,
      version: p.revision, updatedAt: p.updated_at,
      tasks: (tasks.get(p.id) ?? []).sort(byPosition).map((t) => {
        const status = info.get(t.id)!;
        const visibleBlockers = status.blockedBy.filter((id) => known.has(id));
        const hidden = options.hiddenBlockers ? options.hiddenBlockers[t.id] ?? 0 : status.blockedBy.length - visibleBlockers.length;
        return {
          id: t.id, text: t.title, note: t.note, done: status.done, priority: t.priority, due: t.due ?? '', owner: t.owner_label_id, parentId: t.parent_id,
          labels: (taskLabels.get(t.id) ?? []).sort(byCreation).map((l) => l.label_id),
          dependsOn: (dependencies.get(t.id) ?? []).sort(byPosition).map((d) => d.depends_on_id),
          attachments: (taskFiles.get(t.id) ?? []).sort(byPosition).map(attachment),
          order: t.position, deleted: !!t.deleted_at, deletedAt: t.deleted_at, deleteBatch: t.deleted_at, cost: t.cost,
          version: t.revision, updatedAt: t.updated_at,
          blocked: !status.done && visibleBlockers.length + hidden > 0, blockedBy: status.done ? [] : visibleBlockers, hiddenBlockers: status.done ? 0 : hidden,
        };
      }),
    })),
  }));
}

// ---------------------------------------------------------------------------------------------------------------------
// decompose
// ---------------------------------------------------------------------------------------------------------------------

type Fields = Record<string, unknown>;
interface Desired { table: string; id: Uuid; fields: Fields; deleted: boolean }
type Row = { id: Uuid; revision: number; deleted_at: string | null } & Record<string, unknown>;

const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
};
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, sortKeys((value as Fields)[k])]));
  return value;
}

const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const orNull = <T>(value: T | null | undefined | ''): T | null => (value === undefined || value === '' ? null : (value as T | null));
const amount = (value: unknown): number | null => (typeof value === 'number' ? value : null);

/**
 * Operaciones de fila que llevan las filas actuales al modelo editado. Devuelve uno o dos lotes: el segundo solo
 * existe cuando una misma fila necesita cambiar campos y además borrarse o restaurarse (una operación por fila y lote).
 * Las operaciones del segundo lote llevan la misma `expectedRevision` que vio el espejo, como pide `sync-client`
 * (que la ajusta al confirmar el primero); quien confirme sin él debe volver a descomponer tras el primer lote.
 * Lo ausente del modelo pasa a la papelera (áreas, proyectos, tareas, vistas); el catálogo no se borra, se archiva.
 */
export function decompose(data: Dataset, tabs: readonly LegacyTab[], newId: () => Uuid = () => crypto.randomUUID()): Operation[][] {
  const rows = new Map<string, Row>();
  for (const [table, list] of Object.entries(data)) for (const row of list as unknown as Row[]) rows.set(`${table}|${row.id}`, row);
  const rowOf = (table: string, id: Uuid) => rows.get(`${table}|${id}`);
  const desired: Desired[] = [];
  const want = (table: string, id: Uuid, fields: Fields, deleted = false) => { desired.push({ table, id, fields, deleted }); };

  const tabPosition = (() => { let max = Math.max(0, ...data['tasks.tabs'].map((t) => t.position || 0)); return () => (max += POSITION_STEP); })();
  const taskRows = data['tasks.tasks'];
  const modelTasks = new Map<Uuid, { task: LegacyTask; project: LegacyProject; tab: LegacyTab }>();
  for (const tab of tabs) for (const project of tab.projects ?? []) for (const task of project.tasks ?? []) modelTasks.set(task.id, { task, project, tab });

  // La interfaz ya propaga en el modelo el borrado a las hijas y la restauración a todo el lote. Aquí solo se garantiza
  // la regla que el servidor exige, de forma idempotente: una hija no queda viva bajo un padre en la papelera.
  const deletedWanted = new Map<Uuid, boolean>();
  for (const [id, { task }] of modelTasks) {
    const parent = task.parentId ? modelTasks.get(task.parentId)?.task : undefined;
    deletedWanted.set(id, !!task.deleted || !!parent?.deleted);
  }
  // Contenedor: tiene alguna hija que está viva ahora o lo estará tras este guardado. Borrar un padre con sus hijas
  // no lo convierte en hoja: su `done` (calculado al componer) no se escribe.
  const containers = new Set<Uuid>();
  for (const [id, { task }] of modelTasks) {
    if (!task.parentId) continue;
    const row = taskRows.find((r) => r.id === id);
    if (!deletedWanted.get(id) || !row || !row.deleted_at) containers.add(task.parentId);
  }

  const bridges = (table: 'tasks.project_labels' | 'tasks.task_labels' | 'tasks.task_dependencies', ownerKey: string, ownerId: Uuid, projectId: Uuid, targetKey: string, targets: readonly Uuid[], fields: (target: Uuid, index: number) => Fields) => {
    // Una fila puente en papelera que quedó en otro proyecto no se puede corregir: no se reutiliza, se inserta otra.
    const existing = (data[table] as unknown as Row[]).filter((r) => r[ownerKey] === ownerId && (!r.deleted_at || r.project_id === projectId));
    const pick = new Map<Uuid, Row>();
    for (const row of existing) { const current = pick.get(row[targetKey] as Uuid); if (!current || (current.deleted_at && !row.deleted_at)) pick.set(row[targetKey] as Uuid, row); }
    const wanted = [...new Set(targets)];
    wanted.forEach((target, index) => want(table, pick.get(target)?.id ?? newId(), fields(target, index)));
    for (const [target, row] of pick) if (!wanted.includes(target) && !row.deleted_at) want(table, row.id, {}, true);
  };
  const files = (tabId: Uuid, projectId: Uuid, taskId: Uuid | null, list: readonly LegacyAttachment[] | undefined) => {
    const existing = live(data['tasks.attachments']).filter((a) => (taskId ? a.task_id === taskId : a.project_id === projectId && !a.task_id));
    const keep = new Set((list ?? []).map((a) => a.id));
    (list ?? []).forEach((a, index) => {
      const row = rowOf('tasks.attachments', a.id);
      if (row) { want('tasks.attachments', a.id, { project_id: projectId }); return; }
      if (!a.sha256 || typeof a.size !== 'number' || !a.mime) reject(422, 'INVALID_ATTACHMENT', 'Sube el archivo antes de asociarlo.', { attachmentId: a.id });
      want('tasks.attachments', a.id, { tab_id: tabId, project_id: projectId, task_id: taskId, name: a.name, mime: a.mime, size: a.size, sha256: a.sha256, file_id: { $blob: a.sha256 }, position: (index + 1) * POSITION_STEP });
    });
    for (const row of existing) if (!keep.has(row.id)) want('tasks.attachments', row.id, {}, true);
  };

  for (const tab of tabs) {
    const tabRow = rowOf('tasks.tabs', tab.id);
    want('tasks.tabs', tab.id, { name: tab.name, color: orNull(tab.color), ...(tabRow ? {} : { position: tabPosition() }) }, !!tab.deleted);

    const familyArchived = new Map<Uuid, boolean>();
    (tab.families ?? []).forEach((f, index) => {
      const row = rowOf('tasks.families', f.id);
      familyArchived.set(f.id, !!f.archived);
      want('tasks.families', f.id, { name: f.name, color: f.color, archived: !!f.archived, ...(row ? {} : { tab_id: tab.id, position: (index + 1) * POSITION_STEP, system_key: f.system ?? null }) });
    });
    (tab.labels ?? []).forEach((l, index) => {
      const row = rowOf('tasks.labels', l.id) as (LabelRow & Row) | undefined;
      const fields: Fields = { family_id: l.family, parent_id: orNull(l.parent), name: l.text, archived: !!l.archived };
      // Etiquetas de una familia archivada: siempre archivadas, recordando su estado previo. Al reactivarla lo recuperan.
      // La interfaz ya lo hace en el modelo; estas reglas dan el mismo resultado si no lo hizo, y repetidas no cambian nada.
      if (familyArchived.get(l.family)) {
        fields.archived = true;
        fields.archived_before_family = l.beforeFamilyArchive ?? (row ? row.archived_before_family ?? row.archived : !!l.archived);
      } else {
        if (l.beforeFamilyArchive !== undefined) fields.archived = !!l.beforeFamilyArchive;
        fields.archived_before_family = null;
      }
      want('tasks.labels', l.id, { ...fields, ...(row ? {} : { tab_id: tab.id, position: (index + 1) * POSITION_STEP }) });
    });
    (tab.views ?? []).forEach((v, index) => {
      const row = rowOf('tasks.saved_views', v.id);
      want('tasks.saved_views', v.id, { name: v.name, search: text(v.search), filters: v.filters ?? {}, group_by: v.groupBy || 'project', ...(row ? {} : { tab_id: tab.id, position: (index + 1) * POSITION_STEP }) }, !!v.deleted);
    });
    (tab.projects ?? []).forEach((p, index) => {
      const row = rowOf('tasks.projects', p.id);
      want('tasks.projects', p.id, {
        title: p.title, note: text(p.note), status: p.status ?? 'active', priority: p.priority ?? 'normal', due: orNull(p.due), owner_label_id: orNull(p.owner),
        color: orNull(p.color), budget: amount(p.budget), position: typeof p.order === 'number' ? p.order : (index + 1) * POSITION_STEP,
        ...(row ? {} : { tab_id: tab.id, system: p.system ?? null }),
      }, !!p.deleted);
      bridges('tasks.project_labels', 'project_id', p.id, p.id, 'label_id', p.ownLabels ?? [], (label) => ({ tab_id: tab.id, project_id: p.id, label_id: label }));
      files(tab.id, p.id, null, p.attachments);
      (p.tasks ?? []).forEach((t, taskIndex) => {
        const taskRow = rowOf('tasks.tasks', t.id) as (TaskRow & Row) | undefined;
        const container = containers.has(t.id);
        want('tasks.tasks', t.id, {
          project_id: p.id, parent_id: orNull(t.parentId), title: t.text, note: text(t.note),
          // El `done` de un contenedor se calcula: se guarda como pendiente y no se compara con el valor mostrado.
          done: container ? false : !!t.done,
          priority: t.priority ?? 'normal', due: orNull(t.due), owner_label_id: orNull(t.owner), cost: amount(t.cost),
          position: typeof t.order === 'number' ? t.order : (taskIndex + 1) * POSITION_STEP,
          ...(taskRow ? {} : { tab_id: tab.id }),
        }, deletedWanted.get(t.id) ?? false);
        bridges('tasks.task_labels', 'task_id', t.id, p.id, 'label_id', t.labels ?? [], (label) => ({ tab_id: tab.id, project_id: p.id, task_id: t.id, label_id: label }));
        bridges('tasks.task_dependencies', 'task_id', t.id, p.id, 'depends_on_id', t.dependsOn ?? [], (dep, i) => ({ tab_id: tab.id, project_id: p.id, task_id: t.id, depends_on_id: dep, position: (i + 1) * POSITION_STEP }));
        files(tab.id, p.id, t.id, t.attachments);
      });
    });
  }

  // Lo que estaba en el modelo y ya no está pasa a la papelera.
  const mentioned = new Set(desired.map((d) => `${d.table}|${d.id}`));
  for (const table of ['tasks.tabs', 'tasks.projects', 'tasks.tasks', 'tasks.saved_views'] as const) {
    for (const row of data[table]) if (!row.deleted_at && !mentioned.has(`${table}|${row.id}`)) want(table, row.id, {}, true);
  }

  const first: Operation[] = [];
  const second: Operation[] = [];
  for (const d of desired) {
    const row = rowOf(d.table, d.id);
    if (!row) {
      first.push({ op: 'insert', table: d.table, id: d.id, fields: d.fields });
      if (d.deleted) second.push({ op: 'delete', table: d.table, id: d.id, expectedRevision: 0 });
      continue;
    }
    const changed: Fields = {};
    for (const [key, value] of Object.entries(d.fields)) if (!same(row[key] ?? null, value ?? null)) changed[key] = value;
    const update = Object.keys(changed).length > 0;
    const wasDeleted = !!row.deleted_at;
    if (wasDeleted && !d.deleted) {
      first.push({ op: 'restore', table: d.table, id: d.id, expectedRevision: row.revision });
      if (update) second.push({ op: 'update', table: d.table, id: d.id, expectedRevision: row.revision, fields: changed });
    } else if (!wasDeleted && d.deleted) {
      if (update) { first.push({ op: 'update', table: d.table, id: d.id, expectedRevision: row.revision, fields: changed }); second.push({ op: 'delete', table: d.table, id: d.id, expectedRevision: row.revision }); }
      else first.push({ op: 'delete', table: d.table, id: d.id, expectedRevision: row.revision });
    } else if (update && !wasDeleted) {
      first.push({ op: 'update', table: d.table, id: d.id, expectedRevision: row.revision, fields: changed });
    }
  }
  return [first, second].filter((batch) => batch.length > 0).map(ordered);
}

const TABLE_ORDER = ['tasks.tabs', 'tasks.families', 'tasks.labels', 'tasks.projects', 'tasks.tasks', 'tasks.project_labels', 'tasks.task_labels', 'tasks.task_dependencies', 'tasks.saved_views', 'tasks.attachments'];

/** Orden canónico de tablas; dentro de tareas y etiquetas, los padres antes que sus hijas (las FK son inmediatas). */
function ordered(operations: Operation[]): Operation[] {
  const inserted = new Map<string, Operation>();
  for (const op of operations) if (op.op === 'insert' && (op.table === 'tasks.tasks' || op.table === 'tasks.labels')) inserted.set(`${op.table}|${op.id}`, op);
  const depth = (op: Operation): number => {
    let level = 0;
    let current: Operation | undefined = op;
    while (current?.op === 'insert' && typeof current.fields?.parent_id === 'string' && level < 64) {
      level += 1;
      current = inserted.get(`${current.table}|${current.fields.parent_id}`);
    }
    return level;
  };
  const rank = (op: Operation) => TABLE_ORDER.indexOf(op.table ?? '') * 100 + (inserted.has(`${op.table}|${op.id}`) ? depth(op) : 0);
  return operations.map((op, index) => ({ op, index, rank: rank(op) })).sort((a, b) => a.rank - b.rank || a.index - b.index).map((x) => x.op);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYSTEM_FAMILIES = ['person', 'trade', 'phase', 'building', 'space'];

/**
 * La interfaz heredada crea las familias por defecto de un área nueva con ids fijos (`person`, `trade`…).
 * Sustituye en el propio modelo esos ids por uuid, conserva la clave en `system` y corrige las referencias
 * (familia de las etiquetas, filtros y agrupación de las vistas). Se llama antes de `decompose`.
 */
export function adoptLegacyIds(tabs: LegacyTab[], newId: () => Uuid = () => crypto.randomUUID()): void {
  for (const tab of tabs) {
    const renamed = new Map<string, Uuid>();
    for (const family of tab.families ?? []) {
      if (UUID.test(family.id)) continue;
      const id = newId();
      renamed.set(family.id, id);
      if (family.system == null) family.system = SYSTEM_FAMILIES.includes(family.id) ? family.id : null;
      family.id = id;
    }
    if (!renamed.size) continue;
    for (const label of tab.labels ?? []) label.family = renamed.get(label.family) ?? label.family;
    for (const view of tab.views ?? []) {
      view.groupBy = renamed.get(view.groupBy) ?? view.groupBy;
      view.filters = Object.fromEntries(Object.entries(view.filters ?? {}).map(([key, ids]) => [renamed.get(key) ?? key, ids]));
    }
  }
}
