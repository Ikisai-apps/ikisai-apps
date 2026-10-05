import { createSyncClient, type ApiError, type SyncClient, type SyncedRow, type TableName } from '@ikisai/sync-client';

export const APP = 'invoices';
export const SUPPLIERS: TableName = 'invoices.suppliers';

/** Categorías por defecto de un proveedor (misma lista que supabase/functions/invoices-api/app.ts). */
export const CATEGORIES = ['compras', 'suministros', 'mantenimiento', 'inversiones', 'canon_concesion', 'seguros', 'personal', 'fiscalidad', 'otros'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
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

export function categoryLabel(value: unknown): string {
  return typeof value === 'string' && value in CATEGORY_LABELS ? CATEGORY_LABELS[value as Category] : 'Sin categoría';
}

/** Fila de proveedor tal y como la devuelve el espejo local (`_pending` lo pone el cliente offline). */
export interface SupplierRow extends SyncedRow {
  name: string;
  tax_id: string | null;
  default_category: Category | null;
  notes: string | null;
  _pending?: boolean;
}

export function createClient(): SyncClient {
  return createSyncClient({
    app: APP,
    apiBase: '/api/v1',
    tables: [SUPPLIERS],
    pullIntervalMs: 30_000,
  });
}

/** Mensaje legible en español para un error de la API o de red. */
export function describeError(error: unknown): string {
  const e = error as Partial<ApiError> & { message?: string };
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
      return 'Tu cuenta no tiene acceso a Invoices.';
    case 'VERSION_CONFLICT':
      return 'Otra persona ha modificado esta fila.';
    case 'BACKEND_UNAVAILABLE':
      return 'El servidor no está disponible ahora mismo.';
    default:
      return typeof e?.message === 'string' && e.message ? e.message : 'Ha ocurrido un error inesperado.';
  }
}
