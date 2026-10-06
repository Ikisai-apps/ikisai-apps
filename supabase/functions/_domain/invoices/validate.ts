/**
 * Validación de campos por tabla (API.md §4.1). La ejecuta el cliente antes de encolar y la Edge en `beforeCommit`.
 * Solo comprueba lo que PostgreSQL no expresa bien o que conviene explicar en español; las restricciones duras
 * (check, FK, unique) siguen en la migración.
 */
import { decimalsOf, isFiniteNumber } from './money.ts';
import {
  DEDUCTIBILITIES, EXPENSE_CATEGORIES, EXPORT_STATUSES, FILE_KINDS, FILE_MIMES, INVOICE_SOURCES, INVOICE_STATUSES, ITEM_TYPES, PAYMENT_METHODS,
  PAYMENT_STATUSES, TABLES, TARGET_APPS, TARGET_KINDS, TAX_TYPES, WRITABLE, type InvoicesTable,
} from './types.ts';

/** Error de dominio: se convierte en `Fault(422, code, message, details)` en la Edge y en mensaje en el cliente. */
export class DomainError extends Error {
  code: string;
  details: Record<string, unknown> | null;
  status: number;
  constructor(code: string, message: string, details: Record<string, unknown> | null = null, status = 422) {
    super(message);
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

export function domainFail(code: string, message: string, details: Record<string, unknown> | null = null, status = 422): never {
  throw new DomainError(code, message, details, status);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;

type Fields = Record<string, unknown>;

function has(fields: Fields, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(fields, key);
}

function text(fields: Fields, key: string, { required = false, max = 500, min = 1 }: { required?: boolean; max?: number; min?: number } = {}): void {
  if (!has(fields, key)) return;
  const v = fields[key];
  if (v === null) {
    if (required) domainFail('INVALID_FIELDS', `El campo ${key} es obligatorio.`, { field: key });
    return;
  }
  if (typeof v !== 'string') domainFail('INVALID_FIELDS', `El campo ${key} debe ser texto.`, { field: key });
  const t = (v as string).trim();
  if (required && t.length < min) domainFail('INVALID_FIELDS', `El campo ${key} no puede estar vacío.`, { field: key });
  if (t.length > max) domainFail('INVALID_FIELDS', `El campo ${key} supera ${max} caracteres.`, { field: key, max });
}

function oneOf(fields: Fields, key: string, values: readonly string[], { nullable = true }: { nullable?: boolean } = {}): void {
  if (!has(fields, key)) return;
  const v = fields[key];
  if (v === null) {
    if (!nullable) domainFail('INVALID_FIELDS', `El campo ${key} es obligatorio.`, { field: key });
    return;
  }
  if (typeof v !== 'string' || !values.includes(v)) domainFail('INVALID_FIELDS', `Valor no admitido en ${key}.`, { field: key, allowed: values });
}

function bool(fields: Fields, key: string, { nullable = false }: { nullable?: boolean } = {}): void {
  if (!has(fields, key)) return;
  const v = fields[key];
  if (v === null && nullable) return;
  if (typeof v !== 'boolean') domainFail('INVALID_FIELDS', `El campo ${key} debe ser sí o no.`, { field: key });
}

function money(fields: Fields, key: string, { nullable = true, min, decimals = 2 }: { nullable?: boolean; min?: number; decimals?: number } = {}): void {
  if (!has(fields, key)) return;
  const v = fields[key];
  if (v === null) {
    if (!nullable) domainFail('INVALID_FIELDS', `El campo ${key} es obligatorio.`, { field: key });
    return;
  }
  if (!isFiniteNumber(v)) domainFail('INVALID_FIELDS', `El campo ${key} debe ser un número.`, { field: key });
  if (decimalsOf(v as number) > decimals) domainFail('INVALID_FIELDS', `El campo ${key} admite ${decimals} decimales.`, { field: key });
  if (min !== undefined && (v as number) < min) domainFail('INVALID_FIELDS', `El campo ${key} no puede ser menor que ${min}.`, { field: key });
  if (Math.abs(v as number) >= 1e10) domainFail('INVALID_FIELDS', `El campo ${key} es demasiado grande.`, { field: key });
}

function date(fields: Fields, key: string, { nullable = true }: { nullable?: boolean } = {}): void {
  if (!has(fields, key)) return;
  const v = fields[key];
  if (v === null) {
    if (!nullable) domainFail('INVALID_FIELDS', `El campo ${key} es obligatorio.`, { field: key });
    return;
  }
  if (typeof v !== 'string' || !ISO_DATE.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) domainFail('INVALID_FIELDS', `El campo ${key} debe ser una fecha AAAA-MM-DD.`, { field: key });
}

function uuid(fields: Fields, key: string, { nullable = false }: { nullable?: boolean } = {}): void {
  if (!has(fields, key)) return;
  const v = fields[key];
  if (v === null && nullable) return;
  if (typeof v !== 'string' || !UUID.test(v)) domainFail('INVALID_FIELDS', `El campo ${key} debe ser un identificador válido.`, { field: key });
}

function integer(fields: Fields, key: string, { min = 0, nullable = false }: { min?: number; nullable?: boolean } = {}): void {
  if (!has(fields, key)) return;
  const v = fields[key];
  if (v === null && nullable) return;
  if (!Number.isSafeInteger(v) || (v as number) < min) domainFail('INVALID_FIELDS', `El campo ${key} debe ser un entero ≥ ${min}.`, { field: key });
}

function onlyWritable(table: InvoicesTable, fields: Fields): void {
  const allowed = WRITABLE[table];
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) domainFail('INVALID_FIELDS', `El campo ${key} no se puede escribir en ${table}.`, { field: key, table });
  }
}

export function validateSupplierFields(fields: Fields, op: 'insert' | 'update'): void {
  onlyWritable(TABLES.suppliers, fields);
  if (op === 'insert' && !has(fields, 'name')) domainFail('INVALID_FIELDS', 'El nombre del proveedor es obligatorio.', { field: 'name' });
  text(fields, 'name', { required: true, max: 200 });
  text(fields, 'tax_id', { max: 32 });
  text(fields, 'slug', { max: 40 });
  if (has(fields, 'slug') && typeof fields.slug === 'string' && !/^[a-z0-9_]*$/.test(fields.slug)) domainFail('INVALID_FIELDS', 'El slug solo admite minúsculas, dígitos y _.', { field: 'slug' });
  oneOf(fields, 'default_category', EXPENSE_CATEGORIES);
  bool(fields, 'default_is_investment');
  text(fields, 'notes', { max: 4000 });
  if (has(fields, 'aliases')) {
    const a = fields.aliases;
    if (!Array.isArray(a) || a.length > 20 || a.some((x) => typeof x !== 'string' || !x.trim() || x.length > 200)) {
      domainFail('INVALID_FIELDS', 'Los alias deben ser hasta 20 textos no vacíos de máximo 200 caracteres.', { field: 'aliases' });
    }
  }
}

export function validateInvoiceFields(fields: Fields, op: 'insert' | 'update', { allowImportMeta = false }: { allowImportMeta?: boolean } = {}): void {
  onlyWritable(TABLES.invoices, fields);
  if (op === 'insert') {
    for (const key of ['supplier_id', 'invoice_date', 'object']) {
      if (!has(fields, key)) domainFail('INVALID_FIELDS', `El campo ${key} es obligatorio.`, { field: key });
    }
  }
  uuid(fields, 'supplier_id');
  date(fields, 'invoice_date', { nullable: false });
  date(fields, 'due_date');
  date(fields, 'paid_at');
  text(fields, 'object', { required: true, max: 120 });
  text(fields, 'invoice_number', { max: 64 });
  text(fields, 'review_reason', { max: 200 });
  text(fields, 'annulled_reason', { max: 500 });
  text(fields, 'notes', { max: 4000 });
  if (has(fields, 'currency') && fields.currency !== 'EUR') domainFail('UNSUPPORTED_IN_V1', 'En V1 solo se admiten facturas en euros.', { field: 'currency' });
  oneOf(fields, 'expense_category', EXPENSE_CATEGORIES);
  bool(fields, 'is_investment');
  oneOf(fields, 'deductibility', DEDUCTIBILITIES, { nullable: false });
  oneOf(fields, 'status', INVOICE_STATUSES, { nullable: false });
  oneOf(fields, 'payment_status', PAYMENT_STATUSES, { nullable: false });
  oneOf(fields, 'payment_method', PAYMENT_METHODS);
  oneOf(fields, 'source', INVOICE_SOURCES, { nullable: false });
  money(fields, 'source_total');
  for (const key of ['calculated_base', 'calculated_vat', 'calculated_other', 'calculated_withholding', 'calculated_total']) money(fields, key, { nullable: false });
  money(fields, 'totals_delta');
  if (has(fields, 'import_sha256') && fields.import_sha256 !== null && (typeof fields.import_sha256 !== 'string' || !SHA256.test(fields.import_sha256))) {
    domainFail('INVALID_FIELDS', 'import_sha256 debe ser un SHA-256 en hexadecimal.', { field: 'import_sha256' });
  }
  if (has(fields, 'import_meta') && !allowImportMeta) domainFail('INVALID_FIELDS', 'import_meta solo lo escribe la importación.', { field: 'import_meta' });
  if (fields.payment_status === 'pagada' && has(fields, 'paid_at') && fields.paid_at === null) domainFail('PAID_AT_REQUIRED', 'Indica la fecha de pago.', { field: 'paid_at' });
  if (fields.status === 'anulada' && has(fields, 'annulled_reason') && !fields.annulled_reason) domainFail('ANNUL_REASON_REQUIRED', 'Indica el motivo de la anulación.', { field: 'annulled_reason' });
}

export function validateInvoiceFileFields(fields: Fields, op: 'insert' | 'update'): void {
  onlyWritable(TABLES.invoiceFiles, fields);
  if (op === 'insert') {
    for (const key of ['invoice_id', 'file_id', 'original_filename']) {
      if (!has(fields, key)) domainFail('INVALID_FIELDS', `El campo ${key} es obligatorio.`, { field: key });
    }
  }
  uuid(fields, 'invoice_id');
  // file_id puede llegar como marcador { "$blob": sha } desde el cliente; el sync-client lo sustituye antes de enviar.
  if (has(fields, 'file_id') && !isBlobMarker(fields.file_id)) uuid(fields, 'file_id');
  text(fields, 'original_filename', { required: true, max: 255 });
  integer(fields, 'page_order', { min: 1 });
  oneOf(fields, 'kind', FILE_KINDS, { nullable: false });
  oneOf(fields, 'mime_type', FILE_MIMES, { nullable: false });
  integer(fields, 'size_bytes', { min: 0 });
  if (has(fields, 'sha256') && (typeof fields.sha256 !== 'string' || !SHA256.test(fields.sha256))) domainFail('INVALID_FIELDS', 'sha256 inválido.', { field: 'sha256' });
}

export function isBlobMarker(value: unknown): value is { $blob: string } {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 1 && typeof (value as { $blob?: unknown }).$blob === 'string';
}

export function validateInvoiceLineFields(fields: Fields, op: 'insert' | 'update'): void {
  onlyWritable(TABLES.invoiceLines, fields);
  if (op === 'insert') {
    for (const key of ['invoice_id', 'position', 'description', 'net_amount']) {
      if (!has(fields, key)) domainFail('INVALID_FIELDS', `El campo ${key} es obligatorio.`, { field: key });
    }
  }
  uuid(fields, 'invoice_id');
  integer(fields, 'position', { min: 0 });
  text(fields, 'description', { required: true, max: 500 });
  text(fields, 'unit', { max: 16 });
  text(fields, 'match_name', { max: 200 });
  text(fields, 'notes', { max: 2000 });
  money(fields, 'quantity', { decimals: 3 });
  money(fields, 'unit_price', { decimals: 4 });
  money(fields, 'discount_amount', { nullable: false });
  money(fields, 'net_amount', { nullable: false });
  money(fields, 'vat_amount');
  money(fields, 'gross_amount');
  if (has(fields, 'vat_rate') && fields.vat_rate !== null) {
    if (!isFiniteNumber(fields.vat_rate) || fields.vat_rate < 0 || fields.vat_rate > 100) domainFail('INVALID_FIELDS', 'El tipo de IVA debe estar entre 0 y 100.', { field: 'vat_rate' });
  }
  if (has(fields, 'confidence') && fields.confidence !== null) {
    if (!isFiniteNumber(fields.confidence) || fields.confidence < 0 || fields.confidence > 1) domainFail('INVALID_FIELDS', 'La confianza debe estar entre 0 y 1.', { field: 'confidence' });
  }
  oneOf(fields, 'item_type', ITEM_TYPES);
  oneOf(fields, 'expense_category', EXPENSE_CATEGORIES);
  bool(fields, 'is_investment', { nullable: true });
}

export function validateTaxLineFields(fields: Fields, op: 'insert' | 'update'): void {
  onlyWritable(TABLES.taxLines, fields);
  if (op === 'insert') {
    for (const key of ['invoice_id', 'position', 'tax_type', 'amount']) {
      if (!has(fields, key)) domainFail('INVALID_FIELDS', `El campo ${key} es obligatorio.`, { field: key });
    }
  }
  uuid(fields, 'invoice_id');
  integer(fields, 'position', { min: 0 });
  oneOf(fields, 'tax_type', TAX_TYPES, { nullable: false });
  if (has(fields, 'rate') && fields.rate !== null && (!isFiniteNumber(fields.rate) || fields.rate < 0 || fields.rate > 100)) domainFail('INVALID_FIELDS', 'El tipo debe estar entre 0 y 100.', { field: 'rate' });
  money(fields, 'taxable_base');
  money(fields, 'amount', { nullable: false, min: 0 });
  text(fields, 'notes', { max: 2000 });
}

export function validTargetPair(targetApp: unknown, targetKind: unknown): boolean {
  return typeof targetApp === 'string' && typeof targetKind === 'string' && (TARGET_KINDS[targetApp as keyof typeof TARGET_KINDS] ?? []).includes(targetKind);
}

export function validateAllocationFields(fields: Fields, op: 'insert' | 'update'): void {
  onlyWritable(TABLES.allocations, fields);
  if (op === 'insert') {
    for (const key of ['invoice_line_id', 'target_app', 'target_kind', 'target_label', 'allocated_amount']) {
      if (!has(fields, key)) domainFail('INVALID_FIELDS', `El campo ${key} es obligatorio.`, { field: key });
    }
  }
  uuid(fields, 'invoice_line_id');
  oneOf(fields, 'target_app', TARGET_APPS, { nullable: false });
  if (has(fields, 'target_app') || has(fields, 'target_kind')) {
    if (has(fields, 'target_app') && has(fields, 'target_kind') && !validTargetPair(fields.target_app, fields.target_kind)) {
      domainFail('INVALID_FIELDS', 'El tipo de destino no corresponde a esa aplicación.', { field: 'target_kind', allowed: TARGET_KINDS });
    }
    if (has(fields, 'target_app') !== has(fields, 'target_kind')) domainFail('INVALID_FIELDS', 'target_app y target_kind se cambian juntos.', { field: 'target_kind' });
  }
  if (fields.target_app === 'general') {
    if (has(fields, 'target_id') && fields.target_id !== null) domainFail('INVALID_FIELDS', 'Un destino general no lleva identificador.', { field: 'target_id' });
  } else if (has(fields, 'target_app')) {
    if (!has(fields, 'target_id') || typeof fields.target_id !== 'string' || !fields.target_id.trim()) domainFail('INVALID_FIELDS', 'Indica el destino.', { field: 'target_id' });
  }
  text(fields, 'target_id', { max: 120 });
  text(fields, 'target_code', { max: 64 });
  text(fields, 'target_label', { required: true, max: 300 });
  integer(fields, 'target_revision', { min: 0, nullable: true });
  money(fields, 'allocated_quantity', { decimals: 3 });
  if (has(fields, 'allocated_quantity') && fields.allocated_quantity !== null && (fields.allocated_quantity as number) <= 0) domainFail('INVALID_FIELDS', 'La cantidad asignada debe ser mayor que cero.', { field: 'allocated_quantity' });
  money(fields, 'allocated_amount', { nullable: false });
  if (has(fields, 'allocated_amount') && (fields.allocated_amount as number) <= 0) domainFail('INVALID_FIELDS', 'El importe asignado debe ser mayor que cero.', { field: 'allocated_amount' });
  text(fields, 'notes', { max: 2000 });
}

export function validateExportFields(fields: Fields, op: 'insert' | 'update'): void {
  if (op === 'insert') domainFail('INVALID_OPERATION', 'Las entregas se crean con el procedimiento invoices.create_export.', { table: TABLES.exports });
  onlyWritable(TABLES.exports, fields);
  oneOf(fields, 'status', EXPORT_STATUSES, { nullable: false });
  text(fields, 'delivered_to', { max: 300 });
  text(fields, 'notes', { max: 4000 });
}

/** Valida los `fields` de una operación de fila de cualquier tabla de Invoices. */
export function validateRowFields(table: string, op: 'insert' | 'update', fields: Fields, options: { allowImportMeta?: boolean } = {}): void {
  switch (table) {
    case TABLES.suppliers: return validateSupplierFields(fields, op);
    case TABLES.invoices: return validateInvoiceFields(fields, op, options);
    case TABLES.invoiceFiles: return validateInvoiceFileFields(fields, op);
    case TABLES.invoiceLines: return validateInvoiceLineFields(fields, op);
    case TABLES.taxLines: return validateTaxLineFields(fields, op);
    case TABLES.allocations: return validateAllocationFields(fields, op);
    case TABLES.exports: return validateExportFields(fields, op);
    case TABLES.exportItems: return domainFail('INVALID_OPERATION', 'Las filas de entrega las escribe el procedimiento invoices.create_export.', { table });
    default: return;
  }
}

/** Mensajes en español por código de error del dominio (cliente y Edge). */
export const DOMAIN_MESSAGES: Record<string, string> = {
  IMPORT_INVALID: 'El JSON no cumple el formato ikisai.invoice.v1.',
  INVOICE_NOT_IMPORTABLE: 'Esta factura ya tiene datos; importa sobre una factura vacía.',
  SUPPLIER_TAX_ID_EXISTS: 'Ya existe un proveedor con ese NIF.',
  DUPLICATE_INVOICE: 'Ya existe una factura de este proveedor con ese número.',
  DUPLICATE_IMPORT: 'Este JSON ya se importó.',
  DUPLICATE_FILE: 'Este documento ya está adjunto a otra factura.',
  INVOICE_NOT_DELETABLE: 'Las facturas no se borran: anúlala.',
  INVOICE_INCOMPLETE: 'Faltan datos para validar la factura.',
  INVOICE_TOTALS_MISMATCH: 'Los importes no cuadran con el total del documento.',
  INVOICE_LOCKED: 'La factura está archivada o anulada y no admite ese cambio.',
  INVOICE_ARCHIVED: 'La factura está archivada: solo se pueden cambiar pago y notas.',
  INVOICE_ANNULLED: 'La factura está anulada.',
  INVOICE_FILE_LOCKED: 'Los documentos de una factura validada no se quitan; añade otro.',
  INVOICE_LINE_LOCKED: 'Las líneas de una factura validada no se borran; edítalas.',
  INVALID_TRANSITION: 'Ese cambio de estado se hace con su acción propia.',
  ANNUL_REASON_REQUIRED: 'Indica el motivo de la anulación.',
  PAID_AT_REQUIRED: 'Indica la fecha de pago.',
  TARGET_NOT_FOUND: 'El destino ya no existe en Tareas.',
  TARGET_FORBIDDEN: 'No tienes acceso a ese destino en Tareas.',
  TARGET_UNAVAILABLE: 'No se pudo consultar Tareas. Se reintentará.',
  TARGET_APP_NOT_AVAILABLE: 'Ese tipo de destino llegará en la fase 2.',
  ALLOCATIONS_EXCEED_LINE: 'La suma de asignaciones supera el importe de la línea.',
  ALLOCATIONS_EXCEED_QUANTITY: 'La suma de cantidades asignadas supera la cantidad de la línea.',
  TAX_LINE_DUPLICATE: 'Hay dos líneas de impuesto con el mismo tipo y tasa.',
  EXPORT_EMPTY: 'No hay facturas validadas en ese rango.',
  EXPORT_NOT_DELETABLE: 'Las entregas no se borran.',
  EXPORT_IMMUTABLE: 'Una entrega generada no se modifica.',
  EXPORT_FILE_MISSING: 'Falta un documento en el almacenamiento; no se puede generar el ZIP.',
  UNSUPPORTED_IN_V1: 'Esta opción no está disponible en la versión actual.',
};

export function domainMessage(code: string, fallback = 'La operación no se pudo completar.'): string {
  return DOMAIN_MESSAGES[code] ?? fallback;
}
