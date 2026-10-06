// Punto de entrada Deno de la Edge Function `booking-api`.
import { createBookingApp } from './app.ts';
import { createGoogleCalendarAdapter } from './calendar/google.ts';

declare const Deno: { serve: (handler: (request: Request) => Promise<Response>) => void; env: { get: (name: string) => string | undefined } };

Deno.serve(createBookingApp({
  url: Deno.env.get('SUPABASE_URL') ?? '',
  anonKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  release: Deno.env.get('IKISAI_RELEASE') ?? 'development',
  stage: 'beta',
  workerKey: Deno.env.get('IKISAI_WORKER_KEY'),
  // Sin los dos secretos el adaptador es null y Calendar queda «no configurado».
  calendar: {
    adapter: createGoogleCalendarAdapter({ serviceAccountJson: Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON'), calendarId: Deno.env.get('BOOKING_CALENDAR_ID') }),
    syncOnCommit: true,
  },
}));
