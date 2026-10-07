/** Ikisai Central · API. Administración común (`admin/*` del kit) y personas sobre el núcleo (docs/central/API.md). */
import { createApp, createSupabase, createUploads, fail, isFault, type AppConfig, type AppRoute, type Operation, type RequestContext, type Supabase, type UploadsConfig } from '../_kit/mod.ts';
import { ENTITY_TABLE, LOGO_MIME, TABLES, validateOperations, visibleRow } from '../_domain/central/mod.ts';

export const CENTRAL_ORIGINS = ['https://central.ikisai.com', 'https://ikisai-central.pages.dev'];

/** Documentación de personas y de cumplimiento: PDF e imágenes (fotos recomprimidas en el cliente). */
export const CENTRAL_UPLOADS: UploadsConfig = {
  bucket: 'central-documents',
  maxBytes: 25 * 1024 * 1024,
  allowedMime: ['application/pdf', 'image/webp', 'image/jpeg', 'image/png'],
};

/** Columnas que referencian un archivo de Central, y los tipos que admite cada una (vacío = cualquiera del bucket). */
const FILE_FIELDS: Record<string, { field: string; mime: readonly string[] }> = {
  [TABLES.personRecords]: { field: 'file_id', mime: [] },
  [ENTITY_TABLE]: { field: 'logo_file_id', mime: LOGO_MIME },
};

/** Un archivo referenciado debe ser de Central, estar verificado y tener un tipo admitido para esa columna. */
async function checkFiles(supabase: Supabase, operations: Operation[], ctx: RequestContext): Promise<void> {
  for (const [index, op] of operations.entries()) {
    const spec = op.table ? FILE_FIELDS[op.table] : undefined;
    const id = spec && op.fields ? op.fields[spec.field] : undefined;
    if (!spec || typeof id !== 'string') continue;
    let file: { status: string; mime: string };
    try {
      file = await supabase.rpc('core_file_get', { p_app: ctx.app, p_actor: ctx.user.id, p_id: id });
    } catch (error) {
      if (isFault(error) && error.code === 'FILE_NOT_FOUND') fail(422, 'INVALID_FILE', 'El archivo no existe o no pertenece a Central.', { index, field: spec.field });
      throw error;
    }
    if (file.status !== 'verified') fail(422, 'INVALID_FILE', 'El archivo todavía no se ha subido por completo.', { index, field: spec.field });
    if (spec.mime.length && !spec.mime.includes(file.mime)) fail(422, 'INVALID_FILE', 'El logotipo debe ser una imagen PNG, JPEG o WebP.', { index, field: spec.field, mime: file.mime });
  }
}

function centralRoutes(supabase: Supabase, uploads: UploadsConfig): AppRoute[] {
  const files = createUploads(supabase, 'central', uploads);
  const read = <T>(ctx: RequestContext, name: string, args: Record<string, unknown> = {}) =>
    supabase.rpc<T>('core_read', { p_app: ctx.app, p_actor: ctx.user.id, p_name: name, p_args: args });
  return [
    // Catálogo completo de apps para la pantalla Accesos (solo owner de Central).
    { method: 'GET', pattern: 'catalog/apps', handler: ({ ctx }) => read(ctx, 'central.app_catalog') },
    // Archivo de un registro de documentación: solo para quien ve los datos reservados (API.md §8, mientras falte P1).
    {
      method: 'GET', pattern: 'people/records/:id/file', handler: async ({ ctx, params }) => {
        const { fileId } = await read<{ fileId: string }>(ctx, 'central.record_file', { id: params.id ?? '' });
        return files.readUrl(ctx, fileId);
      },
    },
  ];
}

export function createCentralApp(base: Omit<AppConfig, 'app' | 'slug' | 'origins' | 'hooks' | 'routes' | 'uploads' | 'admin'> & Partial<Pick<AppConfig, 'origins' | 'uploads'>>) {
  const supabase = createSupabase(base);
  const uploads = base.uploads ?? CENTRAL_UPLOADS;
  return createApp({
    ...base,
    app: 'central',
    slug: 'central-api',
    admin: true,
    origins: base.origins ?? CENTRAL_ORIGINS,
    uploads,
    hooks: {
      visible: (table, _row, ctx) => visibleRow(table, ctx.membership),
      beforeCommit: async (operations, ctx) => {
        const issue = validateOperations(operations, ctx.membership);
        if (issue) fail(issue.code === 'FORBIDDEN' ? 403 : 422, issue.code, issue.message, issue.details);
        await checkFiles(supabase, operations, ctx);
      },
    },
    routes: centralRoutes(supabase, uploads),
  });
}
