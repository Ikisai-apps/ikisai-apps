/**
 * Ikisai Organizers · API (docs/organizers/API.md §6 y §15). Portal de los organizadores.
 * - Lee y escribe en Booking con sus lecturas y acciones de portal (`read/booking.portal_*`, `invoke/booking.portal_*`),
 *   filtradas por el ámbito del enlace; emite los enlaces de sus huéspedes con `portal-links` (`portalIssuer`).
 * - Fase 4: sus propias tablas `organizers.*` (experiencia de Guests, materiales, preguntas, respuestas y ofertas), con
 *   `commands`/`snapshot`/`changes` del kit. Cada organizador ve y escribe solo las filas de sus reservas (`visible` y
 *   `beforeCommit` aquí; el gancho `organizers.validate_batch` en la base de datos) y abre los archivos de sus materiales
 *   (K3: `files/:id` comprueba la fila que los referencia con `visible`).
 * - Conservación (B18): `POST worker/retention/tick` borra las respuestas de los huéspedes a los 6 meses del fin del retiro,
 *   en un lote del sistema firmado por la cuenta de servicio `organizers`.
 */
import { createApp, createSupabase, ensureServiceActor, fail, type AppConfig } from '../_kit/mod.ts';
import { MATERIAL_MAX_BYTES, MATERIAL_MIME, validateOperations, visibleRow } from '../_domain/organizers/mod.ts';

export const ORGANIZERS_ORIGINS = ['https://organizers.ikisai.com', 'https://ikisai-organizers.pages.dev'];

/** Materiales del retiro: PDF hasta 15 MB e imágenes recomprimidas en el dispositivo (bucket de K5, #323). */
export const ORGANIZERS_UPLOADS = { bucket: 'organizers-materials', allowedMime: MATERIAL_MIME, maxBytes: MATERIAL_MAX_BYTES };

export function createOrganizersApp(base: Omit<AppConfig, 'app' | 'slug' | 'origins' | 'portalIssuer' | 'uploads' | 'hooks' | 'workerRoutes'> & Partial<Pick<AppConfig, 'origins'>>) {
  const supabase = createSupabase(base);
  return createApp({
    ...base,
    app: 'organizers',
    slug: 'organizers-api',
    origins: base.origins ?? ORGANIZERS_ORIGINS,
    portalIssuer: true,
    uploads: ORGANIZERS_UPLOADS,
    workerRoutes: [{
      method: 'POST', pattern: 'retention/tick',
      handler: async () => {
        await ensureServiceActor(supabase, 'organizers'); // el lote lo firma «Organizers (sistema)»
        return supabase.rpc('core_invoke', { p_app: 'organizers', p_actor: null, p_name: 'organizers.retention_run', p_args: { limit: 200 } });
      },
    }],
    hooks: {
      visible: (table, row, ctx) => visibleRow(table, row, ctx.membership, ctx.user.id),
      beforeCommit: (operations, ctx) => {
        const issue = validateOperations(operations, ctx.membership, undefined, ctx.user.id);
        if (issue) fail(issue.code === 'FORBIDDEN' || issue.code === 'OUT_OF_SCOPE' ? 403 : 422, issue.code, issue.message, issue.details);
      },
    },
  });
}
