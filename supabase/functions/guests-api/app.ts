/**
 * Ikisai Guests · API (docs/guests/API.md §6). Portal de los huéspedes: sin tablas ni rutas propias en la fase 1.
 * Lee su ficha de Booking (`read/booking.portal_my_guest`) y los textos de Central, y escribe con las acciones de portal de
 * Booking (`invoke/booking.portal_guest_*`, `portal_set_restrictions`), filtradas por el ámbito del enlace `{reservation_id,
 * guest_id}`. Sube la imagen de su firma al bucket privado `guests-documents`; en los portales, el kit solo deja leer y
 * verificar un archivo a quien lo subió (C7, #288). No emite enlaces.
 */
import { createApp, type AppConfig } from '../_kit/mod.ts';

export const GUESTS_ORIGINS = ['https://guests.ikisai.com', 'https://ikisai-guests.pages.dev'];

/** Firma del parte: imagen pequeña del trazo (API.md §8). */
export const GUESTS_UPLOADS = { bucket: 'guests-documents', allowedMime: ['image/png', 'image/webp'], maxBytes: 300_000 };

export function createGuestsApp(base: Omit<AppConfig, 'app' | 'slug' | 'origins' | 'uploads' | 'portalIssuer'> & Partial<Pick<AppConfig, 'origins'>>) {
  return createApp({
    ...base,
    app: 'guests',
    slug: 'guests-api',
    origins: base.origins ?? GUESTS_ORIGINS,
    uploads: GUESTS_UPLOADS,
  });
}
