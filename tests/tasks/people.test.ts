/**
 * Tasks · fase P2, PR 3a: la familia «Grupo: Persona» pasa a ser personas de Central (migración 0327, docs/tasks/API.md
 * §33), contra el núcleo, Central y el hook reales. La propuesta (por iniciales, por nombre, por nombre de pila único, la
 * ambigua sin propuesta, las madres de grupo por nivel), las copias de área agrupadas, la ida (confirmación obligatoria,
 * lo más hondo, responsables de tareas, proyectos y reglas de Entrada, vistas, archivado sin borrar), el hook con
 * `central.person_alive`, la vuelta exacta y con `dropUnmapped`, los permisos y lo que ve el outsider. Nombres inventados.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import {
  createTabOps, createTaskOps, emptyDataset, personLabelGroups, proposePerson, validateOperations, type Operation, type PersonOption,
} from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), MEJ = uuid(), P = uuid(), PM = uuid();
// Etiquetas de persona: en Mantenimiento, Staff › VG y «Ana Nunez», Outsiders › Marta, Dirección, Pepe y Sola (sin usar);
// en Mejoras, su copia Staff › vg.
const STAFF = uuid(), VG = uuid(), ANA = uuid(), OUT = uuid(), MARTA = uuid(), DIR = uuid(), PEPE = uuid(), SOLA = uuid(), STAFF2 = uuid(), VG2 = uuid();
// Fichas de Central (inventadas).
const P_VG = uuid(), P_ANA = uuid(), P_MARTA = uuid(), P_PEPE1 = uuid(), P_PEPE2 = uuid(), P_OLD = uuid(), P_NEW = uuid();
const T1 = uuid(), T2 = uuid(), T3 = uuid(), T4 = uuid(), T5 = uuid(), T6 = uuid(), TM = uuid();
const VIEW = uuid(), ROUTE = uuid(), ROUTE2 = uuid();
let app: TestApp;
let seq = 0;
let PF = '', PF2 = '';

const rows = async (t: string) => (await app.call(`/api/v1/snapshot?tables=${t}&includeDeleted=1&limit=2000`)).data.tables[0].rows as any[];
const commit = (operations: Operation[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `p-${++seq}`, operations } });
const ok = async (operations: Operation[]) => { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res.data; };
const action = (name: 'people-to-central' | 'people-to-labels', body: Record<string, unknown> = {}, token?: string) =>
  app.call(`/api/v1/actions/${name}`, { token, body: { requestId: `pp-${++seq}`, ...body } });
const preview = (args: Record<string, unknown> = {}, token?: string) => app.call('/api/v1/read/tasks.people_preview', { body: args, token });
const sql = (text: string, params: unknown[] = []) => app.t.db.query(text, params);
const person = (id: string, name: string, level: string | null, initials: string | null = null, active = true) =>
  sql(`insert into central.people (id, display_name, relation, house_level, initials, active) values ($1, $2, 'equipo', $3, $4, $5)`, [id, name, level, initials, active]);
const people = async (table: 'tasks.task_people' | 'tasks.project_people', key: 'task_id' | 'project_id', id: string) =>
  (await rows(table)).filter((r) => r[key] === id && !r.deleted_at).map((r) => r.person_id ?? `level:${r.house_level}`).sort();
const labelsOf = async (task: string) => (await rows('tasks.task_labels')).filter((r) => r.task_id === task && !r.deleted_at).map((r) => r.label_id).sort();
const tl = (tab: string, p: string, task: string, label: string): Operation => ({ op: 'insert', table: 'tasks.task_labels', id: uuid(), fields: { tab_id: tab, project_id: p, task_id: task, label_id: label } });
const label = (id: string, tab: string, family: string, name: string, parent: string | null = null): Operation =>
  ({ op: 'insert', table: 'tasks.labels', id, fields: { tab_id: tab, family_id: family, parent_id: parent, name, position: 1 } });
const owner = async (table: string, id: string) => { const r = (await rows(table)).find((x) => x.id === id); return [r.owner_label_id, r.owner_person_id, r.owner_house_level]; };
/** La correspondencia que confirma la propietaria: lo propuesto, Pepe se quita. */
const MAPPING = () => ({ [VG]: P_VG, [STAFF]: 'level:staff', [ANA]: P_ANA, [OUT]: 'level:outsider', [MARTA]: P_MARTA, [DIR]: 'level:direccion', [PEPE]: 'remove' });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  await ok(createTabOps({ id: TAB, name: 'Mantenimiento', position: 1024 }));
  await ok(createTabOps({ id: MEJ, name: 'Mejoras', position: 2048 }));
  const families = await rows('tasks.families');
  PF = families.find((f) => f.tab_id === TAB && f.system_key === 'person').id;
  PF2 = families.find((f) => f.tab_id === MEJ && f.system_key === 'person').id;
  // La familia de Mantenimiento se llama como en producción.
  await ok([{ op: 'update', table: 'tasks.families', id: PF, expectedRevision: families.find((f) => f.id === PF).revision, fields: { name: 'Grupo: Persona' } }]);
  await ok([label(STAFF, TAB, PF, 'Staff'), label(OUT, TAB, PF, 'Outsiders'), label(DIR, TAB, PF, 'Dirección'), label(PEPE, TAB, PF, 'Pepe'), label(SOLA, TAB, PF, 'Sola'),
    label(ANA, TAB, PF, 'Ana Nunez'), label(STAFF2, MEJ, PF2, 'Staff'),
    { op: 'insert', table: 'tasks.projects', id: P, fields: { tab_id: TAB, title: 'Obras', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: PM, fields: { tab_id: MEJ, title: 'Mejoras 2026', position: 2048 } }]);
  await ok([label(VG, TAB, PF, 'VG', STAFF), label(MARTA, TAB, PF, 'Marta', OUT), label(VG2, MEJ, PF2, 'vg', STAFF2)]);
  const t = (id: string, tab: string, p: string, title: string, extra: Record<string, unknown> = {}) =>
    ({ op: 'insert', table: 'tasks.tasks', id, fields: { tab_id: tab, project_id: p, title, position: 1024, ...extra } } as Operation);
  await ok([t(T1, TAB, P, 'Revisar caldera'), t(T2, TAB, P, 'Turno de limpieza'), t(T3, TAB, P, 'Podar'), t(T4, TAB, P, 'Pintar', { owner_label_id: VG }),
    t(T5, TAB, P, 'Inventario', { owner_label_id: STAFF }), t(T6, TAB, P, 'Recados'), t(TM, MEJ, PM, 'Termo nuevo'),
    { op: 'insert', table: 'tasks.project_labels', id: uuid(), fields: { tab_id: TAB, project_id: P, label_id: DIR } }]);
  await ok([tl(TAB, P, T1, STAFF), tl(TAB, P, T1, VG), tl(TAB, P, T2, STAFF), tl(TAB, P, T3, OUT), tl(TAB, P, T3, MARTA), tl(TAB, P, T4, ANA), tl(TAB, P, T6, PEPE),
    tl(MEJ, PM, TM, VG2)]);
  await ok([{ op: 'insert', table: 'tasks.saved_views', id: VIEW, fields: { tab_id: TAB, name: 'Staff sin Marta', filters: { [PF]: [VG, STAFF], _exclude: [MARTA] }, group_by: PF, position: 1 } },
    { op: 'insert', table: 'tasks.request_routes', id: ROUTE, fields: { kind: 'central.compliance_due', tab_id: TAB, owner_label_id: VG, position: 1 } },
    { op: 'insert', table: 'tasks.request_routes', id: ROUTE2, fields: { kind: 'booking.extra_item', tab_id: TAB, owner_label_id: OUT, position: 2 } }]);
});
test.after(async () => { await app.close(); });

test('dominio · propuesta por iniciales, nombre y nombre de pila único; la ambigua sin propuesta; madres por nivel; copias agrupadas', () => {
  const o = (person_id: string, name: string, house_level: PersonOption['house_level'], initials: string | null = null): PersonOption => ({ person_id, name, house_level, initials });
  const options = [o('a', 'Víctor Gómez', 'staff', 'VG'), o('b', 'Ana Núñez', 'staff'), o('c', 'Marta Ruiz', 'outsider'), o('d', 'Pepe Sanz', 'staff'), o('e', 'Pepe López', 'staff'), o('f', 'Sin Nivel', null, 'SN')];
  assert.deepEqual(proposePerson('vg', options), { personId: 'a', name: 'Víctor Gómez', initials: 'VG', by: 'initials' });
  assert.deepEqual(proposePerson(' ana nunez ', options), { personId: 'b', name: 'Ana Núñez', initials: null, by: 'name' });
  assert.deepEqual(proposePerson('Marta', options), { personId: 'c', name: 'Marta Ruiz', initials: null, by: 'first_name' });
  assert.equal(proposePerson('Pepe', options), null, 'dos con el mismo nombre de pila: ninguna');
  assert.equal(proposePerson('SN', options), null, 'solo las que tienen nivel de casa (las del selector)');
  assert.deepEqual(['Staff', 'Outsiders', 'outsider', 'Voluntarias', 'Dirección', 'Equipo'].map((n) => proposePerson(n, options)),
    [{ houseLevel: 'staff' }, { houseLevel: 'outsider' }, { houseLevel: 'outsider' }, { houseLevel: 'outsider' }, { houseLevel: 'direccion' }, null]);
  const fam = [{ id: 'g', name: 'Grupo: Persona', system_key: null, deleted_at: null }, { id: 'h', name: 'Persona', system_key: 'person' as const, deleted_at: null }, { id: 'x', name: 'Fase', system_key: null, deleted_at: null }];
  const l = (id: string, family: string, name: string, parent: string | null, tab: string) => ({ id, family_id: family, name, parent_id: parent, tab_id: tab, deleted_at: null });
  const groups = personLabelGroups(fam, [l('s1', 'g', 'Staff', null, 'A'), l('v1', 'g', 'VG', 's1', 'A'), l('s2', 'h', 'staff', null, 'B'), l('v2', 'h', 'vg', 's2', 'B'), l('v3', 'h', 'VG', null, 'B'), l('z', 'x', 'VG', null, 'A')]);
  assert.deepEqual(groups.map((g) => [g.labelIds.sort(), g.tabIds.sort()]).sort(), [[['s1', 's2'], ['A', 'B']], [['v1', 'v2'], ['A', 'B']], [['v3'], ['B']]]);
  // El dominio rechaza una fila sin persona ni grupo, un nivel desconocido y dos responsables a la vez.
  const ctx = { role: 'owner' as const, scopes: '*' as const };
  const row = (fields: Record<string, unknown>): Operation[] => [{ op: 'insert', table: 'tasks.task_people', id: uuid(), fields: { tab_id: TAB, project_id: P, task_id: T1, ...fields } }];
  assert.throws(() => validateOperations(row({}), ctx), (e: any) => e.code === 'INVALID_PERSON');
  assert.throws(() => validateOperations(row({ person_id: P_VG, house_level: 'staff' }), ctx), (e: any) => e.code === 'INVALID_PERSON');
  assert.throws(() => validateOperations(row({ house_level: 'jefes' }), ctx), (e: any) => e.code === 'INVALID_PERSON');
  assert.throws(() => validateOperations([{ op: 'update', table: 'tasks.tasks', id: T1, expectedRevision: 1, fields: { owner_label_id: VG, owner_house_level: 'staff' } }], ctx), (e: any) => e.code === 'INVALID_OWNER');
  assert.throws(() => validateOperations([{ op: 'insert', table: 'tasks.saved_views', id: uuid(), fields: { tab_id: TAB, name: 'X', filters: { _person: ['level:jefes'] } } }], ctx), (e: any) => e.code === 'INVALID_VIEW');
  validateOperations([{ op: 'insert', table: 'tasks.saved_views', id: uuid(), fields: { tab_id: TAB, name: 'X', filters: { _person: ['level:staff', P_VG], _exclude: ['level:outsider'] }, group_by: '_person' } }], ctx);
});

test('Central sin personas con nivel o ilegible: la vista previa lo dice y la ida se niega', async () => {
  const empty = await preview();
  assert.equal(empty.status, 200, JSON.stringify(empty.data));
  assert.equal(empty.data.centralEmpty, true);
  assert.equal((await action('people-to-central', { mapping: MAPPING() })).data.error?.code, 'CENTRAL_PEOPLE_EMPTY');
  const saved = (await sql(`select * from core.allowed_reads where app = 'tasks' and name = 'central.people_options'`)).rows[0] as any;
  await sql(`delete from core.allowed_reads where app = 'tasks' and name = 'central.people_options'`);
  try {
    const down = await preview();
    assert.equal(down.status, 503);
    assert.equal(down.data.error.code, 'CENTRAL_UNAVAILABLE');
  } finally {
    await sql(`insert into core.allowed_reads (app, name, kind, roles) values ($1, $2, $3, $4)`, [saved.app, saved.name, saved.kind, saved.roles]);
  }
});

test('vista previa: propone por iniciales, nombre y nombre de pila; madres por nivel; copias de área agrupadas; solo la propietaria con acceso a todo', async () => {
  await person(P_VG, 'Víctor Gómez', 'staff', 'VG');
  await person(P_ANA, 'Ana Núñez', 'staff');
  await person(P_MARTA, 'Marta Ruiz', 'outsider');
  await person(P_PEPE1, 'Pepe Sanz', 'staff');
  await person(P_PEPE2, 'Pepe López', 'outsider');
  await person(P_OLD, 'Antiguo Inactivo', 'staff', null, false);

  assert.equal((await preview({}, app.tokens.editor)).status, 403);
  await sql(`update core.memberships set role = 'owner', scopes = $2::jsonb where app = 'tasks' and user_id = $1`, [app.users.editor, JSON.stringify({ tabs: [TAB] })]);
  try {
    assert.equal((await preview({}, app.tokens.editor)).status, 403, 'una propietaria sin acceso a todo, tampoco');
    assert.equal((await action('people-to-central', { mapping: MAPPING() }, app.tokens.editor)).status, 403);
  } finally {
    await sql(`update core.memberships set role = 'editor', scopes = '"*"'::jsonb where app = 'tasks' and user_id = $1`, [app.users.editor]);
  }

  const out = (await preview()).data;
  assert.equal(out.source, 'labels');
  assert.equal(out.centralEmpty, undefined);
  assert.deepEqual([...out.families].sort(), [PF, PF2].sort());
  const by = (id: string) => out.labels.find((l: any) => l.labelIds.includes(id));
  assert.deepEqual(by(VG).labelIds.sort(), [VG, VG2].sort(), 'VG de dos áreas es una sola persona');
  assert.equal(by(VG2), by(VG));
  assert.deepEqual(by(VG).areas.map((a: any) => a.name).sort(), ['Mantenimiento', 'Mejoras']);
  assert.deepEqual([by(VG).tasks, by(VG).owners, by(VG).routes, by(VG).parentName], [2, 1, 1, 'Staff']);
  assert.deepEqual(by(VG).proposal, { personId: P_VG, name: 'Víctor Gómez', initials: 'VG', by: 'initials' });
  assert.equal(by(ANA).proposal.by, 'name');
  assert.equal(by(MARTA).proposal.by, 'first_name');
  assert.equal(by(PEPE).proposal, null, 'ambigua: sin propuesta');
  assert.deepEqual(by(STAFF).labelIds.sort(), [STAFF, STAFF2].sort());
  assert.deepEqual([by(STAFF).proposal, by(OUT).proposal, by(DIR).proposal], [{ houseLevel: 'staff' }, { houseLevel: 'outsider' }, { houseLevel: 'direccion' }]);
  assert.deepEqual([by(SOLA).used, by(SOLA).confirmed], [false, null]);
  assert.deepEqual(out.people.map((p: any) => p.name), ['Ana Núñez', 'Marta Ruiz', 'Pepe López', 'Pepe Sanz', 'Víctor Gómez'], 'solo activas con nivel, por nombre');
  assert.deepEqual(out.unconfirmed, [PEPE], 'lo que falta por confirmar: la ambigua');
  // T6 (solo Pepe, sin propuesta) se quedaría sin persona.
  assert.deepEqual(out.counts, { tasks: 6, projects: 1, owners: 2, routes: 2, withoutPerson: 1, views: 1 });
  const chosen = (await preview({ mapping: { [PEPE]: P_PEPE1 } })).data;
  assert.deepEqual([chosen.unconfirmed, chosen.counts.withoutPerson], [[], 0]);
  assert.equal(chosen.labels.find((l: any) => l.labelId === PEPE).chosen, P_PEPE1);
});

test('ida: exige todas confirmadas y personas vivas; lo más hondo, responsables, reglas, vistas y archivado sin borrar', async () => {
  const { [PEPE]: _, ...partial } = MAPPING();
  const refused = await action('people-to-central', { mapping: partial });
  assert.equal(refused.status, 422);
  assert.equal(refused.data.error.code, 'PEOPLE_UNCONFIRMED', JSON.stringify(refused.data));
  assert.deepEqual(refused.data.error.details.labels, [{ labelId: PEPE, name: 'Pepe' }]);
  assert.equal((await action('people-to-central', { mapping: MAPPING() }, app.tokens.editor)).status, 403);
  // Una correspondencia falsificada con una persona inactiva no pasa: el procedimiento la revalida con central.person_alive.
  const forged = await app.t.rpc('core_commit', { p_app: 'tasks', p_actor: app.users.owner, p_request_id: 'forged-p', p_digest: 'forged-p', p_expected_cursor: null,
    p_operations: [{ op: 'call', procedure: 'tasks.people_to_central', args: { map: [{ labelId: PEPE, value: P_OLD }] } }] }).then(() => null, (e: any) => e);
  assert.equal(forged?.code, 'INVALID_PERSON');

  const done = await action('people-to-central', { mapping: MAPPING() });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.deepEqual(done.data.counts, { taskPeople: 5, projectPeople: 1, owners: 2, routes: 2, views: 1, labels: 10, families: 2 });

  assert.deepEqual(await people('tasks.task_people', 'task_id', T1), [P_VG], 'grupo con hija: solo la persona');
  assert.deepEqual(await people('tasks.task_people', 'task_id', T2), ['level:staff'], 'la madre sola: todo el staff');
  assert.deepEqual(await people('tasks.task_people', 'task_id', T3), [P_MARTA]);
  assert.deepEqual(await people('tasks.task_people', 'task_id', T4), [P_ANA]);
  assert.deepEqual(await people('tasks.task_people', 'task_id', T6), [], 'la quitada no da persona');
  assert.deepEqual(await people('tasks.task_people', 'task_id', TM), [P_VG], 'la copia de área, la misma persona');
  assert.deepEqual(await people('tasks.project_people', 'project_id', P), ['level:direccion']);
  assert.deepEqual(await owner('tasks.tasks', T4), [null, P_VG, null], 'responsable a persona');
  assert.deepEqual(await owner('tasks.tasks', T5), [null, null, 'staff'], 'responsable a grupo');
  assert.deepEqual(await owner('tasks.request_routes', ROUTE), [null, P_VG, null], 'regla de Entrada a persona');
  assert.deepEqual(await owner('tasks.request_routes', ROUTE2), [null, null, 'outsider'], 'regla de Entrada a grupo');

  const view = (await rows('tasks.saved_views')).find((v) => v.id === VIEW);
  assert.deepEqual([[...view.filters._person].sort(), view.filters._exclude, view.group_by, Object.keys(view.filters).sort()],
    [[P_VG, 'level:staff'].sort(), [P_MARTA], '_person', ['_exclude', '_person']]);

  const families = await rows('tasks.families');
  assert.deepEqual([PF, PF2].map((id) => families.find((f) => f.id === id).archived), [true, true]);
  const labels = await rows('tasks.labels');
  assert.ok(labels.filter((l) => [PF, PF2].includes(l.family_id)).every((l) => l.archived && l.archived_before_family === false && !l.deleted_at), 'archivadas, nunca borradas');
  assert.deepEqual(await labelsOf(T1), [STAFF, VG].sort(), 'la copia en etiquetas sigue intacta');
  assert.deepEqual(await labelsOf(T6), [PEPE]);
  const settings = Object.fromEntries((await rows('tasks.settings')).filter((s) => !s.deleted_at).map((s) => [s.key, s.value]));
  assert.equal(settings.people_source, 'central');
  assert.deepEqual([...settings.people_families].sort(), [PF, PF2].sort());
  assert.deepEqual(settings.people_map, { ...MAPPING(), [VG2]: P_VG, [STAFF2]: 'level:staff' });
  assert.equal((await action('people-to-central', { mapping: MAPPING() })).status, 409, 'una sola vez');
});

test('hook: persona viva (central.person_alive), sin repetir, con las claves de su tarea; responsable único y vivo; vistas con `_person`; heredar del proyecto', async () => {
  const add = (task: string, fields: Record<string, unknown>, project = P, tab = TAB) =>
    commit([{ op: 'insert', table: 'tasks.task_people', id: uuid(), fields: { tab_id: tab, project_id: project, task_id: task, ...fields } }]);
  assert.equal((await add(T6, { person_id: uuid() })).data.error?.code, 'INVALID_PERSON', 'no existe');
  assert.equal((await add(T6, { person_id: P_OLD })).data.error?.code, 'INVALID_PERSON', 'inactiva en Central');
  assert.equal((await add(T1, { person_id: P_VG })).data.error?.code, 'INVALID_PEOPLE', 'repetida');
  assert.equal((await add(T2, { house_level: 'staff' })).data.error?.code, 'INVALID_PEOPLE', 'grupo repetido');
  assert.equal((await add(T6, { person_id: P_ANA }, PM, MEJ)).data.error?.code, 'INCONSISTENT_KEYS');
  assert.equal((await add(T6, { person_id: P_PEPE1 })).status, 200);

  const t6 = (await rows('tasks.tasks')).find((t) => t.id === T6);
  assert.equal((await commit([{ op: 'update', table: 'tasks.tasks', id: T6, expectedRevision: t6.revision, fields: { owner_person_id: P_OLD } }])).data.error?.code, 'INVALID_OWNER', 'responsable inactivo');
  const t4 = (await rows('tasks.tasks')).find((t) => t.id === T4);
  assert.equal((await commit([{ op: 'update', table: 'tasks.tasks', id: T4, expectedRevision: t4.revision, fields: { owner_label_id: VG } }])).data.error?.code, 'INVALID_OWNER', 'etiqueta y persona a la vez');
  await ok([{ op: 'update', table: 'tasks.tasks', id: T6, expectedRevision: t6.revision, fields: { owner_house_level: 'outsider' } }]);

  const bad = await commit([{ op: 'insert', table: 'tasks.saved_views', id: uuid(), fields: { tab_id: TAB, name: 'Vieja', filters: { _person: [P_OLD] }, group_by: '_person', position: 3 } }]);
  assert.equal(bad.data.error?.code, 'INVALID_VIEW');
  await ok([{ op: 'insert', table: 'tasks.saved_views', id: uuid(), fields: { tab_id: TAB, name: 'Todo el staff', filters: { _person: ['level:staff', P_ANA], _exclude: ['level:outsider'] }, group_by: '_person', position: 3 } }]);

  // La tarea nueva de un proyecto con personas las hereda, como el oficio.
  const data = emptyDataset();
  data['tasks.projects'] = await rows('tasks.projects');
  data['tasks.tasks'] = await rows('tasks.tasks');
  data['tasks.project_people'] = await rows('tasks.project_people');
  const created = uuid();
  await ok(createTaskOps(data, { id: created, project_id: P, title: 'Revisar extintores', labelIds: [] }));
  assert.deepEqual(await people('tasks.task_people', 'task_id', created), ['level:direccion']);
  // La regla de Entrada pasa su responsable persona a la tarea.
  const asked = await app.call('/api/v1/requests/task', { body: { source: 'central', external_ref: 'LEG_P2_PERSONAS', kind: 'central.compliance_due', title: 'Revisión anual' } });
  assert.equal(asked.status, 200, JSON.stringify(asked.data));
  assert.deepEqual(await owner('tasks.tasks', asked.data.task.id), [null, P_VG, null]);
});

test('outsider: con un proyecto abierto ve las personas de ese proyecto y nada más', async () => {
  const id = await app.t.createUser();
  await sql(`insert into core.memberships (app, user_id, role, scopes) values ('tasks', $1, 'outsider', $2::jsonb)`, [id, JSON.stringify({ tabs: [], projects: { [TAB]: [P] } })]);
  const snap = await app.call('/api/v1/snapshot', { token: app.supabase.tokenFor(id) });
  assert.equal(snap.status, 200, JSON.stringify(snap.data));
  const table = (name: string) => (snap.data.tables.find((t: any) => t.table === name)?.rows ?? []) as any[];
  const seen = table('tasks.task_people');
  assert.ok(seen.length > 0);
  assert.ok(seen.every((r) => r.project_id === P), 'solo las del proyecto abierto');
  assert.ok(!seen.some((r) => r.task_id === TM));
  assert.deepEqual(table('tasks.project_people').map((r) => r.project_id), [P]);
});

test('vuelta: avisa de lo que se perdería; con dropUnmapped vuelve exacta, desarchiva lo archivado y deja las personas en la papelera', async () => {
  // Una persona añadida en modo central que no viene de ninguna etiqueta: se perdería.
  await person(P_NEW, 'Nueva Persona', 'staff');
  assert.equal((await commit([{ op: 'insert', table: 'tasks.task_people', id: uuid(), fields: { tab_id: TAB, project_id: P, task_id: T3, person_id: P_NEW } }])).status, 200);
  const lost = (await preview()).data;
  assert.equal(lost.source, 'central');
  // También la que se puso a «Recados» en la prueba del hook (Pepe Sanz: su etiqueta se quitó en la ida).
  assert.deepEqual(lost.lost.map((l: any) => [l.value, l.name, l.tasks]).sort(), [[P_NEW, 'Nueva Persona', 1], [P_PEPE1, 'Pepe Sanz', 1]].sort());
  assert.equal((await action('people-to-labels', {}, app.tokens.editor)).status, 403);
  const refused = await action('people-to-labels');
  assert.equal(refused.data.error?.code, 'PEOPLE_UNMAPPED');
  assert.deepEqual([...refused.data.error.details.lost].sort(), [P_NEW, P_PEPE1].sort());

  const back = await action('people-to-labels', { dropUnmapped: true });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.deepEqual(await labelsOf(T1), [STAFF, VG].sort(), 'exacta: madre e hija como estaban');
  assert.deepEqual(await labelsOf(T2), [STAFF]);
  assert.deepEqual(await labelsOf(T3), [OUT, MARTA].sort(), 'la nueva se pierde con dropUnmapped');
  assert.deepEqual(await labelsOf(T4), [ANA]);
  assert.deepEqual(await labelsOf(TM), [VG2], 'la copia de su área, sin añadirle la madre que no tenía');
  assert.deepEqual(await labelsOf(T6), [], 'la quitada en la ida no vuelve');
  assert.deepEqual(await owner('tasks.tasks', T6), [OUT, null, null], 'el grupo puesto en modo central vuelve a su madre');
  assert.deepEqual(await owner('tasks.tasks', T4), [VG, null, null]);
  assert.deepEqual(await owner('tasks.tasks', T5), [STAFF, null, null]);
  assert.deepEqual(await owner('tasks.request_routes', ROUTE), [VG, null, null]);
  assert.deepEqual(await owner('tasks.request_routes', ROUTE2), [OUT, null, null]);
  assert.deepEqual((await rows('tasks.project_labels')).filter((r) => r.project_id === P && !r.deleted_at).map((r) => r.label_id), [DIR]);
  assert.equal((await rows('tasks.task_people')).filter((r) => !r.deleted_at).length, 0);
  assert.equal((await rows('tasks.project_people')).filter((r) => !r.deleted_at).length, 0);

  const view = (await rows('tasks.saved_views')).find((v) => v.id === VIEW);
  assert.deepEqual([[...view.filters[PF]].sort(), view.filters._exclude, view.group_by], [[VG, STAFF].sort(), [MARTA], PF]);
  const families = await rows('tasks.families');
  assert.deepEqual([PF, PF2].map((id) => families.find((f) => f.id === id).archived), [false, false]);
  const labels = await rows('tasks.labels');
  assert.ok(labels.filter((l) => [PF, PF2].includes(l.family_id)).every((l) => !l.archived && l.archived_before_family === null));
  const settings = Object.fromEntries((await rows('tasks.settings')).filter((s) => !s.deleted_at).map((s) => [s.key, s.value]));
  assert.deepEqual([settings.people_source, settings.people_families], ['labels', []]);
  assert.equal((await action('people-to-labels')).status, 409);
  // La siguiente vista previa enseña lo confirmado.
  const again = (await preview()).data;
  assert.equal(again.labels.find((l: any) => l.labelId === PEPE || l.labelIds.includes(PEPE)).confirmed, 'remove');
});

test('lo que mueve o borra tareas conoce sus personas: convertir un área y vaciar la papelera', async () => {
  const OLD = uuid(), OP = uuid(), OT = uuid(), NEWP = uuid();
  await ok(createTabOps({ id: OLD, name: 'Taller', position: 9000 }));
  await ok([{ op: 'insert', table: 'tasks.projects', id: OP, fields: { tab_id: OLD, title: 'Bancos', position: 2048 } }]);
  await ok([{ op: 'insert', table: 'tasks.tasks', id: OT, fields: { tab_id: OLD, project_id: OP, title: 'Lijar', position: 1024, owner_person_id: P_ANA } }]);
  await ok([{ op: 'insert', table: 'tasks.task_people', id: uuid(), fields: { tab_id: OLD, project_id: OP, task_id: OT, person_id: P_MARTA } }]);
  const converted = await app.call(`/api/v1/tabs/${OLD}/convert`, { body: { requestId: `cv-${++seq}`, targetTabId: TAB, projectId: NEWP, title: 'Taller' } });
  assert.equal(converted.status, 200, JSON.stringify(converted.data));
  const moved = (await rows('tasks.task_people')).find((r) => r.task_id === OT && !r.deleted_at);
  assert.deepEqual([moved.tab_id, moved.project_id, moved.person_id], [TAB, NEWP, P_MARTA]);
  assert.deepEqual(await owner('tasks.tasks', OT), [null, P_ANA, null]);

  const gone = (await rows('tasks.tasks')).find((t) => t.id === OT);
  await ok([{ op: 'delete', table: 'tasks.tasks', id: OT, expectedRevision: gone.revision }]);
  const emptied = await app.call('/api/v1/trash/empty', { body: { requestId: `tt-${++seq}` } });
  assert.equal(emptied.status, 200, JSON.stringify(emptied.data));
  assert.equal((await rows('tasks.task_people')).some((r) => r.task_id === OT), false);
});
