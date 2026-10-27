// Punto de entrada Deno de la Edge Function `flow-api`.
import { createFlowApp } from './app.ts';

declare const Deno: { serve: (handler: (request: Request) => Promise<Response>) => void; env: { get: (name: string) => string | undefined } };

Deno.serve(createFlowApp({
  url: Deno.env.get('SUPABASE_URL') ?? '',
  anonKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  release: Deno.env.get('IKISAI_RELEASE') ?? 'development',
  // Identidad de servicio de Flow ante Finance y Tasks (FL1, FL2): X-Ikisai-Worker-Key + X-Ikisai-Caller: flow.
  workerKey: Deno.env.get('IKISAI_WORKER_KEY'),
  stage: 'beta',
}));
