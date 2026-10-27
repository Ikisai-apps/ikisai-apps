/** Booking · «Montaje» (0491): la ruta que manda a Tasks la madre «Montaje del evento» con una hija por cambio. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
const posts: Array<{ path: string; body: any }> = [];
let tasksStatus = 200;
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], ses: { notifyTasks: null, tasksPost: async (path, body) => {
      posts.push({ path, body });
      return tasksStatus === 200 ? { status: 200, data: { taskId: 'tarea-madre', status: 'created' } } : { status: tasksStatus, data: { error: { code: 'PROJECT_NOT_READY' } } };
    } } }),
  });
});
test.after(async () => { await app.close(); });
async function ok(operations: unknown[]) {
  const res = await app.call('/api/v1/commands', { body: { requestId: `ms-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}

test('montaje · sync: sin proyecto, 409; sin cambios, nada; con cambios, la lista entera; quitar todo vacía las hijas', async () => {
  const db = app.t.db;
  const res = uuid(); const event = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Retiro con montaje', status: 'pre_reservada', start_date: '2031-11-06', end_date: '2031-11-08', expected_guests: 20 } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  await db.query(`update booking.reservations set code = coalesce(code, '2031-77') where id = $1`, [res]);
  const code = (await db.query<{ code: string }>('select code from booking.reservations where id = $1', [res])).rows[0]!.code;
  const sync = (token?: string) => app.call(`/api/v1/montage/${res}/sync`, { ...(token ? { token } : {}), body: {} });

  assert.equal((await sync(app.tokens.reader)).status, 403, 'un lector no cambia el montaje');
  assert.equal((await sync()).data?.error?.code, 'PROJECT_NOT_READY', 'sin proyecto del retiro en Tasks');
  await db.query(`insert into booking.tasks_projects (reservation_id, project_id, synced_at) values ($1, 'proyecto-1', now())
    on conflict (reservation_id) do update set project_id = 'proyecto-1'`, [res]);
  await db.query(`delete from core.memberships where app = 'resources' and user_id = $1`, [app.users.owner]);
  const noAccess = await sync();
  assert.equal(noAccess.data?.error?.code, 'NEEDS_ACCESS', `sin Recursos no se lee la decoración: ${JSON.stringify(noAccess.data)}`);
  await db.query(`insert into core.memberships (app, user_id, role) values ('resources', $1, 'reader')`, [app.users.owner]);
  assert.deepEqual((await sync()).data, { status: 'nothing', children: 0 }, 'sin cambios y sin nada mandado no se crea la madre');
  assert.equal(posts.length, 0);

  const albergue = (await db.query<{ id: string }>(`insert into resources.spaces (kind, name) values ('exterior', 'Albergue del montaje') returning id`)).rows[0]!.id;
  const plan = (await db.query<{ id: string }>(`insert into resources.floor_plans (building_id, width, height, floor) values ($1, 20, 10, '0') returning id`, [albergue])).rows[0]!.id;
  const icon = async (name: string) => {
    const file = (await db.query<{ id: string }>(`insert into core.files (app, bucket, path, filename, mime, size, sha256, status) values ('resources', 'resources-plans', $1, 'i.svg', 'image/svg+xml', 900, $2, 'verified') returning id`,
      [`resources/${uuid()}`, 'f'.repeat(64)])).rows[0]!.id;
    return (await db.query<{ id: string }>(`insert into resources.decor_icons (name, category, file_id, default_size) values ($1, 'Montaje', $2, 1) returning id`, [name, file])).rows[0]!.id;
  };
  const mesa = await icon('Mesa larga'); const atril = await icon('Atril');
  const general = (await db.query<{ id: string }>(`insert into resources.decor_items (plan_id, icon_id, cell_x, cell_y) values ($1, $2, 4, 2) returning id`, [plan, mesa])).rows[0]!.id;
  const add = (await db.query<{ id: string }>(`insert into resources.decor_items (plan_id, icon_id, cell_x, cell_y, layer, event_id, op) values ($1, $2, 1, 1, 'event', $3, 'add') returning id`, [plan, atril, event])).rows[0]!.id;
  const remove = (await db.query<{ id: string }>(`insert into resources.decor_items (plan_id, icon_id, cell_x, cell_y, layer, event_id, op, replaces_item_id) values ($1, $2, 4, 2, 'event', $3, 'remove', $4) returning id`, [plan, mesa, event, general])).rows[0]!.id;
  // un cambio de otro evento no entra
  await db.query(`insert into resources.decor_items (plan_id, icon_id, cell_x, cell_y, layer, event_id, op) values ($1, $2, 8, 8, 'event', $3, 'add')`, [plan, atril, uuid()]);

  const out = await sync();
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.deepEqual(out.data, { status: 'sent', children: 2, taskId: 'tarea-madre' });
  const body = posts[0]!.body;
  assert.equal(posts[0]!.path, 'requests/task');
  assert.deepEqual([body.external_ref, body.project_ref, body.title, body.due], [`RES${code}-MONTAJE`, `RES${code}`, 'Montaje del evento', '2031-11-06']);
  assert.deepEqual(body.children.map((c: any) => [c.external_ref, c.title]), [
    [add, 'Montar: Atril (Albergue del montaje · planta 0)'],
    [remove, 'Retirar: Mesa larga (Albergue del montaje · planta 0)'],
  ]);
  const mark = (await db.query<{ montage_task_id: string; montage_children: number }>('select montage_task_id, montage_children from booking.tasks_projects where reservation_id = $1', [res])).rows[0]!;
  assert.deepEqual([mark.montage_task_id, mark.montage_children], ['tarea-madre', 2]);

  // se deshacen los cambios: como ya se mandó, se manda la lista vacía para que Tasks retire las hijas
  await db.query(`update resources.decor_items set deleted_at = now() where id = any($1)`, [[add, remove]]);
  assert.deepEqual((await sync()).data, { status: 'sent', children: 0, taskId: 'tarea-madre' });
  assert.deepEqual(posts[1]!.body.children, []);

  tasksStatus = 409;
  assert.equal((await sync()).data?.error?.code, 'PROJECT_NOT_READY');
});
