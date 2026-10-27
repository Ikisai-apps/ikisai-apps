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
import { MATERIAL_MAX_BYTES, MATERIAL_MIME, proposalVisible, validateOperations, visibleRow } from '../_domain/organizers/mod.ts';
import { githubEvidence, GithubError, parseRef, type EvidenceStore } from '../_domain/organizers/github.ts';

export const ORGANIZERS_ORIGINS = ['https://organizers.ikisai.com', 'https://ikisai-organizers.pages.dev'];

/** Materiales del retiro: PDF hasta 15 MB e imágenes recomprimidas en el dispositivo (bucket de K5, #323). */
// K3 para miembros (#585): ningún miembro que no sea propietario lee un archivo ajeno por su id si no ve (`visible`) una
// fila viva que lo referencia. El único campo de archivo es `materials.file_id`, registrado en 0700.
export const ORGANIZERS_UPLOADS = { bucket: 'organizers-materials', allowedMime: MATERIAL_MIME, maxBytes: MATERIAL_MAX_BYTES, membersK3: true };

/** `organizers.github_evidence` (0704): token de solo lectura de la Edge (GITHUB_TOKEN); en las pruebas, `fetch` y caché propios. */
export interface OrganizersGithub { token?: string | null; fetch?: typeof fetch; store?: EvidenceStore }

export function createOrganizersApp(base: Omit<AppConfig, 'app' | 'slug' | 'origins' | 'portalIssuer' | 'uploads' | 'hooks' | 'workerRoutes'> & Partial<Pick<AppConfig, 'origins'>> & { github?: OrganizersGithub }) {
  const supabase = createSupabase(base);
  const { github, ...config } = base;
  const githubToken = github && 'token' in github ? github.token ?? null : ((globalThis as any).Deno?.env?.get?.('GITHUB_TOKEN') ?? null);
  return createApp({
    ...config,
    app: 'organizers',
    slug: 'organizers-api',
    origins: base.origins ?? ORGANIZERS_ORIGINS,
    portalIssuer: true,
    uploads: ORGANIZERS_UPLOADS,
    routes: [...(config.routes ?? []), {
      // Evidencia de GitHub de una tarjeta de Flow (capacidad del catálogo, 0704). Solo el personal de Organizers: owner o
      // editor sin `scopes.grants` (quien organiza un retiro es editor con grants y no la ve).
      method: 'GET', pattern: 'github/evidence',
      handler: async ({ ctx, url }) => {
        const role = ctx.membership.role;
        const portal = Array.isArray((ctx.membership.scopes as { grants?: unknown } | null)?.grants);
        if (!(role === 'owner' || (role === 'editor' && !portal))) fail(403, 'FORBIDDEN', 'Solo el equipo de Ikisai ve la evidencia de GitHub.');
        try {
          return await githubEvidence(parseRef(url.searchParams), { fetch: github?.fetch ?? fetch, token: githubToken, store: github?.store },
            { fresh: url.searchParams.get('fresh') === '1' });
        } catch (error) {
          if (error instanceof GithubError) fail(error.status, error.code, error.message, error.retryAfter ? { retryAfter: error.retryAfter } : null);
          throw error;
        }
      },
    }],
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
        if (issue) fail(issue.code === 'FORBIDDEN' || issue.code === 'OUT_OF_SCOPE' || issue.code === 'SUGGESTION_REQUIRED' ? 403 : 422, issue.code, issue.message, issue.details);
      },
      // Propuestas del equipo de Ikisai (0703): las ve y las decide quien organiza ese retiro con permiso propio.
      suggestionVisible: (suggestion, ctx) => proposalVisible(suggestion, ctx.membership),
    },
  });
}
