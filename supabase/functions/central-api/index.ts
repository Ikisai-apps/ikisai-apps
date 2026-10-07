// Punto de entrada Deno de la Edge Function `central-api`.
import { createCentralApp, DEFAULT_TASKS_API_BASE } from './app.ts';

declare const Deno: { serve: (handler: (request: Request) => Promise<Response>) => void; env: { get: (name: string) => string | undefined } };

Deno.serve(createCentralApp({
  url: Deno.env.get('SUPABASE_URL') ?? '',
  anonKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  release: Deno.env.get('IKISAI_RELEASE') ?? 'development',
  stage: 'beta',
  // Core: worker del feedback (contrato §3.7), despertado por pg_cron con la clave de worker.
  workerKey: Deno.env.get('IKISAI_WORKER_KEY'),
  feedbackWorker: true,
}, { tasksApiBase: Deno.env.get('IKISAI_TASKS_API_BASE') ?? DEFAULT_TASKS_API_BASE }));
