/**
 * Recursos · finca y decoración sobre el plano (migración 0814, encargo de VG del 27-10-2026): el plano de la finca y las
 * cotas de las alturas, los iconos, la decoración general por celdas, la capa de un evento (solo desde Booking) y las
 * lecturas para los portales y para Central y Booking.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const ORIGIN = 'https://tasks.ikisai.com';
const SPACES = 'resources.spaces';
const PLANS = 'resources.floor_plans';
const ICONS = 'resources.decor_icons';
const DECOR = 'resources.decor_items';
const IMAGES = 'resources.space_images';
const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
const commit = (operations: unknown[], token?: string) =>
  app.call('/api/v1/resources/commands', { token, body: { requestId: `de-${++seq}`, operations } });
const ok = (res: { status: number; data: any }) => assert.equal(res.status, 200, JSON.stringify(res.data));
const fails = (res: { status: number; data: any }, code?: string) => {
  assert.ok(res.status >= 400, `esperaba un error: ${JSON.stringify(res.data)}`);
  if (code) assert.equal(res.data?.error?.code, code, JSON.stringify(res.data));
};
const rev = async (table: string, id: string) =>
  Number((await app.t.db.query<{ revision: string }>(`select revision from ${table} where id = $1`, [id])).rows[0]!.revision);
const altura = async (n: number) =>
  (await app.t.db.query<{ id: string }>(`select id from resources.spaces where name = $1 and kind = 'altura'`, [`Altura ${n}`])).rows[0]!.id;
/** Un archivo ya subido y verificado del módulo (lo que deja la subida de Recursos). */
async function file(mime: string, size: number): Promise<string> {
  const id = uuid();
  await app.t.db.query(`insert into core.files (id, app, bucket, path, filename, mime, size, sha256, status, hash_verified)
    values ($1, 'resources', 'resources-plans', $2, 'icono', $3, $4, $5, 'verified', true)`, [id, `resources/${id}`, mime, size, 'b'.repeat(64)]);
  return id;
}

let building: string; let plan: string; let estate: string; let finca: string; let icon: string; let piece: string;

test.before(async () => {
  app = await createTestApp({
    app: 'tasks', slug: 'tasks-api', origin: ORIGIN,
    createHandler: (config) => createApp({ ...config, app: 'tasks', slug: 'tasks-api' }),
  });
});
test.after(async () => { await app.close(); });

test('finca · un plano estate cuelga de un exterior raíz, lleva edificios y curvas de alturas con su cota', async () => {
  building = uuid(); finca = uuid(); estate = uuid(); plan = uuid();
  ok(await commit([
    { op: 'insert', table: SPACES, id: building, fields: { parent_id: await altura(3), kind: 'edificio', name: 'Albergue de la finca' } },
    { op: 'insert', table: SPACES, id: finca, fields: { kind: 'exterior', name: 'Finca' } },
  ], app.tokens.owner));
  // Un plano de finca solo cuelga de un exterior raíz.
  fails(await commit([{ op: 'insert', table: PLANS, id: uuid(), fields: { building_id: building, kind: 'estate', width: 1000, height: 1000 } }], app.tokens.owner));
  ok(await commit([{ op: 'insert', table: PLANS, id: estate, fields: {
    building_id: finca, kind: 'estate', width: 1000, height: 1000, grid: { metersPerUnit: 0.5, originX: 0, originY: 0 },
    bands: [{ name: 'Altura 3', y0: 0.2, y1: 0.4 }], contours: [{ spaceId: await altura(3), x: 0.5, y: 0.3 }],
  } }], app.tokens.owner));
  // La finca no tiene también un plano de edificio.
  fails(await commit([{ op: 'insert', table: PLANS, id: uuid(), fields: { building_id: finca, floor: 'Otra', width: 10, height: 10 } }], app.tokens.owner));
  // Curvas solo de alturas; retícula y franjas bien formadas.
  fails(await commit([{ op: 'update', table: PLANS, id: estate, expectedRevision: await rev(PLANS, estate), fields: { contours: [{ spaceId: building, x: 0.1, y: 0.1 }] } }], app.tokens.owner));
  fails(await commit([{ op: 'update', table: PLANS, id: estate, expectedRevision: await rev(PLANS, estate), fields: { grid: { metersPerUnit: 0 } } }], app.tokens.owner));
  fails(await commit([{ op: 'update', table: PLANS, id: estate, expectedRevision: await rev(PLANS, estate), fields: { bands: [{ name: 'X', y0: 0.5, y1: 0.4 }] } }], app.tokens.owner));

  // En la finca se colocan edificios, no estancias.
  const shape = { points: [[0.1, 0.1], [0.3, 0.1], [0.3, 0.2]] };
  ok(await commit([{ op: 'update', table: SPACES, id: building, expectedRevision: await rev(SPACES, building), fields: { plan_id: estate, plan_shape: shape } }], app.tokens.owner));
  const room = uuid();
  ok(await commit([{ op: 'insert', table: SPACES, id: room, fields: { parent_id: building, kind: 'sala', name: 'Sala de la finca' } }], app.tokens.owner));
  fails(await commit([{ op: 'update', table: SPACES, id: room, expectedRevision: await rev(SPACES, room), fields: { plan_id: estate, plan_shape: shape } }], app.tokens.owner));

  // Cota de la altura: un número, que también edita el editor.
  const a3 = await altura(3);
  ok(await commit([{ op: 'update', table: SPACES, id: a3, expectedRevision: await rev(SPACES, a3), fields: { attributes: { elevation_m: 412.5 } } }], app.tokens.editor));
  fails(await commit([{ op: 'update', table: SPACES, id: a3, expectedRevision: await rev(SPACES, a3), fields: { attributes: { elevation_m: 'alto' } } }], app.tokens.owner), 'INVALID_SPACE_ATTRIBUTE');

  // Un plano de edificio con retícula, para decorar.
  ok(await commit([{ op: 'insert', table: PLANS, id: plan, fields: { building_id: building, floor: 'Planta baja', width: 200, height: 100, grid: { metersPerUnit: 0.1 } } }], app.tokens.owner));
});

test('decoración · iconos del owner (SVG, PNG o GIF de hasta 1 MB) y piezas generales dentro del dibujo', async () => {
  icon = uuid();
  fails(await commit([{ op: 'insert', table: ICONS, id: uuid(), fields: { name: 'Planta', category: 'Plantas', file_id: await file('image/svg+xml', 2000) } }], app.tokens.editor));
  fails(await commit([{ op: 'insert', table: ICONS, id: uuid(), fields: { name: 'Pesado', category: 'Plantas', file_id: await file('image/gif', 2_000_000) } }], app.tokens.owner));
  fails(await commit([{ op: 'insert', table: ICONS, id: uuid(), fields: { name: 'PDF', category: 'Plantas', file_id: await file('application/pdf', 2000) } }], app.tokens.owner));
  ok(await commit([{ op: 'insert', table: ICONS, id: icon, fields: { name: 'Planta', category: 'Plantas', file_id: await file('image/gif', 500_000), default_size: 4 } }], app.tokens.owner));
  const author = (await app.t.db.query<{ created_by: string }>('select created_by from resources.decor_icons where id = $1', [icon])).rows[0]!.created_by;
  assert.equal(author, app.users.owner);

  // El dibujo mide 200 × 0,1 = 20 m por 10 m: a 1 m por celda, la x llega a 19 con size 1 y a 18 con size 4.
  piece = uuid();
  ok(await commit([{ op: 'insert', table: DECOR, id: piece, fields: { plan_id: plan, icon_id: icon, cell_x: 18, cell_y: 8, scale: 1, size: 4, rotation: 90 } }], app.tokens.owner));
  fails(await commit([{ op: 'insert', table: DECOR, id: uuid(), fields: { plan_id: plan, icon_id: icon, cell_x: 19, cell_y: 0, scale: 1, size: 4 } }], app.tokens.owner));
  fails(await commit([{ op: 'insert', table: DECOR, id: uuid(), fields: { plan_id: plan, icon_id: icon, cell_x: 0, cell_y: 0, rotation: 45 } }], app.tokens.owner));
  // La general es del owner; un editor no decora.
  fails(await commit([{ op: 'insert', table: DECOR, id: uuid(), fields: { plan_id: plan, icon_id: icon, cell_x: 0, cell_y: 0 } }], app.tokens.editor), 'FORBIDDEN');
  // La capa de evento no se escribe por commands; y no se quita la retícula de un dibujo decorado.
  fails(await commit([{ op: 'insert', table: DECOR, id: uuid(), fields: { plan_id: plan, icon_id: icon, cell_x: 0, cell_y: 0, layer: 'event', event_id: uuid(), op: 'add' } }], app.tokens.owner), 'FORBIDDEN');
  fails(await commit([{ op: 'update', table: PLANS, id: plan, expectedRevision: await rev(PLANS, plan), fields: { grid: null } }], app.tokens.owner), 'PLAN_HAS_DECOR');
  // Un icono en uso y un dibujo decorado no se borran; quitar y deshacer sí.
  fails(await commit([{ op: 'delete', table: ICONS, id: icon, expectedRevision: await rev(ICONS, icon) }], app.tokens.owner), 'ICON_IN_USE');
  fails(await commit([{ op: 'delete', table: PLANS, id: plan, expectedRevision: await rev(PLANS, plan) }], app.tokens.owner));
  ok(await commit([{ op: 'delete', table: DECOR, id: piece, expectedRevision: await rev(DECOR, piece) }], app.tokens.owner));
  ok(await commit([{ op: 'restore', table: DECOR, id: piece, expectedRevision: await rev(DECOR, piece) }], app.tokens.owner));
});

test('decoración · la capa de un evento solo con set_event_decor, desde Booking, sobre piezas generales del mismo dibujo', async () => {
  const event = uuid();
  const call = (args: unknown, token: string) => commit([{ op: 'call', procedure: 'resources.set_event_decor', args }], token);
  // Sin ser de Booking, no.
  fails(await call({ event_id: event, put: [{ plan_id: plan, op: 'remove', replaces_item_id: piece, cell_x: 18, cell_y: 8 }] }, app.tokens.editor), 'FORBIDDEN');
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, 'editor') on conflict do nothing`, [app.users.editor]);

  const swap = uuid();
  const done = await call({ event_id: event, put: [{ id: swap, plan_id: plan, op: 'replace', replaces_item_id: piece, icon_id: icon, cell_x: 10, cell_y: 2, size: 1 }] }, app.tokens.editor);
  ok(done);
  const row = (await app.t.db.query<Record<string, any>>('select layer, event_id, op from resources.decor_items where id = $1', [swap])).rows[0]!;
  assert.deepEqual([row.layer, row.event_id, row.op], ['event', event, 'replace']);
  // Solo piezas generales del mismo dibujo.
  fails(await call({ event_id: event, put: [{ plan_id: plan, op: 'remove', replaces_item_id: swap, cell_x: 0, cell_y: 0 }] }, app.tokens.editor));
  // Lo que cambia un evento no se borra de la general por debajo.
  fails(await commit([{ op: 'delete', table: DECOR, id: piece, expectedRevision: await rev(DECOR, piece) }], app.tokens.owner), 'DECOR_REPLACED');
  // Un lote no cuela otra pieza de evento junto a la llamada.
  fails(await commit([
    { op: 'call', procedure: 'resources.set_event_decor', args: { event_id: event, put: [{ id: swap, plan_id: plan, op: 'replace', replaces_item_id: piece, icon_id: icon, cell_x: 11, cell_y: 2 }] } },
    { op: 'insert', table: DECOR, id: uuid(), fields: { plan_id: plan, icon_id: icon, cell_x: 1, cell_y: 1, layer: 'event', event_id: event, op: 'add' } },
  ], app.tokens.editor), 'FORBIDDEN');
  // Y se quita desde Booking.
  ok(await call({ event_id: event, delete: [swap] }, app.tokens.editor));
});

test('lecturas · el portal ve la finca, la cota, los iconos y solo la general; Central y Booking, también la del evento', async () => {
  const event = uuid();
  ok(await commit([{ op: 'call', procedure: 'resources.set_event_decor', args: { event_id: event, put: [{ plan_id: plan, op: 'remove', replaces_item_id: piece, cell_x: 18, cell_y: 8 }] } }], app.tokens.editor));
  const silueta = uuid();
  ok(await commit([{ op: 'insert', table: IMAGES, id: silueta, fields: { space_id: building, kind: 'silueta', title: 'Albergue desde el camino', file_id: await file('image/png', 300_000) } }], app.tokens.owner));
  fails(await commit([{ op: 'insert', table: IMAGES, id: uuid(), fields: { space_id: building, kind: 'foto', file_id: await file('image/png', 6_000_000) } }], app.tokens.owner));

  const guest = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('guests', $1, 'editor')`, [guest]);
  const out = await app.t.rpc('core_read', { p_app: 'guests', p_actor: guest, p_name: 'resources.portal_plans', p_args: {} }) as any;
  const e = out.plans.find((p: any) => p.id === estate);
  assert.equal(e.kind, 'estate');
  assert.deepEqual(e.grid, { metersPerUnit: 0.5, originX: 0, originY: 0 });
  assert.deepEqual(e.contours, [{ spaceId: await altura(3), label: 'Altura 3', elevationM: 412.5, x: 0.5, y: 0.3 }]);
  assert.ok(out.icons.some((i: any) => i.id === icon && i.defaultSize === 4 && i.file.mime === 'image/gif'));
  assert.ok(out.images.some((m: any) => m.id === silueta && m.kind === 'silueta'));
  assert.deepEqual(out.decor.map((d: any) => [d.id, d.layer]), [[piece, 'general']], 'el portal solo ve la general');

  const inner = await app.t.rpc('core_read', { p_app: 'resources', p_actor: app.users.reader, p_name: 'resources.plans_with_decor', p_args: { event_id: event } }) as any;
  assert.deepEqual(inner.decor.map((d: any) => d.layer).sort(), ['event', 'general']);
  assert.equal(inner.decor.find((d: any) => d.layer === 'event').replacesItemId, piece);
});

test('finca · la curva de cada altura se guarda ajustada a mano (0815): puntos en 0..1, con su ancla', async () => {
  const a3 = await altura(3);
  const points = [[0.05, 0.31], [0.4, 0.29], [0.95, 0.33]];
  ok(await commit([{ op: 'update', table: PLANS, id: estate, expectedRevision: await rev(PLANS, estate), fields: { contours: [{ spaceId: a3, x: 0.5, y: 0.3, points }] } }], app.tokens.owner));
  // Puntos fuera de 0..1 o una curva de un solo punto, no.
  fails(await commit([{ op: 'update', table: PLANS, id: estate, expectedRevision: await rev(PLANS, estate), fields: { contours: [{ spaceId: a3, x: 0.5, y: 0.3, points: [[0.1, 1.2], [0.2, 0.2]] }] } }], app.tokens.owner));
  fails(await commit([{ op: 'update', table: PLANS, id: estate, expectedRevision: await rev(PLANS, estate), fields: { contours: [{ spaceId: a3, x: 0.5, y: 0.3, points: [[0.1, 0.2]] }] } }], app.tokens.owner));

  const guest = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('guests', $1, 'editor')`, [guest]);
  const out = await app.t.rpc('core_read', { p_app: 'guests', p_actor: guest, p_name: 'resources.portal_plans', p_args: {} }) as any;
  const contour = out.plans.find((p: any) => p.id === estate).contours[0];
  assert.deepEqual(contour.points, points);
  assert.deepEqual([contour.x, contour.y, contour.label], [0.5, 0.3, 'Altura 3']);
});

test('portales · cada cama con su tipo y una silueta de cabecera por app (0816)', async () => {
  const room = uuid(); const bed = uuid(); const bare = uuid();
  ok(await commit([
    { op: 'insert', table: SPACES, id: room, fields: { parent_id: building, kind: 'habitacion', name: 'Hab de prueba' } },
    { op: 'insert', table: SPACES, id: bed, fields: { parent_id: room, kind: 'cama', name: 'Cama 1', attributes: { bed_kind: 'litera' } } },
    { op: 'insert', table: SPACES, id: bare, fields: { parent_id: room, kind: 'cama', name: 'Cama 2' } },
  ], app.tokens.owner));

  // La cabecera solo en siluetas, de apps conocidas y una viva por app (se pasa de una a otra en el mismo lote).
  const a = uuid(); const b = uuid();
  fails(await commit([{ op: 'insert', table: IMAGES, id: uuid(), fields: { space_id: building, kind: 'foto', file_id: await file('image/png', 1000), header_for: ['guests'] } }], app.tokens.owner));
  fails(await commit([{ op: 'insert', table: IMAGES, id: uuid(), fields: { space_id: building, kind: 'silueta', file_id: await file('image/png', 1000), header_for: ['finance'] } }], app.tokens.owner));
  fails(await commit([{ op: 'insert', table: IMAGES, id: uuid(), fields: { space_id: building, kind: 'silueta', file_id: await file('image/png', 1000), header_for: ['guests', 'guests'] } }], app.tokens.owner), 'HEADER_TAKEN');
  ok(await commit([{ op: 'insert', table: IMAGES, id: a, fields: { space_id: building, kind: 'silueta', file_id: await file('image/png', 1000), header_for: ['guests', 'central'] } }], app.tokens.owner));
  fails(await commit([{ op: 'insert', table: IMAGES, id: b, fields: { space_id: building, kind: 'silueta', file_id: await file('image/png', 1000), header_for: ['guests'] } }], app.tokens.owner), 'HEADER_TAKEN');
  ok(await commit([
    { op: 'update', table: IMAGES, id: a, expectedRevision: await rev(IMAGES, a), fields: { header_for: ['central'] } },
    { op: 'insert', table: IMAGES, id: b, fields: { space_id: building, kind: 'silueta', file_id: await file('image/png', 1000), header_for: ['guests'] } },
  ], app.tokens.owner));
  fails(await commit([{ op: 'update', table: IMAGES, id: b, expectedRevision: await rev(IMAGES, b), fields: { header_for: [] } }], app.tokens.editor));

  const guest = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('guests', $1, 'editor')`, [guest]);
  const out = await app.t.rpc('core_read', { p_app: 'guests', p_actor: guest, p_name: 'resources.portal_plans', p_args: {} }) as any;
  assert.equal(out.spaces.find((s: any) => s.id === bed).bedKind, 'litera');
  assert.ok(!('bedKind' in out.spaces.find((s: any) => s.id === bare)));
  assert.ok(!('attributes' in out.spaces.find((s: any) => s.id === bed)), 'ningún otro atributo');
  assert.deepEqual(out.images.find((m: any) => m.id === b).headerFor, ['guests']);
  assert.deepEqual(out.images.find((m: any) => m.id === a).headerFor, ['central']);
});
