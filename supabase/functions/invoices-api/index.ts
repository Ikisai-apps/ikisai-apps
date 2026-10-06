// Punto de entrada Deno de la Edge Function `invoices-api`.
import { createInvoicesApp, DEFAULT_TASKS_API_BASE } from './app.ts';

declare const Deno: { serve: (handler: (request: Request) => Promise<Response>) => void; env: { get: (name: string) => string | undefined } };

Deno.serve(createInvoicesApp({
  url: Deno.env.get('SUPABASE_URL') ?? '',
  anonKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  release: Deno.env.get('IKISAI_RELEASE') ?? 'development',
  stage: 'beta',
  workerKey: Deno.env.get('IKISAI_WORKER_KEY'),
  // API de Tareas para validar destinos con el token del usuario; en QA puede apuntar a la función directa.
  tasksApiBase: Deno.env.get('IKISAI_TASKS_API_BASE') ?? DEFAULT_TASKS_API_BASE,
}));
