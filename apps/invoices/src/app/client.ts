import { createSyncClient, type ApiError, type SyncClient, type SyncedRow, type TableName } from '@ikisai/sync-client';
import {
  EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS, TABLES, domainMessage,
  type AllocationRow, type ExpenseCategory, type IssuedAllocationRow, type IssuedFileRow, type TemplateLike, type IssuedInvoiceRow, type IssuedLineRow, type IssuedSeriesRow, type IssuedTaxLineRow, type ExportItemRow, type ExportRow, type InvoiceFileRow, type InvoiceLineRow, type InvoiceRow, type SupplierRow as DomainSupplierRow, type TaxLineRow,
} from '@ikisai/domain-invoices';

export const APP = 'invoices';
export const SUPPLIERS: TableName = TABLES.suppliers;
export const INVOICES: TableName = TABLES.invoices;
export const INVOICE_FILES: TableName = TABLES.invoiceFiles;
export const INVOICE_LINES: TableName = TABLES.invoiceLines;
export const TAX_LINES: TableName = TABLES.taxLines;
export const ALLOCATIONS: TableName = TABLES.allocations;
export const EXPORTS: TableName = TABLES.exports;
export const EXPORT_ITEMS: TableName = TABLES.exportItems;
export const ISSUED_SERIES: TableName = TABLES.issuedSeries;
export const ISSUED_INVOICES: TableName = TABLES.issuedInvoices;
export const ISSUED_LINES: TableName = TABLES.issuedLines;
export const ISSUED_TAX_LINES: TableName = TABLES.issuedTaxLines;
export const ISSUED_FILES: TableName = TABLES.issuedFiles;
export const ISSUED_ALLOCATIONS: TableName = TABLES.issuedAllocations;
/** Plantillas por proveedor (API.md §6.9): en el dispositivo para que «Leer PDF» funcione sin red. */
export const SUPPLIER_TEMPLATES: TableName = TABLES.supplierTemplates;
export const ALL_TABLES: TableName[] = [SUPPLIERS, INVOICES, INVOICE_FILES, INVOICE_LINES, TAX_LINES, ALLOCATIONS, EXPORTS, EXPORT_ITEMS,
  ISSUED_SERIES, ISSUED_INVOICES, ISSUED_LINES, ISSUED_TAX_LINES, ISSUED_FILES, ISSUED_ALLOCATIONS, SUPPLIER_TEMPLATES];

/** Categorías de gasto (lista cerrada del dominio) y sus etiquetas. */
export const CATEGORIES = EXPENSE_CATEGORIES;
export type Category = ExpenseCategory;
export const CATEGORY_LABELS = EXPENSE_CATEGORY_LABELS;

export function categoryLabel(value: unknown): string {
  return typeof value === 'string' && value in CATEGORY_LABELS ? CATEGORY_LABELS[value as Category] : 'Sin categoría';
}

/** Fila del espejo local: la del dominio más `_pending`, que pone el cliente offline. */
type Local<T> = T & SyncedRow & { _pending?: boolean };
export type LocalSupplier = Local<DomainSupplierRow>;
export type LocalInvoice = Local<InvoiceRow>;
export type LocalInvoiceFile = Local<InvoiceFileRow>;
export type LocalInvoiceLine = Local<InvoiceLineRow>;
export type LocalTaxLine = Local<TaxLineRow>;
export type LocalAllocation = Local<AllocationRow>;
export type LocalExport = Local<ExportRow>;
export type LocalExportItem = Local<ExportItemRow>;
export type LocalIssuedSeries = Local<IssuedSeriesRow>;
export type LocalSupplierTemplate = Local<TemplateLike & { created_at: string; updated_at: string; updated_by: string | null; deleted_at: string | null; revision: number; last_confirmed_invoice_id: string | null }>;
export type LocalIssuedInvoice = Local<IssuedInvoiceRow>;
export type LocalIssuedLine = Local<IssuedLineRow>;
export type LocalIssuedTaxLine = Local<IssuedTaxLineRow>;
export type LocalIssuedFile = Local<IssuedFileRow>;
export type LocalIssuedAllocation = Local<IssuedAllocationRow>;
/** Compatibilidad con las vistas de la fase 0. */
export type SupplierRow = LocalSupplier;

export function createClient(): SyncClient {
  return createSyncClient({
    app: APP,
    apiBase: '/api/v1',
    tables: ALL_TABLES,
    pullIntervalMs: 30_000,
    // Las facturas son datos del negocio: al cerrar sesión no se quedan en un dispositivo compartido (API.md §10).
    clearOnLogout: true,
  });
}

/** Mensaje legible en español para un error de la API, del dominio o de red. */
export function describeError(error: unknown): string {
  const e = error as Partial<ApiError> & { message?: string; details?: unknown };
  const code = typeof e?.code === 'string' ? e.code : '';
  switch (code) {
    case 'LOGIN_FAILED':
      return 'Correo o contraseña incorrectos.';
    case 'NETWORK':
      return 'No hay conexión con el servidor.';
    case 'UNAUTHENTICATED':
    case 'UNAUTHORIZED':
      return 'La sesión ha caducado. Vuelve a iniciar sesión.';
    case 'FORBIDDEN':
    case 'NO_MEMBERSHIP':
      return 'Tu cuenta no tiene permiso para esto en Invoices.';
    case 'VERSION_CONFLICT':
      return 'Otra persona ha modificado esta fila.';
    case 'BACKEND_UNAVAILABLE':
      return 'El servidor no está disponible ahora mismo.';
    case 'INVALID_FIELDS': {
      const field = (e.details as { field?: string } | undefined)?.field;
      return typeof e.message === 'string' && e.message ? e.message : field ? `El campo ${field} no es válido.` : 'Hay campos inválidos.';
    }
    case 'CONSTRAINT_VIOLATION':
    case 'INVALID_VALUE':
    case 'DOMAIN_ERROR':
      return typeof e.message === 'string' && e.message ? e.message : 'Los datos no cumplen una regla de la aplicación.';
    default: {
      const known = domainMessage(code, '');
      if (known) return known;
      return typeof e?.message === 'string' && e.message ? e.message : 'Ha ocurrido un error inesperado.';
    }
  }
}
