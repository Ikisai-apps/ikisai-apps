/**
 * Ikisai Organizers · API (docs/organizers/API.md §6). Portal de los organizadores: sin tablas ni rutas propias en la V1.
 * Lee y escribe en Booking con sus lecturas y acciones de portal (`read/booking.portal_*`, `invoke/booking.portal_*`),
 * filtradas por el ámbito del enlace; emite los enlaces de sus huéspedes con `portal-links` (`portalIssuer`).
 */
import { createApp, type AppConfig } from '../_kit/mod.ts';

export const ORGANIZERS_ORIGINS = ['https://organizers.ikisai.com', 'https://ikisai-organizers.pages.dev'];

export function createOrganizersApp(base: Omit<AppConfig, 'app' | 'slug' | 'origins' | 'portalIssuer'> & Partial<Pick<AppConfig, 'origins'>>) {
  return createApp({
    ...base,
    app: 'organizers',
    slug: 'organizers-api',
    origins: base.origins ?? ORGANIZERS_ORIGINS,
    portalIssuer: true,
  });
}
