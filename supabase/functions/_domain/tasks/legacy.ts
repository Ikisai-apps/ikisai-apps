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
import { personFields, personKey } from './people.ts';
import { POSITION_STEP, reject, type AttachmentRow, type Dataset, type FamilyRow, type LabelRow, type Operation, type Priority, type ProjectStatus, type TaskRow, type Uuid } from './types.ts';

export interface LegacyAttachment { id: Uuid; name: string; mime?: string; size?: number; sha256?: string; url?: string }
/** `general`: del catálogo General (tab_id nulo, FB_2026_023); sale en todas las áreas y se guarda una sola vez. */
export interface LegacyFamily { id: Uuid; name: string; color: string; archived: boolean; system: string | null; version: number; general?: boolean }
export interface LegacyLabel { id: Uuid; text: string; family: Uuid; parent: Uuid | null; archived: boolean; beforeFamilyArchive?: boolean; version: number; general?: boolean }
export interface LegacyView { id: Uuid; name: string; search: string; filters: Record<string, string[]>; groupBy: string; deleted: boolean; version: number }
export interface LegacyTask {
  id: Uuid; text: string; note: string; done: boolean; priority: Priority; due: string; labels: Uuid[]; owner: Uuid | null; parentId: Uuid | null;
  /** FB_2026_041: pasos en orden (en la madre) y fuera de la cadena (en una hija). */
  stepsInOrder?: boolean; stepFree?: boolean;
  /** Espacios de Recursos (R2). Sin el campo, `decompose` no los toca (copias y modelos de antes de R2). */
  spaces?: Uuid[];
  /** Oficios de Central (P2). Sin el campo, `decompose` no los toca. */
  trades?: Uuid[];
  /** Personas de Central (P2, PR 3): ids de persona o `level:<nivel>`. Sin el campo, `decompose` no las toca. */
  people?: string[];
  /** Responsable de Central (P2, PR 3): id de persona o `level:<nivel>`. Sin el campo, `decompose` no lo toca. */
  ownerPerson?: string | null;
  order: number; attachments: LegacyAttachment[]; deleted: boolean; deletedAt: string | null; deleteBatch: string | null; dependsOn: Uuid[]; cost: number | null;
  version: number; updatedAt: string;
  /** Calculados al componer; `decompose` los ignora. */
  blocked?: boolean; blockedBy?: Uuid[]; hiddenBlockers?: number;
}
export interface LegacyProject {
  id: Uuid; title: string; note: string; status: ProjectStatus; priority: Priority; due: string; ownLabels: Uuid[]; owner: Uuid | null;
  /** Espacios de Recursos del proyecto (R2); las tareas nuevas los heredan. Sin el campo, no se tocan. */
  ownSpaces?: Uuid[];
  /** Oficios de Central del proyecto (P2); las tareas nuevas los heredan. Sin el campo, no se tocan. */
  ownTrades?: Uuid[];
  /** Personas de Central del proyecto (P2, PR 3); las tareas nuevas las heredan. Sin el campo, no se tocan. */
  ownPeople?: string[];
  /** Responsable de Central del proyecto (P2, PR 3). Sin el campo, no se toca. */
  ownerPerson?: string | null;
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
  const families = group(live(data['tasks.families']).filter((f) => f.tab_id != null), (f) => f.tab_id!);
  const labels = group(live(data['tasks.labels']).filter((l) => l.tab_id != null), (l) => l.tab_id!);
  // Catálogo General (FB_2026_023): en todas las áreas, delante de lo propio de cada una.
  const generalFamilies = live(data['tasks.families']).filter((f) => f.tab_id == null).sort(byPosition);
  const generalLabels = live(data['tasks.labels']).filter((l) => l.tab_id == null).sort(byPosition);
  const familyOf = (f: FamilyRow, general: boolean) => ({ id: f.id, name: f.name, color: f.color, archived: f.archived, system: f.system_key, version: f.revision, ...(general ? { general: true } : {}) });
  const labelOf = (l: LabelRow, general: boolean) => ({
    id: l.id, text: l.name, family: l.family_id, parent: l.parent_id, archived: l.archived,
    ...(l.archived_before_family === null ? {} : { beforeFamilyArchive: l.archived_before_family }), version: l.revision, ...(general ? { general: true } : {}),
  });
  const views = group(data['tasks.saved_views'], (v) => v.tab_id);
  const projects = group(data['tasks.projects'], (p) => p.tab_id);
  const tasks = group(data['tasks.tasks'], (t) => t.project_id);
  const projectLabels = group(live(data['tasks.project_labels']), (l) => l.project_id);
  const taskLabels = group(live(data['tasks.task_labels']), (l) => l.task_id);
  const taskSpaces = group(live(data['tasks.task_spaces'] ?? []), (s) => s.task_id);
  const projectSpaces = group(live(data['tasks.project_spaces'] ?? []), (s) => s.project_id);
  const taskTrades = group(live(data['tasks.task_trades'] ?? []), (s) => s.task_id);
  const projectTrades = group(live(data['tasks.project_trades'] ?? []), (s) => s.project_id);
  const taskPeople = group(live(data['tasks.task_people'] ?? []), (s) => s.task_id);
  const projectPeople = group(live(data['tasks.project_people'] ?? []), (s) => s.project_id);
  const ownerOf = (row: { owner_person_id?: Uuid | null; owner_house_level?: string | null }) =>
    (row.owner_person_id || row.owner_house_level ? { ownerPerson: personKey({ person_id: row.owner_person_id ?? null, house_level: row.owner_house_level ?? null }) } : {});
  const dependencies = group(live(data['tasks.task_dependencies']), (d) => d.task_id);
  const projectFiles = group(live(data['tasks.attachments']).filter((a) => !a.task_id), (a) => a.project_id);
  const taskFiles = group(live(data['tasks.attachments']), (a) => a.task_id);

  return [...data['tasks.tabs']].sort(byPosition).map((tab) => ({
    id: tab.id, name: tab.name, color: tab.color, deleted: !!tab.deleted_at, version: tab.revision, updatedAt: tab.updated_at,
    ...(options.scopes !== undefined && !fullTab(options.scopes, tab.id) ? { restricted: true } : {}),
    families: [...generalFamilies.map((f) => familyOf(f, true)), ...(families.get(tab.id) ?? []).sort(byPosition).map((f) => familyOf(f, false))],
    labels: [...generalLabels.map((l) => labelOf(l, true)), ...(labels.get(tab.id) ?? []).sort(byPosition).map((l) => labelOf(l, false))],
    views: (views.get(tab.id) ?? []).sort(byPosition).map((v) => ({ id: v.id, name: v.name, search: v.search, filters: v.filters, groupBy: v.group_by, deleted: !!v.deleted_at, version: v.revision })),
    projects: (projects.get(tab.id) ?? []).sort(byPosition).map((p) => ({
      id: p.id, title: p.title, note: p.note, status: p.status, priority: p.priority, due: p.due ?? '', owner: p.owner_label_id,
      ownLabels: (projectLabels.get(p.id) ?? []).sort(byCreation).map((l) => l.label_id),
      // Solo si hay alguno: así un modelo sin espacios (antes de R2) compone igual que siempre.
      ...(projectSpaces.has(p.id) ? { ownSpaces: projectSpaces.get(p.id)!.sort(byCreation).map((s) => s.space_id) } : {}),
      ...(projectTrades.has(p.id) ? { ownTrades: projectTrades.get(p.id)!.sort(byCreation).map((s) => s.trade_id) } : {}),
      ...(projectPeople.has(p.id) ? { ownPeople: projectPeople.get(p.id)!.sort(byCreation).map(personKey) } : {}),
      ...ownerOf(p),
      attachments: (projectFiles.get(p.id) ?? []).sort(byPosition).map(attachment),
      deleted: !!p.deleted_at, deletedAt: p.deleted_at, order: p.position, color: p.color, budget: p.budget, system: p.system,
      version: p.revision, updatedAt: p.updated_at,
      tasks: (tasks.get(p.id) ?? []).sort(byPosition).map((t) => {
        const status = info.get(t.id)!;
        const visibleBlockers = status.blockedBy.filter((id) => known.has(id));
        const hidden = options.hiddenBlockers ? options.hiddenBlockers[t.id] ?? 0 : status.blockedBy.length - visibleBlockers.length;
        return {
          id: t.id, text: t.title, note: t.note, done: status.done, priority: t.priority, due: t.due ?? '', owner: t.owner_label_id, parentId: t.parent_id,
          ...(t.steps_in_order ? { stepsInOrder: true } : {}), ...(t.step_free ? { stepFree: true } : {}),
          labels: (taskLabels.get(t.id) ?? []).sort(byCreation).map((l) => l.label_id),
          ...(taskSpaces.has(t.id) ? { spaces: taskSpaces.get(t.id)!.sort(byCreation).map((s) => s.space_id) } : {}),
          ...(taskTrades.has(t.id) ? { trades: taskTrades.get(t.id)!.sort(byCreation).map((s) => s.trade_id) } : {}),
          ...(taskPeople.has(t.id) ? { people: taskPeople.get(t.id)!.sort(byCreation).map(personKey) } : {}),
          ...ownerOf(t),
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
const personRowKey = (row: Row): Uuid => personKey(row as { person_id?: Uuid | null; house_level?: string | null });
/**
 * Responsable de Central (P2, PR 3), solo si el modelo trae `ownerPerson`. Con él puesto, la etiqueta se vacía (como mucho
 * uno de los tres); nulo, quedan vacíos la persona y el grupo y manda `owner`.
 */
const ownerFields = (item: { ownerPerson?: string | null }): Fields => {
  if (item.ownerPerson === undefined) return {};
  if (!item.ownerPerson) return { owner_person_id: null, owner_house_level: null };
  const f = personFields(item.ownerPerson);
  return { owner_label_id: null, owner_person_id: f.person_id, owner_house_level: f.house_level };
};

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

  const bridges = (table: 'tasks.project_labels' | 'tasks.task_labels' | 'tasks.project_spaces' | 'tasks.task_spaces' | 'tasks.project_trades' | 'tasks.task_trades' | 'tasks.project_people' | 'tasks.task_people' | 'tasks.task_dependencies', ownerKey: string, ownerId: Uuid, projectId: Uuid, targetKey: string | ((row: Row) => Uuid), targets: readonly Uuid[], fields: (target: Uuid, index: number) => Fields) => {
    // Una fila puente en papelera que quedó en otro proyecto no se puede corregir: no se reutiliza, se inserta otra.
    const existing = ((data[table] ?? []) as unknown as Row[]).filter((r) => r[ownerKey] === ownerId && (!r.deleted_at || r.project_id === projectId));
    const keyOf = typeof targetKey === 'string' ? (row: Row) => row[targetKey] as Uuid : targetKey;
    const pick = new Map<Uuid, Row>();
    for (const row of existing) { const current = pick.get(keyOf(row)); if (!current || (current.deleted_at && !row.deleted_at)) pick.set(keyOf(row), row); }
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

  // Lo General sale en todas las áreas del modelo: se guarda una vez, con la copia que cambió (si ninguna, la primera).
  const generalWanted = new Map<string, { table: string; id: Uuid; fields: Fields }[]>();
  const wantGeneral = (table: string, id: Uuid, fields: Fields) => { const key = `${table}|${id}`; generalWanted.set(key, [...(generalWanted.get(key) ?? []), { table, id, fields }]); };
  const isGeneral = (table: string, item: { id: Uuid; general?: boolean }) => !!item.general || (rowOf(table, item.id) !== undefined && rowOf(table, item.id)!.tab_id == null);

  for (const tab of tabs) {
    const tabRow = rowOf('tasks.tabs', tab.id);
    want('tasks.tabs', tab.id, { name: tab.name, color: orNull(tab.color), ...(tabRow ? {} : { position: tabPosition() }) }, !!tab.deleted);

    const familyArchived = new Map<Uuid, boolean>();
    (tab.families ?? []).forEach((f, index) => {
      const row = rowOf('tasks.families', f.id);
      familyArchived.set(f.id, !!f.archived);
      // La marca de familia de responsables ('person') se puede mover (migración 0304); las demás claves no cambian.
      const personMoved = !!row && (row.system_key ?? null) !== (f.system ?? null) && ((row.system_key ?? null) === 'person' || (f.system ?? null) === 'person');
      const general = isGeneral('tasks.families', f);
      const fields: Fields = { name: f.name, color: f.color, archived: !!f.archived, ...(row ? (personMoved ? { system_key: f.system ?? null } : {}) : { tab_id: general ? null : tab.id, position: (index + 1) * POSITION_STEP, system_key: f.system ?? null }) };
      if (general) wantGeneral('tasks.families', f.id, fields); else want('tasks.families', f.id, fields);
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
      const general = isGeneral('tasks.labels', l);
      const all = { ...fields, ...(row ? {} : { tab_id: general ? null : tab.id, position: (index + 1) * POSITION_STEP }) };
      if (general) wantGeneral('tasks.labels', l.id, all); else want('tasks.labels', l.id, all);
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
        ...ownerFields(p),
        ...(row ? {} : { tab_id: tab.id, system: p.system ?? null }),
      }, !!p.deleted);
      bridges('tasks.project_labels', 'project_id', p.id, p.id, 'label_id', p.ownLabels ?? [], (label) => ({ tab_id: tab.id, project_id: p.id, label_id: label }));
      if (p.ownSpaces) bridges('tasks.project_spaces', 'project_id', p.id, p.id, 'space_id', p.ownSpaces, (space) => ({ tab_id: tab.id, project_id: p.id, space_id: space }));
      if (p.ownTrades) bridges('tasks.project_trades', 'project_id', p.id, p.id, 'trade_id', p.ownTrades, (trade) => ({ tab_id: tab.id, project_id: p.id, trade_id: trade }));
      if (p.ownPeople) bridges('tasks.project_people', 'project_id', p.id, p.id, personRowKey, p.ownPeople, (person) => ({ tab_id: tab.id, project_id: p.id, ...personFields(person) }));
      files(tab.id, p.id, null, p.attachments);
      (p.tasks ?? []).forEach((t, taskIndex) => {
        const taskRow = rowOf('tasks.tasks', t.id) as (TaskRow & Row) | undefined;
        const container = containers.has(t.id);
        want('tasks.tasks', t.id, {
          project_id: p.id, parent_id: orNull(t.parentId), title: t.text, note: text(t.note),
          // El `done` de un contenedor se calcula: se guarda como pendiente y no se compara con el valor mostrado.
          done: container ? false : !!t.done,
          priority: t.priority ?? 'normal', due: orNull(t.due), owner_label_id: orNull(t.owner), cost: amount(t.cost),
          // Solo si hay algo que guardar: un espejo de antes de la columna (0320) no la trae, y no debe reescribir cada tarea.
          ...(t.stepsInOrder || taskRow?.steps_in_order ? { steps_in_order: !!t.stepsInOrder } : {}),
          ...(t.stepFree || taskRow?.step_free ? { step_free: !!t.stepFree } : {}),
          position: typeof t.order === 'number' ? t.order : (taskIndex + 1) * POSITION_STEP,
          ...ownerFields(t),
          ...(taskRow ? {} : { tab_id: tab.id }),
        }, deletedWanted.get(t.id) ?? false);
        bridges('tasks.task_labels', 'task_id', t.id, p.id, 'label_id', t.labels ?? [], (label) => ({ tab_id: tab.id, project_id: p.id, task_id: t.id, label_id: label }));
        if (t.spaces) bridges('tasks.task_spaces', 'task_id', t.id, p.id, 'space_id', t.spaces, (space) => ({ tab_id: tab.id, project_id: p.id, task_id: t.id, space_id: space }));
        if (t.trades) bridges('tasks.task_trades', 'task_id', t.id, p.id, 'trade_id', t.trades, (trade) => ({ tab_id: tab.id, project_id: p.id, task_id: t.id, trade_id: trade }));
        if (t.people) bridges('tasks.task_people', 'task_id', t.id, p.id, personRowKey, t.people, (person) => ({ tab_id: tab.id, project_id: p.id, task_id: t.id, ...personFields(person) }));
        bridges('tasks.task_dependencies', 'task_id', t.id, p.id, 'depends_on_id', t.dependsOn ?? [], (dep, i) => ({ tab_id: tab.id, project_id: p.id, task_id: t.id, depends_on_id: dep, position: (i + 1) * POSITION_STEP }));
        files(tab.id, p.id, t.id, t.attachments);
      });
    });
  }

  for (const copies of generalWanted.values()) {
    const row = rowOf(copies[0]!.table, copies[0]!.id);
    const changed = row ? copies.find((c) => Object.entries(c.fields).some(([k, v]) => !same(row[k] ?? null, v ?? null))) : undefined;
    const pick = changed ?? copies[0]!;
    want(pick.table, pick.id, pick.fields);
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
      // Restaurar y corregir en una sola operación: la fila puede no ser válida tal y como quedó en la papelera
      // (por ejemplo, una hija cuyo padre cambió de proyecto mientras tanto).
      first.push({ op: 'restore', table: d.table, id: d.id, expectedRevision: row.revision, ...(update ? { fields: changed } : {}) });
    } else if (!wasDeleted && d.deleted) {
      if (update) { first.push({ op: 'update', table: d.table, id: d.id, expectedRevision: row.revision, fields: changed }); second.push({ op: 'delete', table: d.table, id: d.id, expectedRevision: row.revision }); }
      else first.push({ op: 'delete', table: d.table, id: d.id, expectedRevision: row.revision });
    } else if (update && !wasDeleted) {
      first.push({ op: 'update', table: d.table, id: d.id, expectedRevision: row.revision, fields: changed });
    }
  }
  return [first, second].filter((batch) => batch.length > 0).map(ordered);
}

const TABLE_ORDER = ['tasks.tabs', 'tasks.families', 'tasks.labels', 'tasks.projects', 'tasks.tasks', 'tasks.project_labels', 'tasks.task_labels', 'tasks.project_spaces', 'tasks.task_spaces', 'tasks.project_trades', 'tasks.task_trades', 'tasks.project_people', 'tasks.task_people', 'tasks.task_dependencies', 'tasks.saved_views', 'tasks.attachments'];

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
