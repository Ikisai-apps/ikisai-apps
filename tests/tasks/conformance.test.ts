/**
 * Tasks · suite de conformidad del núcleo contra `tasks-api` (contrato §9).
 * Ninguna tabla de Tasks admite una fila suelta (toda área necesita su Entrada), así que antes de la primera
 * petición se siembra un área por la propia API y la tabla de muestra es `tasks.tasks` dentro de su Entrada.
 */
import { runConformance } from '../../packages/test-kit/src/conformance.ts';
import { TEST_PASSWORD } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

const TAB = '00000000-0000-4000-8000-0000000000a1';
const INBOX = '00000000-0000-4000-8000-0000000000a2';
const origin = TASKS_ORIGINS[0]!;

runConformance({
  app: 'tasks',
  slug: 'tasks-api',
  origin,
  createHandler: (config) => {
    const handler = createTasksApp({ ...config, origins: [origin] });
    const post = (path: string, body: unknown, token?: string) => handler(new Request(`${config.url}/functions/v1/tasks-api${path}`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(body),
    }));
    let seeded: Promise<void> | null = null;
    const seed = async () => {
      const login = await (await post('/api/v1/auth/login', { username: 'owner@example.invalid', password: TEST_PASSWORD })).json();
      const result = await post('/api/v1/commands', { requestId: 'conformance-seed', operations: createTabOps({ id: TAB, name: 'Conformidad', position: 1024, inboxId: INBOX }) }, login.token);
      if (!result.ok) throw new Error('No se pudo sembrar el área de conformidad: ' + (await result.text()));
    };
    return async (request) => {
      seeded ??= seed();
      await seeded;
      return handler(request);
    };
  },
  table: 'tasks.tasks',
  fieldA: 'title',
  fieldB: 'note',
  required: { tab_id: TAB, project_id: INBOX, title: 'Tarea de prueba', position: 1024 },
});
