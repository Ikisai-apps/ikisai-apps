/**
 * Central · fase O4: el nivel de casa da los roles (trigger 1506 sobre el núcleo 0092). Empezó como caracterización (PR 0,
 * #489). Desde el núcleo 0095 (encargo de VG del 26-10) los tres niveles abren todas sus puertas: dirección es propietaria de
 * las internas y entra en los portales con el ámbito «todos»; staff, editor de Tasks, Food y Flow; outsider, outsider de Tasks
 * y Flow y editor de Guests. La fusión conserva el nivel de la ficha de destino. Datos ficticios.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import { MERGE_PEOPLE_PROCEDURE, TABLES, houseDoors, pendingDoors, portalCell } from '../../supabase/functions/_domain/central/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `outsider-${++seq}`, operations } });
const rows = async (sql: string, args: unknown[] = []) => (await app.t.db.query<any>(sql, args)).rows;
const revision = async (id: string) => Number((await rows(`select revision from central.people where id = $1`, [id]))[0].revision);
const update = async (id: string, fields: Record<string, unknown>) => {
  const out = await commit([{ op: 'update', table: TABLES.people, id, expectedRevision: await revision(id), fields }]);
  assert.equal(out.status, 200, JSON.stringify(out.data));
};

test.before(async () => {
  app = await createTestApp({ app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!, createHandler: (c) => createCentralApp({ ...c, origins: [CENTRAL_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });

test('O4 · el nivel de casa da los accesos de cada nivel (0095); nunca rebaja; quitarlo devuelve lo que había', async () => {
  const user = await app.t.createUser();
  // Huésped con su membresía de portal (editor con `scopes`) y lector de Tasks puesto a mano.
  const scopes = { grants: [{ reservation_id: uuid(), guest_id: uuid() }] };
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('tasks', $1, 'reader', null), ('guests', $1, 'editor', $2::jsonb)`, [user, JSON.stringify(scopes)]);
  const access = async () => Object.fromEntries((await rows(`select app, role from core.memberships where user_id = $1 and app in ('guests', 'tasks')`, [user])).map((m) => [m.app, m.role]));
  const grants = async () => (await rows(`select app, role, previous_role from core.house_grants where user_id = $1 and app in ('guests', 'tasks') order by app`, [user])).map((g) => [g.app, g.role, g.previous_role]);
  const guestScopes = async () => (await rows(`select scopes from core.memberships where user_id = $1 and app = 'guests'`, [user]))[0]?.scopes ?? null;
  const houseLevel = async () => (await rows(`select level from core.house_levels where user_id = $1`, [user]))[0]?.level ?? null;
  const manual = { guests: 'editor', tasks: 'reader' };

  const id = uuid();
  const created = await commit([{ op: 'insert', table: TABLES.people, id, fields: { display_name: 'Olga Ficticia', relation: 'otro', user_id: user } }]);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  // Staff: Tasks sube de lector a editor; en Guests ya era huésped y staff no lo toca (sus retiros los pone Booking).
  await update(id, { house_level: 'staff' });
  assert.deepEqual(await access(), { guests: 'editor', tasks: 'editor' });
  assert.deepEqual(await grants(), [['tasks', 'editor', 'reader']]);
  assert.deepEqual(await guestScopes(), scopes);
  assert.equal(await houseLevel(), 'staff');
  // Dirección: Tasks, propietario; en Guests ya era editor, así que solo se le añade el ámbito «todos» a sus retiros.
  await update(id, { house_level: 'direccion' });
  assert.deepEqual(await access(), { guests: 'editor', tasks: 'owner' });
  assert.deepEqual(await grants(), [['tasks', 'owner', 'reader']]);
  assert.deepEqual(await guestScopes(), { grants: [...scopes.grants, { all: true }] });
  assert.equal(await houseLevel(), 'direccion');
  // Sin nivel: vuelve lo de antes, también el ámbito de Guests (sin «todos»).
  await update(id, { house_level: null });
  assert.deepEqual(await access(), manual);
  assert.deepEqual(await grants(), []);
  assert.deepEqual(await guestScopes(), scopes);
  assert.equal(await houseLevel(), null);
  // Outsider: Tasks sube a `outsider`; en Guests ya era editor (igual a lo que da): no se toca, ni sus `scopes`.
  await update(id, { house_level: 'outsider' });
  assert.deepEqual(await access(), { guests: 'editor', tasks: 'outsider' });
  assert.deepEqual(await grants(), [['tasks', 'outsider', 'reader']]);
  assert.deepEqual((await rows(`select scopes from core.memberships where user_id = $1 and app = 'guests'`, [user]))[0].scopes, scopes);
  assert.equal(await houseLevel(), 'outsider');
  // Desenlazar devuelve lo de antes; enlazar lo vuelve a dar. Igual al desactivar y reactivar.
  await update(id, { user_id: null });
  assert.deepEqual(await access(), manual);
  assert.equal(await houseLevel(), null);
  await update(id, { user_id: user });
  assert.deepEqual(await access(), { guests: 'editor', tasks: 'outsider' });
  await update(id, { active: false });
  assert.deepEqual(await access(), manual);
  await update(id, { active: true });
  assert.deepEqual(await access(), { guests: 'editor', tasks: 'outsider' });
  // Papelera: devuelve lo de antes, y la ficha conserva el nivel.
  const del = await commit([{ op: 'delete', table: TABLES.people, id, expectedRevision: await revision(id) }]);
  assert.equal(del.status, 200, JSON.stringify(del.data));
  assert.deepEqual(await access(), manual);
  assert.equal((await rows(`select house_level from central.people where id = $1`, [id]))[0].house_level, 'outsider');
});

test('O4 · sin acceso previo, el nivel crea la membresía y al quitarlo la borra; un cambio a mano posterior se respeta', async () => {
  const user = await app.t.createUser();
  const tasks = async () => (await rows(`select role from core.memberships where user_id = $1 and app = 'tasks'`, [user]))[0]?.role ?? null;
  const guests = async () => (await rows(`select role from core.memberships where user_id = $1 and app = 'guests'`, [user]))[0]?.role ?? null;
  const id = uuid();
  assert.equal((await commit([{ op: 'insert', table: TABLES.people, id, fields: { display_name: 'Pepa Ficticia', relation: 'colaborador', house_level: 'outsider', user_id: user } }])).status, 200);
  assert.deepEqual([await tasks(), await guests()], ['outsider', 'editor']);
  // Staff: editor de Tasks; el huésped de Guests que daba el nivel outsider se retira (a staff se lo pone Booking).
  await update(id, { house_level: 'staff' });
  assert.deepEqual([await tasks(), await guests()], ['editor', null]);
  await update(id, { house_level: 'outsider' });
  // Dirección le da Tasks · Editor a mano después: al quitar el nivel se respeta.
  await app.t.db.query(`update core.memberships set role = 'editor' where user_id = $1 and app = 'tasks'`, [user]);
  await update(id, { house_level: null });
  assert.deepEqual([await tasks(), await guests()], ['editor', null]);
});

test('O4 · lectura de lo que ha dado el nivel: solo dirección', async () => {
  const user = await app.t.createUser();
  assert.equal((await commit([{ op: 'insert', table: TABLES.people, id: uuid(), fields: { display_name: 'Quique Ficticio', relation: 'colaborador', house_level: 'outsider', user_id: user } }])).status, 200);
  const out = await app.call('/api/v1/people/house-grants', { method: 'GET' });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.ok(Array.isArray(out.data.items));
  for (const g of out.data.items) assert.deepEqual(Object.keys(g).sort(), ['app', 'level', 'previousRole', 'role', 'userId']);
  assert.deepEqual(out.data.items.filter((g: any) => g.userId === user).map((g: any) => [g.app, g.role, g.previousRole]), [['flow', 'outsider', null], ['guests', 'editor', null], ['tasks', 'outsider', null]]);
  const denied = await app.call('/api/v1/people/house-grants', { method: 'GET', token: app.tokens.editor });
  assert.equal(denied.status, 403);
});

test('O4 · fusión: se queda el nivel de la ficha de destino (también para los accesos); las capacidades pasan y se leen según ese nivel', async () => {
  const trade = uuid();
  const account = await app.t.createUser();
  const [outsider, noLevel, staff, outsider2] = [uuid(), uuid(), uuid(), uuid()];
  const person = (id: string, name: string, house_level: string | null) => ({ op: 'insert', table: TABLES.people, id, fields: { display_name: name, relation: 'otro', house_level } });
  const setup = await commit([
    { op: 'insert', table: TABLES.trades, id: trade, fields: { name: 'Jardinería Caracterización' } },
    { ...person(outsider, 'Pablo Ficticio', 'outsider'), fields: { display_name: 'Pablo Ficticio', relation: 'otro', house_level: 'outsider', user_id: account } }, person(noLevel, 'Pablo F.', null),
    person(staff, 'Rita Ficticia', 'staff'), person(outsider2, 'Rita F.', 'outsider'),
    { op: 'insert', table: TABLES.personTrades, id: uuid(), fields: { person_id: outsider, trade_id: trade, level: 2 } },
    { op: 'insert', table: TABLES.personTrades, id: uuid(), fields: { person_id: staff, trade_id: trade, level: 1 } },
  ]);
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  const merge = async (from: string, into: string) => {
    const out = await commit([{ op: 'call', procedure: MERGE_PEOPLE_PROCEDURE, args: { from, into } }]);
    assert.equal(out.status, 200, JSON.stringify(out.data));
  };
  const level = async (id: string) => (await rows(`select house_level from central.people where id = $1`, [id]))[0].house_level;
  const capable = async () => (await rows(`select person_id, level from central.capability_options where trade_id = $1 order by person_id`, [trade])).map((r) => [r.person_id, r.level]);
  assert.deepEqual(await capable(), [[outsider, 2], [staff, 1]].sort());

  // El outsider se fusiona en una ficha sin nivel: la que queda sigue sin nivel, y su capacidad deja de leerse.
  const tasksRole = async () => (await rows(`select role from core.memberships where user_id = $1 and app = 'tasks'`, [account]))[0]?.role ?? null;
  assert.equal(await tasksRole(), 'outsider');
  await merge(outsider, noLevel);
  assert.equal(await level(noLevel), null);
  // La cuenta pasa a la ficha que queda, sin nivel: pierde lo que le daba el nivel.
  assert.equal((await rows(`select user_id from central.people where id = $1`, [noLevel]))[0].user_id, account);
  assert.equal(await tasksRole(), null);
  assert.equal((await rows(`select 1 from central.person_trades where deleted_at is null and person_id = $1 and trade_id = $2`, [noLevel, trade])).length, 1);
  // Una ficha outsider se fusiona en una de staff: queda staff.
  await merge(outsider2, staff);
  assert.equal(await level(staff), 'staff');
  assert.deepEqual(await capable(), [[staff, 1]]);
});

test('«Aplicar accesos» (1515): el núcleo aplica el nivel de la ficha, solo el owner y solo con cuenta', async () => {
  const user = await app.t.createUser();
  const id = uuid();
  const created = await commit([{ op: 'insert', table: TABLES.people, id, fields: { display_name: 'Pía Ficticia', relation: 'colaborador', house_level: 'outsider', user_id: user } }]);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const access = async () => (await rows(`select app, role from core.memberships where user_id = $1 and app in ('guests', 'tasks') order by app`, [user])).map((m) => `${m.app}:${m.role}`);
  assert.deepEqual(await access(), ['guests:editor', 'tasks:outsider']);
  // Falta una puerta (se perdió el acceso a Tasks y lo que lo apuntaba): «Aplicar accesos» la vuelve a abrir.
  await app.t.db.query(`delete from core.memberships where user_id = $1 and app = 'tasks'`, [user]);
  await app.t.db.query(`delete from core.house_grants where user_id = $1 and app = 'tasks'`, [user]);
  const apply = (body: unknown, token?: string) => app.call('/api/v1/invoke/central.apply_house_level', { body, ...(token ? { token } : {}) });
  const out = await apply({ personId: id });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.equal(out.data.level, 'outsider');
  assert.equal(out.data.userId, user);
  assert.deepEqual(out.data.changes, [{ app: 'tasks', from: null, to: 'outsider' }]);
  assert.deepEqual(await access(), ['guests:editor', 'tasks:outsider']);
  // Idempotente: otra vez no cambia nada.
  assert.deepEqual((await apply({ personId: id })).data.changes, []);
  // Solo el owner de Central; el lector, ni invocar.
  assert.equal((await apply({ personId: id }, app.tokens.editor)).status, 403);
  assert.equal((await apply({ personId: id }, app.tokens.reader)).status, 403);
  // Sin cuenta, lo dice; una ficha que no existe o un id raro, 404.
  const bare = uuid();
  assert.equal((await commit([{ op: 'insert', table: TABLES.people, id: bare, fields: { display_name: 'Sin Cuenta Ficticia', relation: 'colaborador', house_level: 'staff' } }])).status, 200);
  const none = await apply({ personId: bare });
  assert.equal(none.status, 422); assert.equal(none.data.error.code, 'NO_ACCOUNT');
  assert.equal((await apply({ personId: uuid() })).status, 404);
  assert.equal((await apply({ personId: 'x' })).status, 404);
  // Una ficha inactiva no tiene nivel vigente: aplicar la trata como sin nivel (lo que dio ya se retiró al desactivarla).
  await update(id, { active: false });
  const off = await apply({ personId: id });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal(off.data.level, null);
});

test('dominio · puertas del nivel: lo que pide cada nivel, concedido o pendiente, nunca a la baja', () => {
  const catalog = [
    { id: 'central', kind: 'internal' }, { id: 'tasks', kind: 'internal' }, { id: 'flow', kind: 'internal' },
    { id: 'organizers', kind: 'portal' }, { id: 'guests', kind: 'portal' },
  ];
  assert.deepEqual(houseDoors(null, catalog, [], []), []);
  // Dirección: propietario en las internas y todos los retiros en los dos portales.
  const dir = houseDoors('direccion', catalog, [{ app: 'tasks', role: 'owner' }, { app: 'central', role: 'editor' }, { app: 'guests', role: 'editor' }], [{ app: 'guests', role: 'editor' }]);
  assert.deepEqual(dir.map((d) => [d.app, d.kind, d.status]), [
    ['central', 'internal', 'pendiente'], ['tasks', 'internal', 'concedido'], ['flow', 'internal', 'pendiente'],
    ['organizers', 'portal', 'pendiente'], ['guests', 'portal', 'concedido'],
  ]);
  assert.deepEqual(dir.find((d) => d.app === 'organizers')!.want, { portal: 'todos' });
  assert.equal(dir.find((d) => d.app === 'tasks')!.derived, false, 'puesto a mano');
  // «Todos los retiros» solo cuenta si lo dio el nivel: una membresía de huésped no basta.
  assert.equal(houseDoors('direccion', catalog, [{ app: 'guests', role: 'editor' }], []).find((d) => d.app === 'guests')!.status, 'pendiente');
  // Staff: editor (un propietario a mano también vale) y huésped en Guests; Organizers no es suyo.
  const staff = houseDoors('staff', catalog, [{ app: 'central', role: 'owner' }, { app: 'tasks', role: 'reader' }], []);
  assert.deepEqual(staff.map((d) => [d.app, d.status]), [['central', 'concedido'], ['tasks', 'pendiente'], ['flow', 'pendiente'], ['guests', 'pendiente']]);
  assert.deepEqual(staff.find((d) => d.app === 'guests')!.want, { portal: 'huesped' });
  // Outsider: el lector sube a outsider; con huésped ya dado, Guests concedido.
  const out = houseDoors('outsider', catalog, [{ app: 'tasks', role: 'reader' }, { app: 'guests', role: 'editor' }], [{ app: 'guests', role: 'editor' }]);
  assert.deepEqual(pendingDoors(out).map((d) => d.app), ['central', 'tasks', 'flow']);
  assert.equal(out.find((d) => d.app === 'guests')!.derived, true);
  // Casilla del portal en Accesos.
  assert.equal(portalCell('guests', null, null), null);
  assert.equal(portalCell('guests', { role: 'editor' }, null), 'huesped');
  assert.equal(portalCell('organizers', { role: 'editor' }, null), 'organiza');
  assert.equal(portalCell('organizers', { role: 'editor' }, { level: 'direccion' }), 'todos');
  assert.equal(portalCell('guests', { role: 'editor' }, { level: 'outsider' }), 'huesped');
});
