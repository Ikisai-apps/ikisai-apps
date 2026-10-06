/** Ikisai Booking · API. Configuración de la app sobre el núcleo; las rutas propias se añaden aquí. */
import { createApp, fail, type AppConfig, type AppRoute, type Operation, type RequestContext } from '../_kit/mod.ts';
import { validateOperations } from '../_domain/booking/mod.ts';

export const BOOKING_ORIGINS = ['https://booking.ikisai.com', 'https://ikisai-booking.pages.dev'];

/** Validación de dominio antes de `core.commit` (docs/booking/API.md §4.1). Las reglas viven en `_domain/booking`. */
export function validateBookingOperations(operations: Operation[], ctx: RequestContext): void {
  const [issue] = validateOperations(operations, { role: ctx.membership.role });
  if (issue) fail(issue.status, issue.code, issue.message, issue.details);
}

export const bookingRoutes: AppRoute[] = [];

export function createBookingApp(base: Omit<AppConfig, 'app' | 'slug' | 'origins' | 'hooks' | 'routes' | 'uploads'> & Partial<Pick<AppConfig, 'origins'>>) {
  return createApp({
    ...base,
    app: 'booking',
    slug: 'booking-api',
    origins: base.origins ?? BOOKING_ORIGINS,
    uploads: { bucket: 'booking-documents', maxBytes: 15 * 1024 * 1024, allowedMime: ['application/pdf', 'image/webp', 'image/jpeg', 'image/png'] },
    hooks: { beforeCommit: validateBookingOperations },
    routes: bookingRoutes,
  });
}
