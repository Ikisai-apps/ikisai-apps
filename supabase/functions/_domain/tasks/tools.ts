/**
 * Tasks · herramientas de dominio para agentes (docs/tasks/AGENTES.md §6). Cada herramienta recibe una entrada JSON
 * no fiable (la de un agente por MCP), la valida y devuelve el lote de operaciones de fila, con sus cascadas, que
 * después pasa por el camino de siempre: `beforeCommit`, riesgo, propuesta si hace falta y `core.commit`.
 *
 * Son funciones puras sobre el `Dataset` que el agente puede ver: lo que no ve no existe (`NOT_FOUND`), igual que una
 * fila borrada para las que solo trabajan sobre filas vivas. Conectarlas a `AppConfig.mcpTools` es una línea por
 * herramienta: `{ ...spec, build: (input, data, newId) => buildTaskTool(spec.name, data, input, newId) }`.
 */
import { createTaskOps, deleteTaskOps, moveTaskOps, setDependenciesOps, setTaskDoneOps, setTaskLabelsOps, type NewId } from './ops.ts';
import { preparePlanOps, reorderSupplyOps, requestPurchaseOps } from './purchases.ts';
import { fullTab, type Scopes } from './scopes.ts';
import { reject, type Dataset, type Operation, type Priority, type TaskRow, type Uuid } from './types.ts';

export type TaskToolName =
  | 'tasks_create_task' | 'tasks_update_task' | 'tasks_complete' | 'tasks_move' | 'tasks_delete' | 'tasks_set_labels' | 'tasks_set_dependencies'
  | 'tasks_request_purchase' | 'tasks_prepare_purchase_plan';

export interface TaskToolSpec {
  name: TaskToolName;
  description: string;
  /** JSON Schema de la entrada, para `tools/list`. La validación real la hace `buildTaskTool`. */
  inputSchema: Record<string, unknown>;
  /** Pistas MCP: si la herramienta puede borrar (`destructiveHint`) o no cambia nada al repetirla (`idempotentHint`). */
  annotations: { destructiveHint: boolean; idempotentHint: boolean };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PRIORITIES: readonly Priority[] = ['normal', 'high', 'critical'];
const uuid = { type: 'string', format: 'uuid' };
const uuids = { type: 'array', items: uuid, uniqueItems: true, maxItems: 100 };
const TASK_FIELD_SCHEMA = {
  title: { type: 'string', minLength: 1, maxLength: 500 },
  note: { type: 'string', maxLength: 20000 },
  priority: { type: 'string', enum: PRIORITIES },
  due: { type: ['string', 'null'], description: 'Fecha objetivo AAAA-MM-DD, o null para quitarla.' },
  owner_label_id: { ...uuid, type: ['string', 'null'], description: 'Etiqueta de la familia Persona que hace de responsable.' },
  cost: { type: ['number', 'null'], minimum: 0 },
};

export const TASK_TOOL_SPECS: readonly TaskToolSpec[] = [
  {
    name: 'tasks_create_task',
    description: 'Crea una tarea en un proyecto, opcionalmente como hija de otra, con etiquetas (por defecto las del proyecto) y dependencias.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['project_id', 'title'], properties: { project_id: uuid, parent_id: { ...uuid, type: ['string', 'null'] }, ...TASK_FIELD_SCHEMA, label_ids: uuids, depends_on_ids: uuids } },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'tasks_update_task',
    description: 'Cambia nombre, nota, prioridad, fecha, responsable o coste de una tarea. Para completarla, moverla o etiquetarla usa sus herramientas.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['task_id'], minProperties: 2, properties: { task_id: uuid, ...TASK_FIELD_SCHEMA } },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'tasks_complete',
    description: 'Completa o reabre una tarea. En una tarea con hijas se aplica a cada hija viva; el padre se calcula.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['task_id'], properties: { task_id: uuid, done: { type: 'boolean', default: true } } },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'tasks_move',
    description: 'Mueve una tarea, con sus hijas, etiquetas, dependencias y adjuntos, a otro proyecto de la misma área, o la cuelga de otra tarea.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['task_id', 'project_id'], properties: { task_id: uuid, project_id: uuid, parent_id: { ...uuid, type: ['string', 'null'] }, position: { type: 'number' } } },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'tasks_delete',
    description: 'Envía a la papelera una tarea y sus hijas vivas. Siempre necesita la aprobación de una persona.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['task_id'], properties: { task_id: uuid } },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  {
    name: 'tasks_set_labels',
    description: 'Deja en una tarea exactamente estas etiquetas (quita las demás).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['task_id', 'label_ids'], properties: { task_id: uuid, label_ids: uuids } },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'tasks_set_dependencies',
    description: 'Deja en una tarea exactamente estas dependencias, en este orden (tareas que deben completarse antes).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['task_id', 'depends_on_ids'], properties: { task_id: uuid, depends_on_ids: uuids } },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  // Compras (§18). Pedir es seguro: la solicitud nace «pedida» y nada se compra sin que la apruebe el responsable de
  // compras del área. Preparar un plan siempre pide aprobación: es la lista con la que alguien saldrá a comprar.
  {
    name: 'tasks_request_purchase',
    description: 'Pide una compra: crea una solicitud «pedida» que el responsable de compras del área aprobará o rechazará. Con supply_item_id es «Queda poco: pedir»: toma del suministro el nombre, la unidad, el proveedor y la cantidad de reposición (o lo que falta hasta el mínimo), y los campos que indiques los sustituyen. Sin suministro, indica tab_id (o project_id o task_id) y title.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      supply_item_id: uuid, tab_id: uuid, project_id: uuid, task_id: uuid,
      title: { type: 'string', minLength: 1, maxLength: 300 }, note: { type: 'string', maxLength: 5000 },
      quantity: { type: 'number', exclusiveMinimum: 0 }, unit: { type: 'string', maxLength: 20 }, estimated_amount: { type: 'number', minimum: 0 },
      priority: { type: 'string', enum: PRIORITIES }, due: { type: 'string', description: 'Para cuándo, AAAA-MM-DD.' },
      supplier_name: { type: 'string', maxLength: 200 }, needs_invoice: { type: 'boolean', default: true },
      repeat_days: { type: 'integer', minimum: 1, maximum: 366, description: 'Compra recurrente: cada cuántos días.' },
    } },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'tasks_prepare_purchase_plan',
    description: 'Prepara un plan de compras del área: una parada por proveedor con las solicitudes aprobadas que aún no están en ningún plan. Siempre necesita la aprobación de una persona. Las compras recurrentes que tocan las añade quien aprueba desde la app.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['tab_id'], properties: {
      tab_id: uuid, title: { type: 'string', minLength: 1, maxLength: 200 }, planned_for: { type: 'string', description: 'Día previsto, AAAA-MM-DD.' },
    } },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
];

// --- Validación de la entrada ---------------------------------------------------------------------------------------

type Input = Record<string, unknown>;
const invalid = (field: string, message: string): never => reject(422, 'INVALID_INPUT', message, { field });
const notFound = (what: string, id: string): never => reject(404, 'NOT_FOUND', `No existe ${what} o no tienes acceso.`, { id });

function object(input: unknown, allowed: readonly string[]): Input {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('', 'La entrada debe ser un objeto.');
  for (const key of Object.keys(input as Input)) if (!allowed.includes(key)) invalid(key, `Campo desconocido: ${key}.`);
  return input as Input;
}
function id(input: Input, field: string, required = true): Uuid | undefined {
  const value = input[field];
  if (value === undefined) return required ? invalid(field, `Falta ${field}.`) : undefined;
  if (typeof value !== 'string' || !UUID.test(value)) invalid(field, `${field} debe ser un uuid.`);
  return (value as string).toLowerCase();
}
function nullableId(input: Input, field: string): Uuid | null | undefined {
  return input[field] === null ? null : id(input, field, false);
}
function idList(input: Input, field: string, required: boolean): Uuid[] | undefined {
  const value = input[field];
  if (value === undefined) return required ? invalid(field, `Falta ${field}.`) : undefined;
  if (!Array.isArray(value) || value.length > 100 || value.some((v) => typeof v !== 'string' || !UUID.test(v))) invalid(field, `${field} debe ser una lista de hasta 100 uuid.`);
  const list = (value as string[]).map((v) => v.toLowerCase());
  if (new Set(list).size !== list.length) invalid(field, `${field} tiene elementos repetidos.`);
  return list;
}
/** Campos editables de una tarea: solo los presentes, ya validados y normalizados. */
function editableFields(input: Input): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 500) invalid('title', 'El nombre no puede estar vacío ni pasar de 500 caracteres.');
    out.title = (input.title as string).trim();
  }
  if (input.note !== undefined) {
    if (typeof input.note !== 'string' || input.note.length > 20000) invalid('note', 'La nota debe ser texto de hasta 20 000 caracteres.');
    out.note = input.note;
  }
  if (input.priority !== undefined) {
    if (!PRIORITIES.includes(input.priority as Priority)) invalid('priority', 'La prioridad es normal, high o critical.');
    out.priority = input.priority;
  }
  if (input.due !== undefined) {
    if (input.due !== null && (typeof input.due !== 'string' || !DATE.test(input.due) || Number.isNaN(Date.parse(input.due)))) invalid('due', 'La fecha va como AAAA-MM-DD, o null.');
    out.due = input.due;
  }
  if (input.owner_label_id !== undefined) out.owner_label_id = nullableId(input, 'owner_label_id');
  if (input.cost !== undefined) {
    if (input.cost !== null && (typeof input.cost !== 'number' || !Number.isFinite(input.cost) || input.cost < 0)) invalid('cost', 'El coste es un número no negativo, o null.');
    out.cost = input.cost;
  }
  return out;
}

// --- Búsquedas sobre lo visible -------------------------------------------------------------------------------------

function liveTask(data: Dataset, taskId: Uuid): TaskRow {
  const task = data['tasks.tasks'].find((t) => t.id === taskId);
  if (!task || task.deleted_at) notFound('la tarea', taskId);
  return task!;
}
function liveProject(data: Dataset, projectId: Uuid) {
  const project = data['tasks.projects'].find((p) => p.id === projectId);
  if (!project || project.deleted_at) notFound('el proyecto', projectId);
  return project!;
}
function liveLabels(data: Dataset, tabId: Uuid, labelIds: readonly Uuid[], field: string): void {
  for (const labelId of labelIds) {
    const label = data['tasks.labels'].find((l) => l.id === labelId);
    if (!label || label.deleted_at) notFound('la etiqueta', labelId);
    if (label!.tab_id !== tabId) invalid(field, 'Las etiquetas deben ser del área de la tarea.');
    if (label!.archived) invalid(field, 'No se puede usar una etiqueta archivada.');
  }
}
function liveTasks(data: Dataset, tabId: Uuid, taskIds: readonly Uuid[], field: string): void {
  for (const taskId of taskIds) if (liveTask(data, taskId).tab_id !== tabId) invalid(field, 'Las dependencias deben ser del área de la tarea.');
}
function validParent(data: Dataset, parentId: Uuid | null | undefined, projectId: Uuid, taskId?: Uuid): void {
  if (parentId === undefined || parentId === null) return;
  if (parentId === taskId) invalid('parent_id', 'Una tarea no puede colgar de sí misma.');
  const parent = liveTask(data, parentId);
  if (parent.parent_id) invalid('parent_id', 'Solo hay un nivel de hijas: el padre no puede ser a su vez una hija.');
  if (parent.project_id !== projectId) invalid('parent_id', 'La tarea padre debe estar en el mismo proyecto.');
  if (taskId && data['tasks.tasks'].some((t) => t.parent_id === taskId && !t.deleted_at)) invalid('parent_id', 'Una tarea con hijas no puede colgar de otra.');
}

function text(input: Input, field: string, max: number): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) invalid(field, `${field} debe ser texto de hasta ${max} caracteres.`);
  return (value as string).trim();
}
function amount(input: Input, field: string, positive: boolean): number | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (positive && value === 0)) invalid(field, `${field} debe ser un número ${positive ? 'mayor que cero' : 'no negativo'}.`);
  return value as number;
}
function day(input: Input, field: string): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(value))) invalid(field, `${field} va como AAAA-MM-DD.`);
  return value as string;
}
function liveTab(data: Dataset, tabId: Uuid) {
  const tab = data['tasks.tabs'].find((t) => t.id === tabId);
  if (!tab || tab.deleted_at) notFound('el área', tabId);
  return tab!;
}
/** El almacén, los planes y lo que se pide para el área en general son del área entera (la Edge lo vuelve a comprobar). */
function wholeTab(scopes: Scopes | undefined, tabId: Uuid): void {
  if (scopes !== undefined && !fullTab(scopes, tabId)) reject(403, 'FORBIDDEN', 'Esto es del área entera y tu acceso es a algunos proyectos.', { tab_id: tabId });
}

/** Opciones de construcción: el día de hoy (para el título del plan) y los ámbitos de quien llama. */
export interface TaskToolOptions { today?: string; scopes?: Scopes }

// --- Constructores --------------------------------------------------------------------------------------------------

/** Valida la entrada de una herramienta y devuelve su lote. Lanza `DomainError` (422 `INVALID_INPUT`, 404 `NOT_FOUND`). */
export function buildTaskTool(name: TaskToolName, data: Dataset, raw: unknown, newId?: NewId, options: TaskToolOptions = {}): Operation[] {
  switch (name) {
    case 'tasks_create_task': {
      const input = object(raw, ['project_id', 'parent_id', 'title', 'note', 'priority', 'due', 'owner_label_id', 'cost', 'label_ids', 'depends_on_ids']);
      const project = liveProject(data, id(input, 'project_id')!);
      if (input.title === undefined) invalid('title', 'Falta title.');
      const fields = editableFields(input);
      const parentId = nullableId(input, 'parent_id');
      validParent(data, parentId, project.id);
      const labelIds = idList(input, 'label_ids', false), dependsOnIds = idList(input, 'depends_on_ids', false);
      if (labelIds) liveLabels(data, project.tab_id, labelIds, 'label_ids');
      if (fields.owner_label_id) liveLabels(data, project.tab_id, [fields.owner_label_id as Uuid], 'owner_label_id');
      if (dependsOnIds) liveTasks(data, project.tab_id, dependsOnIds, 'depends_on_ids');
      return createTaskOps(data, { project_id: project.id, parent_id: parentId ?? null, title: fields.title as string, ...fields, labelIds, dependsOnIds }, newId);
    }
    case 'tasks_update_task': {
      const input = object(raw, ['task_id', 'title', 'note', 'priority', 'due', 'owner_label_id', 'cost']);
      const task = liveTask(data, id(input, 'task_id')!);
      const fields = editableFields(input);
      if (!Object.keys(fields).length) invalid('', 'Indica al menos un campo que cambiar.');
      if (fields.owner_label_id) liveLabels(data, task.tab_id, [fields.owner_label_id as Uuid], 'owner_label_id');
      const changed = Object.fromEntries(Object.entries(fields).filter(([key, value]) => (task as unknown as Input)[key] !== value));
      return Object.keys(changed).length ? [{ op: 'update', table: 'tasks.tasks', id: task.id, expectedRevision: task.revision, fields: changed }] : [];
    }
    case 'tasks_complete': {
      const input = object(raw, ['task_id', 'done']);
      const task = liveTask(data, id(input, 'task_id')!);
      if (input.done !== undefined && typeof input.done !== 'boolean') invalid('done', 'done es true o false.');
      return setTaskDoneOps(data, task.id, input.done !== false);
    }
    case 'tasks_move': {
      const input = object(raw, ['task_id', 'project_id', 'parent_id', 'position']);
      const task = liveTask(data, id(input, 'task_id')!);
      const project = liveProject(data, id(input, 'project_id')!);
      if (project.tab_id !== task.tab_id) invalid('project_id', 'Solo se mueve dentro de la misma área.');
      const parentId = nullableId(input, 'parent_id');
      validParent(data, parentId, project.id, task.id);
      if (input.position !== undefined && (typeof input.position !== 'number' || !Number.isFinite(input.position))) invalid('position', 'position es un número.');
      return moveTaskOps(data, task.id, { project_id: project.id, ...(parentId !== undefined ? { parent_id: parentId } : {}), ...(input.position !== undefined ? { position: input.position as number } : {}) });
    }
    case 'tasks_delete': {
      const input = object(raw, ['task_id']);
      return deleteTaskOps(data, liveTask(data, id(input, 'task_id')!).id);
    }
    case 'tasks_set_labels': {
      const input = object(raw, ['task_id', 'label_ids']);
      const task = liveTask(data, id(input, 'task_id')!);
      const labelIds = idList(input, 'label_ids', true)!;
      liveLabels(data, task.tab_id, labelIds, 'label_ids');
      return setTaskLabelsOps(data, task.id, labelIds, newId);
    }
    case 'tasks_set_dependencies': {
      const input = object(raw, ['task_id', 'depends_on_ids']);
      const task = liveTask(data, id(input, 'task_id')!);
      const dependsOnIds = idList(input, 'depends_on_ids', true)!;
      if (dependsOnIds.includes(task.id)) invalid('depends_on_ids', 'Una tarea no puede depender de sí misma.');
      liveTasks(data, task.tab_id, dependsOnIds, 'depends_on_ids');
      return setDependenciesOps(data, task.id, dependsOnIds, newId);
    }
    case 'tasks_request_purchase': {
      const input = object(raw, ['supply_item_id', 'tab_id', 'project_id', 'task_id', 'title', 'note', 'quantity', 'unit', 'estimated_amount', 'priority', 'due', 'supplier_name', 'needs_invoice', 'repeat_days']);
      const given: Record<string, unknown> = {};
      const put = (key: string, value: unknown) => { if (value !== undefined) given[key] = value; };
      put('title', text(input, 'title', 300)); put('note', text(input, 'note', 5000)); put('unit', text(input, 'unit', 20)); put('supplier_name', text(input, 'supplier_name', 200));
      put('quantity', amount(input, 'quantity', true)); put('estimated_amount', amount(input, 'estimated_amount', false)); put('due', day(input, 'due'));
      if (input.priority !== undefined) { if (!PRIORITIES.includes(input.priority as Priority)) invalid('priority', 'La prioridad es normal, high o critical.'); put('priority', input.priority); }
      if (input.needs_invoice !== undefined) { if (typeof input.needs_invoice !== 'boolean') invalid('needs_invoice', 'needs_invoice es true o false.'); put('needs_invoice', input.needs_invoice); }
      if (input.repeat_days !== undefined) {
        if (!Number.isInteger(input.repeat_days) || (input.repeat_days as number) < 1 || (input.repeat_days as number) > 366) invalid('repeat_days', 'repeat_days va de 1 a 366.');
        put('repeat_days', input.repeat_days);
      }
      if (given.title === '') invalid('title', 'El nombre no puede estar vacío.');
      const supplyId = id(input, 'supply_item_id', false);
      if (supplyId) {
        const item = data['tasks.supply_items'].find((s) => s.id === supplyId);
        if (!item || item.deleted_at) notFound('el suministro', supplyId);
        if (input.tab_id !== undefined && id(input, 'tab_id') !== item!.tab_id) invalid('tab_id', 'El suministro es de otra área.');
        if (input.project_id !== undefined || input.task_id !== undefined) invalid('supply_item_id', 'Un suministro es del área entera: no lleva proyecto ni tarea.');
        const op = reorderSupplyOps(data, item!.id, newId)[0]!;
        Object.assign(op.fields!, given);
        return [op];
      }
      let tabId = id(input, 'tab_id', false), projectId = id(input, 'project_id', false);
      const taskId = id(input, 'task_id', false);
      if (taskId) {
        const task = liveTask(data, taskId);
        if (projectId && projectId !== task.project_id) invalid('project_id', 'La tarea es de otro proyecto.');
        projectId = task.project_id;
      }
      if (projectId) {
        const project = liveProject(data, projectId);
        if (tabId && tabId !== project.tab_id) invalid('tab_id', 'El proyecto es de otra área.');
        tabId = project.tab_id;
      }
      if (!tabId) invalid('tab_id', 'Indica supply_item_id, o el área (tab_id, project_id o task_id).');
      liveTab(data, tabId!);
      if (!projectId) wholeTab(options.scopes, tabId!);
      if (given.title === undefined) invalid('title', 'Falta title.');
      return requestPurchaseOps(data, { ...(given as { title: string }), tab_id: tabId!, project_id: projectId ?? null, task_id: taskId ?? null }, newId);
    }
    case 'tasks_prepare_purchase_plan': {
      const input = object(raw, ['tab_id', 'title', 'planned_for']);
      const tab = liveTab(data, id(input, 'tab_id')!);
      wholeTab(options.scopes, tab.id);
      const today = options.today ?? new Date().toISOString().slice(0, 10);
      const plannedFor = day(input, 'planned_for');
      const title = text(input, 'title', 200) || `Compra del ${plannedFor ?? today}`;
      return preparePlanOps(data, { tab_id: tab.id, title, planned_for: plannedFor ?? null, today, recurring: false }, newId);
    }
    default:
      return reject(404, 'NOT_FOUND', `Herramienta desconocida: ${String(name)}.`);
  }
}
