import { runConformance } from '../../packages/test-kit/src/conformance.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';

runConformance({
  app: 'booking',
  slug: 'booking-api',
  origin: BOOKING_ORIGINS[0]!,
  createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  table: 'booking.reservations',
  fieldA: 'title',
  fieldB: 'internal_notes',
  required: { title: 'Retiro de prueba' },
});
