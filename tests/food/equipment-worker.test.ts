/**
 * Food · tanda 27: «En reparación» con el estado real de la petición en Tasks (migración 1106; Tasks #606), contra
 * PGlite. El worker `equipment/tick` pregunta a Tasks (simulado) y copia el estado en el aviso; nadie más lo escribe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import { noticeRef } from '../../supabase/functions/food-api/equipment.ts';
import { equipmentJourney, type EquipmentNotice } from '../../supabase/functions/_domain/food/mod.ts';

const WORKER_KEY = 'clave-de-prueba';
let app: TestApp;
let counter = 0;
const uuid = () => crypto.randomUUID();
const q = async <T = any>(sql: string, params: unknown[] = []) => (await app.t.db.query<T>(sql, params)).rows;
/** Lo que Tasks responde ahora a `worker/requests/status`, por referencia. */
const tasksState = new Map<string, string>();
const statusCalls: Array<{ refs: string[]; key: string | null }> = [];
let tasksDown = false;
const tasksFetch: typeof fetch = async (input, init) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  if (String(input).endsWith('/worker/requests/status')) {
    if (tasksDown) return new Response('caído', { status: 503 });
    statusCalls.push({ refs: body.externalRefs, key: new Headers(init?.headers).get('X-Ikisai-Worker-Key') });
    return Response.json({ items: (body.externalRefs as string[]).map((ref) => ({ externalRef: ref, status: tasksState.get(ref) ?? 'pending', taskId: null })) });
  }
  return Response.json({ created: true, routed: 'pending', task: { id: `task-${body.external_ref}`, title: body.title } });
};

async function tick() {
  const res = await app.handler(new Request(`${app.supabase.url}/functions/v1/food-api/api/v1/worker/equipment/tick`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': WORKER_KEY }, body: '{}',
  }));
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  return data;
}
const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `ew-${++counter}`, operations } });
const notices = async () => (await q(`select id, revision, created_at::text, deleted_at, equipment_id, notified_on::text, equipment_status, task_id, request_status from food.equipment_notices where deleted_at is null`)) as unknown as EquipmentNotice[];

const oven = uuid();

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!], workerKey: WORKER_KEY }, { tasksApiBase: 'https://tasks.example.invalid', tasksFetch }),
  });
  assert.equal((await commit([{ op: 'insert', table: 'food.equipment', id: oven, fields: { name: 'Horno grande', quantity: 1, status: 'averiado' } }])).status, 200);
});
test.after(async () => { await app.close(); });

test('worker · programado cada 15 minutos; sin avisos no hay trabajo ni llamada a Tasks', async () => {
  assert.deepEqual(await q(`select route, probe from core.scheduled_ticks where app = 'food' order by route`),
    [{ route: 'consumption/tick', probe: 'food.consumption_has_work' }, { route: 'equipment/tick', probe: 'food.equipment_status_has_work' }]);
  assert.deepEqual(await tick(), { checked: 0, updated: 0, error: null });
  assert.equal(statusCalls.length, 0);
});

test('worker · copia el estado de Tasks: pending sigue «Avisado», open es «En reparación», done vuelve a «Falla»', async () => {
  const fault = await app.call(`/api/v1/equipment/${oven}/fault`, { body: { name: 'Horno grande', status: 'averiado' } });
  assert.equal(fault.status, 200, JSON.stringify(fault.data));
  const machine = (await q(`select id, status, status_since::text from food.equipment where id = $1`, [oven]))[0];
  const [notice] = await notices();
  const ref = noticeRef(oven, notice!.notified_on);
  assert.equal((await q(`select food.equipment_status_has_work() as w`))[0].w, true);

  assert.deepEqual(await tick(), { checked: 1, updated: 1, error: null }); // pending: se anota que ya se miró
  assert.deepEqual(statusCalls.at(-1), { refs: [ref], key: WORKER_KEY });
  assert.equal(equipmentJourney(machine, await notices()).stage, 'avisado');
  assert.deepEqual(await tick(), { checked: 1, updated: 0, error: null }); // nada cambia: no se escribe

  tasksState.set(ref, 'open');
  assert.equal((await tick()).updated, 1);
  assert.equal((await notices())[0]!.request_status, 'open');
  assert.equal(equipmentJourney(machine, await notices()).stage, 'en_reparacion');

  tasksState.set(ref, 'done');
  assert.equal((await tick()).updated, 1);
  assert.equal(equipmentJourney(machine, await notices()).stage, 'falla');
  // Hecha: ya no se vuelve a preguntar.
  assert.equal((await q(`select food.equipment_status_has_work() as w`))[0].w, false);
  assert.deepEqual(await tick(), { checked: 0, updated: 0, error: null });
});

test('nadie más que el worker escribe el estado: una persona no puede poner «En reparación»', async () => {
  const [notice] = await notices();
  const res = await commit([{ op: 'update', table: 'food.equipment_notices', id: notice!.id, expectedRevision: Number(notice!.revision), fields: { request_status: 'open' } }]);
  // La Edge ya lo rechaza (no es un campo que se escriba); por debajo, el trigger de 1106 solo deja a la cuenta `food`.
  assert.equal(res.status, 422, JSON.stringify(res.data));
  assert.equal(res.data.error.code, 'INVALID_FIELDS');
  assert.equal((await notices())[0]!.request_status, 'done');
});

test('si Tasks no responde, no se toca nada y la siguiente vuelta lo reintenta', async () => {
  await app.t.db.query(`update food.equipment_notices set request_status = 'pending'`);
  tasksState.set(noticeRef(oven, (await notices())[0]!.notified_on), 'open');
  const before = (await notices())[0]!.revision;
  tasksDown = true;
  assert.deepEqual(await tick(), { checked: 1, updated: 0, error: 'TASKS_503' });
  assert.equal((await notices())[0]!.revision, before);
  tasksDown = false;
  assert.equal((await tick()).updated, 1);
  assert.equal((await notices())[0]!.request_status, 'open');
});
