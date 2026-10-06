/** Ikisai Food · API. Configuración de la app sobre el núcleo; las rutas propias se añaden aquí. */
import { createApp, createSupabase, fail, isFault, type AppConfig, type AppRoute, type Operation, type RequestContext, type Supabase, type UploadsConfig } from '../_kit/mod.ts';
import { PHOTO_MAX_BYTES, PHOTO_MIME, RECIPE_FILE_FIELDS, validateOperations } from '../_domain/food/mod.ts';

export const FOOD_ORIGINS = ['https://food.ikisai.com', 'https://ikisai-food.pages.dev'];

export const FOOD_UPLOADS: UploadsConfig = { bucket: 'kitchen-media', maxBytes: PHOTO_MAX_BYTES, allowedMime: [...PHOTO_MIME] };

/** Una foto de receta debe ser un archivo de Food ya verificado y con tipo de imagen admitido. */
async function checkRecipePhotos(supabase: Supabase, operations: Operation[], ctx: RequestContext): Promise<void> {
  for (const [index, op] of operations.entries()) {
    if (op.table !== 'food.recipes' || !op.fields) continue;
    for (const field of RECIPE_FILE_FIELDS) {
      const id = op.fields[field];
      if (typeof id !== 'string') continue;
      let file: { status: string; mime: string };
      try {
        file = await supabase.rpc('core_file_get', { p_app: ctx.app, p_actor: ctx.user.id, p_id: id });
      } catch (error) {
        if (isFault(error) && error.code === 'FILE_NOT_FOUND') fail(422, 'INVALID_FILE', 'La foto no existe o no pertenece a Food.', { index, field });
        throw error;
      }
      if (file.status !== 'verified') fail(422, 'INVALID_FILE', 'La foto todavía no se ha subido por completo.', { index, field });
      if (!(PHOTO_MIME as readonly string[]).includes(file.mime)) fail(422, 'INVALID_FILE', 'La foto debe ser una imagen WebP o JPEG.', { index, field, mime: file.mime });
    }
  }
}

export const foodRoutes: AppRoute[] = [];

export function createFoodApp(base: Omit<AppConfig, 'app' | 'slug' | 'origins' | 'hooks' | 'routes' | 'uploads'> & Partial<Pick<AppConfig, 'origins' | 'uploads'>>) {
  const supabase = createSupabase(base);
  return createApp({
    ...base,
    app: 'food',
    slug: 'food-api',
    origins: base.origins ?? FOOD_ORIGINS,
    uploads: base.uploads ?? FOOD_UPLOADS,
    hooks: {
      beforeCommit: async (operations, ctx) => {
        const issue = validateOperations(operations);
        if (issue) fail(422, issue.code, issue.message, issue.details);
        await checkRecipePhotos(supabase, operations, ctx);
      },
    },
    routes: foodRoutes,
  });
}
