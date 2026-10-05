/** Ikisai Invoices · API. Configuración de la app sobre el núcleo; las rutas propias se añaden aquí. */
import { createApp, fail, type AppConfig, type AppRoute, type Operation, type RequestContext } from '../_kit/mod.ts';

export const INVOICES_ORIGINS = ['https://invoices.ikisai.com', 'https://ikisai-invoices.pages.dev'];

const CATEGORIES = ['compras', 'suministros', 'mantenimiento', 'inversiones', 'canon_concesion', 'seguros', 'personal', 'fiscalidad', 'otros'];

/** Validación de dominio: tipos y reglas que PostgreSQL no expresa bien o que queremos explicar al usuario. */
export function validateInvoicesOperations(operations: Operation[], _ctx: RequestContext): void {
  for (const op of operations) {
    if (op.table === 'invoices.suppliers' && op.fields) {
      const f = op.fields;
      if ('name' in f && (typeof f.name !== 'string' || !f.name.trim() || f.name.length > 200)) fail(422, 'INVALID_FIELDS', 'El nombre del proveedor es obligatorio (máximo 200 caracteres).', { field: 'name' });
      if ('tax_id' in f && f.tax_id !== null && (typeof f.tax_id !== 'string' || f.tax_id.length > 32)) fail(422, 'INVALID_FIELDS', 'NIF inválido.', { field: 'tax_id' });
      if ('default_category' in f && f.default_category !== null && !CATEGORIES.includes(f.default_category as string)) fail(422, 'INVALID_FIELDS', 'Categoría desconocida.', { field: 'default_category', allowed: CATEGORIES });
      if ('notes' in f && f.notes !== null && typeof f.notes !== 'string') fail(422, 'INVALID_FIELDS', 'Notas inválidas.', { field: 'notes' });
    }
  }
}

export const invoicesRoutes: AppRoute[] = [
  { method: 'GET', pattern: 'dashboard', handler: async ({ ctx }) => ({ app: 'invoices', cursor: ctx.bootstrap.cursor, pending: [], message: 'Panel pendiente de la fase 1.' }) },
];

export function createInvoicesApp(base: Omit<AppConfig, 'app' | 'slug' | 'origins' | 'hooks' | 'routes' | 'uploads'> & Partial<Pick<AppConfig, 'origins'>>) {
  return createApp({
    ...base,
    app: 'invoices',
    slug: 'invoices-api',
    origins: base.origins ?? INVOICES_ORIGINS,
    uploads: { bucket: 'purchase-documents', maxBytes: 50 * 1024 * 1024, allowedMime: ['application/pdf', 'image/webp', 'image/jpeg', 'image/png'] },
    hooks: { beforeCommit: validateInvoicesOperations },
    routes: invoicesRoutes,
  });
}
