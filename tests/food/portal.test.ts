/**
 * Food · el menú del retiro en los portales (API.md §7.5; Fd2/FD1 y Fd3) contra PGlite: ámbito con core.portal_in_scope,
 * solo lo compartido, Guests solo lo confirmado, nada interno, y comentarios del organizador que devuelven a revisión
 * un menú validado.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import { eventSnapshot, type FoodEvent } from '../../supabase/functions/_domain/food/mod.ts';
import { day, seedBookingEvent } from './helpers.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let counter = 0;

async function commit(operations: unknown[]) {
  return app.call('/api/v1/commands', { body: { requestId: `portal-${++counter}`, operations } });
}
async function ok(operations: unknown[]) {
  const res = await commit(operations);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const revision = async (table: string, id: string) => Number((await app.t.db.query<{ revision: string }>(`select revision from ${table} where id = $1`, [id])).rows[0]!.revision);
const menuRow = async (id: string) => (await app.t.db.query<Record<string, any>>(`select * from food.menus where id = $1`, [id])).rows[0]!;
const read = (portal: string, actor: string, name: string, args: unknown) => app.t.rpc('core_read', { p_app: portal, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const invoke = (actor: string, name: string, args: unknown) => app.t.rpc('core_invoke', { p_app: 'organizers', p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const reservationOf = async (event: string) => (await app.t.db.query<{ r: string }>(`select reservation_id r from booking.events where id = $1`, [event])).rows[0]!.r;
async function member(portal: string, grant: Record<string, string>): Promise<string> {
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ($1, $2, 'editor', $3::jsonb)`, [portal, user, JSON.stringify({ grants: [grant] })]);
  return user;
}

const menu = uuid(); const service = uuid(); const dish = uuid(); const plain = uuid(); const curry = uuid(); const salad = uuid();
let reservation = ''; let other = ''; let event = '';

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  });
  event = await seedBookingEvent(app, { title: 'Retiro del portal', start: day(20), end: day(22), restrictions: [{ type: 'alergia', subject: 'frutos secos', severity: 'grave', servings: 1 }] });
  reservation = await reservationOf(event);
  other = await reservationOf(await seedBookingEvent(app, { title: 'Otro retiro', start: day(30), end: day(31) }));
  const snapshot = (await app.call(`/api/v1/events/${event}`)).data.event as FoodEvent;
  await ok([
    insert('food.recipes', curry, { name: 'Curry adaptado 2', public_name: 'Curry de verduras', public_description: 'Con arroz basmati', category: 'principal', base_servings: 10,
      method: 'Secreto de la casa', service_notes: 'Servir caliente', diet_tags: ['vegano'], allergens: [], allergens_checked: true }),
    insert('food.recipes', salad, { name: 'Ensalada', category: 'entrante', base_servings: 4, allergens: ['frutos_de_cascara'], allergens_checked: false }),
    insert('food.menus', menu, { event_id: event, source_event_revision: snapshot.event_revision, source_event_snapshot: eventSnapshot(snapshot), notes: 'Nota interna de cocina' }),
    insert('food.menu_services', service, { menu_id: menu, service_date: day(20), service_type: 'cena', service_time: '20:30', position: 1, notes: 'Servicio interno' }),
    insert('food.menu_items', dish, { service_id: service, recipe_id: curry, servings: 22, position: 1, notes: 'Doble ración' }),
    insert('food.menu_items', plain, { service_id: service, recipe_id: salad, servings: 22, position: 2 }),
  ]);
});

test('portal_menu · ámbito, solo lo compartido y nada interno; Guests solo lo confirmado', async () => {
  const org = await member('organizers', { reservation_id: reservation });
  const guest = uuid();
  const guestUser = await member('guests', { reservation_id: reservation, guest_id: guest });

  // Sin compartir: el organizador no ve nada todavía (y no se sabe si hay menú).
  let out = await read('organizers', org, 'food.portal_menu', { reservation_id: reservation });
  assert.deepEqual([out.available, out.services], [false, []]);

  await ok([{ op: 'update', table: 'food.menus', id: menu, expectedRevision: await revision('food.menus', menu), fields: { organizer_shared: true } }]);
  out = await read('organizers', org, 'food.portal_menu', { reservation_id: reservation });
  assert.equal(out.available, true);
  assert.equal(out.status, 'provisional');
  assert.equal(out.services.length, 1);
  const [s] = out.services;
  assert.deepEqual([s.date, s.type, s.time], [day(20), 'cena', '20:30:00']);
  assert.deepEqual(s.dishes.map((d: any) => [d.name, d.description]), [['Curry de verduras', 'Con arroz basmati'], ['Ensalada', null]]);
  assert.deepEqual(s.dishes[1].allergens, ['frutos_de_cascara']);
  assert.equal(s.dishes[1].allergens_checked, false);
  assert.deepEqual(out.restrictions.map((r: any) => [r.type, r.subject, r.servings]), [['alergia', 'frutos secos', 1]]);
  // Nada interno: ni nombre interno, ni raciones, ni elaboración, ni notas.
  const text = JSON.stringify(out);
  for (const secret of ['Curry adaptado 2', 'Secreto de la casa', 'Servir caliente', 'Nota interna de cocina', 'Servicio interno', 'Doble ración', '"servings":22']) {
    assert.ok(!text.includes(secret), secret);
  }

  // Guests: lo provisional no; lo confirmado sí, sin el resumen de restricciones.
  assert.equal((await read('guests', guestUser, 'food.portal_menu', { reservation_id: reservation, guest_id: guest })).available, false);
  await app.t.db.query(`update food.menus set status = 'validado', validated_at = now() where id = $1`, [menu]);
  const forGuest = await read('guests', guestUser, 'food.portal_menu', { reservation_id: reservation, guest_id: guest });
  assert.deepEqual([forGuest.available, forGuest.status, forGuest.restrictions], [true, 'confirmado', null]);
  assert.equal(forGuest.services[0].dishes.length, 2);

  // Fuera de ámbito, otra reserva, huésped ajeno o id inválido: la misma respuesta.
  await assert.rejects(read('organizers', org, 'food.portal_menu', { reservation_id: other }), (e: any) => e.code === 'OUT_OF_SCOPE');
  await assert.rejects(read('organizers', org, 'food.portal_menu', { reservation_id: 'no-es-uuid' }), (e: any) => e.code === 'OUT_OF_SCOPE');
  await assert.rejects(read('guests', guestUser, 'food.portal_menu', { reservation_id: reservation, guest_id: uuid() }), (e: any) => e.code === 'OUT_OF_SCOPE');
  await assert.rejects(read('guests', guestUser, 'food.portal_menu', { reservation_id: reservation }), (e: any) => e.code === 'OUT_OF_SCOPE');
});

test('portal_menu_comment · el organizador comenta; sobre un menú validado lo devuelve a revisión; cocina responde en Food', async () => {
  const org = await member('organizers', { reservation_id: reservation });
  const outsider = await member('organizers', { reservation_id: other });
  assert.equal((await menuRow(menu)).status, 'validado');

  await assert.rejects(invoke(org, 'food.portal_menu_comment', { reservation_id: reservation, kind: 'comentario' }), (e: any) => e.code === 'INVALID_FIELDS');
  await assert.rejects(invoke(org, 'food.portal_menu_comment', { reservation_id: reservation, kind: 'prefiero_que_no' }), (e: any) => e.code === 'INVALID_FIELDS');
  await assert.rejects(invoke(org, 'food.portal_menu_comment', { reservation_id: reservation, kind: 'otro' }), (e: any) => e.code === 'INVALID_OPERATION');
  await assert.rejects(invoke(outsider, 'food.portal_menu_comment', { reservation_id: reservation, menu_item_id: dish, kind: 'prefiero_que_no' }), (e: any) => e.code === 'OUT_OF_SCOPE');
  await assert.rejects(invoke(org, 'food.portal_menu_comment', { reservation_id: reservation, menu_item_id: uuid(), kind: 'prefiero_que_no' }), (e: any) => e.code === 'OUT_OF_SCOPE');

  const first = await invoke(org, 'food.portal_menu_comment', { reservation_id: reservation, menu_item_id: plain, kind: 'prefiero_que_no' });
  assert.deepEqual([first.status, first.menu_status], ['nuevo', 'revisar']);
  assert.equal((await menuRow(menu)).status, 'revisar', 'un comentario sobre un menú validado lo devuelve a revisión');
  const second = await invoke(org, 'food.portal_menu_comment', { reservation_id: reservation, kind: 'comentario', message: '¿Podría haber algo de picante aparte?' });
  assert.equal(second.menu_status, 'revisar');

  const mine = await read('organizers', org, 'food.portal_my_menu_comments', { reservation_id: reservation });
  assert.deepEqual(mine.items.map((c: any) => [c.kind, c.dish, c.status, c.mine]), [
    ['comentario', null, 'nuevo', true], ['prefiero_que_no', 'Ensalada', 'nuevo', true]]);
  assert.equal((await read('organizers', outsider, 'food.portal_my_menu_comments', { reservation_id: other })).items.length, 0);

  // Cocina lo ve en su espejo, lo resuelve y responde; lo que escribió el organizador no se toca.
  const snap = await app.call('/api/v1/snapshot?tables=food.menu_comments');
  const rows = snap.data.tables[0].rows as Array<Record<string, any>>;
  const comment = rows.find((r) => r.id === first.id)!;
  assert.equal(comment.menu_item_id, plain);
  await ok([{ op: 'update', table: 'food.menu_comments', id: comment.id, expectedRevision: comment.revision, fields: { status: 'resuelto', reply: 'La cambiamos por crema de calabaza.' } }]);
  const forbidden = await commit([{ op: 'update', table: 'food.menu_comments', id: comment.id, expectedRevision: comment.revision + 1, fields: { message: 'otra cosa' } }]);
  assert.equal(forbidden.status, 422);
  const created = await commit([insert('food.menu_comments', uuid(), { menu_id: menu, kind: 'comentario', message: 'Desde Food no' })]);
  assert.equal(created.status, 422, 'los comentarios solo llegan desde el portal');
  const after = await read('organizers', org, 'food.portal_my_menu_comments', { reservation_id: reservation });
  assert.deepEqual(after.items.find((c: any) => c.id === first.id).reply, 'La cambiamos por crema de calabaza.');

  // Un menú cerrado ya no admite comentarios.
  await app.t.db.query(`update food.menus set status = 'cerrado' where id = $1`, [menu]);
  await assert.rejects(invoke(org, 'food.portal_menu_comment', { reservation_id: reservation, kind: 'comentario', message: 'Tarde' }), (e: any) => e.code === 'MENU_CLOSED');
  // Guests no comenta el menú.
  const guest = uuid();
  const guestUser = await member('guests', { reservation_id: reservation, guest_id: guest });
  await assert.rejects(app.t.rpc('core_invoke', { p_app: 'guests', p_actor: guestUser, p_name: 'food.portal_menu_comment', p_args: { reservation_id: reservation, guest_id: guest, kind: 'comentario', message: 'x' } }));
});

test('fotos de los platos (C8): portal_menu da la miniatura y portal-files solo la abre a quien ve ese menú', async () => {
  const file = async (name: string) => (await app.t.db.query<{ id: string }>(`insert into core.files (app, bucket, path, filename, mime, size, sha256, status)
    values ('food', 'kitchen-media', $1, $1, 'image/webp', 10, $2, 'verified') returning id`, [`food/${name}.webp`, name.padEnd(64, '0').slice(0, 64)])).rows[0]!.id;
  const thumb = await file('a1'); const big = await file('b2'); const loose = await file('c3');
  await app.t.db.query(`update food.recipes set photo_file_id = $2, photo_thumb_file_id = $3 where id = $1`, [curry, big, thumb]);
  // Un menú compartido de nuevo y validado (las pruebas anteriores lo cerraron).
  await app.t.db.query(`update food.menus set status = 'validado', organizer_shared = true where id = $1`, [menu]);
  const org = await member('organizers', { reservation_id: reservation });
  const outsider = await member('organizers', { reservation_id: other });
  const guest = uuid();
  const guestUser = await member('guests', { reservation_id: reservation, guest_id: guest });
  const open = (portal: string, actor: string, id: string) => app.t.rpc('core_portal_file_get', { p_portal: portal, p_actor: actor, p_file: id }) as Promise<any>;

  const out = await read('organizers', org, 'food.portal_menu', { reservation_id: reservation });
  const curryDish = out.services[0].dishes.find((d: any) => d.name === 'Curry de verduras');
  assert.equal(curryDish.photo_thumb_file_id, thumb);
  assert.ok(!JSON.stringify(out).includes(big), 'la foto grande no sale');
  assert.equal((await open('organizers', org, thumb)).id, thumb);
  assert.equal((await open('guests', guestUser, thumb)).id, thumb);
  for (const [portal, actor, id] of [['organizers', org, big], ['organizers', org, loose], ['organizers', outsider, thumb]] as const) {
    await assert.rejects(open(portal, actor, id), (e: any) => e.code === 'FILE_NOT_FOUND', `${portal} ${id}`);
  }
  // Guests solo con el menú confirmado; el organizador ve también la propuesta. Sin compartir, nadie.
  await app.t.db.query(`update food.menus set status = 'revisar' where id = $1`, [menu]);
  await assert.rejects(open('guests', guestUser, thumb), (e: any) => e.code === 'FILE_NOT_FOUND');
  assert.equal((await open('organizers', org, thumb)).id, thumb);
  await app.t.db.query(`update food.menus set organizer_shared = false where id = $1`, [menu]);
  await assert.rejects(open('organizers', org, thumb), (e: any) => e.code === 'FILE_NOT_FOUND');
});

test('las lecturas de portal están registradas para cada portal, y el comentario como acción', async () => {
  const { rows } = await app.t.db.query<{ app: string; name: string; kind: string }>(`select app, name, kind from core.allowed_reads where name like 'food.portal_%' order by app, name`);
  assert.deepEqual(rows.map((r) => `${r.app}:${r.name}:${r.kind}`), [
    'guests:food.portal_menu:function', 'organizers:food.portal_menu:function', 'organizers:food.portal_menu_comment:action', 'organizers:food.portal_my_menu_comments:function']);
  const files = await app.t.db.query<{ portal: string; procedure: string }>(`select portal, procedure from core.portal_file_resolvers where procedure like 'food.%' order by portal`);
  assert.deepEqual(files.rows.map((r) => `${r.portal}:${r.procedure}`), ['guests:food.portal_dish_photo', 'organizers:food.portal_dish_photo']);
});
