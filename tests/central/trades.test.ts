/** Central · fase P1: oficios en árbol y capacidades (dominio, base, lecturas para Tasks y fusión). Datos ficticios. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import { MERGE_PEOPLE_PROCEDURE, TABLES, TRADE_LEVEL_LABELS, planTradeImport, validateOperations } from '../../supabase/functions/_domain/central/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
let scoped: string;
const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `trade-${++seq}`, operations } });
const rows = async (sql: string, args: unknown[] = []) => (await app.t.db.query<any>(sql, args)).rows;
const trade = (id: string, name: string, parent_id: string | null = null) => ({ op: 'insert', table: TABLES.trades, id, fields: { name, parent_id } });

test.before(async () => {
  app = await createTestApp({ app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!, createHandler: (c) => createCentralApp({ ...c, origins: [CENTRAL_ORIGINS[0]!] }) });
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('central', $1, 'editor', '{"people": true}'::jsonb)`, [user]);
  scoped = app.supabase.tokenFor(user);
});
test.after(async () => { await app.close(); });

test('oficios · dominio: niveles de la estrella, permisos como los equipos y nivel de 0 a 2', () => {
  assert.deepEqual([...TRADE_LEVEL_LABELS], ['Aprende', 'Sabe', 'Experto']);
  const ins = [trade('a', 'Fontanería')];
  assert.equal(validateOperations(ins, { role: 'owner' }), null);
  assert.equal(validateOperations(ins, { role: 'editor', scopes: { people: true } }), null);
  assert.equal(validateOperations(ins, { role: 'editor' })?.code, 'FORBIDDEN');
  const [p, t] = [uuid(), uuid()];
  const cap = (level: unknown) => [{ op: 'insert', table: TABLES.personTrades, id: uuid(), fields: { person_id: p, trade_id: t, level } }];
  assert.equal(validateOperations(cap(2), { role: 'owner' }), null);
  assert.equal(validateOperations(cap(3), { role: 'owner' })?.details.field, 'level');
  assert.equal(validateOperations(cap(1.5), { role: 'owner' })?.details.field, 'level');
  assert.equal(validateOperations([{ op: 'update', table: TABLES.personTrades, id: uuid(), fields: { trade_id: uuid() } }], { role: 'owner' })?.code, 'IMMUTABLE_FIELD');
});

test('oficios · árbol de hasta tres niveles, sin ciclos ni nombres repetidos entre hermanos; permisos en la base', async () => {
  const fon = uuid(); const acs = uuid(); const sub = uuid(); const elec = uuid();
  assert.equal((await commit([trade(fon, 'Fontanería Prueba')], app.tokens.editor)).status, 403);
  const ok = await commit([trade(fon, 'Fontanería Prueba'), trade(acs, 'ACS', fon), trade(sub, 'Calentador', acs), trade(elec, 'Electricidad Prueba')], scoped);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  // Cuarto nivel, no.
  const deep = await commit([trade(uuid(), 'Demasiado', sub)]);
  assert.equal(deep.status, 422); assert.equal(deep.data.error.code, 'INVALID_TREE');
  // Ciclo, no.
  const [f] = await rows(`select revision from central.trades where id = $1`, [fon]);
  const cycle = await commit([{ op: 'update', table: TABLES.trades, id: fon, expectedRevision: Number(f.revision), fields: { parent_id: sub } }]);
  assert.equal(cycle.status, 422);
  // Nombre repetido entre hermanos, no; en otra rama, sí.
  assert.equal((await commit([trade(uuid(), ' acs ', fon)])).data.error.code, 'CONSTRAINT_VIOLATION');
  assert.equal((await commit([trade(uuid(), 'ACS', elec)])).status, 200);
  // Ruta legible.
  assert.equal((await rows(`select central.trade_path($1) as p`, [sub]))[0].p, 'Fontanería Prueba › ACS › Calentador');
  // Un editor sin ámbito tampoco por SQL directo.
  const editor = (await rows(`select user_id from core.memberships where app = 'central' and role = 'editor' and scopes is null limit 1`))[0].user_id;
  await assert.rejects(app.t.rpc('core_commit', { p_app: 'central', p_actor: editor, p_request_id: 'sql-trade', p_digest: 'sql-trade', p_expected_cursor: null,
    p_operations: [trade(uuid(), 'Pintura Prueba')] }), (e: any) => e.code === 'FORBIDDEN');
});

test('capacidades · una por persona y oficio; lecturas para Tasks solo con nivel de casa y oficio activo; fusión las pasa', async () => {
  const pint = uuid(); const old = uuid();
  const ana = uuid(); const anaDup = uuid(); const noLevel = uuid();
  const setup = await commit([
    trade(pint, 'Pintura Capacidad'), trade(old, 'Oficio archivado'),
    { op: 'insert', table: TABLES.people, id: ana, fields: { display_name: 'Ana Oficio', relation: 'equipo', house_level: 'staff' } },
    { op: 'insert', table: TABLES.people, id: anaDup, fields: { display_name: 'Ana O.', relation: 'equipo', house_level: 'staff' } },
    { op: 'insert', table: TABLES.people, id: noLevel, fields: { display_name: 'Sin nivel Oficio', relation: 'otro' } },
    { op: 'insert', table: TABLES.personTrades, id: uuid(), fields: { person_id: ana, trade_id: pint, level: 1 } },
    { op: 'insert', table: TABLES.personTrades, id: uuid(), fields: { person_id: anaDup, trade_id: pint, level: 2, note: 'Fachadas' } },
    { op: 'insert', table: TABLES.personTrades, id: uuid(), fields: { person_id: anaDup, trade_id: old, level: 0 } },
    { op: 'insert', table: TABLES.personTrades, id: uuid(), fields: { person_id: noLevel, trade_id: pint, level: 2 } },
  ]);
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  assert.equal((await commit([{ op: 'insert', table: TABLES.personTrades, id: uuid(), fields: { person_id: ana, trade_id: pint, level: 0 } }])).data.error.code, 'CONSTRAINT_VIOLATION');
  const [o] = await rows(`select revision from central.trades where id = $1`, [old]);
  assert.equal((await commit([{ op: 'update', table: TABLES.trades, id: old, expectedRevision: Number(o.revision), fields: { active: false } }])).status, 200);

  const tasksUser = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('tasks', $1, 'reader')`, [tasksUser]);
  const read = async (name: string) => (await app.t.rpc('core_read', { p_app: 'tasks', p_actor: tasksUser, p_name: name, p_args: {} }) as { rows: any[] }).rows;
  const options = await read('central.trade_options');
  assert.ok(options.some((t) => t.trade_id === pint && t.path === 'Pintura Capacidad'));
  assert.ok(!options.some((t) => t.trade_id === old)); // archivado, fuera
  const caps = (await read('central.capability_options')).filter((c) => c.trade_id === pint || c.trade_id === old);
  assert.deepEqual(caps.map((c) => [c.person_id, c.level]).sort(), [[ana, 1], [anaDup, 2]].sort()); // sin nivel de casa ni oficio archivado
  for (const c of caps) assert.deepEqual(Object.keys(c).sort(), ['level', 'person_id', 'trade_id']);

  // Fusionar «Ana O.» en «Ana Oficio»: se queda el nivel más alto y la nota; la del oficio que no tenía pasa entera.
  const merged = await commit([{ op: 'call', procedure: MERGE_PEOPLE_PROCEDURE, args: { from: anaDup, into: ana } }]);
  assert.equal(merged.status, 200, JSON.stringify(merged.data));
  const after = await rows(`select trade_id, level, note from central.person_trades where deleted_at is null and person_id = $1 order by level desc`, [ana]);
  assert.deepEqual(after.map((r) => [r.trade_id, r.level, r.note]), [[pint, 2, 'Fachadas'], [old, 0, null]]);
  assert.equal((await rows(`select 1 from central.person_trades where deleted_at is null and person_id = $1`, [anaDup])).length, 0);
});

test('importar oficios · plan: junta las repetidas entre áreas, respeta el árbol, marca lo que ya existe y lo archivado', () => {
  const L = (label_id: string, name: string, parent_id: string | null, tab_id: string | null, archived = false, position = 0) => ({ label_id, name, parent_id, tab_id, archived, position });
  const labels = [
    L('f1', 'Fontanería', null, 'A', false, 1), L('acs1', 'ACS', 'f1', 'A'), L('fria1', 'Agua fría', 'f1', 'A'),
    L('f2', ' fontaneria ', null, 'B', false, 1), L('acs2', 'acs', 'f2', 'B'),
    L('e0', 'Electricidad', null, null, false, 2), L('cuadro', 'Cuadro', 'e0', null),
    L('viejo', 'Oficio viejo', null, 'A', true, 3),
  ];
  const plan = planTradeImport(labels, [{ id: 'T-E', parent_id: null, name: 'ELECTRICIDAD', source_label_id: null }]);
  assert.deepEqual(plan.map((n) => [n.path, n.depth, n.areas, n.archived, n.existingId]), [
    ['Fontanería', 0, 2, false, null], ['Fontanería › ACS', 1, 2, false, null], ['Fontanería › Agua fría', 1, 1, false, null],
    ['Electricidad', 0, 1, false, 'T-E'], ['Electricidad › Cuadro', 1, 1, false, null],
    ['Oficio viejo', 0, 1, true, null],
  ]);
  assert.deepEqual(plan[0]!.labelIds.sort(), ['f1', 'f2']);
  assert.equal(plan[3]!.sourceLabelId, 'e0'); // la de General
  // Una segunda vez, con lo ya importado (por su etiqueta de origen), no queda nada nuevo.
  const again = planTradeImport(labels, plan.map((n, i) => ({ id: `t${i}`, parent_id: null, name: `otro ${i}`, source_label_id: n.sourceLabelId })));
  assert.ok(again.every((n) => n.existingId));
});

test('importar oficios · Central lee `tasks.action_labels` (solo la familia «Tipo: Acción»)', async () => {
  const db = app.t.db;
  const tab = uuid(); const fam = uuid(); const other = uuid(); const parent = uuid();
  await db.query(`insert into tasks.tabs (id, name) values ($1, 'Área de prueba')`, [tab]);
  await db.query(`insert into tasks.families (id, tab_id, name, color) values ($1, $2, 'Tipo: Acción', '#336699'), ($3, $2, 'Zona: Espacio', '#336699')`, [fam, tab, other]);
  await db.query(`insert into tasks.labels (id, tab_id, family_id, parent_id, name) values ($1, $2, $3, null, 'Pintura'), ($4, $2, $3, $1, 'Fachadas'), ($5, $2, $6, null, 'Albergue')`,
    [parent, tab, fam, uuid(), uuid(), other]);
  const out = await app.call('/api/v1/read/tasks.action_labels', { body: { limit: 2000 } });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  const names = (out.data.rows as Array<{ name: string; parent_id: string | null }>).map((r) => r.name).sort();
  assert.deepEqual(names, ['Fachadas', 'Pintura']);
  const plan = planTradeImport(out.data.rows, []);
  assert.deepEqual(plan.map((n) => n.path), ['Pintura', 'Pintura › Fachadas']);
});

test('P2 · central.person_alive y central.trade_alive: vivos, archivados, borrados e inexistentes', async () => {
  const one = async (fn: string, id: string) => (await rows(`select central.${fn}($1::uuid) as ok`, [id]))[0].ok as boolean;
  const [p1, p2, t1, t2] = [uuid(), uuid(), uuid(), uuid()];
  await app.t.db.query(`insert into central.people (id, display_name, relation) values ($1, 'Persona viva P2', 'equipo'), ($2, 'Persona inactiva P2', 'equipo')`, [p1, p2]);
  await app.t.db.query(`update central.people set active = false where id = $1`, [p2]);
  await app.t.db.query(`insert into central.trades (id, name) values ($1, 'Oficio vivo P2'), ($2, 'Oficio borrado P2')`, [t1, t2]);
  await app.t.db.query(`update central.trades set deleted_at = now() where id = $1`, [t2]);
  assert.equal(await one('person_alive', p1), true);
  assert.equal(await one('person_alive', p2), false);
  assert.equal(await one('person_alive', uuid()), false);
  assert.equal(await one('trade_alive', t1), true);
  assert.equal(await one('trade_alive', t2), false);
  assert.equal(await one('trade_alive', uuid()), false);
});
