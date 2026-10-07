/**
 * Tasks · validación de lotes antes de `core.commit` (docs/tasks/API.md §4.1).
 * El mismo código corre en el cliente antes de encolar y en la Edge (`beforeCommit`). Solo ve las
 * operaciones y los ámbitos del actor: las reglas que dependen del estado viven en el hook SQL.
 */
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MIME, IMMUTABLE, WRITABLE, isTable, reject, type Operation, type Role, type TableName } from './types.ts';
import { allAccess, canProject, fullTab, type Scopes } from './scopes.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^#[0-9a-fA-F]{6}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PRIORITIES = ['normal', 'high', 'critical'];
const STATUSES = ['active', 'paused', 'archived'];
const SYSTEM_KEYS = ['person', 'trade', 'phase', 'building', 'space'];

type Check = (value: unknown, field: string) => void;

const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);

const uuid = (code = 'INVALID_ID'): Check => (v, field) => {
  if (typeof v !== 'string' || !UUID.test(v)) reject(422, code, 'Identificador inválido.', { field });
};
const nullable = (check: Check): Check => (v, field) => { if (v !== null) check(v, field); };
const text = (min: number, max: number, code: string, message: string): Check => (v, field) => {
  if (typeof v !== 'string' || v.trim().length < min || v.length > max) reject(422, code, message, { field, max });
};
const note: Check = (v, field) => {
  if (typeof v !== 'string' || v.length > 20000) reject(422, 'INVALID_NOTE', 'La nota debe ser texto.', { field });
};
const color: Check = (v, field) => {
  if (typeof v !== 'string' || !HEX.test(v)) reject(422, 'INVALID_COLOR', 'El color debe tener seis cifras hexadecimales.', { field });
};
const amount: Check = (v, field) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 999999999999.99) reject(422, 'INVALID_AMOUNT', 'El importe debe ser un número finito no negativo.', { field });
};
const date: Check = (v, field) => {
  const ok = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
  if (!ok) reject(422, 'INVALID_DATE', 'Fecha objetivo inválida.', { field });
};
const position: Check = (v, field) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) reject(422, 'INVALID_ORDER', 'Orden fraccional inválido.', { field });
};
const flag = (code: string): Check => (v, field) => {
  if (typeof v !== 'boolean') reject(422, code, 'El valor debe ser verdadero o falso.', { field });
};
const oneOf = (values: readonly string[], code: string, message: string): Check => (v, field) => {
  if (typeof v !== 'string' || !values.includes(v)) reject(422, code, message, { field, allowed: values });
};
/** `file_id` llega como uuid o como marcador `{"$blob": "<sha256>"}` que `sync-client` sustituye al subir. */
const fileRef: Check = (v, field) => {
  if (typeof v === 'string' && UUID.test(v)) return;
  if (isObject(v) && Object.keys(v).length === 1 && typeof v.$blob === 'string' && SHA256.test(v.$blob)) return;
  reject(422, 'INVALID_ATTACHMENT', 'Sube el archivo antes de asociarlo.', { field });
};
const filters: Check = (v, field) => {
  if (!isObject(v)) reject(422, 'INVALID_VIEW', 'Filtros de vista inválidos.', { field });
  for (const [key, ids] of Object.entries(v)) {
    const allowed = key === '_state' ? ['pending', 'done'] : key === '_availability' ? ['ready', 'blocked'] : null;
    if (!allowed && key !== '_project' && !UUID.test(key)) reject(422, 'INVALID_VIEW', 'Un filtro referencia una familia desconocida.', { field, key });
    if (!Array.isArray(ids) || ids.length > 200 || ids.some((id) => typeof id !== 'string' || (allowed ? !allowed.includes(id) : !UUID.test(id)))) {
      reject(422, 'INVALID_VIEW', 'Un filtro contiene valores inválidos.', { field, key });
    }
  }
};
const groupBy: Check = (v, field) => {
  if (typeof v !== 'string' || !(v === 'project' || v === 'state' || UUID.test(v))) reject(422, 'INVALID_VIEW', 'Agrupación de vista inválida.', { field });
};
const mime: Check = (v, field) => {
  if (typeof v !== 'string' || !ATTACHMENT_MIME.includes(v.toLowerCase())) reject(422, 'INVALID_ATTACHMENT', 'Tipo de archivo no admitido.', { field, allowed: ATTACHMENT_MIME });
};
const size: Check = (v, field) => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > ATTACHMENT_MAX_BYTES) reject(422, 'INVALID_ATTACHMENT', 'El archivo supera el tamaño máximo.', { field, maxBytes: ATTACHMENT_MAX_BYTES });
};
const sha: Check = (v, field) => {
  if (typeof v !== 'string' || !SHA256.test(v)) reject(422, 'INVALID_ATTACHMENT', 'Huella de archivo inválida.', { field });
};

const name = (max: number) => text(1, max, 'REQUIRED_NAME', 'Escribe un nombre.');
const quantity: Check = (v, field) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 999999999.999) reject(422, 'INVALID_QUANTITY', 'La cantidad debe ser un número mayor que cero.', { field });
};
const minimum: Check = (v, field) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 999999999.999) reject(422, 'INVALID_QUANTITY', 'El mínimo debe ser un número de cero en adelante.', { field });
};
const delta: Check = (v, field) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v === 0 || Math.abs(v) > 999999999.999) reject(422, 'INVALID_QUANTITY', 'El movimiento debe ser un número distinto de cero.', { field });
};
const shortText = (max: number) => (v: unknown, field: string) => {
  if (typeof v !== 'string' || v.length > max) reject(422, 'INVALID_FIELDS', `Texto de hasta ${max} caracteres.`, { field });
};
const supplierId: Check = (v, field) => {
  if (typeof v !== 'string' || v.length < 1 || v.length > 100) reject(422, 'INVALID_FIELDS', 'Proveedor inválido.', { field });
};
const repeatDays: Check = (v, field) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 366) reject(422, 'INVALID_FIELDS', 'La repetición va de 1 a 366 días.', { field });
};
const priority = oneOf(PRIORITIES, 'INVALID_PRIORITY', 'Prioridad inválida.');

interface TableRules { fields: Record<string, Check>; required: string[] }

const KIND = /^[a-z][a-z0-9_-]{1,30}\.[a-z0-9][a-z0-9_.-]{0,60}$/;
const URL_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*ikisai\.com(\/|$)/;
const requestKind = (v: unknown, f: string) => { if (typeof v !== 'string' || v.length > 100 || !KIND.test(v)) reject(422, 'INVALID_FIELDS', 'El tipo va como <app>.<nombre>, en minúsculas.', { field: f }); };
const externalUrl = (v: unknown, f: string) => { if (typeof v !== 'string' || v.length > 500 || !URL_ORIGIN.test(v)) reject(422, 'INVALID_FIELDS', 'El enlace de origen debe ser https en ikisai.com.', { field: f }); };

const RULES: Record<TableName, TableRules> = {
  'tasks.tabs': {
    fields: { name: name(200), color: nullable(color), position, purchase_approver_id: nullable(uuid()) },
    required: ['name', 'position'],
  },
  'tasks.families': {
    fields: {
      tab_id: uuid(), name: text(1, 100, 'INVALID_FAMILY', 'La familia necesita un nombre.'),
      color: (v, f) => { if (typeof v !== 'string' || !HEX.test(v)) reject(422, 'INVALID_FAMILY', 'La familia necesita un color de seis cifras hexadecimales.', { field: f }); },
      archived: flag('INVALID_FLAG'), position, system_key: nullable(oneOf(SYSTEM_KEYS, 'INVALID_FIELDS', 'Familia de sistema desconocida.')),
    },
    required: ['tab_id', 'name', 'color'],
  },
  'tasks.labels': {
    fields: {
      tab_id: uuid(), family_id: uuid('INVALID_LABEL'), parent_id: nullable(uuid('INVALID_LABEL_PARENT')),
      name: text(1, 200, 'INVALID_LABEL', 'La etiqueta necesita texto.'), archived: flag('INVALID_FLAG'), archived_before_family: nullable(flag('INVALID_FLAG')), position,
    },
    required: ['tab_id', 'family_id', 'name'],
  },
  'tasks.projects': {
    fields: {
      tab_id: uuid(), title: name(300), note, status: oneOf(STATUSES, 'INVALID_STATUS', 'Estado de proyecto inválido.'), priority, due: nullable(date),
      owner_label_id: nullable(uuid('INVALID_OWNER')), color: nullable(color), budget: nullable(amount), position,
      system: nullable(oneOf(['inbox'], 'INVALID_FIELDS', 'Proyecto de sistema desconocido.')),
    },
    required: ['tab_id', 'title', 'position'],
  },
  'tasks.tasks': {
    fields: {
      tab_id: uuid(), project_id: uuid(), parent_id: nullable(uuid('INVALID_PARENT')), title: text(1, 1000, 'REQUIRED_TEXT', 'La tarea necesita texto.'), note,
      done: flag('INVALID_DONE'), priority, due: nullable(date), owner_label_id: nullable(uuid('INVALID_OWNER')), cost: nullable(amount), position,
      // Origen (§19, §20): solo en el insert de la tarea de una petición que se clasifica en el mismo lote (ver abajo).
      external_ref: text(3, 182, 'INVALID_FIELDS', 'Referencia de origen inválida.'), external_kind: nullable(text(3, 100, 'INVALID_FIELDS', 'Tipo de origen inválido.')),
      external_url: nullable(externalUrl),
    },
    required: ['tab_id', 'project_id', 'title', 'position'],
  },
  'tasks.project_labels': {
    fields: { tab_id: uuid(), project_id: uuid(), label_id: uuid('INVALID_LABELS') },
    required: ['tab_id', 'project_id', 'label_id'],
  },
  'tasks.task_labels': {
    fields: { tab_id: uuid(), project_id: uuid(), task_id: uuid(), label_id: uuid('INVALID_LABELS') },
    required: ['tab_id', 'project_id', 'task_id', 'label_id'],
  },
  'tasks.task_dependencies': {
    fields: { tab_id: uuid(), project_id: uuid(), task_id: uuid('INVALID_DEPENDENCIES'), depends_on_id: uuid('INVALID_DEPENDENCIES'), position },
    required: ['tab_id', 'project_id', 'task_id', 'depends_on_id'],
  },
  'tasks.saved_views': {
    fields: {
      tab_id: uuid(), name: text(1, 100, 'INVALID_VIEW', 'La vista necesita un nombre de hasta 100 caracteres.'),
      search: (v, f) => { if (typeof v !== 'string' || v.length > 1000) reject(422, 'INVALID_VIEW', 'Búsqueda de vista inválida.', { field: f }); },
      filters, group_by: groupBy, position,
    },
    required: ['tab_id', 'name'],
  },
  'tasks.attachments': {
    fields: {
      tab_id: uuid(), project_id: uuid(), task_id: nullable(uuid()), name: text(1, 255, 'INVALID_ATTACHMENT', 'El adjunto necesita un nombre.'),
      mime, size, sha256: sha, file_id: fileRef, position,
    },
    required: ['tab_id', 'project_id', 'name', 'mime', 'size', 'sha256', 'file_id'],
  },
  'tasks.supply_items': {
    fields: {
      tab_id: uuid(), name: name(200), category: oneOf(['cleaning', 'pool', 'maintenance', 'textile', 'other'], 'INVALID_FIELDS', 'Categoría desconocida.'),
      unit: text(1, 20, 'INVALID_FIELDS', 'Unidad de hasta 20 caracteres.'), location: shortText(200), min_quantity: minimum, reorder_quantity: nullable(quantity),
      supplier_id: nullable(supplierId), supplier_name: nullable(shortText(200)), note, archived: flag('INVALID_FLAG'), position,
    },
    required: ['tab_id', 'name'],
  },
  'tasks.purchase_plans': {
    fields: {
      tab_id: uuid(), title: name(200), planned_for: nullable(date), status: oneOf(['draft', 'shopping', 'done'], 'INVALID_STATUS', 'Estado del plan desconocido.'), note,
    },
    required: ['tab_id', 'title'],
  },
  'tasks.purchase_plan_stops': {
    fields: { tab_id: uuid(), plan_id: uuid(), supplier_id: nullable(supplierId), supplier_name: name(200), position, note: shortText(2000) },
    required: ['tab_id', 'plan_id', 'supplier_name'],
  },
  'tasks.purchase_requests': {
    fields: {
      tab_id: uuid(), project_id: nullable(uuid()), task_id: nullable(uuid()), supply_item_id: nullable(uuid()), plan_stop_id: nullable(uuid()),
      title: text(1, 300, 'REQUIRED_TEXT', 'Escribe qué hay que comprar.'), note, quantity: nullable(quantity), unit: nullable(shortText(20)),
      estimated_amount: nullable(amount), priority, status: oneOf(['requested', 'approved', 'purchased', 'received', 'rejected'], 'INVALID_STATUS', 'Estado de la solicitud desconocido.'),
      needs_invoice: flag('INVALID_FLAG'), repeat_days: nullable(repeatDays), due: nullable(date),
      supplier_id: nullable(supplierId), supplier_name: nullable(shortText(200)), position,
    },
    required: ['tab_id', 'title'],
  },
  'tasks.request_routes': {
    fields: {
      kind: requestKind, kind_label: nullable(text(1, 100, 'INVALID_FIELDS', 'El nombre del tipo va de 1 a 100 caracteres.')),
      tab_id: uuid(), project_id: nullable(uuid()), owner_label_id: nullable(uuid('INVALID_OWNER')), position,
    },
    required: ['kind', 'tab_id'],
  },
  'tasks.requests': {
    fields: {
      source: (_v, f) => reject(422, 'INVALID_REQUEST', 'Las peticiones solo llegan por requests/task.', { field: f }),
      kind: requestKind, kind_label: nullable(text(1, 100, 'INVALID_FIELDS', 'Nombre de tipo inválido.')), external_ref: text(3, 182, 'INVALID_FIELDS', 'Referencia inválida.'),
      external_url: nullable(externalUrl), title: text(1, 500, 'REQUIRED_TEXT', 'La petición necesita texto.'), note, due: nullable(date), priority,
      suggested_tab_id: nullable(uuid()), suggested_project_id: nullable(uuid()), requested_by: nullable(uuid()),
      status: oneOf(['pending', 'routed', 'dismissed'], 'INVALID_STATUS', 'Estado de la petición desconocido.'),
      routed_by: nullable(oneOf(['rule', 'hint', 'manual'], 'INVALID_STATUS', 'Origen del enrutado desconocido.')),
    },
    required: [],
  },
  'tasks.supply_movements': {
    fields: {
      tab_id: uuid(), supply_item_id: uuid(), kind: oneOf(['in', 'out', 'adjust'], 'INVALID_FIELDS', 'Tipo de movimiento desconocido.'), delta,
      purchase_request_id: nullable(uuid()), note: shortText(2000),
    },
    required: ['tab_id', 'supply_item_id', 'kind', 'delta'],
  },
};

export interface ValidationContext {
  role: Role;
  scopes: Scopes;
  /** Solo las rutas internas de `tasks-api` (importación) pueden enviar `call`. */
  allowCalls?: boolean;
}

function forbidden(message: string, details: unknown = null): never {
  reject(403, 'FORBIDDEN', message, details);
}

/** Descartes de ámbito que no necesitan leer la base. La autoridad es `tasks.check_scope` en el hook SQL. */
function precheckScope(op: Operation, table: TableName, ctx: ValidationContext): void {
  const { scopes } = ctx;
  if (allAccess(scopes)) return;
  const f = op.fields ?? {};
  const tab = typeof f.tab_id === 'string' ? f.tab_id : null;
  if (table === 'tasks.tabs') {
    if (op.op === 'insert' || !fullTab(scopes, op.id!)) forbidden('No puedes administrar esta área.');
    return;
  }
  if (table === 'tasks.requests') forbidden('Las peticiones de otras apps son de quien tiene acceso a toda la app.');
  if (op.op !== 'insert' || !tab) return;
  if (table === 'tasks.families' || table === 'tasks.labels' || table === 'tasks.saved_views') {
    if (!fullTab(scopes, tab)) forbidden('Un acceso por proyecto no administra el catálogo ni las vistas del área.');
  } else if (table === 'tasks.request_routes') {
    if (!fullTab(scopes, tab)) forbidden('Las reglas de entrada son del área entera.');
  } else if (['tasks.supply_items', 'tasks.supply_movements', 'tasks.purchase_plans', 'tasks.purchase_plan_stops'].includes(table)) {
    if (!fullTab(scopes, tab)) forbidden('El almacén y los planes de compra son del área entera.');
  } else if (table === 'tasks.purchase_requests' && typeof f.project_id !== 'string') {
    if (!fullTab(scopes, tab)) forbidden('Una solicitud sin proyecto es del área entera.');
  } else if (table === 'tasks.projects') {
    if (!fullTab(scopes, tab)) forbidden('No puedes crear proyectos en esta área.');
  } else if (typeof f.project_id === 'string' && !canProject(scopes, tab, f.project_id)) {
    forbidden('No tienes acceso a este proyecto.');
  }
}

/** Valida un lote completo. Lanza `DomainError` con el primer problema. */
export function validateOperations(operations: readonly Operation[], ctx: ValidationContext): void {
  if (ctx.role === 'reader') forbidden('Tu acceso es de solo lectura.');
  const seen = new Set<string>();
  operations.forEach((op, index) => {
    if (op.op === 'call') {
      if (!ctx.allowCalls) reject(422, 'INVALID_OPERATION', 'Los procedimientos de Tasks solo se ejecutan desde sus rutas de importación.', { index, procedure: op.procedure });
      return;
    }
    if (!isTable(op.table)) reject(422, 'INVALID_OPERATION', 'Tabla desconocida.', { index, table: op.table });
    const table = op.table;
    if (typeof op.id !== 'string' || !UUID.test(op.id)) reject(422, 'INVALID_OPERATION', 'El id debe ser un uuid.', { index });
    const key = `${table}|${op.id.toLowerCase()}`;
    if (seen.has(key)) reject(422, 'DUPLICATE_OPERATION', 'Usa una operación por elemento en cada lote.', { index, table, id: op.id });
    seen.add(key);

    if ((op.op === 'delete' || op.op === 'restore') && (table === 'tasks.families' || table === 'tasks.labels')) {
      reject(422, 'ARCHIVE_REQUIRED', 'Archiva familias y etiquetas, no las borres.', { index, table });
    }
    const rules = RULES[table];
    const fields = op.fields ?? {};
    // `restore` puede llevar campos (contrato §4.2): se corrige la fila al sacarla de la papelera, con las reglas de un `update`.
    const corrects = op.op === 'restore' && op.fields !== undefined && op.fields !== null;
    if (op.op === 'insert' || op.op === 'update' || corrects) {
      if (!isObject(fields)) reject(422, 'INVALID_FIELDS', 'Campos inválidos.', { index });
      for (const [field, value] of Object.entries(fields)) {
        if (!WRITABLE[table].includes(field)) reject(422, 'INVALID_FIELDS', 'Campos desconocidos o de solo lectura.', { index, table, field });
        if (op.op !== 'insert' && IMMUTABLE[table].includes(field)) reject(422, 'IMMUTABLE_FIELD', 'Este campo no se puede cambiar una vez creado el elemento.', { index, table, field });
        if (value === undefined) reject(422, 'INVALID_FIELDS', 'Campos inválidos.', { index, table, field });
        rules.fields[field]!(value, field);
      }
      if (table === 'tasks.families' && op.op !== 'insert' && 'system_key' in fields && fields.system_key !== null && fields.system_key !== 'person') {
        reject(422, 'IMMUTABLE_FIELD', 'Solo la marca de familia de responsables se puede mover de una familia a otra.', { index, table, field: 'system_key' });
      }
    }
    if (op.op === 'insert') {
      for (const field of rules.required) {
        if (!(field in fields) || fields[field] === null) {
          const code = field === 'title' ? (table === 'tasks.tasks' ? 'REQUIRED_TEXT' : 'REQUIRED_NAME') : field === 'name' && table === 'tasks.tabs' ? 'REQUIRED_NAME' : 'INVALID_FIELDS';
          reject(422, code, 'Falta un campo obligatorio.', { index, table, field });
        }
      }
      if (table === 'tasks.supply_movements' && typeof fields.delta === 'number' && (fields.kind === 'in' && fields.delta < 0 || fields.kind === 'out' && fields.delta > 0)) {
        reject(422, 'INVALID_QUANTITY', 'Una entrada suma y un consumo resta.', { index });
      }
      if (table === 'tasks.task_dependencies' && fields.task_id === fields.depends_on_id) {
        reject(422, 'INVALID_DEPENDENCIES', 'Una tarea no puede depender de sí misma.', { index });
      }
      if ((table === 'tasks.tasks' || table === 'tasks.labels') && fields.parent_id === op.id) {
        reject(422, table === 'tasks.tasks' ? 'INVALID_PARENT' : 'INVALID_LABEL_PARENT', 'Un elemento no puede colgar de sí mismo.', { index });
      }
      if (table === 'tasks.projects' && fields.system === 'inbox' && fields.title !== 'Entrada') {
        reject(422, 'INBOX_PROTECTED', 'Entrada no se puede renombrar.', { index });
      }
    }
    precheckScope(op, table, ctx);
  });
  // El origen de una tarea (§19, §20) solo se fija al clasificar su petición en el mismo lote: la petición pasa a
  // `routed` y la tarea nace con su mismo id. Lo de `tasks.request_task` no pasa por aquí (es un `call`).
  operations.forEach((op, index) => {
    if (op.op !== 'insert' || op.table !== 'tasks.tasks') return;
    const f = op.fields ?? {};
    if (f.external_ref === undefined && f.external_kind === undefined && f.external_url === undefined) return;
    const routed = operations.some((o) => o.table === 'tasks.requests' && o.op === 'update' && o.id === op.id && o.fields?.status === 'routed');
    if (!routed) reject(422, 'INVALID_FIELDS', 'El origen de una tarea solo se fija al clasificar su petición.', { index, field: 'external_ref' });
  });
}
