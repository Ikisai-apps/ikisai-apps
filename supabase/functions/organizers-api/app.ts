/**
 * Ikisai Organizers · API (docs/organizers/API.md §6 y §15). Portal de los organizadores.
 * - Lee y escribe en Booking con sus lecturas y acciones de portal (`read/booking.portal_*`, `invoke/booking.portal_*`),
 *   filtradas por el ámbito del enlace; emite los enlaces de sus huéspedes con `portal-links` (`portalIssuer`).
 * - Fase 4: sus propias tablas `organizers.*` (experiencia de Guests, materiales, preguntas, respuestas y ofertas), con
 *   `commands`/`snapshot`/`changes` del kit. Cada organizador ve y escribe solo las filas de sus reservas (`visible` y
 *   `beforeCommit` aquí; el gancho `organizers.validate_batch` en la base de datos) y abre los archivos de sus materiales
 *   (K3: `files/:id` comprueba la fila que los referencia con `visible`).
 */
import { createApp, fail, type AppConfig } from '../_kit/mod.ts';
import { MATERIAL_MAX_BYTES, MATERIAL_MIME, validateOperations, visibleRow } from '../_domain/organizers/mod.ts';

export const ORGANIZERS_ORIGINS = ['https://organizers.ikisai.com', 'https://ikisai-organizers.pages.dev'];

/** Materiales del retiro: PDF hasta 15 MB e imágenes recomprimidas en el dispositivo (bucket de K5, #323). */
export const ORGANIZERS_UPLOADS = { bucket: 'organizers-materials', allowedMime: MATERIAL_MIME, maxBytes: MATERIAL_MAX_BYTES };

export function createOrganizersApp(base: Omit<AppConfig, 'app' | 'slug' | 'origins' | 'portalIssuer' | 'uploads' | 'hooks'> & Partial<Pick<AppConfig, 'origins'>>) {
  return createApp({
    ...base,
    app: 'organizers',
    slug: 'organizers-api',
    origins: base.origins ?? ORGANIZERS_ORIGINS,
    portalIssuer: true,
    uploads: ORGANIZERS_UPLOADS,
    hooks: {
      visible: (table, row, ctx) => visibleRow(table, row, ctx.membership, ctx.user.id),
      beforeCommit: (operations, ctx) => {
        const issue = validateOperations(operations, ctx.membership, undefined, ctx.user.id);
        if (issue) fail(issue.code === 'FORBIDDEN' || issue.code === 'OUT_OF_SCOPE' ? 403 : 422, issue.code, issue.message, issue.details);
      },
    },
  });
}
