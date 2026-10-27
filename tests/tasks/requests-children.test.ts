/**
 * Tasks · «Pedir a Tasks» con hijas (`worker/requests/task` con `children`, migración 0344, docs/tasks/API.md §42): el
 * «Montaje del evento» de Booking, de extremo a extremo contra el núcleo y el hook reales. La madre va al proyecto de su
 * reserva; cada hija tiene su clave estable (repetir no duplica); las que dejan de venir se retiran a la papelera salvo
 * las hechas; las añadidas a mano y las que alguien borró no se tocan. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { requestTaskId } from '../../supabase/functions/tasks-api/requests.ts';
import { simulateServiceIdentity } from './fixtures.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';
import * as montage from '../../supabase/functions/_domain/booking/montage.ts';

const origin = TASKS_ORIGINS[0]!;
const WORKER_KEY = 'clave-de-worker-de-prueba';
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), INBOX = uuid();
let app: TestApp;
let seq = 0;
let projectId = '';

const rows = async (table: string) => (await app.call(`/api/v1/snapshot?tables=${table}&includeDeleted=1&limit=2000`)).data.tables[0].rows as any[];
const commit = (operations: Operation[]) => app.call('/api/v1/commands', { body: { requestId: `seed-${++seq}`, operations } });
const worker = async (route: string, body: unknown) => {
  const res = await app.handler(new Request(`http://localhost/api/v1/worker/requests/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': WORKER_KEY }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() as any };
};
const setup = (children: unknown, extra: Record<string, unknown> = {}) => worker('task', {
  source: 'booking', kind: 'booking.event_setup', external_ref: 'RES2026-80-MONTAJE', project_ref: 'RES2026-80', title: 'Montaje del evento',
  due: '2026-11-14', external_url: 'https://booking.ikisai.com/#/reservas/80', children, ...extra });
const kids = async (parent: string) => (await rows('tasks.tasks')).filter((t) => t.parent_id === parent);

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin], workerKey: WORKER_KEY }) });
  await commit(createTabOps({ id: TAB, name: 'Eventos', position: 1024, inboxId: INBOX }));
  await commit([{ op: 'insert', table: 'tasks.request_routes', id: uuid(), fields: { kind: 'booking.retreat_project', tab_id: TAB, position: 9000 } }]);
  await simulateServiceIdentity(app.t.db, uuid(), 'booking');
  const project = await worker('project', { source: 'booking', kind: 'booking.retreat_project', external_ref: 'RES2026-80', date: '2026-11-14', title: 'Boda de prueba' });
  assert.equal(project.status, 200, JSON.stringify(project.body));
  projectId = project.body.projectId;
});
test.after(async () => { await app.close(); });

test('la madre en el proyecto de la reserva y sus hijas, una vez cada una; repetir no duplica', async () => {
  const list = [{ external_ref: 'mesas', title: 'Montar 12 mesas' }, { external_ref: 'sillas', title: 'Colocar 96 sillas', due: '2026-11-13' }, { external_ref: 'luces', title: 'Guirnaldas de luces', priority: 'high' }];
  const first = await setup(list);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const parent = first.body.taskId;
  assert.equal(parent, await requestTaskId('booking:RES2026-80-MONTAJE'));
  assert.equal(first.body.status, 'open');
  assert.deepEqual(first.body.childrenCounts, { created: 3, updated: 0, retired: 0 });
  assert.deepEqual(first.body.children.map((c: any) => [c.ref, c.status]), [['mesas', 'open'], ['sillas', 'open'], ['luces', 'open']]);
  const mesas = first.body.children[0].taskId;
  assert.equal(mesas, await requestTaskId('booking:RES2026-80-MONTAJE/mesas'));
  const made = await kids(parent);
  assert.equal(made.length, 3);
  for (const k of made) assert.deepEqual([k.project_id, k.external_kind, k.external_ref.startsWith('booking:RES2026-80-MONTAJE/')], [projectId, 'booking.event_setup', true]);
  const sillas = made.find((k) => k.title === 'Colocar 96 sillas');
  assert.deepEqual([sillas.due, made.find((k) => k.title === 'Guirnaldas de luces').priority], ['2026-11-13', 'high']);
  assert.equal((await rows('tasks.tasks')).find((t) => t.id === parent).project_id, projectId);

  const again = await setup(list);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body.childrenCounts, { created: 0, updated: 0, retired: 0 });
  assert.equal((await kids(parent)).length, 3);
});

test('reenvío: pone al día, crea lo nuevo y retira lo que ya no viene, salvo lo hecho y lo añadido a mano', async () => {
  const parent = await requestTaskId('booking:RES2026-80-MONTAJE');
  const byRef = async (ref: string) => (await rows('tasks.tasks')).find((t) => t.external_ref === `booking:RES2026-80-MONTAJE/${ref}`);
  // «Sillas» ya está hecha; alguien añade a mano una hija sin referencia.
  const sillas = await byRef('sillas');
  assert.equal((await commit([{ op: 'update', table: 'tasks.tasks', id: sillas.id, expectedRevision: sillas.revision, fields: { done: true } }])).status, 200);
  const manual = uuid();
  assert.equal((await commit([{ op: 'insert', table: 'tasks.tasks', id: manual, fields: { tab_id: TAB, project_id: projectId, parent_id: parent, title: 'Revisar el generador', position: 999999 } }])).status, 200);

  const res = await setup([{ external_ref: 'mesas', title: 'Montar 14 mesas' }, { external_ref: 'flores', title: 'Centros de flores' }], { title: 'Montaje del evento · sábado' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.updated, true, 'la madre toma el título nuevo');
  assert.deepEqual(res.body.childrenCounts, { created: 1, updated: 1, retired: 1 });
  assert.equal((await rows('tasks.tasks')).find((t) => t.id === parent).title, 'Montaje del evento · sábado');
  assert.equal((await byRef('mesas')).title, 'Montar 14 mesas');
  assert.ok((await byRef('flores')) && !(await byRef('flores')).deleted_at);
  assert.ok((await byRef('luces')).deleted_at, 'lo que ya no viene, a la papelera');
  assert.equal((await byRef('sillas')).deleted_at, null, 'lo hecho se queda');
  assert.equal((await rows('tasks.tasks')).find((t) => t.id === manual).deleted_at, null, 'lo añadido a mano no se toca');

  // Lo que alguien borró no se resucita: vuelve como «deleted».
  const flores = await byRef('flores');
  assert.equal((await commit([{ op: 'delete', table: 'tasks.tasks', id: flores.id, expectedRevision: flores.revision }])).status, 200);
  const back = await setup([{ external_ref: 'mesas', title: 'Montar 14 mesas' }, { external_ref: 'flores', title: 'Centros de flores' }], { title: 'Montaje del evento · sábado' });
  assert.deepEqual(back.body.children.map((c: any) => [c.ref, c.status]), [['mesas', 'open'], ['flores', 'deleted']]);
  assert.ok((await byRef('flores')).deleted_at);
});

test('entrada: hijas con clave única, campos conocidos y hasta 100; el montaje necesita su reserva', async () => {
  for (const bad of [
    [{ external_ref: 'a', title: 'x' }, { external_ref: 'a', title: 'y' }],
    [{ external_ref: 'a b', title: 'x' }],
    [{ external_ref: 'a', title: '' }],
    [{ external_ref: 'a', title: 'x', owner: 'alguien' }],
    Array.from({ length: 101 }, (_, i) => ({ external_ref: `h${i}`, title: 'x' })),
    'mesas',
  ]) {
    const res = await setup(bad);
    assert.equal(res.status, 422, JSON.stringify(bad).slice(0, 80));
  }
  const noProject = await worker('task', { source: 'booking', kind: 'booking.event_setup', external_ref: 'RES2026-81-MONTAJE', title: 'Montaje', children: [] });
  assert.equal(noProject.status, 422);
  assert.equal(noProject.body.error.details.field, 'project_ref');
});

test('ámbito (0347): el procedimiento, llamado directamente, exige editor u owner y la madre en el ámbito de quien escribe', async () => {
  const list = [{ external_ref: 'mesas', title: 'Montar 12 mesas' }, { external_ref: 'sillas', title: 'Colocar 96 sillas' }];
  const first = await setup(list);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const parent = first.body.taskId;
  const member = async (role: string, scopes: unknown) => {
    const id = await app.t.createUser();
    await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('tasks', $1, $2, $3::jsonb)`, [id, role, JSON.stringify(scopes)]);
    return id;
  };
  // Directo al núcleo, sin la Edge: lo que haría alguien con `allow_procedure` y el `parentRef` de una madre ajena.
  const direct = (actor: string, children: unknown[]) => app.t.db.query(`select core.commit('tasks', $1::uuid, $2, 'd', null, $3::jsonb)`, [actor, `scope-${++seq}`,
    JSON.stringify([{ op: 'call', procedure: 'tasks.request_children', args: { parentRef: 'booking:RES2026-80-MONTAJE', kind: 'booking.event_setup', children, create: false, retire: true } }])]);
  const before = (await kids(parent)).filter((k) => !k.deleted_at).map((k) => [k.id, k.revision]).sort();

  const outsider = await member('editor', [uuid()]);
  await assert.rejects(direct(outsider, []), /FORBIDDEN/, 'una editora de otra área no retira las hijas');
  await assert.rejects(direct(outsider, [{ ref: 'mesas', title: 'Cambiado' }]), /FORBIDDEN/, 'ni las pone al día');
  const otherProject = await member('editor', { projects: { [TAB]: [uuid()] } });
  await assert.rejects(direct(otherProject, []), /FORBIDDEN/, 'ni con otro proyecto de la misma área');
  const reader = await member('reader', '*');
  await assert.rejects(direct(reader, []), /FORBIDDEN/, 'ni una lectora');
  assert.deepEqual((await kids(parent)).filter((k) => !k.deleted_at).map((k) => [k.id, k.revision]).sort(), before, 'nada cambió');

  // Con el proyecto de la madre en su ámbito, sí.
  const inProject = await member('editor', { projects: { [TAB]: [projectId] } });
  const ok = await direct(inProject, [{ ref: 'mesas', title: 'Montar 12 mesas' }, { ref: 'sillas', title: 'Colocar 96 sillas' }]);
  assert.equal(ok.rows.length, 1);
});

test('contrato con Booking: la petición que arma montageRequest crea la madre y una hija por objeto; quitar un objeto la retira', async () => {
  // La misma función que usa booking-api (POST reservas/:id/montaje), con datos sintéticos.
  const project = await worker('project', { source: 'booking', kind: 'booking.retreat_project', external_ref: 'RES2026-82', date: '2026-12-05', title: 'Retiro de prueba' });
  assert.equal(project.status, 200, JSON.stringify(project.body));
  const reservation = { id: uuid(), code: '2026-82', title: 'Retiro de prueba', start_date: '2026-12-05' };
  const names = montage.namesFrom({ icons: [{ id: 'mesa', name: 'Mesa redonda' }, { id: 'silla', name: 'Silla' }, { id: 'atril', name: 'Atril' }], plans: [{ id: 'plan-a', label: 'Salón' }] });
  const changes: montage.MontageChange[] = [
    { id: uuid(), planId: 'plan-a', op: 'add', iconId: 'mesa', replacesIconId: null },
    { id: uuid(), planId: 'plan-a', op: 'remove', iconId: null, replacesIconId: 'atril' },
    { id: uuid(), planId: 'plan-a', op: 'replace', iconId: 'silla', replacesIconId: 'mesa' },
  ];
  const sent = await worker('task', montage.montageRequest(reservation, changes, names));
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.taskId, await requestTaskId('booking:RES2026-82-MONTAJE'));
  assert.deepEqual(sent.body.childrenCounts, { created: 3, updated: 0, retired: 0 });
  const parent = (await rows('tasks.tasks')).find((t) => t.id === sent.body.taskId);
  assert.deepEqual([parent.project_id, parent.title, parent.due], [project.body.projectId, 'Montaje del evento', '2026-12-05']);
  const made = await kids(sent.body.taskId);
  assert.equal(made.length, 3, 'una hija por objeto');
  for (const c of changes) assert.ok(made.some((k) => k.external_ref === `booking:RES2026-82-MONTAJE/${c.id}`), c.id);
  assert.ok(made.every((k) => k.project_id === project.body.projectId && k.title.endsWith('(Salón)')));

  // Booking reenvía la lista entera sin el atril: su hija se retira y las otras siguen.
  const again = await worker('task', montage.montageRequest(reservation, [changes[0]!, changes[2]!], names));
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body.childrenCounts, { created: 0, updated: 0, retired: 1 });
  const atril = (await kids(sent.body.taskId)).find((k) => k.external_ref.endsWith(changes[1]!.id));
  assert.ok(atril.deleted_at, 'el objeto quitado, a la papelera');
});
