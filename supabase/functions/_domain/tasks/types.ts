/** Tasks · tipos de fila y metadatos de las tablas `tasks.*` (docs/tasks/API.md §2). */

export type Uuid = string;
export type Role = 'reader' | 'editor' | 'owner';

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
}
export interface TaskRow extends BaseRow {
  tab_id: Uuid; project_id: Uuid; parent_id: Uuid | null; title: string; note: string; done: boolean; done_at: string | null;
  priority: Priority; due: string | null; owner_label_id: Uuid | null; cost: number | null; position: number;
  /** `<source>:<referencia>` de una tarea pedida desde otra app (§19); solo la fija la ruta `requests/task` o la clasificación. */
  external_ref?: string | null;
  /** Tipo (`central.compliance_due`) y enlace al elemento que la generó (§20). */
  external_kind?: string | null;
  external_url?: string | null;
}
export interface TaskDependencyRow extends BaseRow { tab_id: Uuid; project_id: Uuid; task_id: Uuid; depends_on_id: Uuid; position: number }
export interface FamilyRow extends BaseRow { tab_id: Uuid; name: string; color: string; archived: boolean; position: number; system_key: FamilySystemKey | null }
export interface LabelRow extends BaseRow {
  tab_id: Uuid; family_id: Uuid; parent_id: Uuid | null; name: string; archived: boolean; archived_before_family: boolean | null; position: number;
}
export interface TaskLabelRow extends BaseRow { tab_id: Uuid; project_id: Uuid; task_id: Uuid; label_id: Uuid }
export interface ProjectLabelRow extends BaseRow { tab_id: Uuid; project_id: Uuid; label_id: Uuid }
export interface SavedViewRow extends BaseRow { tab_id: Uuid; name: string; search: string; filters: Record<string, string[]>; group_by: string; position: number }
export interface AttachmentRow extends BaseRow {
  tab_id: Uuid; project_id: Uuid; task_id: Uuid | null; name: string; mime: string; size: number; sha256: string; file_id: Uuid; position: number;
}

// Compras no alimentarias (docs/tasks/API.md §18, migración 0305).
export type SupplyCategory = 'cleaning' | 'pool' | 'maintenance' | 'textile' | 'other';
export type PurchaseStatus = 'requested' | 'approved' | 'purchased' | 'received' | 'rejected';
export type PlanStatus = 'draft' | 'shopping' | 'done';
export type MovementKind = 'in' | 'out' | 'adjust';
export interface SupplyItemRow extends BaseRow {
  tab_id: Uuid; name: string; category: SupplyCategory; unit: string; location: string; min_quantity: number; reorder_quantity: number | null;
  supplier_id: string | null; supplier_name: string | null; note: string; archived: boolean; position: number;
}
export interface PurchasePlanRow extends BaseRow { tab_id: Uuid; title: string; planned_for: string | null; status: PlanStatus; note: string }
export interface PurchasePlanStopRow extends BaseRow { tab_id: Uuid; plan_id: Uuid; supplier_id: string | null; supplier_name: string; position: number; note: string }
export interface PurchaseRequestRow extends BaseRow {
  tab_id: Uuid; project_id: Uuid | null; task_id: Uuid | null; supply_item_id: Uuid | null; plan_stop_id: Uuid | null;
  title: string; note: string; quantity: number | null; unit: string | null; estimated_amount: number | null; priority: Priority;
  status: PurchaseStatus; needs_invoice: boolean; repeat_days: number | null; due: string | null;
  supplier_id: string | null; supplier_name: string | null; approved_at: string | null; purchased_at: string | null; received_at: string | null; position: number;
}
/** Petición de otra app (§20): pendiente en «Por clasificar», enrutada (su tarea tiene el mismo id) o descartada. */
export interface RequestRow extends BaseRow {
  source: string; kind: string; kind_label: string | null; external_ref: string; external_url: string | null;
  title: string; note: string; due: string | null; priority: Priority; suggested_tab_id: Uuid | null; suggested_project_id: Uuid | null;
  requested_by: Uuid | null; status: 'pending' | 'routed' | 'dismissed'; routed_by: 'rule' | 'hint' | 'manual' | null;
}
/** Regla de entrada (§20): un tipo de petición va a un área, un proyecto (si no, su Entrada) y un responsable. */
export interface RequestRouteRow extends BaseRow {
  kind: string; kind_label: string | null; tab_id: Uuid; project_id: Uuid | null; owner_label_id: Uuid | null; position: number;
}
export interface SupplyMovementRow extends BaseRow {
  tab_id: Uuid; supply_item_id: Uuid; kind: MovementKind; delta: number; purchase_request_id: Uuid | null; note: string;
}

/** Orden canónico: snapshot, importación y (en sentido inverso) purga. */
export const TABLES = [
  'tasks.tabs', 'tasks.families', 'tasks.labels', 'tasks.projects', 'tasks.tasks',
  'tasks.project_labels', 'tasks.task_labels', 'tasks.task_dependencies', 'tasks.saved_views', 'tasks.attachments',
  'tasks.supply_items', 'tasks.purchase_plans', 'tasks.purchase_plan_stops', 'tasks.purchase_requests', 'tasks.supply_movements',
  'tasks.request_routes', 'tasks.requests',
] as const;
export type TableName = (typeof TABLES)[number];

export interface RowTypes {
  'tasks.tabs': TabRow; 'tasks.families': FamilyRow; 'tasks.labels': LabelRow; 'tasks.projects': ProjectRow; 'tasks.tasks': TaskRow;
  'tasks.project_labels': ProjectLabelRow; 'tasks.task_labels': TaskLabelRow; 'tasks.task_dependencies': TaskDependencyRow;
  'tasks.saved_views': SavedViewRow; 'tasks.attachments': AttachmentRow;
  'tasks.supply_items': SupplyItemRow; 'tasks.purchase_plans': PurchasePlanRow; 'tasks.purchase_plan_stops': PurchasePlanStopRow;
  'tasks.purchase_requests': PurchaseRequestRow; 'tasks.supply_movements': SupplyMovementRow;
  'tasks.request_routes': RequestRouteRow; 'tasks.requests': RequestRow;
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
  'tasks.projects': ['tab_id', 'title', 'note', 'status', 'priority', 'due', 'owner_label_id', 'color', 'budget', 'position', 'system'],
  'tasks.tasks': ['tab_id', 'project_id', 'parent_id', 'title', 'note', 'done', 'priority', 'due', 'owner_label_id', 'cost', 'position', 'external_ref', 'external_kind', 'external_url'],
  'tasks.project_labels': ['tab_id', 'project_id', 'label_id'],
  'tasks.task_labels': ['tab_id', 'project_id', 'task_id', 'label_id'],
  'tasks.task_dependencies': ['tab_id', 'project_id', 'task_id', 'depends_on_id', 'position'],
  'tasks.saved_views': ['tab_id', 'name', 'search', 'filters', 'group_by', 'position'],
  'tasks.attachments': ['tab_id', 'project_id', 'task_id', 'name', 'mime', 'size', 'sha256', 'file_id', 'position'],
  'tasks.supply_items': ['tab_id', 'name', 'category', 'unit', 'location', 'min_quantity', 'reorder_quantity', 'supplier_id', 'supplier_name', 'note', 'archived', 'position'],
  'tasks.purchase_plans': ['tab_id', 'title', 'planned_for', 'status', 'note'],
  'tasks.purchase_plan_stops': ['tab_id', 'plan_id', 'supplier_id', 'supplier_name', 'position', 'note'],
  'tasks.purchase_requests': ['tab_id', 'project_id', 'task_id', 'supply_item_id', 'plan_stop_id', 'title', 'note', 'quantity', 'unit', 'estimated_amount', 'priority', 'status', 'needs_invoice', 'repeat_days', 'due', 'supplier_id', 'supplier_name', 'position'],
  'tasks.supply_movements': ['tab_id', 'supply_item_id', 'kind', 'delta', 'purchase_request_id', 'note'],
  'tasks.request_routes': ['kind', 'kind_label', 'tab_id', 'project_id', 'owner_label_id', 'position'],
  'tasks.requests': ['source', 'kind', 'kind_label', 'external_ref', 'external_url', 'title', 'note', 'due', 'priority', 'suggested_tab_id', 'suggested_project_id', 'requested_by', 'status', 'routed_by'],
};

/** Columnas que solo se escriben en el `insert` (trigger `tasks.guard_immutable`). */
export const IMMUTABLE: Record<TableName, readonly string[]> = {
  'tasks.tabs': [],
  // `system_key` solo puede pasar a o desde 'person' (familia de responsables, migración 0304): lo valida `validate.ts`.
  'tasks.families': ['tab_id'],
  'tasks.labels': ['tab_id'],
  'tasks.projects': ['tab_id', 'system'],
  'tasks.tasks': ['tab_id', 'external_ref', 'external_kind', 'external_url'],
  'tasks.project_labels': ['tab_id', 'project_id', 'label_id'],
  'tasks.task_labels': ['tab_id', 'task_id', 'label_id'],
  'tasks.task_dependencies': ['tab_id', 'task_id', 'depends_on_id'],
  'tasks.saved_views': ['tab_id'],
  'tasks.attachments': ['tab_id', 'task_id', 'mime', 'size', 'sha256', 'file_id'],
  'tasks.supply_items': ['tab_id'],
  'tasks.purchase_plans': ['tab_id'],
  'tasks.purchase_plan_stops': ['tab_id', 'plan_id'],
  'tasks.purchase_requests': ['tab_id'],
  // Un movimiento no se edita salvo su nota: corregir es otro movimiento o enviarlo a la papelera.
  'tasks.supply_movements': ['tab_id', 'supply_item_id', 'kind', 'delta', 'purchase_request_id'],
  'tasks.request_routes': [],
  // Una petición solo la da de alta `tasks.request_task`; después solo cambia su estado (lo comprueba el hook).
  'tasks.requests': ['source', 'kind', 'external_ref', 'requested_by'],
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
