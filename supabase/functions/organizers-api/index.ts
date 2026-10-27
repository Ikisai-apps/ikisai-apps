// Punto de entrada Deno de la Edge Function `organizers-api`.
import { createOrganizersApp } from './app.ts';

declare const Deno: { serve: (handler: (request: Request) => Promise<Response>) => void; env: { get: (name: string) => string | undefined } };

Deno.serve(createOrganizersApp({
  url: Deno.env.get('SUPABASE_URL') ?? '',
  anonKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  // Sin ella, `worker/retention/tick` (B18) respondía 401, y «Pagar ahora» (F5) no llega al worker de Finance.
  workerKey: Deno.env.get('IKISAI_WORKER_KEY'),
  release: Deno.env.get('IKISAI_RELEASE') ?? 'development',
  stage: 'beta',
}));
