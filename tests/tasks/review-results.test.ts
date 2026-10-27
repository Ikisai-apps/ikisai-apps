/**
 * Tasks · «Revisión de apertura», 3: el resultado de cada ítem (`POST reviews/result`, capacidad
 * `tasks.review_item_result`, migración 0350, docs/tasks/API.md §46.3), de extremo a extremo contra el núcleo y los hooks
 * reales. Un fallo guarda su evidencia y crea la correctiva y «volver a comprobar»; reparar no es verificar; solo un nuevo
 * «ok» verifica; la revisión queda lista cuando todos los críticos lo están. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), PROJECT = uuid();
let app: TestApp;
let seq = 0;
let reviewId = '';

const rows = async (table: string) => (await app.call(`/api/v1/snapshot?tables=${table}&limit=5000`)).data.tables[0].rows as any[];
const commit = (operations: Operation[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `res-${++seq}`, operations } });
const mark = (body: Record<string, unknown>, token?: string) => app.call('/api/v1/reviews/result', { token, body });
const items = async () => (await rows('tasks.review_items')).filter((i) => i.review_id === reviewId);
const byZone = async (zone: string, answer?: string) => (await items()).find((i) => i.zone === zone && (!answer || i.answer === answer));
const task = async (id: string) => (await rows('tasks.tasks')).find((t) => t.id === id);
const review = async () => (await rows('tasks.reviews')).find((r) => r.id === reviewId);

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  assert.equal((await commit(createTabOps({ id: TAB, name: 'Casa', position: 1024 }))).status, 200);
  assert.equal((await commit([{ op: 'insert', table: 'tasks.projects', id: PROJECT, fields: { tab_id: TAB, title: 'Otro', position: 4096 } }])).status, 200);
  const house = (await rows('tasks.review_templates')).find((t) => t.name === 'Revisión de apertura').id;
  const out = await app.call('/api/v1/reviews', { body: { templateId: house, tabId: TAB, title: 'Apertura de prueba' } });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  reviewId = out.data.reviewId;
});
test.after(async () => { await app.close(); });

test('un fallo guarda su evidencia y crea «Arreglar» y «Volver a comprobar»; reparar no verifica; un nuevo «ok» sí', async () => {
  const acs = await byZone('duchas_acs');
  // 45 °C con «ok»: fuera de rango, cuenta como fallo.
  const failed = await mark({ itemId: acs.id, result: 'ok', value: 45, text: 'Tarda mucho en salir caliente' }, app.tokens.editor);
  assert.equal(failed.status, 200, JSON.stringify(failed.data));
  assert.equal(failed.data.state, 'failed');
  const { correctiveTaskId, recheckTaskId } = failed.data;
  const item = await byZone('duchas_acs');
  assert.deepEqual([item.state, Number(item.value), item.first_failure.value, item.first_failure.text], ['failed', 45, 45, 'Tarda mucho en salir caliente']);
  const [own, fix, recheck] = [await task(acs.task_id), await task(correctiveTaskId), await task(recheckTaskId)];
  assert.equal(own.done, false);
  assert.deepEqual([fix.title, fix.parent_id, fix.priority, fix.done], ['Arreglar: Agua caliente en las duchas', own.parent_id, 'high', false]);
  assert.deepEqual([recheck.title, recheck.parent_id, recheck.done], ['Volver a comprobar: Agua caliente en las duchas', own.parent_id, false]);
  assert.ok((await rows('tasks.task_dependencies')).some((d) => d.task_id === recheckTaskId && d.depends_on_id === correctiveTaskId && !d.deleted_at), 'comprobar espera a arreglar');

  // Otro fallo no duplica: las mismas dos tareas; el primer fallo no se pisa.
  const again = await mark({ itemId: acs.id, result: 'fail', value: 40 }, app.tokens.editor);
  assert.deepEqual([again.data.correctiveTaskId, again.data.recheckTaskId], [correctiveTaskId, recheckTaskId]);
  assert.equal((await byZone('duchas_acs')).first_failure.value, 45);

  // Hacer la correctiva no verifica nada.
  const f = await task(correctiveTaskId);
  assert.equal((await commit([{ op: 'update', table: 'tasks.tasks', id: f.id, expectedRevision: f.revision, fields: { done: true } }])).status, 200);
  assert.equal((await byZone('duchas_acs')).state, 'failed', 'reparar no es verificar');

  // Volver a comprobar con 55 °C: verificado; su tarea y la de comprobar, hechas; el primer fallo, guardado.
  const ok = await mark({ itemId: acs.id, result: 'ok', value: 55 }, app.tokens.editor);
  assert.equal(ok.data.state, 'verified');
  const done = await byZone('duchas_acs');
  assert.deepEqual([done.state, Number(done.value), done.first_failure.value], ['verified', 55, 45]);
  assert.equal((await task(acs.task_id)).done, true);
  assert.equal((await task(recheckTaskId)).done, true);
});

test('lista para abrir: todos los críticos en ok o verificados; si uno falla, vuelve a abierta', async () => {
  assert.equal((await review()).status, 'open');
  const critical = (await items()).filter((i) => i.critical && i.state !== 'verified');
  for (const i of critical) {
    const value = i.answer !== 'reading' ? undefined : i.zone === 'maquinaria' ? 3 : i.zone === 'agua' ? 0.5 : 60;
    const out = await mark({ itemId: i.id, result: 'ok', ...(value !== undefined ? { value } : {}) });
    assert.equal(out.status, 200, `${i.zone}: ${JSON.stringify(out.data)}`);
  }
  assert.equal((await review()).status, 'ready', 'los no críticos pendientes no bloquean');
  const extintores = await byZone('extintores');
  const out = await mark({ itemId: extintores.id, result: 'fail', text: 'Uno caducado' });
  assert.deepEqual([out.data.state, out.data.reviewStatus], ['failed', 'open']);
});

test('lo que pide cada tipo, quién marca y lo que no se puede escribir a mano', async () => {
  const camas = await byZone('camas'), note = await byZone('comunes', 'note'), photo = await byZone('comunes', 'photo'), puertas = await byZone('puertas');
  const code = async (body: Record<string, unknown>, token?: string) => { const r = await mark(body, token); return `${r.status} ${r.data.error?.code ?? 'OK'}`; };
  assert.equal(await code({ itemId: camas.id, result: 'ok' }), '422 INVALID_OPERATION', 'una cantidad necesita su valor');
  assert.equal(await code({ itemId: camas.id, result: 'ok', value: 2.5 }), '422 INVALID_OPERATION');
  assert.equal(await code({ itemId: camas.id, result: 'ok', value: 24 }), '200 OK');
  assert.equal(await code({ itemId: puertas.id, result: 'ok', value: 1 }), '422 INVALID_OPERATION', 'funciona o no: sin valor');
  assert.equal(await code({ itemId: note.id, result: 'ok' }), '422 INVALID_OPERATION', 'una observación necesita su texto');
  assert.equal(await code({ itemId: note.id, result: 'ok', text: 'Todo en orden' }), '200 OK');
  assert.equal(await code({ itemId: photo.id, result: 'ok' }), '422 INVALID_OPERATION', 'una foto necesita su archivo');
  assert.equal(await code({ itemId: photo.id, result: 'ok', fileId: uuid() }), '422 INVALID_OPERATION', 'y que sea una subida tuya');
  assert.equal(await code({ itemId: puertas.id, result: 'quizá' }), '422 INVALID_INPUT');
  assert.equal(await code({ itemId: puertas.id, result: 'ok', state: 'verified' }), '422 INVALID_INPUT');
  assert.equal(await code({ itemId: uuid(), result: 'ok' }), '404 NOT_FOUND');
  assert.equal(await code({ itemId: puertas.id, result: 'ok' }, app.tokens.reader), '403 FORBIDDEN');
  await app.t.db.query(`update core.memberships set scopes = $1 where app = 'tasks' and user_id = $2`, [JSON.stringify({ tabs: [], projects: { [TAB]: [PROJECT] } }), app.users.editor]);
  try {
    assert.equal(await code({ itemId: puertas.id, result: 'ok' }, app.tokens.editor), '404 NOT_FOUND', 'sin el proyecto de la revisión, no la ve');
  } finally {
    await app.t.db.query(`update core.memberships set scopes = null where app = 'tasks' and user_id = $1`, [app.users.editor]);
  }
  // Ni el resultado a mano ni el procedimiento por commands.
  const p = await byZone('puertas');
  assert.equal((await commit([{ op: 'update', table: 'tasks.review_items', id: p.id, expectedRevision: p.revision, fields: { state: 'verified' } }])).status, 422);
  assert.equal((await commit([{ op: 'call', procedure: 'tasks.review_item_result', args: { itemId: p.id, result: 'ok' } } as Operation])).status, 422);
});

test('la capacidad tasks.review_item_result está en el catálogo, para editor y owner', async () => {
  const out = await app.call('/api/v1/capabilities');
  assert.equal(out.status, 200, JSON.stringify(out.data));
  const cap = out.data.items.find((c: any) => c.id === 'tasks.review_item_result');
  assert.ok(cap, 'registrada');
  assert.deepEqual([cap.route, cap.roles, cap.kind], ['POST reviews/result', ['editor', 'owner'], 'execute']);
});
