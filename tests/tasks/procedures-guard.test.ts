/**
 * Tasks · los procedimientos se defienden solos (migración 0355, autoauditoría del 27-10-2026): llamados directamente al
 * núcleo, sin la Edge, `import_rows` es solo de la propietaria con acceso a toda la app, y `request_task` /
 * `request_project` con referencias de sistema, `projectRef` u `onBehalfOf` solo de la identidad de servicio de esa fuente.
 * Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid();
let app: TestApp;
let seq = 0;

/** Directo a core.commit, como lo haría cualquiera con `allow_procedure`, sin pasar por la Edge. */
const direct = (actor: string, procedure: string, args: Record<string, unknown>) => app.t.db.query(`select core.commit('tasks', $1::uuid, $2, 'd', null, $3::jsonb)`,
  [actor, `guard-${++seq}`, JSON.stringify([{ op: 'call', procedure, args }])]);

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  const out = await app.call('/api/v1/commands', { body: { requestId: 'seed', operations: createTabOps({ id: TAB, name: 'Casa', position: 1024 }) } });
  assert.equal(out.status, 200, JSON.stringify(out.data));
});
test.after(async () => { await app.close(); });

test('import_rows: solo la propietaria con acceso a toda la app', async () => {
  const rows = { 'tasks.tasks': [] as unknown[] };
  await assert.rejects(direct(app.users.editor, 'tasks.import_rows', { mode: 'portable', rows }), /FORBIDDEN/, 'una editora, no');
  await app.t.db.query(`update core.memberships set scopes = $1 where app = 'tasks' and user_id = $2`, [JSON.stringify({ tabs: [TAB], projects: {} }), app.users.owner]);
  try {
    await assert.rejects(direct(app.users.owner, 'tasks.import_rows', { mode: 'portable', rows }), /FORBIDDEN/, 'ni una propietaria con solo un área');
  } finally {
    await app.t.db.query(`update core.memberships set scopes = null where app = 'tasks' and user_id = $1`, [app.users.owner]);
  }
  // La propietaria con todo pasa la guarda (y luego falla por no traer filas, que es lo que tiene que pasar).
  await assert.rejects(direct(app.users.owner, 'tasks.import_rows', { mode: 'portable', rows }), /INVALID_IMPORT/);
});

test('request_task y request_project: lo de sistema, projectRef y onBehalfOf solo con la identidad de servicio de la fuente', async () => {
  const task = (extra: Record<string, unknown>) => ({ id: uuid(), externalRef: 'central:X-1', kind: 'central.otra', title: 'x', tabId: TAB, ...extra });
  await assert.rejects(direct(app.users.editor, 'tasks.request_task', task({ externalRef: 'booking:RES2026-90-MONTAJE', kind: 'booking.event_setup' })), /FORBIDDEN/, 'adelantarse a Booking, no');
  await assert.rejects(direct(app.users.editor, 'tasks.request_task', task({ projectRef: 'RES2026-90' })), /FORBIDDEN/, 'meter trabajo por projectRef, no');
  await assert.rejects(direct(app.users.editor, 'tasks.request_task', task({ onBehalfOf: { kind: 'guest', report_code: 'FB_1' } })), /FORBIDDEN/, 'ni en nombre de otro');
  await assert.rejects(direct(app.users.reader, 'tasks.request_task', task({})), /FORBIDDEN|NOT_ALLOWED|READ_ONLY|403/, 'ni quien solo lee');
  await assert.rejects(direct(app.users.editor, 'tasks.request_project', { id: uuid(), externalRef: 'booking:RES2026-90', kind: 'booking.retreat_project', name: 'Retiro', state: 'confirmed' }), /FORBIDDEN/);
  // Una referencia que no es de sistema, sin nada de worker, sigue entrando (como la ruta de personas).
  const ok = await direct(app.users.editor, 'tasks.request_task', task({}));
  assert.equal(ok.rows.length, 1);
});
