/** Recursos · módulo del núcleo y espacios (RECURSOS.md §3, §4 y §11.1): pertenencia derivada, rutas montadas y reglas del árbol. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const ORIGIN = 'https://tasks.ikisai.com';
const SPACES = 'resources.spaces';
const KINDS = 'resources.space_kinds';
const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
const commit = (operations: unknown[], token?: string) =>
  app.call('/api/v1/resources/commands', { token, body: { requestId: `res-${++seq}`, operations } });
const altura = async (n: number) =>
  (await app.t.db.query<{ id: string }>(`select id from resources.spaces where name = $1`, [`Altura ${n}`])).rows[0]!.id;
const row = async (id: string) => (await app.t.db.query<any>(`select * from resources.spaces where id = $1`, [id])).rows[0];

test.before(async () => {
  app = await createTestApp({
    app: 'tasks', slug: 'tasks-api', origin: ORIGIN,
    createHandler: (config) => createApp({ ...config, app: 'tasks', slug: 'tasks-api' }),
  });
});
test.after(async () => { await app.close(); });

test('módulo · la pertenencia se deriva de las apps de origen, con el rol más alto, y no se da a mano', async () => {
  const roles = (await app.t.db.query<{ user_id: string; role: string }>(`select user_id, role from core.memberships where app = 'resources'`)).rows;
  const byUser = new Map(roles.map((r) => [r.user_id, r.role]));
  assert.equal(byUser.get(app.users.owner), 'owner');
  assert.equal(byUser.get(app.users.editor), 'editor');
  assert.equal(byUser.get(app.users.reader), 'reader');

  // Lector en Tasks y editor en Food → editor en Recursos; sin ninguna app de origen, fuera.
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('tasks', $1, 'reader')`, [user]);
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('food', $1, 'editor')`, [user]);
  const role = async () => (await app.t.db.query<{ role: string }>(`select role from core.memberships where app = 'resources' and user_id = $1`, [user])).rows[0]?.role;
  assert.equal(await role(), 'editor');
  await app.t.db.query(`delete from core.memberships where app = 'food' and user_id = $1`, [user]);
  assert.equal(await role(), 'reader');
  await app.t.db.query(`delete from core.memberships where app = 'tasks' and user_id = $1`, [user]);
  assert.equal(await role(), undefined);

  // Un agente, como mucho editor.
  const agent = await app.t.createUser();
  await app.t.db.query(`insert into core.profiles (user_id, display_name, kind) values ($1, 'Agente', 'agent')`, [agent]);
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('central', $1, 'owner')`, [agent]);
  assert.equal((await app.t.db.query<{ role: string }>(`select role from core.memberships where app = 'resources' and user_id = $1`, [agent])).rows[0]?.role, 'editor');

  await assert.rejects(app.t.db.query(`insert into core.memberships (app, user_id, role) values ('resources', $1, 'owner')`, [user]), /MODULE_MEMBERSHIP_DERIVED/);
  // Ni el lanzador ni la administración de cuentas lo enseñan.
  const apps = await app.call('/api/v1/apps');
  assert.equal(apps.status, 200);
  assert.ok(!apps.data.items.some((a: any) => a.id === 'resources'));
});

test('rutas · /api/v1/resources sirve bootstrap y snapshot del módulo; sin pertenencia, 403', async () => {
  const boot = await app.call('/api/v1/resources/bootstrap', { token: app.tokens.reader });
  assert.equal(boot.status, 200, JSON.stringify(boot.data));
  assert.equal(boot.data.app, 'resources');
  assert.equal(boot.data.membership.role, 'reader');
  const snap = await app.call(`/api/v1/resources/snapshot?tables=${SPACES},${KINDS}`, { token: app.tokens.reader });
  assert.equal(snap.status, 200);
  const spaces = snap.data.tables.find((t: any) => t.table === SPACES).rows;
  assert.deepEqual(spaces.map((r: any) => r.name).sort(), ['Altura 1', 'Altura 2', 'Altura 3', 'Altura 4', 'Altura 5']);
  assert.equal(spaces.find((r: any) => r.name === 'Altura 3').notes, 'Albergue');
  const kinds = snap.data.tables.find((t: any) => t.table === KINDS).rows;
  assert.equal(kinds.length, 15);
  // La app sigue respondiendo como siempre en sus propias rutas.
  assert.equal((await app.call('/api/v1/bootstrap')).data.app, 'tasks');

  const stranger = await app.t.createUser();
  const denied = await app.call('/api/v1/resources/bootstrap', { token: app.supabase.tokenFor(stranger) });
  assert.equal(denied.status, 403);
  assert.equal((await app.call('/api/v1/resources/members')).status, 404);
});

test('espacios · el owner crea el árbol; tipos, padres, profundidad y alturas se validan', async () => {
  const a3 = await altura(3);
  const albergue = uuid(); const hab = uuid(); const cama = uuid(); const despensa = uuid(); const estante = uuid();
  const ok = await commit([
    { op: 'insert', table: SPACES, id: albergue, fields: { parent_id: a3, kind: 'edificio', name: 'Albergue' } },
    { op: 'insert', table: SPACES, id: hab, fields: { parent_id: albergue, kind: 'habitacion', name: 'Hab 3', attributes: { bookable: true, capacity: 4, en_suite: false } } },
    { op: 'insert', table: SPACES, id: cama, fields: { parent_id: hab, kind: 'cama', name: 'Cama 1', attributes: { bed_kind: 'litera', capacity: 2 } } },
    { op: 'insert', table: SPACES, id: despensa, fields: { parent_id: albergue, kind: 'almacen', name: 'Despensa', attributes: { storage: 'ambiente' } } },
    { op: 'insert', table: SPACES, id: estante, fields: { parent_id: despensa, kind: 'ubicacion', name: 'Estante 1' } },
  ]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));

  const fails = async (op: unknown, code: string) => {
    const res = await commit([op]);
    assert.equal(res.data?.error?.code, code, JSON.stringify(res.data));
  };
  // Una cama solo en una habitación; una habitación no cuelga de la raíz; una altura no cuelga de nada.
  await fails({ op: 'insert', table: SPACES, id: uuid(), fields: { parent_id: despensa, kind: 'cama', name: 'Cama X' } }, 'INVALID_SPACE_PARENT');
  await fails({ op: 'insert', table: SPACES, id: uuid(), fields: { kind: 'habitacion', name: 'Hab suelta' } }, 'INVALID_SPACE_PARENT');
  await fails({ op: 'insert', table: SPACES, id: uuid(), fields: { parent_id: albergue, kind: 'altura', name: 'Altura 4' } }, 'INVALID_SPACE_PARENT');
  await fails({ op: 'insert', table: SPACES, id: uuid(), fields: { kind: 'altura', name: 'Altura 6' } }, 'INVALID_SPACE_NAME');
  await fails({ op: 'insert', table: SPACES, id: uuid(), fields: { parent_id: albergue, kind: 'garaje', name: 'Garaje' } }, 'INVALID_SPACE_KIND');
  // Datos propios: solo los del tipo y con su forma.
  await fails({ op: 'insert', table: SPACES, id: uuid(), fields: { parent_id: albergue, kind: 'sala', name: 'Sala', attributes: { bed_kind: 'doble' } } }, 'INVALID_SPACE_ATTRIBUTE');
  await fails({ op: 'insert', table: SPACES, id: uuid(), fields: { parent_id: albergue, kind: 'sala', name: 'Sala', attributes: { capacity: -1 } } }, 'INVALID_SPACE_ATTRIBUTE');
  // Mismo nombre entre hermanos.
  await fails({ op: 'insert', table: SPACES, id: uuid(), fields: { parent_id: albergue, kind: 'sala', name: 'hab 3' } }, 'CONSTRAINT_VIOLATION');
  // Durante la migración, un edificio puede estar sin altura (grupo «Sin altura»).
  const loose = await commit([{ op: 'insert', table: SPACES, id: uuid(), fields: { kind: 'exterior', name: 'Huerto' } }]);
  assert.equal(loose.status, 200, JSON.stringify(loose.data));
  // Mover a un descendiente propio crea un ciclo.
  const cycle = await commit([{ op: 'update', table: SPACES, id: albergue, expectedRevision: 1, fields: { parent_id: hab } }]);
  assert.ok(['INVALID_SPACE_PARENT'].includes(cycle.data?.error?.code), JSON.stringify(cycle.data));
});

test('espacios · el editor cambia datos y orden; crear, mover y archivar es del owner; archivar va con lo de dentro', async () => {
  const a2 = await altura(2);
  const a3 = await altura(3);
  const salas = uuid(); const roble = uuid();
  assert.equal((await commit([
    { op: 'insert', table: SPACES, id: salas, fields: { parent_id: a2, kind: 'edificio', name: 'Salas' } },
    { op: 'insert', table: SPACES, id: roble, fields: { parent_id: salas, kind: 'sala', name: 'Sala Roble', attributes: { capacity: 30 } } },
  ])).status, 200);

  const edit = await commit([{ op: 'update', table: SPACES, id: roble, expectedRevision: 1, fields: { notes: 'Con proyector', public_name: 'Roble', position: 3, attributes: { capacity: 28, bookable: true } } }], app.tokens.editor);
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  assert.equal((await row(roble)).public_name, 'Roble');

  const forbidden = async (op: unknown) => assert.equal((await commit([op], app.tokens.editor)).data?.error?.code, 'FORBIDDEN');
  await forbidden({ op: 'insert', table: SPACES, id: uuid(), fields: { parent_id: salas, kind: 'sala', name: 'Sala Nueva' } });
  await forbidden({ op: 'update', table: SPACES, id: salas, expectedRevision: 1, fields: { parent_id: a3 } });
  await forbidden({ op: 'update', table: SPACES, id: salas, expectedRevision: 1, fields: { active: false } });
  await forbidden({ op: 'insert', table: KINDS, id: uuid(), fields: { kind: 'garaje', label: 'Garaje', level: 3, parents: ['edificio'] } });
  assert.equal((await commit([{ op: 'update', table: SPACES, id: roble, expectedRevision: 2, fields: { name: 'Sala R' } }], app.tokens.reader)).status, 403);

  // Archivar el edificio sin su sala deja algo activo dentro de algo archivado.
  const lone = await commit([{ op: 'update', table: SPACES, id: salas, expectedRevision: 1, fields: { active: false } }]);
  assert.equal(lone.data?.error?.code, 'ORPHAN_CHILD');
  const both = await commit([
    { op: 'update', table: SPACES, id: salas, expectedRevision: 1, fields: { active: false } },
    { op: 'update', table: SPACES, id: roble, expectedRevision: 2, fields: { active: false } },
  ]);
  assert.equal(both.status, 200, JSON.stringify(both.data));
  // Borrar con hijos vivos tampoco.
  const del = await commit([{ op: 'delete', table: SPACES, id: salas, expectedRevision: 2 }]);
  assert.equal(del.data?.error?.code, 'ORPHAN_CHILD');

  // Tipos ampliables: el owner añade uno nuevo y ya se puede usar.
  const garaje = await commit([
    { op: 'insert', table: KINDS, id: uuid(), fields: { kind: 'garaje', label: 'Garaje', level: 3, parents: ['edificio', 'exterior'], attribute_keys: ['capacity'] } },
    { op: 'insert', table: SPACES, id: uuid(), fields: { parent_id: (await app.t.db.query<{ id: string }>(`select id from resources.spaces where name = 'Albergue'`)).rows[0]!.id, kind: 'garaje', name: 'Garaje', attributes: { capacity: 2 } } },
  ]);
  assert.equal(garaje.status, 200, JSON.stringify(garaje.data));
});

test('camas · plazas fijas y supletorias, sofá cama en una sala; solo el owner las crea', async () => {
  const a1 = await altura(1);
  const salas = uuid(); const multiusos = uuid(); const hab = uuid();
  const ok = await commit([
    { op: 'insert', table: SPACES, id: salas, fields: { parent_id: a1, kind: 'edificio', name: 'Salas camas' } },
    { op: 'insert', table: SPACES, id: multiusos, fields: { parent_id: salas, kind: 'sala', name: 'Multiusos' } },
    { op: 'insert', table: SPACES, id: uuid(), fields: { parent_id: multiusos, kind: 'cama', name: 'Sofá 1', attributes: { bed_kind: 'sofa_cama', capacity: 0, extra_capacity: 1 } } },
    { op: 'insert', table: SPACES, id: hab, fields: { parent_id: salas, kind: 'habitacion', name: 'Hab 4' } },
    { op: 'insert', table: SPACES, id: uuid(), fields: { parent_id: hab, kind: 'cama', name: 'Litera 1', attributes: { bed_kind: 'litera', capacity: 1, extra_capacity: 1 } } },
  ]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const bad = await commit([{ op: 'insert', table: SPACES, id: uuid(), fields: { parent_id: hab, kind: 'cama', name: 'Litera X', attributes: { extra_capacity: -1 } } }]);
  assert.equal(bad.data?.error?.code, 'INVALID_SPACE_ATTRIBUTE');
  const editor = await commit([{ op: 'insert', table: SPACES, id: uuid(), fields: { parent_id: hab, kind: 'cama', name: 'Litera 2' } }], app.tokens.editor);
  assert.equal(editor.data?.error?.code, 'FORBIDDEN');
});
