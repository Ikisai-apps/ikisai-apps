/**
 * Ikisai Guests · API (docs/guests/API.md §6). Portal de los huéspedes: sin tablas propias.
 * Lee su ficha de Booking (`read/booking.portal_my_guest`) y los textos de Central, y escribe con las acciones de portal de
 * Booking (`invoke/booking.portal_guest_*`, `portal_set_restrictions`), filtradas por el ámbito del enlace `{reservation_id,
 * guest_id}`. Sube la imagen de su firma al bucket privado `guests-documents`; en los portales, el kit solo deja leer y
 * verificar un archivo a quien lo subió (C7, #288). No emite enlaces.
 * Ruta propia: `GET plans`, el mapa de zonas (Recursos §2, `resources.portal_plans`) con cada dibujo firmado aquí.
 */
import { createApp, createStorage, createSupabase, r2ConfigFromEnv, type AppConfig, type AppRoute, type Supabase } from '../_kit/mod.ts';

export const GUESTS_ORIGINS = ['https://guests.ikisai.com', 'https://ikisai-guests.pages.dev'];

/** Firma del parte: imagen pequeña del trazo (API.md §8). */
export const GUESTS_UPLOADS = { bucket: 'guests-documents', allowedMime: ['image/png', 'image/webp'], maxBytes: 300_000 };

const PORTAL_PLANS = 'resources.portal_plans';
const denoEnv = (name: string): string | undefined => (globalThis as any).Deno?.env?.get?.(name);

interface PortalPlansRow {
  plans?: Array<{ id: string; buildingId: string; floor: string | null; position: number; width: number; height: number;
    file: { id: string; bucket: string; path: string; mime: string; sha256: string; provider?: 'supabase' | 'r2' | null } | null }>;
  spaces?: Array<Record<string, unknown>>;
}

export function guestsRoutes(supabase: Supabase): AppRoute[] {
  // Los dibujos los sube Central al bucket de Recursos: se firman aquí con la clave de servicio (contrato §3.9).
  const storage = createStorage(supabase, { r2: r2ConfigFromEnv(denoEnv) });
  return [
    {
      // El mapa de zonas (MUELA-024): geometría y nombres públicos, nunca personas. Cada dibujo con una URL de 10 minutos
      // y su `sha256` (la app lo guarda para verlo sin red y no lo vuelve a bajar si no cambia). Nunca bucket ni ruta.
      method: 'GET', pattern: 'plans',
      handler: async ({ ctx }) => {
        const out = await supabase.rpc<PortalPlansRow>('core_read', { p_app: 'guests', p_actor: ctx.user.id, p_name: PORTAL_PLANS, p_args: {} });
        const plans = await Promise.all((out.plans ?? []).map(async ({ file, ...plan }) => ({
          ...plan,
          fileId: file?.id ?? null,
          mime: file?.mime ?? null,
          sha256: file?.sha256 ?? null,
          url: file ? await storage.readUrl({ bucket: file.bucket, path: file.path, storage_provider: file.provider ?? null }, 600).catch(() => null) : null,
        })));
        return { plans, spaces: out.spaces ?? [] };
      },
    },
  ];
}

export function createGuestsApp(base: Omit<AppConfig, 'app' | 'slug' | 'origins' | 'uploads' | 'portalIssuer' | 'routes'> & Partial<Pick<AppConfig, 'origins'>>) {
  const supabase = createSupabase(base);
  return createApp({
    ...base,
    app: 'guests',
    slug: 'guests-api',
    origins: base.origins ?? GUESTS_ORIGINS,
    uploads: GUESTS_UPLOADS,
    routes: guestsRoutes(supabase),
  });
}
