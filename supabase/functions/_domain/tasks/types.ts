/** Tasks · tipos de fila y metadatos de las tablas `tasks.*` (docs/tasks/API.md §2). */

export type Uuid = string;
/** `outsider` (O1): solo ve lo que se le abre en sus ámbitos; ahí marca hecha (solo `done`) y comenta (paso 2). */
export type Role = 'reader' | 'outsider' | 'editor' | 'owner';

/** Columnas del contrato §2.1 que lleva toda fila sincronizable. */
export interface BaseRow {
  id: Uuid;
  revision: number;
  created_at: string;
  updated_at: string;
  updated_by: Uuid | null;
  deleted_at: string | null;
}

export type Priority = 'normal' | 'high' | 'critical';
export type ProjectStatus = 'active' | 'paused' | 'archived';
export type FamilySystemKey = 'person' | 'trade' | 'phase' | 'building' | 'space';

export interface TabRow extends BaseRow { name: string; color: string | null; position: number; purchase_approver_id?: Uuid | null }
export interface ProjectRow extends BaseRow {
  tab_id: Uuid; title: string; note: string; status: ProjectStatus; priority: Priority; due: string | null;
  owner_label_id: Uuid | null; color: string | null; budget: number | null; position: number; system: 'inbox' | null;
  /** Responsable de Central (P2, PR 3): una persona o un grupo por nivel de casa. Como mucho uno de los tres `owner_*`. */
  owner_person_id?: Uuid | null;
  owner_house_level?: 'direccion' | 'staff' | 'outsider' | null;
  /** Proyecto de un retiro (§23): `booking:RES<código>`; solo lo fija la ruta de worker `requests/project`. */
  external_ref?: string | null;
}
export interface TaskRow extends BaseRow {
  tab_id: Uuid; project_id: Uuid; parent_id: Uuid | null; title: string; note: string; done: boolean; done_at: string | null;
  priority: Priority; due: string | null; owner_label_id: Uuid | null; cost: number | null; position: number;
  /** Responsable de Central (P2, PR 3): una persona o un grupo por nivel de casa. Como mucho uno de los tres `owner_*`. */
  owner_person_id?: Uuid | null;
  owner_house_level?: 'direccion' | 'staff' | 'outsider' | null;
  /** `<source>:<referencia>` de una tarea pedida desde otra app (§19); solo la fija la ruta `requests/task` o la clasificación. */
  external_ref?: string | null;
  /** Tipo (`central.compliance_due`) y enlace al elemento que la generó (§20). */
  external_kind?: string | null;
  external_url?: string | null;
  /** §22: quién informó del reporte de Feedback que la originó (metadato, nunca el actor). */
  external_on_behalf?: 'internal' | 'organizer' | 'guest' | null;
  /** FB_2026_041: en la madre, sus hijas son pasos en orden; en una hija, `step_free` la deja fuera de la cadena. */
  steps_in_order?: boolean;
  step_free?: boolean;
}
export interface TaskDependencyRow extends BaseRow { tab_id: Uuid; project_id: Uuid; task_id: Uuid; depends_on_id: Uuid; position: number }
export interface FamilyRow extends BaseRow { tab_id: Uuid | null; name: string; color: string; archived: boolean; position: number; system_key: FamilySystemKey | null }
export interface LabelRow extends BaseRow {
  tab_id: Uuid | null; family_id: Uuid; parent_id: Uuid | null; name: string; archived: boolean; archived_before_family: boolean | null; position: number;
}
export interface TaskLabelRow extends BaseRow { tab_id: Uuid; project_id: Uuid; task_id: Uuid; label_id: Uuid }
export interface ProjectLabelRow extends BaseRow { tab_id: Uuid; project_id: Uuid; label_id: Uuid }
/** Espacio de Recursos de una tarea o un proyecto (fase R2): `space_id` apunta a `resources.spaces`, sin clave foránea. */
export interface TaskSpaceRow extends BaseRow { tab_id: Uuid; project_id: Uuid; task_id: Uuid; space_id: Uuid }
export interface ProjectSpaceRow extends BaseRow { tab_id: Uuid; project_id: Uuid; space_id: Uuid }
/** Oficio de Central de una tarea o un proyecto (fase P2): `trade_id` apunta a `central.trades`, sin clave foránea. */
export interface TaskTradeRow extends BaseRow { tab_id: Uuid; project_id: Uuid; task_id: Uuid; trade_id: Uuid }
export interface ProjectTradeRow extends BaseRow { tab_id: Uuid; project_id: Uuid; trade_id: Uuid }
/**
 * Persona de Central de una tarea o un proyecto (fase P2, PR 3): `person_id` apunta a `central.people` sin clave foránea,
 * o `house_level` es un grupo por nivel de casa («todo el staff»). Exactamente uno de los dos.
 */
export interface TaskPersonRow extends BaseRow { tab_id: Uuid; project_id: Uuid; task_id: Uuid; person_id: Uuid | null; house_level: 'direccion' | 'staff' | 'outsider' | null }
export interface ProjectPersonRow extends BaseRow { tab_id: Uuid; project_id: Uuid; person_id: Uuid | null; house_level: 'direccion' | 'staff' | 'outsider' | null }
/**
 * Ajustes de la app (fila por clave). `zone_source`: de dónde sale la zona, `'labels'` o `'spaces'` (R2). `trade_source`:
 * de dónde sale el oficio, `'labels'` o `'central'` (P2); `trade_families`: las familias «Tipo: Acción» que archivó la ida.
 * `people_source`: de dónde sale la persona, `'labels'` o `'central'` (P2, PR 3); `people_families`: las familias de persona
 * que archivó la ida; `people_map`: la correspondencia confirmada `{labelId: personId | 'level:<nivel>' | 'remove'}`.
 */
export interface SettingRow extends BaseRow { key: string; value: unknown }
export interface SavedViewRow extends BaseRow { tab_id: Uuid; name: string; search: string; filters: Record<string, string[]>; group_by: string; position: number }
export interface AttachmentRow extends BaseRow {
  tab_id: Uuid; project_id: Uuid; task_id: Uuid | null; name: string; mime: string; size: number; sha256: string; file_id: Uuid; position: number;
}

/**
 * Comentario de una tarea (O1, paso 2; migración 0328). Visible como su tarea. `author_id` y `author_name` los pone el
 * servidor con el actor y su perfil; `file_id`, una foto opcional (imagen de core.files subida por quien comenta).
 */
export interface TaskCommentRow extends BaseRow {
  tab_id: Uuid; project_id: Uuid; task_id: Uuid; author_id: Uuid; author_name: string; body: string; file_id: Uuid | null;
}
/**
 * Material o equipo de una tarea (R6 PR 3; migración 0334): un artículo de Recursos con su cantidad prevista (unidad
 * base). `consumed`, lo gastado al confirmar (0 = no se usó); `consumed_at` lo pone el servidor. Visible como su tarea.
 */
export interface TaskMaterialRow extends BaseRow {
  tab_id: Uuid; project_id: Uuid; task_id: Uuid; item_id: Uuid; quantity: number | string | null; note: string;
  consumed: number | string | null; consumed_at: string | null; position: number;
}

// Compras no alimentarias (docs/tasks/API.md §18, migración 0305). Desde R6 (0333) el almacén es el inventario común de
// Recursos: una solicitud apunta a un artículo (`item_id`).
export type PurchaseStatus = 'requested' | 'approved' | 'purchased' | 'received' | 'rejected';
export type PlanStatus = 'draft' | 'shopping' | 'done';
export interface PurchasePlanRow extends BaseRow { tab_id: Uuid; title: string; planned_for: string | null; status: PlanStatus; note: string }
export interface PurchasePlanStopRow extends BaseRow { tab_id: Uuid; plan_id: Uuid; supplier_id: string | null; supplier_name: string; position: number; note: string }
export interface PurchaseRequestRow extends BaseRow {
  tab_id: Uuid; project_id: Uuid | null; task_id: Uuid | null; item_id: Uuid | null; plan_stop_id: Uuid | null;
  title: string; note: string; quantity: number | null; unit: string | null; need_quantity?: number | null; estimated_amount: number | null; priority: Priority;
  status: PurchaseStatus; needs_invoice: boolean; repeat_days: number | null; due: string | null;
  supplier_id: string | null; supplier_name: string | null; approved_at: string | null; purchased_at: string | null; received_at: string | null; position: number;
  /** Procedencia de una compra pedida desde otra app (`requests/purchase`, migración 0342): app, referencia y enlace de vuelta. */
  source_app?: string | null; source_ref?: string | null; source_url?: string | null;
}
/** Petición de otra app (§20): pendiente en «Por clasificar», enrutada (su tarea tiene el mismo id) o descartada. */
export interface RequestRow extends BaseRow {
  source: string; kind: string; kind_label: string | null; external_ref: string; external_url: string | null;
  title: string; note: string; due: string | null; priority: Priority; suggested_tab_id: Uuid | null; suggested_project_id: Uuid | null;
  requested_by: Uuid | null; status: 'pending' | 'routed' | 'dismissed'; routed_by: 'rule' | 'hint' | 'manual' | null;
  on_behalf_of?: { kind: 'internal' | 'organizer' | 'guest'; report_code: string } | null;
  /** De qué espacio de Recursos se avisa (0336), si quien pide lo dijo. */
  space_id?: Uuid | null;
}
/** Regla de entrada (§20): un tipo de petición va a un área, un proyecto (si no, su Entrada) y un responsable. */
export interface RequestRouteRow extends BaseRow {
  kind: string; kind_label: string | null; tab_id: Uuid; project_id: Uuid | null; owner_label_id: Uuid | null; position: number;
  /** Responsable de Central (P2, PR 3), que pasa a la tarea: una persona o un grupo por nivel de casa. */
  owner_person_id?: Uuid | null;
  owner_house_level?: 'direccion' | 'staff' | 'outsider' | null;
}

/**
 * «Plan de hoy» (MUELA-095, migración 0339): un plan por persona y día, privado. Cada elemento es una tarea (`task_id`) o
 * un texto «solo hoy» (`text`, con su `done`), en el orden de quien lo hace.
 */
export interface DayPlanItem { id: Uuid; task_id?: Uuid; text?: string; tab_id?: Uuid | null; position: number; done?: boolean }
export interface DayPlanRow extends BaseRow { actor_id: Uuid; day: string; items: DayPlanItem[]; reviewed: boolean }

/** Orden canónico: snapshot, importación y (en sentido inverso) purga. */
export const TABLES = [
  'tasks.tabs', 'tasks.families', 'tasks.labels', 'tasks.projects', 'tasks.tasks',
  'tasks.project_labels', 'tasks.task_labels', 'tasks.project_spaces', 'tasks.task_spaces',
  'tasks.project_trades', 'tasks.task_trades', 'tasks.project_people', 'tasks.task_people',
  'tasks.task_dependencies', 'tasks.saved_views', 'tasks.attachments', 'tasks.task_comments', 'tasks.task_materials',
  'tasks.purchase_plans', 'tasks.purchase_plan_stops', 'tasks.purchase_requests',
  'tasks.request_routes', 'tasks.requests', 'tasks.settings', 'tasks.day_plans',
] as const;
export type TableName = (typeof TABLES)[number];

export interface RowTypes {
  'tasks.tabs': TabRow; 'tasks.families': FamilyRow; 'tasks.labels': LabelRow; 'tasks.projects': ProjectRow; 'tasks.tasks': TaskRow;
  'tasks.project_labels': ProjectLabelRow; 'tasks.task_labels': TaskLabelRow;
  'tasks.project_spaces': ProjectSpaceRow; 'tasks.task_spaces': TaskSpaceRow;
  'tasks.project_trades': ProjectTradeRow; 'tasks.task_trades': TaskTradeRow;
  'tasks.project_people': ProjectPersonRow; 'tasks.task_people': TaskPersonRow; 'tasks.task_dependencies': TaskDependencyRow;
  'tasks.saved_views': SavedViewRow; 'tasks.attachments': AttachmentRow; 'tasks.task_comments': TaskCommentRow; 'tasks.task_materials': TaskMaterialRow;
  'tasks.purchase_plans': PurchasePlanRow; 'tasks.purchase_plan_stops': PurchasePlanStopRow; 'tasks.purchase_requests': PurchaseRequestRow;
  'tasks.request_routes': RequestRouteRow; 'tasks.requests': RequestRow; 'tasks.settings': SettingRow;
  'tasks.day_plans': DayPlanRow;
}

/** Filas de todas las tablas, tal y como salen de `snapshot` o del espejo local (incluidas las borradas). */
export type Dataset = { [T in TableName]: RowTypes[T][] };

export function emptyDataset(): Dataset {
  return Object.fromEntries(TABLES.map((t) => [t, []])) as unknown as Dataset;
}

/** `writable_columns` de cada tabla; deben coincidir con `core.register_table` de la migración. */
export const WRITABLE: Record<TableName, readonly string[]> = {
  'tasks.tabs': ['name', 'color', 'position', 'purchase_approver_id'],
  'tasks.families': ['tab_id', 'name', 'color', 'archived', 'position', 'system_key'],
  'tasks.labels': ['tab_id', 'family_id', 'parent_id', 'name', 'archived', 'archived_before_family', 'position'],
  'tasks.projects': ['tab_id', 'title', 'note', 'status', 'priority', 'due', 'owner_label_id', 'color', 'budget', 'position', 'system', 'external_ref', 'owner_person_id', 'owner_house_level'],
  'tasks.tasks': ['tab_id', 'project_id', 'parent_id', 'title', 'note', 'done', 'priority', 'due', 'owner_label_id', 'cost', 'position', 'external_ref', 'external_kind', 'external_url', 'external_on_behalf', 'steps_in_order', 'step_free', 'owner_person_id', 'owner_house_level'],
  'tasks.project_labels': ['tab_id', 'project_id', 'label_id'],
  'tasks.task_labels': ['tab_id', 'project_id', 'task_id', 'label_id'],
  'tasks.project_spaces': ['tab_id', 'project_id', 'space_id'],
  'tasks.task_spaces': ['tab_id', 'project_id', 'task_id', 'space_id'],
  'tasks.project_trades': ['tab_id', 'project_id', 'trade_id'],
  'tasks.task_trades': ['tab_id', 'project_id', 'task_id', 'trade_id'],
  'tasks.project_people': ['tab_id', 'project_id', 'person_id', 'house_level'],
  'tasks.task_people': ['tab_id', 'project_id', 'task_id', 'person_id', 'house_level'],
  'tasks.task_dependencies': ['tab_id', 'project_id', 'task_id', 'depends_on_id', 'position'],
  'tasks.saved_views': ['tab_id', 'name', 'search', 'filters', 'group_by', 'position'],
  'tasks.attachments': ['tab_id', 'project_id', 'task_id', 'name', 'mime', 'size', 'sha256', 'file_id', 'position'],
  'tasks.task_comments': ['tab_id', 'project_id', 'task_id', 'body', 'file_id'],
  'tasks.task_materials': ['tab_id', 'project_id', 'task_id', 'item_id', 'quantity', 'note', 'consumed', 'position'],
  'tasks.purchase_plans': ['tab_id', 'title', 'planned_for', 'status', 'note'],
  'tasks.purchase_plan_stops': ['tab_id', 'plan_id', 'supplier_id', 'supplier_name', 'position', 'note'],
  'tasks.purchase_requests': ['tab_id', 'project_id', 'task_id', 'item_id', 'plan_stop_id', 'title', 'note', 'quantity', 'unit', 'need_quantity', 'estimated_amount', 'priority', 'status', 'needs_invoice', 'repeat_days', 'due', 'supplier_id', 'supplier_name', 'position', 'source_app', 'source_ref', 'source_url'],
  'tasks.request_routes': ['kind', 'kind_label', 'tab_id', 'project_id', 'owner_label_id', 'position', 'owner_person_id', 'owner_house_level'],
  'tasks.requests': ['source', 'kind', 'kind_label', 'external_ref', 'external_url', 'title', 'note', 'due', 'priority', 'suggested_tab_id', 'suggested_project_id', 'requested_by', 'status', 'routed_by', 'on_behalf_of', 'space_id'],
  'tasks.settings': ['key', 'value'],
  'tasks.day_plans': ['actor_id', 'day', 'items', 'reviewed'],
};

/** Columnas que solo se escriben en el `insert` (trigger `tasks.guard_immutable`). */
export const IMMUTABLE: Record<TableName, readonly string[]> = {
  'tasks.tabs': [],
  // `system_key` solo puede pasar a o desde 'person' (familia de responsables, migración 0304): lo valida `validate.ts`.
  'tasks.families': ['tab_id'],
  'tasks.labels': ['tab_id'],
  'tasks.projects': ['tab_id', 'system', 'external_ref'],
  'tasks.tasks': ['tab_id', 'external_ref', 'external_kind', 'external_url', 'external_on_behalf'],
  'tasks.project_labels': ['tab_id', 'project_id', 'label_id'],
  'tasks.task_labels': ['tab_id', 'task_id', 'label_id'],
  'tasks.project_spaces': ['tab_id', 'project_id', 'space_id'],
  'tasks.task_spaces': ['tab_id', 'task_id', 'space_id'],
  'tasks.project_trades': ['tab_id', 'project_id', 'trade_id'],
  'tasks.task_trades': ['tab_id', 'task_id', 'trade_id'],
  'tasks.project_people': ['tab_id', 'project_id', 'person_id', 'house_level'],
  'tasks.task_people': ['tab_id', 'task_id', 'person_id', 'house_level'],
  'tasks.task_dependencies': ['tab_id', 'task_id', 'depends_on_id'],
  'tasks.saved_views': ['tab_id'],
  'tasks.attachments': ['tab_id', 'task_id', 'mime', 'size', 'sha256', 'file_id'],
  'tasks.task_comments': ['tab_id', 'task_id'],
  'tasks.task_materials': ['tab_id', 'task_id', 'item_id'],
  'tasks.purchase_plans': ['tab_id'],
  'tasks.purchase_plan_stops': ['tab_id', 'plan_id'],
  'tasks.purchase_requests': ['tab_id', 'source_app', 'source_ref', 'source_url'],
  'tasks.request_routes': [],
  // Una petición solo la da de alta `tasks.request_task`; después solo cambia su estado (lo comprueba el hook).
  'tasks.requests': ['source', 'kind', 'external_ref', 'requested_by', 'on_behalf_of', 'space_id'],
  // Los ajustes solo los cambian los procedimientos de la app (lo comprueba el hook).
  'tasks.settings': ['key'],
  // El plan es de una persona y un día (trigger `tasks.guard_immutable` de 0339).
  'tasks.day_plans': ['actor_id', 'day'],
};

/** Familias que el cliente crea con cada área nueva. */
export const FAMILY_DEFAULTS: ReadonlyArray<{ system_key: FamilySystemKey; name: string; color: string }> = [
  { system_key: 'person', name: 'Persona', color: '#6f5a8f' },
  { system_key: 'trade', name: 'Oficio', color: '#b76b3d' },
  { system_key: 'phase', name: 'Fase', color: '#6b7b54' },
  { system_key: 'building', name: 'Edificio', color: '#4e6f72' },
  { system_key: 'space', name: 'Espacio', color: '#9c744e' },
];

export const INBOX_TITLE = 'Entrada';
export const POSITION_STEP = 1024;

/** Comentarios (O1, paso 2): de 1 a 2000 caracteres y, como mucho, una foto. */
export const COMMENT_MAX_LENGTH = 2000;
export const COMMENT_PHOTO_MIME: readonly string[] = ['image/webp', 'image/jpeg', 'image/png'];

/** Adjuntos (API.md §8, decisión D5). */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_MIME: readonly string[] = [
  'image/webp', 'image/jpeg', 'image/png', 'application/pdf', 'text/plain', 'text/csv', 'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet', 'application/vnd.oasis.opendocument.presentation',
];

/** Operación de `core.commit`, con la misma forma que `_kit` y `sync-client`. */
export interface Operation {
  op: 'insert' | 'update' | 'delete' | 'restore' | 'call';
  table?: string;
  id?: string;
  expectedRevision?: number;
  fields?: Record<string, unknown>;
  procedure?: string;
  args?: Record<string, unknown>;
}

/** Error de dominio con el mismo sobre que la API: `{status, code, message, details}`. */
export class DomainError extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(status: number, code: string, message: string, details: unknown = null) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function reject(status: number, code: string, message: string, details: unknown = null): never {
  throw new DomainError(status, code, message, details);
}

export function isTable(name: unknown): name is TableName {
  return typeof name === 'string' && (TABLES as readonly string[]).includes(name);
}
