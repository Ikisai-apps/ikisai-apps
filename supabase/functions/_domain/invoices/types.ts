/**
 * Invoices · tipos y listas cerradas del dominio (docs/invoices/API.md §2).
 * Este archivo lo comparten la Edge `invoices-api` y el frontend; no usa APIs de Deno ni de Node.
 */

export const EXPENSE_CATEGORIES = ['compras', 'suministros', 'mantenimiento', 'inversiones', 'canon_concesion', 'seguros', 'personal', 'fiscalidad', 'otros'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  compras: 'Compras',
  suministros: 'Suministros',
  mantenimiento: 'Mantenimiento',
  inversiones: 'Inversiones',
  canon_concesion: 'Canon de concesión',
  seguros: 'Seguros',
  personal: 'Personal',
  fiscalidad: 'Fiscalidad',
  otros: 'Otros',
};

export const INVOICE_STATUSES = ['pendiente_datos', 'pendiente_revision', 'validada', 'archivada', 'anulada'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  pendiente_datos: 'Pendiente de datos',
  pendiente_revision: 'Pendiente de revisión',
  validada: 'Validada',
  archivada: 'Archivada',
  anulada: 'Anulada',
};

export const DEDUCTIBILITIES = ['si', 'no', 'parcial', 'pendiente_revision'] as const;
export type Deductibility = (typeof DEDUCTIBILITIES)[number];

export const PAYMENT_STATUSES = ['pendiente', 'pagada'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_METHODS = ['transferencia', 'tarjeta', 'efectivo', 'bizum', 'domiciliacion', 'otro'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const INVOICE_SOURCES = ['manual', 'import_v1'] as const;
export type InvoiceSource = (typeof INVOICE_SOURCES)[number];

export const TAX_TYPES = ['iva', 'irpf', 'otra_retencion', 'otro'] as const;
export type TaxType = (typeof TAX_TYPES)[number];

export const ITEM_TYPES = ['food_ingredient', 'equipment', 'material', 'service', 'other'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const FILE_KINDS = ['original', 'attachment'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const FILE_MIMES = ['application/pdf', 'image/webp', 'image/jpeg', 'image/png'] as const;
export type FileMime = (typeof FILE_MIMES)[number];

export const TARGET_APPS = ['tasks', 'booking', 'food', 'general'] as const;
export type TargetApp = (typeof TARGET_APPS)[number];

/** Pares `target_app` → `target_kind` admitidos (API.md §2.6). */
export const TARGET_KINDS: Record<TargetApp, readonly string[]> = {
  tasks: ['area', 'project', 'task', 'purchase_request'],
  booking: ['reservation', 'event'],
  food: ['ingredient', 'equipment'],
  general: ['unassigned', 'operating_expense', 'investment'],
};

export const EXPORT_PERIOD_KINDS = ['quarter', 'year', 'custom'] as const;
export type ExportPeriodKind = (typeof EXPORT_PERIOD_KINDS)[number];

export const EXPORT_STATUSES = ['generada', 'entregada'] as const;

/** Tolerancia de cuadre en euros (handoff §24A). */
export const TOLERANCE_EUR = 0.02;

/** Motivos estándar de `review_reason`. */
export const REVIEW_REASONS = {
  imported: 'IMPORTADA',
  totals: 'REVISAR IMPORTES',
  editedAfterValidation: 'EDITADA_TRAS_VALIDAR',
} as const;

/** Nombres de tabla del espejo local y de las operaciones. */
export const TABLES = {
  suppliers: 'invoices.suppliers',
  invoices: 'invoices.invoices',
  invoiceFiles: 'invoices.invoice_files',
  invoiceLines: 'invoices.invoice_lines',
  taxLines: 'invoices.tax_lines',
  allocations: 'invoices.allocations',
  exports: 'invoices.exports',
  exportItems: 'invoices.export_items',
  // Facturas emitidas registradas (API.md §13)
  issuedSeries: 'invoices.issued_series',
  issuedInvoices: 'invoices.issued_invoices',
  issuedLines: 'invoices.issued_invoice_lines',
  issuedTaxLines: 'invoices.issued_tax_lines',
  issuedFiles: 'invoices.issued_invoice_files',
  issuedAllocations: 'invoices.issued_allocations',
  // Plantillas por proveedor (API.md §6.9)
  supplierTemplates: 'invoices.supplier_templates',
  // Directorio de clientes por NIF (ronda 46)
  customers: 'invoices.customers',
} as const;
export type InvoicesTable = (typeof TABLES)[keyof typeof TABLES];

/** Columnas escribibles por tabla (deben coincidir con `core.register_table` de la migración). */
export const WRITABLE: Record<InvoicesTable, readonly string[]> = {
  'invoices.suppliers': ['name', 'tax_id', 'default_category', 'default_is_investment', 'aliases', 'slug', 'notes'],
  'invoices.invoices': [
    'supplier_id', 'invoice_date', 'object', 'invoice_number', 'currency', 'due_date', 'expense_category', 'is_investment', 'deductibility',
    'status', 'review_reason', 'annulled_reason', 'payment_status', 'payment_method', 'paid_at', 'source_total',
    'calculated_base', 'calculated_vat', 'calculated_other', 'calculated_withholding', 'calculated_total', 'totals_delta',
    'source', 'import_sha256', 'import_meta', 'notes',
  ],
  'invoices.invoice_files': ['invoice_id', 'file_id', 'original_filename', 'page_order', 'kind', 'mime_type', 'size_bytes', 'sha256'],
  'invoices.invoice_lines': [
    'invoice_id', 'position', 'description', 'quantity', 'unit', 'unit_price', 'discount_amount', 'net_amount', 'vat_rate', 'vat_amount', 'gross_amount',
    'item_type', 'match_name', 'expense_category', 'is_investment', 'confidence', 'notes',
  ],
  'invoices.tax_lines': ['invoice_id', 'position', 'tax_type', 'rate', 'taxable_base', 'amount', 'notes'],
  'invoices.allocations': ['invoice_line_id', 'target_app', 'target_kind', 'target_id', 'target_code', 'target_label', 'target_revision', 'allocated_quantity', 'allocated_amount', 'notes'],
  'invoices.exports': ['status', 'delivered_at', 'delivered_to', 'notes'],
  'invoices.export_items': [],
  'invoices.issued_series': ['code', 'description', 'kind', 'yearly', 'format', 'active', 'mode', 'valid_year'],
  'invoices.issued_invoices': [
    'series_code', 'number', 'issue_date', 'operation_date', 'invoice_type', 'rectification_kind', 'rectified', 'rectification_reason', 'rectified_base', 'rectified_quota',
    'recipient_name', 'recipient_tax_id', 'recipient_id_type', 'recipient_country', 'extra_recipients', 'description', 'notes', 'currency',
    'base_total', 'quota_total', 'surcharge_total', 'withholding_total', 'total', 'source_total', 'totals_delta', 'status', 'review_reason', 'annulled_reason',
    'origin', 'external_tool', 'external_id', 'import_sha256', 'income_category', 'payment_status', 'paid_at', 'external_qr_url', 'external_csv',
    'issuer_tax_id', 'issuer_name', 'issuer',
    'recipient_address', 'recipient_kind', 'prices_include_vat',
  ],
  'invoices.issued_invoice_lines': [
    'issued_invoice_id', 'position', 'description', 'quantity', 'unit', 'unit_price', 'discount_amount', 'net_amount', 'tax', 'vat_rate', 'vat_amount',
    'surcharge_rate', 'surcharge_amount', 'gross_amount', 'notes',
  ],
  'invoices.issued_tax_lines': ['issued_invoice_id', 'position', 'tax', 'regime_key', 'qualification', 'exemption', 'rate', 'taxable_base', 'quota', 'surcharge_rate', 'surcharge_quota'],
  'invoices.issued_invoice_files': ['issued_invoice_id', 'file_id', 'original_filename', 'page_order', 'mime_type', 'size_bytes', 'sha256'],
  'invoices.issued_allocations': ['issued_invoice_id', 'target_app', 'target_kind', 'target_id', 'target_code', 'target_label', 'target_revision', 'allocated_amount', 'notes'],
  'invoices.customers': ['name', 'tax_id', 'id_type', 'country', 'kind', 'address'],
  'invoices.supplier_templates': ['supplier_id', 'version', 'status', 'layout_tokens', 'layout_hash', 'page_size', 'fields', 'confirmations', 'uses', 'full_hits', 'last_confirmed_invoice_id'],
};

/** Columnas comunes del contrato §2.1. */
export interface SyncedColumns {
  id: string;
  revision: number;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  deleted_at: string | null;
}

export interface SupplierRow extends SyncedColumns {
  name: string;
  tax_id: string | null;
  default_category: ExpenseCategory | null;
  default_is_investment: boolean;
  aliases: string[];
  slug: string;
  notes: string | null;
}

export interface InvoiceRow extends SyncedColumns {
  code: string | null;
  supplier_id: string;
  invoice_date: string;
  object: string;
  invoice_number: string | null;
  currency: string;
  due_date: string | null;
  expense_category: ExpenseCategory | null;
  is_investment: boolean;
  deductibility: Deductibility;
  status: InvoiceStatus;
  review_reason: string | null;
  annulled_reason: string | null;
  payment_status: PaymentStatus;
  payment_method: PaymentMethod | null;
  paid_at: string | null;
  source_total: number | null;
  calculated_base: number;
  calculated_vat: number;
  calculated_other: number;
  calculated_withholding: number;
  calculated_total: number;
  totals_delta: number | null;
  source: InvoiceSource;
  import_sha256: string | null;
  import_meta: Record<string, unknown> | null;
  fiscal_year: number;
  fiscal_quarter: number;
  fiscal_period: string;
  notes: string | null;
}

export interface InvoiceFileRow extends SyncedColumns {
  invoice_id: string;
  file_id: string;
  original_filename: string;
  normalized_filename: string;
  mime_type: FileMime;
  size_bytes: number;
  sha256: string;
  page_order: number;
  kind: FileKind;
}

export interface InvoiceLineRow extends SyncedColumns {
  invoice_id: string;
  position: number;
  description: string;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  discount_amount: number;
  net_amount: number;
  vat_rate: number | null;
  vat_amount: number | null;
  gross_amount: number | null;
  item_type: ItemType | null;
  match_name: string | null;
  expense_category: ExpenseCategory | null;
  is_investment: boolean | null;
  confidence: number | null;
  notes: string | null;
}

export interface TaxLineRow extends SyncedColumns {
  invoice_id: string;
  position: number;
  tax_type: TaxType;
  rate: number | null;
  taxable_base: number | null;
  amount: number;
  notes: string | null;
}

export interface AllocationRow extends SyncedColumns {
  invoice_line_id: string;
  invoice_id: string;
  target_app: TargetApp;
  target_kind: string;
  target_id: string | null;
  target_code: string | null;
  target_label: string;
  target_revision: number | null;
  allocated_quantity: number | null;
  allocated_amount: number;
  notes: string | null;
}

export interface ExportRow extends SyncedColumns {
  code: string;
  period_kind: ExportPeriodKind;
  fiscal_year: number;
  fiscal_quarter: number | null;
  from_date: string;
  to_date: string;
  folder_name: string;
  invoice_count: number;
  totals: Record<string, unknown>;
  manifest: Record<string, unknown>;
  manifest_sha256: string;
  status: (typeof EXPORT_STATUSES)[number];
  delivered_at: string | null;
  delivered_to: string | null;
  notes: string | null;
}

export interface ExportItemRow extends SyncedColumns {
  export_id: string;
  invoice_id: string;
  invoice_code: string;
  invoice_revision: number;
  files: Array<{ file_id: string; normalized_filename: string; sha256: string; size_bytes: number }>;
}
