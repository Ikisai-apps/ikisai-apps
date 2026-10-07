/** Food · peticiones a Tasks (API.md §6.1): avisar de una máquina averiada, con una Tasks falsa y el token de la persona. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';

const calls: Array<{ url: string; auth: string | null; body: Record<string, any> }> = [];
let reply: (body: Record<string, any>) => Response = () => new Response('{}', { status: 500 });
const seen = new Set<string>();
const tasksFetch: typeof fetch = async (input, init) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  calls.push({ url: String(input), auth: new Headers(init?.headers).get('Authorization'), body });
  return reply(body);
};
/** Como Tasks: la misma referencia devuelve la misma tarea sin crearla otra vez; sin regla, «Por clasificar». */
const likeTasks = (body: Record<string, any>) => {
  const created = !seen.has(body.external_ref);
  seen.add(body.external_ref);
  return Response.json({ created, routed: 'pending', task: { id: crypto.randomUUID(), title: body.title } });
};

let app: TestApp;
test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }, { tasksApiBase: 'https://tasks.example.invalid', tasksFetch }),
  });
});

const fault = (id: string, body: Record<string, unknown>, token?: string) => app.call(`/api/v1/equipment/${id}/fault`, { body, ...(token ? { token } : {}) });

test('avería → petición a Tasks con tipo, referencia por máquina y día, enlace y prioridad; repetir no duplica', async () => {
  reply = likeTasks;
  const id = crypto.randomUUID();
  const first = await fault(id, { name: 'Horno grande', status: 'averiado', location: 'Cocina', note: 'No calienta.' });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual({ created: first.data.created, routed: first.data.routed }, { created: true, routed: 'pending' });
  const sent = calls.at(-1)!;
  assert.equal(sent.url, 'https://tasks.example.invalid/api/v1/requests/task');
  assert.match(sent.auth ?? '', /^Bearer .+/);
  assert.equal(sent.body.source, 'food');
  assert.equal(sent.body.kind, 'food.equipment_fault');
  assert.match(sent.body.external_ref, new RegExp(`^equipment_fault:${id}:\\d{4}-\\d{2}-\\d{2}$`));
  assert.equal(sent.body.title, 'Reparar: Horno grande (Cocina)');
  assert.equal(sent.body.note, 'No calienta.');
  assert.equal(sent.body.priority, 'high');
  assert.equal(sent.body.external_url, 'https://food.ikisai.com/#/maquinaria');
  assert.equal(sent.body.project_id, undefined); // sin área ni proyecto: Tasks lo enruta

  const again = await fault(id, { name: 'Horno grande', status: 'averiado' });
  assert.equal(again.data.created, false);
  assert.equal(calls.at(-1)!.body.external_ref, sent.body.external_ref);

  const limited = await fault(crypto.randomUUID(), { name: 'Batidora', status: 'limitado' });
  assert.equal(limited.status, 200);
  assert.equal(calls.at(-1)!.body.title, 'Revisar: Batidora');
  assert.equal(calls.at(-1)!.body.priority, 'normal');
});

test('avería · entrada inválida, solo lectura y Tasks que no deja o no responde', async () => {
  reply = likeTasks;
  const before = calls.length;
  assert.equal((await fault('no-es-uuid', { name: 'Horno', status: 'averiado' })).status, 422);
  assert.equal((await fault(crypto.randomUUID(), { name: 'Horno', status: 'operativo' })).status, 422);
  assert.equal((await fault(crypto.randomUUID(), { name: '', status: 'averiado' })).status, 422);
  const reader = await fault(crypto.randomUUID(), { name: 'Horno', status: 'averiado' }, app.tokens.reader);
  assert.equal(reader.status, 403);
  assert.equal(calls.length, before); // nada de eso llega a Tasks

  reply = () => Response.json({ error: { code: 'FORBIDDEN', message: 'Pedir tareas necesita permiso de edición en Tasks.' } }, { status: 403 });
  const forbidden = await fault(crypto.randomUUID(), { name: 'Horno', status: 'averiado' });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.data.error.code, 'TASKS_FORBIDDEN');

  reply = () => { throw new TypeError('fetch failed'); };
  const down = await fault(crypto.randomUUID(), { name: 'Horno', status: 'averiado' });
  assert.equal(down.status, 503);
  assert.equal(down.data.error.code, 'TASKS_UNAVAILABLE');
});
