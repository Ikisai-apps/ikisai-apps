// Punto de entrada Deno de la Edge Function `food-api`.
import { createFoodApp, DEFAULT_TASKS_API_BASE } from './app.ts';

declare const Deno: { serve: (handler: (request: Request) => Promise<Response>) => void; env: { get: (name: string) => string | undefined } };

Deno.serve(createFoodApp({
  url: Deno.env.get('SUPABASE_URL') ?? '',
  anonKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  release: Deno.env.get('IKISAI_RELEASE') ?? 'development',
  // Los workers (consumo y estado de las máquinas) y la llamada a Tasks con la clave compartida, como las demás Edge.
  workerKey: Deno.env.get('IKISAI_WORKER_KEY'),
  stage: 'beta',
}, { tasksApiBase: Deno.env.get('IKISAI_TASKS_API_BASE') ?? DEFAULT_TASKS_API_BASE }));
