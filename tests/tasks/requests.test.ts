/**
 * Tasks · trabajo pedido desde otras apps (`POST requests/task`, docs/tasks/API.md §19), de extremo a extremo contra el
 * núcleo y el hook reales: idempotencia por referencia, papelera, alcance, procedencia protegida y lectura de varias.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { requestTaskId } from '../../supabase/functions/tasks-api/requests.ts';
import { simulateServiceIdentity } from './fixtures.ts';
import { classifyRequestOps, createTabOps, dismissRequestOps, emptyDataset, pendingRequests, routeWaitingOps, saveRouteOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const WORKER_KEY = 'clave-de-worker-de-prueba';
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), INBOX = uuid(), OBRA = uuid(), PRIVADO = uuid(), LABEL = uuid(), PL = uuid();
let app: TestApp;
let limited = '';
let seq = 0;

const ask = (body: Record<string, unknown>, token?: string) => app.call('/api/v1/requests/task', { token, body });
const rows = async (table: string) => (await app.call(`/api/v1/snapshot?tables=${table}&includeDeleted=1&limit=2000`)).data.tables[0].rows as any[];
const commit = (operations: Operation[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `seed-${++seq}`, operations } });
const targets = (args: Record<string, unknown>, token?: string) => app.call('/api/v1/read/tasks.targets', { token, body: args });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin], workerKey: WORKER_KEY }) });
  const tabOps = createTabOps({ id: TAB, name: 'Casa', position: 1024, inboxId: INBOX });
  const phase = tabOps.find((o) => o.fields?.system_key === 'phase')!.id!;
  await commit(tabOps);
  await commit([
    { op: 'insert', table: 'tasks.projects', id: OBRA, fields: { tab_id: TAB, title: 'Licencias', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: PRIVADO, fields: { tab_id: TAB, title: 'Privado', position: 3072 } },
    { op: 'insert', table: 'tasks.labels', id: LABEL, fields: { tab_id: TAB, family_id: phase, name: 'Cumplimiento' } },
  ]);
  await commit([{ op: 'insert', table: 'tasks.project_labels', id: PL, fields: { tab_id: TAB, project_id: OBRA, label_id: LABEL } }]);
  // Una persona con acceso a un solo proyecto (un agente necesitaría aprobación para cualquier `call`).
  await app.t.db.query(`update core.memberships set scopes = $1 where app = 'tasks' and user_id = $2`, [JSON.stringify({ tabs: [], projects: { [TAB]: [OBRA] } }), app.users.editor]);
  limited = app.tokens.editor;
});
test.after(async () => { await app.close(); });

test('pedir una tarea: se crea una vez, con procedencia y las etiquetas del proyecto; repetir la devuelve sin tocarla', async () => {
  const first = await ask({ source: 'central', external_ref: 'LEG_2026_004', title: 'Renovar licencia de piscina', note: 'Vence en noviembre', due: '2026-11-15', priority: 'high', project_id: OBRA });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.created, true);
  const task = first.data.task;
  assert.equal(task.id, await requestTaskId('central:LEG_2026_004'));
  assert.deepEqual([task.kind, task.projectId, task.externalRef, task.done, task.deleted], ['task', OBRA, 'central:LEG_2026_004', false, false]);
  const row = (await rows('tasks.tasks')).find((t) => t.id === task.id);
  assert.deepEqual([row.title, row.note, row.due, row.priority], ['Renovar licencia de piscina', 'Vence en noviembre', '2026-11-15', 'high']);
  assert.deepEqual((await rows('tasks.task_labels')).filter((l) => l.task_id === task.id).map((l) => l.label_id), [LABEL], 'lleva las etiquetas del proyecto');

  const again = await ask({ source: 'central', external_ref: 'LEG_2026_004', title: 'Otro título', project_id: PRIVADO });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.created, false);
  assert.equal(again.data.task.id, task.id);
  const after = (await rows('tasks.tasks')).filter((t) => t.external_ref === 'central:LEG_2026_004');
  assert.equal(after.length, 1);
  assert.deepEqual([after[0].title, after[0].project_id], ['Renovar licencia de piscina', OBRA], 'una petición repetida no cambia nada');
  // La misma referencia de otra app es otra tarea.
  const other = await ask({ source: 'booking', external_ref: 'LEG_2026_004', title: 'Otra', tab_id: TAB });
  assert.equal(other.data.created, true);
  assert.equal(other.data.task.projectId, INBOX, 'sin proyecto va a la Entrada del área');
});

test('a la vez desde dos sitios: una sola tarea', async () => {
  const body = { source: 'central', external_ref: 'A_LA_VEZ', title: 'Revisar extintores', tab_id: TAB };
  const [a, b] = await Promise.all([ask(body), ask(body)]);
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(b.status, 200, JSON.stringify(b.data));
  assert.equal([a.data.created, b.data.created].filter(Boolean).length, 1);
  assert.equal((await rows('tasks.tasks')).filter((t) => t.external_ref === 'central:A_LA_VEZ').length, 1);
});

test('en la papelera se devuelve como borrada y no se resucita', async () => {
  const made = (await ask({ source: 'central', external_ref: 'BORRADA', title: 'Se borrará', tab_id: TAB })).data.task;
  assert.equal((await commit([{ op: 'delete', table: 'tasks.tasks', id: made.id, expectedRevision: made.revision }])).status, 200);
  const again = await ask({ source: 'central', external_ref: 'BORRADA', title: 'Se borrará', tab_id: TAB });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.deepEqual([again.data.created, again.data.task.deleted], [false, true]);
  assert.ok((await rows('tasks.tasks')).find((t) => t.id === made.id).deleted_at, 'sigue en la papelera');
});

test('alcance: una sugerencia fuera de su alcance no vale (queda por clasificar); una referencia de una tarea que no ve da 409', async () => {
  const outside = await ask({ source: 'central', external_ref: 'FUERA', title: 'x', project_id: PRIVADO }, limited);
  assert.equal(outside.status, 200, JSON.stringify(outside.data));
  assert.deepEqual([outside.data.created, outside.data.routed, outside.data.task.visible, outside.data.task.request], [true, 'pending', false, 'pending']);
  assert.equal(outside.data.task.title, undefined, 'quien pide sin acceso completo no ve los datos de la pendiente');
  await ask({ source: 'central', external_ref: 'PRIVADA', title: 'Privada', project_id: PRIVADO });
  const hidden = await ask({ source: 'central', external_ref: 'PRIVADA', title: 'Privada', project_id: OBRA }, limited);
  assert.equal(hidden.status, 409, JSON.stringify(hidden.data));
  assert.equal(hidden.data.error.code, 'EXTERNAL_REF_IN_USE');
  assert.equal(JSON.stringify(hidden.data).includes('Privada'), false, 'no revela la tarea');
  const reader = await ask({ source: 'central', external_ref: 'LECTOR', title: 'x', tab_id: TAB }, app.tokens.reader);
  assert.equal(reader.status, 403);
});

test('entradas inválidas y procedencia protegida fuera de la ruta', async () => {
  for (const body of [
    { external_ref: 'X', title: 'x', tab_id: TAB },
    { source: 'Central', external_ref: 'X', title: 'x', tab_id: TAB },
    { source: 'central', title: 'x', tab_id: TAB },
    { source: 'central', external_ref: 'X', title: '  ', tab_id: TAB },
    { source: 'central', external_ref: 'X', title: 'x', kind: 'booking.otra' },
    { source: 'central', external_ref: 'X', title: 'x', kind: 'central.Mayúsculas' },
    { source: 'central', external_ref: 'X', title: 'x', external_url: 'https://ejemplo.com/x' },
    { source: 'central', external_ref: 'X', title: 'x', tab_id: TAB, due: '15/11/2026' },
    { source: 'central', external_ref: 'X', title: 'x', tab_id: 'no' },
  ]) {
    const res = await ask(body);
    assert.equal(res.status, 422, JSON.stringify(body));
  }
  // Por `commands` no se fija ni se cambia la procedencia.
  const id = uuid();
  const set = await commit([{ op: 'insert', table: 'tasks.tasks', id, fields: { tab_id: TAB, project_id: INBOX, title: 'x', position: 99, external_ref: 'central:FALSA' } }]);
  assert.equal(set.status, 422, JSON.stringify(set.data));
  const made = (await rows('tasks.tasks')).find((t) => t.external_ref === 'central:LEG_2026_004');
  const change = await commit([{ op: 'update', table: 'tasks.tasks', id: made.id, expectedRevision: made.revision, fields: { external_ref: 'central:OTRA' } }]);
  assert.equal(change.status, 422, JSON.stringify(change.data));
});

test('tasks.targets con lista de ids: las visibles (papelera incluida) y las que faltan', async () => {
  const all = await rows('tasks.tasks');
  const licencia = all.find((t) => t.external_ref === 'central:LEG_2026_004'), borrada = all.find((t) => t.external_ref === 'central:BORRADA');
  const privada = all.find((t) => t.external_ref === 'central:PRIVADA'), nadie = uuid();
  const out = await targets({ kind: 'task', ids: [licencia.id, borrada.id, privada.id, nadie] });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.deepEqual(out.data.items.map((t: any) => t.id).sort(), [licencia.id, borrada.id, privada.id].sort());
  assert.equal(out.data.items.find((t: any) => t.id === borrada.id).deleted, true);
  assert.deepEqual(out.data.missing, [nadie]);
  const seen = await targets({ kind: 'task', ids: [licencia.id, privada.id] }, limited);
  assert.deepEqual(seen.data.items.map((t: any) => t.id), [licencia.id]);
  assert.deepEqual(seen.data.missing, [privada.id], 'lo que no ve sale como que falta');
  assert.equal((await targets({ kind: 'task', ids: ['no'] })).status, 422);
  assert.equal((await targets({ kind: 'task', id: licencia.id })).data.externalRef, 'central:LEG_2026_004');
});

test('enrutado (§20): la regla manda sobre la sugerencia, el buzón y el estado para quien pide', async () => {
  const route = uuid();
  // Regla del usuario: los vencimientos de Central van a Licencias, aunque la petición sugiera otro sitio.
  assert.equal((await commit([{ op: 'insert', table: 'tasks.request_routes', id: route, fields: { kind: 'central.compliance_due', kind_label: 'Vencimientos', tab_id: TAB, project_id: OBRA, position: 1024 } }])).status, 200);
  const ruled = await ask({ source: 'central', kind: 'central.compliance_due', kind_label: 'Vencimientos', external_ref: 'VTO_1', title: 'Seguro de responsabilidad', external_url: 'https://central.ikisai.com/#/cumplimiento/VTO_1', tab_id: TAB });
  assert.equal(ruled.status, 200, JSON.stringify(ruled.data));
  assert.deepEqual([ruled.data.routed, ruled.data.task.projectId, ruled.data.task.externalKind, ruled.data.task.externalUrl, ruled.data.task.request],
    ['rule', OBRA, 'central.compliance_due', 'https://central.ikisai.com/#/cumplimiento/VTO_1', 'created']);
  // Buzón: la regla manda a Privado y quien pide no lo ve; entra igualmente y solo sabe que está creada.
  const other = uuid();
  await commit([{ op: 'insert', table: 'tasks.request_routes', id: other, fields: { kind: 'central.secret', tab_id: TAB, project_id: PRIVADO, position: 2048 } }]);
  const mailbox = await ask({ source: 'central', kind: 'central.secret', external_ref: 'S_1', title: 'Auditoría interna' }, limited);
  assert.equal(mailbox.status, 200, JSON.stringify(mailbox.data));
  assert.deepEqual([mailbox.data.routed, mailbox.data.task.visible, mailbox.data.task.request], ['rule', false, 'created']);
  assert.equal((await rows('tasks.tasks')).find((t) => t.external_ref === 'central:S_1').project_id, PRIVADO);
  // Una regla de otra área o con un proyecto archivado no se guarda.
  const bad = await commit([{ op: 'insert', table: 'tasks.request_routes', id: uuid(), fields: { kind: 'central.otra', tab_id: TAB, project_id: uuid(), position: 1 } }]);
  assert.equal(bad.status, 422, JSON.stringify(bad.data));
  // Solo el propietario escribe reglas.
  const asEditor = await commit([{ op: 'update', table: 'tasks.request_routes', id: route, expectedRevision: 1, fields: { kind_label: 'Otra' } }], app.tokens.editor);
  assert.equal(asEditor.status, 403, JSON.stringify(asEditor.data));
});

test('por clasificar (§20): sin regla espera; clasificar crea la tarea con el mismo id y su origen; descartar se ve', async () => {
  const waiting = await ask({ source: 'booking', kind: 'booking.space_incident', kind_label: 'Incidencias', external_ref: 'INC_7', title: 'Fuga en la sala 2', external_url: 'https://booking.ikisai.com/#/incidencias/INC_7' });
  assert.equal(waiting.status, 200, JSON.stringify(waiting.data));
  assert.deepEqual([waiting.data.routed, waiting.data.task.pending, waiting.data.task.request, waiting.data.task.title], ['pending', true, 'pending', 'Fuga en la sala 2']);
  const id = waiting.data.task.id;
  assert.equal((await rows('tasks.tasks')).some((t) => t.id === id), false, 'todavía no es una tarea');
  const data = async () => {
    const out: any = {};
    for (const table of ['tasks.tabs', 'tasks.projects', 'tasks.tasks', 'tasks.project_labels', 'tasks.requests', 'tasks.request_routes', 'tasks.labels', 'tasks.families']) out[table] = await rows(table);
    return { ...emptyDataset(), ...out };
  };
  // Nadie fija el origen por su cuenta, ni cambia los datos de una petición.
  const forged = await commit([{ op: 'insert', table: 'tasks.tasks', id, fields: { tab_id: TAB, project_id: OBRA, title: 'x', position: 5, external_ref: 'booking:INC_7' } }]);
  assert.equal(forged.status, 422, JSON.stringify(forged.data));
  const request = (await rows('tasks.requests')).find((r) => r.id === id);
  assert.equal((await commit([{ op: 'update', table: 'tasks.requests', id, expectedRevision: request.revision, fields: { title: 'Otro' } }])).status, 422);
  // Un acceso por proyectos no clasifica.
  const ops = classifyRequestOps(await data(), id, { project_id: OBRA });
  assert.equal((await commit(ops, limited)).status, 403);
  const moved = await commit(ops);
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  const task = (await rows('tasks.tasks')).find((t) => t.id === id);
  assert.deepEqual([task.project_id, task.external_ref, task.external_kind, task.external_url], [OBRA, 'booking:INC_7', 'booking.space_incident', 'https://booking.ikisai.com/#/incidencias/INC_7']);
  assert.deepEqual((await rows('tasks.task_labels')).filter((l) => l.task_id === id && !l.deleted_at).map((l) => l.label_id), [LABEL]);
  assert.equal((await rows('tasks.requests')).find((r) => r.id === id).status, 'routed');
  // Descartar: la app que pidió lo ve así.
  const junk = (await ask({ source: 'booking', kind: 'booking.space_incident', external_ref: 'INC_8', title: 'Prueba' }, limited)).data.task.id;
  assert.equal((await commit(dismissRequestOps(await data(), junk))).status, 200);
  const seen = await targets({ kind: 'task', ids: [junk] }, limited);
  assert.deepEqual(seen.data.items, [{ kind: 'task', id: junk, visible: false, request: 'dismissed' }]);
  // Regla nueva y «mover también las que esperaban».
  await ask({ source: 'booking', kind: 'booking.space_incident', external_ref: 'INC_9', title: 'Bombilla fundida' });
  await ask({ source: 'booking', kind: 'booking.space_incident', external_ref: 'INC_10', title: 'Puerta atascada' });
  assert.equal((await commit(saveRouteOps(await data(), { kind: 'booking.space_incident', kind_label: 'Incidencias', tab_id: TAB, project_id: OBRA }))).status, 200);
  assert.equal(pendingRequests(await data(), 'booking.space_incident').length, 2);
  const all = routeWaitingOps(await data(), 'booking.space_incident');
  assert.equal((await commit(all)).status, 200, 'una sola vez, en un lote');
  assert.equal(pendingRequests(await data(), 'booking.space_incident').length, 0);
  assert.equal((await rows('tasks.tasks')).filter((t) => t.external_kind === 'booking.space_incident' && !t.deleted_at).length, 3);
});

test('puente con Feedback (§22.3): worker/requests/status da el estado por referencia, solo con la clave de worker', async () => {
  const status = (body: unknown, key: string | null = WORKER_KEY) => app.handler(new Request('http://localhost/api/v1/worker/requests/status', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Ikisai-Worker-Key': key } : {}) }, body: JSON.stringify(body) }));
  const open = (await ask({ source: 'feedback', kind: 'feedback.space.damage', external_ref: 'FB_2026_0001', title: 'Persiana rota', tab_id: TAB })).data.task;
  const done = (await ask({ source: 'feedback', kind: 'feedback.event.setup', external_ref: 'FB_2026_0002', title: 'Diez sillas más', tab_id: TAB })).data.task;
  await commit([{ op: 'update', table: 'tasks.tasks', id: done.id, expectedRevision: done.revision, fields: { done: true } }]);
  await ask({ source: 'feedback', kind: 'feedback.space.damage', external_ref: 'FB_2026_0003', title: 'Ducha' });
  const out = await status({ externalRefs: ['feedback:FB_2026_0001', 'feedback:FB_2026_0002', 'feedback:FB_2026_0003', 'feedback:FB_2026_9999'] });
  assert.equal(out.status, 200);
  const items = Object.fromEntries(((await out.json()) as any).items.map((i: any) => [i.externalRef, i]));
  assert.deepEqual(['feedback:FB_2026_0001', 'feedback:FB_2026_0002', 'feedback:FB_2026_0003', 'feedback:FB_2026_9999'].map((r) => items[r].status), ['open', 'done', 'pending', 'unknown']);
  assert.equal(items['feedback:FB_2026_0001'].taskId, open.id);
  assert.ok(items['feedback:FB_2026_0002'].doneAt);
  assert.equal(JSON.stringify(items).includes('Persiana'), false, 'solo estados, sin títulos');
  // Sin clave, con otra o con la sesión de una persona: 401. Solo referencias de feedback (los fallos de aplicación no van a Tasks).
  assert.equal((await status({ externalRefs: [] }, null)).status, 401);
  assert.equal((await status({ externalRefs: [] }, 'otra')).status, 401);
  assert.equal((await app.call('/api/v1/worker/requests/status', { body: { externalRefs: [] } })).status, 401);
  assert.equal((await status({ externalRefs: ['central:LEG_2026_004'] })).status, 422);
  assert.equal((await status({ externalRefs: ['qa:FB_2026_0001'] })).status, 422);
  // Una persona no puede lanzar la acción por invoke.
  assert.equal((await app.call('/api/v1/invoke/tasks.requests_status', { body: { externalRefs: ['feedback:FB_2026_0001'] } })).status, 403);
});

test('puente con Feedback (§22.2): worker/requests/task escribe como la identidad de servicio, con quién informó como metadato', async () => {
  const status = (body: unknown) => app.handler(new Request('http://localhost/api/v1/worker/requests/status', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': WORKER_KEY }, body: JSON.stringify(body) }));
  const post = (body: unknown, key: string | null = WORKER_KEY) => app.handler(new Request('http://localhost/api/v1/worker/requests/task', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Ikisai-Worker-Key': key } : {}) }, body: JSON.stringify(body) }));
  const report = (code: string, extra: Record<string, unknown> = {}) => ({
    source: 'feedback', kind: 'feedback.space.damage', kind_label: 'Espacio · Avería', external_ref: code, title: 'Ducha no evacúa bien · Habitación 3',
    note: 'Reporte de huésped. Ver detalle autorizado.', external_url: `https://tasks.ikisai.com/#/feedback/${code}`,
    on_behalf_of: { kind: 'guest', report_code: code }, ...extra });
  // La identidad de servicio la crea Core (migración 0067). Mientras no existe, 503.
  const service = uuid();
  assert.equal((await post(report('FB_2026_000429'))).status, 503);
  await simulateServiceIdentity(app.t.db, service);

  const first = await post(report('FB_2026_000429'));
  assert.equal(first.status, 200);
  const out = await first.json() as any;
  assert.deepEqual(out, { taskId: await requestTaskId('feedback:FB_2026_000429'), status: 'pending' }, 'sin regla, por clasificar');
  const request = (await rows('tasks.requests')).find((r) => r.id === out.taskId);
  assert.deepEqual([request.requested_by, request.on_behalf_of, request.updated_by], [service, { kind: 'guest', report_code: 'FB_2026_000429' }, service]);
  // Idempotente: el reintento devuelve lo mismo sin crear nada.
  assert.deepEqual(await (await post(report('FB_2026_000429'))).json(), out);
  assert.equal((await rows('tasks.requests')).filter((r) => r.external_ref === 'feedback:FB_2026_000429').length, 1);

  // Con regla para su tipo, va a su proyecto y la tarea guarda quién informó (organizador de un evento).
  await commit([{ op: 'insert', table: 'tasks.request_routes', id: uuid(), fields: { kind: 'feedback.event.setup', tab_id: TAB, project_id: OBRA, position: 3072 } }]);
  const event = await (await post(report('FB_2026_000430', { kind: 'feedback.event.setup', title: 'Necesitamos diez sillas adicionales', on_behalf_of: { kind: 'organizer', report_code: 'FB_2026_000430' } }))).json() as any;
  assert.equal(event.status, 'open');
  const task = (await rows('tasks.tasks')).find((t) => t.id === event.taskId);
  assert.deepEqual([task.project_id, task.external_kind, task.external_on_behalf, task.external_url], [OBRA, 'feedback.event.setup', 'organizer', 'https://tasks.ikisai.com/#/feedback/FB_2026_000430']);

  // Clasificar a mano la pendiente lleva también quién informó.
  const data: any = { ...emptyDataset() };
  for (const table of ['tasks.tabs', 'tasks.projects', 'tasks.tasks', 'tasks.project_labels', 'tasks.requests']) data[table] = await rows(table);
  assert.equal((await commit(classifyRequestOps(data, out.taskId, { project_id: OBRA }))).status, 200);
  assert.equal((await rows('tasks.tasks')).find((t) => t.id === out.taskId).external_on_behalf, 'guest');

  // Solo lo del contrato.
  for (const bad of [
    report('FB_1', { source: 'qa' }), report('FB_1', { kind: 'qa.booking' }), report('FB_1', { kind: 'central.otra' }),
    report('FB_1', { title: 'x'.repeat(121) }), report('FB_1', { note: 'x'.repeat(1001) }), report('FB_1', { external_url: 'https://booking.ikisai.com/#/x' }),
    report('FB_1', { on_behalf_of: { kind: 'vecino', report_code: 'FB_1' } }), report('FB_1', { on_behalf_of: { kind: 'guest', report_code: 'FB_1', name: 'Juan' } }),
    report('FB_1', { tab_id: TAB }),
  ]) assert.equal((await post(bad)).status, 422, JSON.stringify(bad));
  // Booking: el plazo de SES, desde su worker, con su propia identidad de servicio y sin on_behalf_of.
  const ses = { source: 'booking', kind: 'booking.ses_deadline', kind_label: 'SES · Plazo', external_ref: 'SES-2026-10-12-RES42', title: 'Enviar el parte de viajeros de la reserva 42',
    external_url: 'https://booking.ikisai.com/#/reservas/42/ses' };
  assert.equal((await post(ses)).status, 503, 'sin la identidad de Booking');
  await simulateServiceIdentity(app.t.db, uuid(), 'booking');
  const booked = await post({ ...ses, due: '2026-10-13', priority: 'critical' });
  assert.equal(booked.status, 200);
  assert.equal(((await booked.json()) as any).status, 'pending');
  const sesRequest = (await rows('tasks.requests')).find((x) => x.external_ref === 'booking:SES-2026-10-12-RES42');
  assert.deepEqual([sesRequest.on_behalf_of, sesRequest.due, sesRequest.priority], [null, '2026-10-13', 'critical']);
  for (const bad of [{ ...ses, priority: 'urgente' }, { ...ses, due: '2026-10-13T10:00:00Z' }]) assert.equal((await post(bad)).status, 422, JSON.stringify(bad));
  for (const bad of [{ ...ses, kind: 'booking.otra' }, { ...ses, external_url: 'https://tasks.ikisai.com/#/x' }, { ...ses, source: 'central' }]) assert.equal((await post(bad)).status, 422, JSON.stringify(bad));
  assert.equal((await status({ externalRefs: ['booking:SES-2026-10-12-RES42'] })).status, 200);
  // Portales de organizadores (T3): fechas posibles, «quiere confirmar» y comentarios a la propuesta, en nombre del organizador.
  for (const [kind, ref] of [['booking.organizer_dates', 'RES42-FECHAS-1'], ['booking.organizer_confirm', 'RES42-CONFIRMAR'], ['booking.proposal_comment', 'PROP42-COMENTARIO-3']]) {
    const res = await post({ source: 'booking', kind, external_ref: ref, title: 'Petición del organizador', external_url: 'https://booking.ikisai.com/#/reservas/42', on_behalf_of: { kind: 'organizer', report_code: 'RES42' } });
    assert.equal(res.status, 200, kind);
    assert.equal(((await res.json()) as any).status, 'pending', `${kind}: sin regla, por clasificar`);
  }
  assert.equal((await rows('tasks.requests')).find((x) => x.external_ref === 'booking:PROP42-COMENTARIO-3').on_behalf_of.kind, 'organizer');
  assert.equal((await post(report('FB_1'), null)).status, 401);
  assert.equal((await post(report('FB_1'), 'otra')).status, 401);
  // Nadie más fija quién informó: ni por commands en una tarea, ni cambiándolo después.
  assert.equal((await commit([{ op: 'update', table: 'tasks.tasks', id: task.id, expectedRevision: task.revision, fields: { external_on_behalf: 'internal' } }])).status, 422);
  assert.equal((await commit([{ op: 'insert', table: 'tasks.tasks', id: uuid(), fields: { tab_id: TAB, project_id: INBOX, title: 'x', position: 7, external_on_behalf: 'guest' } }])).status, 422);
});
