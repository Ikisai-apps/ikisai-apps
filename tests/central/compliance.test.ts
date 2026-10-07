/** Central · cumplimiento: obligaciones, documentos clave, invariantes y tareas pedidas a Tasks (con Tasks simulado). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import { addMonths, COMPLIANCE_TABLES, dueItems, nextExpiry, TABLES, TASK_KIND, validateOperations } from '../../supabase/functions/_domain/central/mod.ts';

const { requirements: REQ, keyDocuments: DOCS, requirementTasks: LINKS } = COMPLIANCE_TABLES;
const uuid = () => crypto.randomUUID();

/** Tasks simulado: guarda lo que recibe y responde lo que diga `next`. */
const tasksCalls: Array<{ url: string; auth: string | null; body: any }> = [];
let next: (path: string, body: any) => Response = (path, body) => path.endsWith('requests/task')
  ? Response.json({ created: true, routed: 'pending', task: { kind: 'task', id: taskIdFor(body.external_ref), title: body.title, revision: 1, pending: true } })
  : Response.json({ items: body.ids.map((id: string) => ({ kind: 'task', id, done: false, visible: false, request: 'pending' })), missing: [] });
const taskIds = new Map<string, string>();
const taskIdFor = (ref: string) => { if (!taskIds.has(ref)) taskIds.set(ref, uuid()); return taskIds.get(ref)!; };
const tasksFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const body = JSON.parse(String(init?.body ?? '{}'));
  tasksCalls.push({ url, auth: new Headers(init?.headers).get('Authorization'), body });
  return next(url, body);
};

let app: TestApp;
let seq = 0;
const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `comp-${++seq}`, operations } });

test.before(async () => {
  app = await createTestApp({
    app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!,
    createHandler: (config) => createCentralApp({ ...config, origins: [CENTRAL_ORIGINS[0]!] }, { tasksApiBase: 'https://tasks.example.invalid', tasksFetch }),
  });
});
test.after(async () => { await app.close(); });

async function newRequirement(fields: Record<string, unknown> = {}) {
  const id = uuid();
  const res = await commit([{ op: 'insert', table: REQ, id, fields: { name: 'Póliza de responsabilidad civil', requirement_type: 'seguro', risk: 'alto', ...fields } }]);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.changes[0].after;
}

test('cumplimiento · dominio: siguiente vencimiento por frecuencia y vencimientos unificados', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2024-02-29', 12), '2025-02-28');
  assert.equal(nextExpiry('2026-10-07', 'anual'), '2027-10-07');
  assert.equal(nextExpiry('2026-10-07', 'otra', 18), '2028-04-07');
  assert.equal(nextExpiry('2026-10-07', 'unica'), null);
  const items = dueItems({
    requirements: [
      { id: 'a', name: 'Vencida', expires_on: '2026-10-01', notice_days: 30, status: 'cumplido', risk: 'critico', blocks_operation: true },
      { id: 'b', name: 'Lejana', expires_on: '2027-10-01', notice_days: 30, status: 'pendiente' },
      { id: 'c', name: 'Con aviso largo', expires_on: '2026-12-01', notice_days: 90, status: 'pendiente' },
      { id: 'd', name: 'Cerrada', expires_on: '2026-01-01', status: 'cerrado' },
    ],
    keyDocuments: [{ id: 'e', name: 'Póliza', expires_on: '2026-10-20', status: 'vigente' }, { id: 'f', name: 'Vieja', expires_on: '2020-01-01', status: 'sustituido' }],
    personRecords: [{ id: 'g', person_id: 'p1', record_type: 'manipulador_alimentos', expires_on: '2026-10-10', status: 'ok' }, { id: 'h', person_id: 'borrada', expires_on: '2026-10-09', status: 'ok' }],
    peopleNames: new Map([['p1', 'Marga']]),
  }, '2026-10-07');
  assert.deepEqual(items.map((i) => [i.id, i.state]), [['a', 'vencido'], ['g', 'por_vencer'], ['e', 'por_vencer'], ['c', 'por_vencer']]);
  assert.equal(items[0]!.blocksOperation, true);
  assert.match(items[1]!.title, /Marga/);
  const owner = { role: 'owner' };
  assert.equal(validateOperations([{ op: 'insert', table: REQ, id: 'x', fields: { name: 'X', requirement_type: 'seguro', frequency: 'otra' } }], owner)?.details.field, 'frequency_months');
  assert.equal(validateOperations([{ op: 'insert', table: LINKS, id: 'x', fields: {} }], owner)?.code, 'INVALID_OPERATION');
});

test('cumplimiento · obligación con código LEG, documento clave DOC e invariantes', async () => {
  const req = await newRequirement({ frequency: 'anual', expires_on: '2027-03-01', notice_days: 60 });
  assert.match(req.code, /^LEG_\d{4}_\d{3}$/);
  const docId = uuid();
  const doc = await commit([{ op: 'insert', table: DOCS, id: docId, fields: { requirement_id: req.id, document_type: 'poliza', name: 'Póliza 2026', expires_on: '2027-03-01' } }]);
  assert.equal(doc.status, 200, JSON.stringify(doc.data)); assert.match(doc.data.changes[0].after.code, /^DOC_/);
  const orphan = await commit([{ op: 'delete', table: REQ, id: req.id, expectedRevision: req.revision }]);
  assert.equal(orphan.data.error.code, 'ORPHAN_CHILD');
  const bad = await commit([{ op: 'insert', table: REQ, id: uuid(), fields: { name: 'X', requirement_type: 'seguro', frequency: 'otra' } }]);
  assert.equal(bad.status, 422); assert.equal(bad.data.error.details.field, 'frequency_months');

  // Una persona responsable de algo vivo no puede ir a la papelera.
  const personId = uuid();
  await commit([{ op: 'insert', table: TABLES.people, id: personId, fields: { display_name: 'Responsable', relation: 'equipo' } }]);
  await commit([{ op: 'update', table: REQ, id: req.id, expectedRevision: req.revision, fields: { responsible_person_id: personId } }]);
  const inUse = await commit([{ op: 'delete', table: TABLES.people, id: personId, expectedRevision: 1 }]);
  assert.equal(inUse.status, 422); assert.equal(inUse.data.error.code, 'PERSON_IN_USE');
  // El lector ve el cumplimiento.
  const snap = await app.call(`/api/v1/snapshot?tables=${REQ},${DOCS}`, { token: app.tokens.reader });
  assert.equal(snap.status, 200); assert.ok(snap.data.tables[0].rows.some((r: any) => r.id === req.id));
});

test('cumplimiento · pedir tarea a Tasks: kind sin área, token de la persona, enlace idempotente', async () => {
  const req = await newRequirement({ name: 'Revisión anual de la piscina', requirement_type: 'revision_tecnica', risk: 'critico' });
  tasksCalls.length = 0;
  const body = { requestId: 'req-piscina-0001', due: '2026-11-15', note: 'Llamar a la empresa' };
  const first = await app.call(`/api/v1/requirements/${req.id}/task`, { body });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.routed, 'pending');
  const sent = tasksCalls[0]!;
  assert.equal(sent.url, 'https://tasks.example.invalid/api/v1/requests/task');
  assert.equal(sent.auth, 'Bearer ' + app.tokens.owner);
  assert.equal(sent.body.source, 'central'); assert.equal(sent.body.kind, TASK_KIND); assert.ok(sent.body.kind_label);
  assert.equal(sent.body.external_ref, `${req.code}:req-piscina-0001`);
  assert.equal(sent.body.external_url, `https://central.ikisai.com/#/cumplimiento/${req.id}`);
  assert.equal(sent.body.priority, 'critical'); assert.equal(sent.body.due, '2026-11-15');
  assert.equal('tab_id' in sent.body || 'project_id' in sent.body, false);

  // Reintento con el mismo requestId: la misma tarea y una sola fila de enlace.
  const again = await app.call(`/api/v1/requirements/${req.id}/task`, { body });
  assert.equal(again.status, 200); assert.equal(again.data.requirementTaskId, first.data.requirementTaskId);
  const links = (await app.call(`/api/v1/snapshot?tables=${LINKS}`)).data.tables[0].rows.filter((r: any) => r.requirement_id === req.id);
  assert.equal(links.length, 1); assert.equal(links[0].target_id, first.data.task.id); assert.equal(links[0].due_on, '2026-11-15');

  // Estado leído de Tasks, con el token de quien mira.
  const status = await app.call('/api/v1/requirements/tasks-status', { token: app.tokens.reader, body: { ids: [links[0].target_id] } });
  assert.equal(status.status, 200); assert.equal(status.data.items[0].request, 'pending');
  assert.equal(tasksCalls.at(-1)!.auth, 'Bearer ' + app.tokens.reader);
  assert.deepEqual(tasksCalls.at(-1)!.body, { kind: 'task', ids: [links[0].target_id] });
});

test('cumplimiento · errores al pedir tarea: lector, Tasks sin permiso, Tasks caído, obligación inexistente', async () => {
  const req = await newRequirement({ name: 'Licencia de actividad', requirement_type: 'licencia_autorizacion' });
  assert.equal((await app.call(`/api/v1/requirements/${req.id}/task`, { token: app.tokens.reader, body: { requestId: 'req-lector-0001' } })).status, 403);
  assert.equal((await app.call(`/api/v1/requirements/${req.id}/task`, { body: {} })).data.error.code, 'INVALID_OPERATION');
  assert.equal((await app.call(`/api/v1/requirements/${uuid()}/task`, { body: { requestId: 'req-nada-0001' } })).status, 404);
  const saved = next;
  try {
    next = () => Response.json({ error: { code: 'FORBIDDEN', message: 'x' } }, { status: 403 });
    const forbidden = await app.call(`/api/v1/requirements/${req.id}/task`, { body: { requestId: 'req-forb-0001' } });
    assert.equal(forbidden.status, 403); assert.equal(forbidden.data.error.code, 'TASKS_FORBIDDEN');
    next = () => { throw new TypeError('network'); };
    const down = await app.call(`/api/v1/requirements/${req.id}/task`, { body: { requestId: 'req-down-0001' } });
    assert.equal(down.status, 503); assert.equal(down.data.error.code, 'TASKS_UNAVAILABLE');
  } finally {
    next = saved;
  }
  // Ningún enlace a medias.
  const links = (await app.call(`/api/v1/snapshot?tables=${LINKS}`)).data.tables[0].rows.filter((r: any) => r.requirement_id === req.id);
  assert.equal(links.length, 0);
  // El cliente no puede insertar enlaces a mano.
  const manual = await commit([{ op: 'insert', table: LINKS, id: uuid(), fields: { requirement_id: req.id, target_id: uuid(), external_ref: 'x' } }]);
  assert.equal(manual.data.error.code, 'INVALID_OPERATION');
});
