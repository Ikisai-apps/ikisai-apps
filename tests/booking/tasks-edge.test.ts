/** Booking · las peticiones a Tasks van a su Edge directa con la clave de worker (el proxy de Pages la perdía: 401). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTasksPost, tasksWorkerBase } from '../../supabase/functions/booking-api/tasks/sync.ts';
import { createTasksNotifier } from '../../supabase/functions/booking-api/ses/service.ts';

const KEY = 'clave-de-worker-de-prueba';
const SUPABASE = 'https://proyecto.example.invalid';
const env = (values: Record<string, string>) => (name: string) => values[name];

// Tasks simulado: rechaza sin la cabecera, como haría la Edge real si un proxy la pierde.
function fakeTasks() {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push(String(url));
    const key = new Headers(init?.headers).get('x-ikisai-worker-key');
    if (key !== KEY) return new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }), { status: 401 });
    return new Response(JSON.stringify({ status: 'created', projectId: 'p1', taskId: 't1' }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test('tasks · base: Edge directa desde la URL de Supabase; nunca el dominio de Pages', () => {
  assert.equal(tasksWorkerBase(env({}), `${SUPABASE}/`), `${SUPABASE}/functions/v1/tasks-api/api/v1/worker`);
  assert.equal(tasksWorkerBase(env({ SUPABASE_URL: SUPABASE })), `${SUPABASE}/functions/v1/tasks-api/api/v1/worker`);
  assert.equal(tasksWorkerBase(env({ TASKS_WORKER_BASE_URL: 'https://x.example.invalid/w/' }), SUPABASE), 'https://x.example.invalid/w');
  assert.equal(tasksWorkerBase(env({})), undefined, 'sin base no hay integración');
  assert.equal(createTasksPost(env({ IKISAI_WORKER_KEY: KEY })), undefined);
});

test('tasks · proyecto, extras y aviso de SES llegan con la clave a la Edge directa', async () => {
  const tasks = fakeTasks();
  const post = createTasksPost(env({ IKISAI_WORKER_KEY: KEY }), tasks.fetchImpl, SUPABASE)!;
  assert.equal((await post('requests/project', { external_ref: 'RES1' })).status, 200);
  const notify = createTasksNotifier(env({ IKISAI_WORKER_KEY: KEY }), tasks.fetchImpl, SUPABASE)!;
  assert.equal(await notify({ source: 'booking' } as any), true);
  assert.deepEqual(tasks.calls, [
    `${SUPABASE}/functions/v1/tasks-api/api/v1/worker/requests/project`,
    `${SUPABASE}/functions/v1/tasks-api/api/v1/worker/requests/task`,
  ]);
  assert.ok(!tasks.calls.some((u) => u.includes('tasks.ikisai.com')));
  // con otra clave (o sin ella, como tras el proxy), Tasks rechaza y Booking lo trata como no enviado
  const wrong = createTasksNotifier(env({ IKISAI_WORKER_KEY: 'otra' }), tasks.fetchImpl, SUPABASE)!;
  assert.equal(await wrong({ source: 'booking' } as any), false);
});
