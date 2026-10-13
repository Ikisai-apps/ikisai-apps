/**
 * Tasks · fase R2: las zonas pasan a ser espacios de Recursos (migración 0322, docs/tasks/API.md §30), contra el núcleo,
 * el módulo de Recursos y el hook reales. Vista previa con las dudosas; ida (espacio más hondo, «Exteriores» quitado, vistas
 * reescritas, familia archivada, copia de las etiquetas intacta); reglas del hook sobre los espacios; y vuelta atrás.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps, createTaskOps, emptyDataset, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), RET = uuid(), P = uuid(), PS = uuid(), PR = uuid();
const ZONA = uuid(), ALB = uuid(), HAB3 = uuid(), BANO = uuid(), SALAS = uuid(), ROBLE = uuid(), EXT = uuid(), PISCINA = uuid(), HUERFANA = uuid(), JARD = uuid(), ROSA = uuid();
const S_ALB = uuid(), S_HAB3 = uuid(), S_BANO = uuid(), S_SALAS = uuid(), S_ROBLE = uuid(), S_PISCINA = uuid(), S_NUEVO = uuid(), S_ROSA = uuid();
const T_HAB = uuid(), T_ALB = uuid(), T_EXT = uuid(), T_PISC = uuid(), T_HUERF = uuid(), T_NADA = uuid(), T_RET = uuid(), T_JARD = uuid();
const VIEW = uuid();
let app: TestApp;
let seq = 0;

const rows = async (t: string) => (await app.call(`/api/v1/snapshot?tables=${t}&includeDeleted=1&limit=2000`)).data.tables[0].rows as any[];
const commit = (operations: Operation[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `z-${++seq}`, operations } });
const ok = async (operations: Operation[]) => { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res.data; };
// Desde las rutas de tasks-api, como la app (los `call` de Tasks no pasan por `commands`).
const zones = (direction: 'to-spaces' | 'to-labels', body: Record<string, unknown> = {}, token?: string) =>
  app.call(`/api/v1/zones/${direction}`, { token, body: { requestId: `zr-${++seq}`, ...body } });
const resources = (operations: unknown[]) => app.call('/api/v1/resources/commands', { body: { requestId: `r-${++seq}`, operations } });
const space = (id: string, parent: string, kind: string, name: string, label?: string) =>
  ({ op: 'insert', table: 'resources.spaces', id, fields: { parent_id: parent, kind, name, position: 1024, source_refs: label ? [`tasks.label:${label}`] : [] } });
const preview = async (args: Record<string, unknown> = {}, token?: string) => app.call('/api/v1/read/tasks.zones_preview', { body: args, token });
const liveSpaces = async (table: 'tasks.task_spaces' | 'tasks.project_spaces', key: 'task_id' | 'project_id', id: string) =>
  (await rows(table)).filter((r) => r[key] === id && !r.deleted_at).map((r) => r.space_id).sort();
const tl = (tab: string, p: string, task: string, label: string): Operation => ({ op: 'insert', table: 'tasks.task_labels', id: uuid(), fields: { tab_id: tab, project_id: p, task_id: task, label_id: label } });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  await ok(createTabOps({ id: TAB, name: 'Mantenimiento', position: 1024 }));
  await ok(createTabOps({ id: RET, name: 'Retiros', position: 2048 }));
  await ok([{ op: 'insert', table: 'tasks.families', id: ZONA, fields: { tab_id: null, name: 'Zona: Espacio', color: '#9c744e', position: 1 } }]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: ALB, fields: { tab_id: null, family_id: ZONA, name: 'Albergue', position: 1 } },
    { op: 'insert', table: 'tasks.labels', id: SALAS, fields: { tab_id: null, family_id: ZONA, name: 'Salas', position: 2 } },
    { op: 'insert', table: 'tasks.labels', id: EXT, fields: { tab_id: null, family_id: ZONA, name: 'Exteriores', position: 3 } },
    { op: 'insert', table: 'tasks.labels', id: HUERFANA, fields: { tab_id: null, family_id: ZONA, name: 'Trastero viejo', position: 4 } },
    // Madre sin espacio que solo se usa con su hija (como «Exteriores» en los datos reales): no deja a nadie sin espacio.
    { op: 'insert', table: 'tasks.labels', id: JARD, fields: { tab_id: null, family_id: ZONA, name: 'Jardines', position: 5 } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: HAB3, fields: { tab_id: null, family_id: ZONA, parent_id: ALB, name: 'Hab 3', position: 1 } },
    { op: 'insert', table: 'tasks.labels', id: BANO, fields: { tab_id: null, family_id: ZONA, parent_id: ALB, name: 'Baño Hombres', position: 2 } },
    { op: 'insert', table: 'tasks.labels', id: ROBLE, fields: { tab_id: null, family_id: ZONA, parent_id: SALAS, name: 'Sala Roble', position: 1 } },
    { op: 'insert', table: 'tasks.labels', id: PISCINA, fields: { tab_id: null, family_id: ZONA, parent_id: EXT, name: 'Piscina', position: 1 } },
    { op: 'insert', table: 'tasks.labels', id: ROSA, fields: { tab_id: null, family_id: ZONA, parent_id: JARD, name: 'Rosaleda', position: 1 } },
    { op: 'insert', table: 'tasks.projects', id: P, fields: { tab_id: TAB, title: 'Pintura', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: PS, fields: { tab_id: TAB, title: 'Salas', position: 3072 } },
    { op: 'insert', table: 'tasks.projects', id: PR, fields: { tab_id: RET, title: 'Otoño', position: 2048 } },
  ]);
  const t = (id: string, tab: string, p: string, title: string) => ({ op: 'insert', table: 'tasks.tasks', id, fields: { tab_id: tab, project_id: p, title, position: 1024 } } as Operation);
  await ok([t(T_HAB, TAB, P, 'Pintar Hab 3'), t(T_ALB, TAB, P, 'Revisar albergue'), t(T_EXT, TAB, P, 'Barrer exteriores'), t(T_PISC, TAB, P, 'Limpiar piscina'),
    t(T_HUERF, TAB, P, 'Vaciar trastero'), t(T_NADA, TAB, P, 'Comprar pintura'), t(T_RET, RET, PR, 'Preparar baño'), t(T_JARD, TAB, P, 'Podar rosales'),
    { op: 'insert', table: 'tasks.project_labels', id: uuid(), fields: { tab_id: TAB, project_id: PS, label_id: SALAS } },
    { op: 'insert', table: 'tasks.project_labels', id: uuid(), fields: { tab_id: TAB, project_id: PS, label_id: ROBLE } }]);
  await ok([tl(TAB, P, T_HAB, ALB), tl(TAB, P, T_HAB, HAB3), tl(TAB, P, T_ALB, ALB), tl(TAB, P, T_EXT, EXT), tl(TAB, P, T_PISC, EXT), tl(TAB, P, T_PISC, PISCINA),
    tl(TAB, P, T_HUERF, HUERFANA), tl(RET, PR, T_RET, ALB), tl(RET, PR, T_RET, BANO), tl(TAB, P, T_JARD, JARD), tl(TAB, P, T_JARD, ROSA)]);
  await ok([{ op: 'insert', table: 'tasks.saved_views', id: VIEW, fields: { tab_id: TAB, name: 'Albergue sin Hab 3', filters: { [ZONA]: [ALB], _exclude: [HAB3] }, group_by: ZONA, position: 1 } }]);
  // Los espacios de Recursos (como los dejó R1 en producción): cada uno nombra en source_refs la etiqueta de la que viene.
  const altura = (await app.t.db.query<{ id: string }>(`select id from resources.spaces where name = 'Altura 1'`)).rows[0]!.id;
  let res = await resources([space(S_ALB, altura, 'edificio', 'Albergue', ALB), space(S_SALAS, altura, 'edificio', 'Edificio de salas', SALAS), space(S_PISCINA, altura, 'exterior', 'Piscina', PISCINA), space(S_ROSA, altura, 'exterior', 'Rosaleda', ROSA)]);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  res = await resources([space(S_HAB3, S_ALB, 'habitacion', 'Hab 3', HAB3), space(S_BANO, S_ALB, 'bano', 'Baño Hombres', BANO), space(S_ROBLE, S_SALAS, 'sala', 'Sala Roble', ROBLE), space(S_NUEVO, S_SALAS, 'sala', 'Sala Olivo')]);
  assert.equal(res.status, 200, JSON.stringify(res.data));
});
test.after(async () => { await app.close(); });

test('vista previa: lo que corresponde a cada zona, «Exteriores» y la huérfana como dudosas, y solo para la propietaria', async () => {
  assert.equal((await preview({}, app.tokens.editor)).status, 403);
  const out = (await preview()).data;
  assert.equal(out.source, 'labels');
  const mapped = Object.fromEntries(out.mapped.map((m: any) => [m.name, [m.spaceId, m.tasks, m.projects]]));
  assert.deepEqual(mapped['Hab 3'], [S_HAB3, 1, 0]);
  assert.deepEqual(mapped.Albergue, [S_ALB, 1, 0], 'solo «Revisar albergue»: en «Pintar Hab 3» cuenta la hija');
  assert.deepEqual(mapped['Baño Hombres'], [S_BANO, 1, 0]);
  assert.deepEqual(mapped['Sala Roble'], [S_ROBLE, 0, 1]);
  // Dudosas: dejan a alguien sin espacio. «Exteriores» cuenta sus dos usos (también el de «Limpiar piscina», con hija).
  assert.deepEqual(out.doubtful.map((d: any) => [d.name, d.reason, d.tasks, d.withoutSpace]).sort(), [['Exteriores', 'no_space', 2, 1], ['Trastero viejo', 'no_space', 1, 1]]);
  assert.deepEqual(out.doubtful.find((d: any) => d.name === 'Exteriores').sample, ['Barrer exteriores', 'Limpiar piscina']);
  // Cubierta: «Jardines» sin espacio, pero su única tarea tiene «Rosaleda»: sale en quitadas, sin dejar a nadie sin espacio.
  assert.deepEqual(out.removed.map((r: any) => [r.name, r.reason, r.tasks, r.withoutSpace]), [['Jardines', 'covered', 1, 0]]);
  assert.equal(out.counts.withoutSpace, 2);
  assert.equal(out.counts.views, 1);
  const marked = (await preview({ remove: [EXT, HUERFANA] })).data;
  assert.deepEqual(marked.doubtful, []);
  assert.deepEqual(marked.removed.map((r: any) => [r.name, r.reason]).sort(), [['Exteriores', 'marked'], ['Jardines', 'covered'], ['Trastero viejo', 'marked']]);
});

test('ida: no se aplica con dudosas; con ellas marcadas, cada tarea y proyecto recibe su espacio más hondo', async () => {
  const refused = await zones('to-spaces');
  assert.equal(refused.status, 422);
  assert.equal(refused.data.error.code, 'ZONES_DOUBTFUL', JSON.stringify(refused.data));
  assert.equal((await zones('to-spaces', { remove: [EXT, HUERFANA] }, app.tokens.editor)).status, 403);
  const done = await zones('to-spaces', { remove: [EXT, HUERFANA] });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.deepEqual(done.data.counts, { taskSpaces: 5, projectSpaces: 1, views: 1, labels: 10 });

  assert.deepEqual(await liveSpaces('tasks.task_spaces', 'task_id', T_HAB), [S_HAB3]);
  assert.deepEqual(await liveSpaces('tasks.task_spaces', 'task_id', T_ALB), [S_ALB]);
  assert.deepEqual(await liveSpaces('tasks.task_spaces', 'task_id', T_RET), [S_BANO]);
  assert.deepEqual(await liveSpaces('tasks.task_spaces', 'task_id', T_PISC), [S_PISCINA], 'la piscina sí; «Exteriores» a secas se quita');
  assert.deepEqual(await liveSpaces('tasks.task_spaces', 'task_id', T_EXT), []);
  assert.deepEqual(await liveSpaces('tasks.task_spaces', 'task_id', T_JARD), [S_ROSA], 'la madre cubierta no impide la ida');
  assert.deepEqual(await liveSpaces('tasks.task_spaces', 'task_id', T_HUERF), []);
  assert.deepEqual(await liveSpaces('tasks.project_spaces', 'project_id', PS), [S_ROBLE]);
  assert.equal((await rows('tasks.task_spaces')).find((r) => r.task_id === T_RET).tab_id, RET);

  const view = (await rows('tasks.saved_views')).find((v) => v.id === VIEW);
  assert.deepEqual(view.filters, { _space: [S_ALB], _exclude: [S_HAB3] });
  assert.equal(view.group_by, '_space');

  assert.equal((await rows('tasks.families')).find((f) => f.id === ZONA).archived, true);
  assert.ok((await rows('tasks.labels')).filter((l) => l.family_id === ZONA).every((l) => l.archived && l.archived_before_family === false));
  assert.equal((await rows('tasks.task_labels')).filter((r) => !r.deleted_at && [T_HAB, T_EXT, T_RET].includes(r.task_id)).length, 5, 'la copia en etiquetas sigue intacta');
  assert.deepEqual((await rows('tasks.settings')).map((s) => [s.key, s.value]), [['zone_source', 'spaces']]);
  assert.equal((await zones('to-spaces', { remove: [EXT, HUERFANA] })).status, 409, 'una sola vez');
});

test('hook: espacio vivo y activo, sin repetir, con las claves de su tarea; los ajustes no se tocan a mano; la tarea nueva hereda el del proyecto', async () => {
  const bad = await commit([{ op: 'insert', table: 'tasks.task_spaces', id: uuid(), fields: { tab_id: TAB, project_id: P, task_id: T_NADA, space_id: uuid() } }]);
  assert.equal(bad.data.error?.code, 'INVALID_SPACE');
  const dup = await commit([{ op: 'insert', table: 'tasks.task_spaces', id: uuid(), fields: { tab_id: TAB, project_id: P, task_id: T_HAB, space_id: S_HAB3 } }]);
  assert.equal(dup.data.error?.code, 'INVALID_SPACES');
  const keys = await commit([{ op: 'insert', table: 'tasks.task_spaces', id: uuid(), fields: { tab_id: TAB, project_id: PS, task_id: T_NADA, space_id: S_NUEVO } }]);
  assert.equal(keys.data.error?.code, 'INCONSISTENT_KEYS');
  await ok([{ op: 'insert', table: 'tasks.task_spaces', id: uuid(), fields: { tab_id: TAB, project_id: P, task_id: T_NADA, space_id: S_NUEVO } }]);
  const setting = (await rows('tasks.settings'))[0];
  const edit = await commit([{ op: 'update', table: 'tasks.settings', id: setting.id, expectedRevision: setting.revision, fields: { value: 'labels' } }]);
  assert.equal(edit.status, 422);
  // La tarea nueva de un proyecto con espacio lo hereda (decisión del usuario).
  const data = emptyDataset();
  data['tasks.projects'] = await rows('tasks.projects');
  data['tasks.tasks'] = await rows('tasks.tasks');
  data['tasks.project_spaces'] = await rows('tasks.project_spaces');
  data['tasks.project_labels'] = [];
  const NEW = uuid();
  await ok(createTaskOps(data, { id: NEW, project_id: PS, title: 'Encerar' }));
  assert.deepEqual(await liveSpaces('tasks.task_spaces', 'task_id', NEW), [S_ROBLE]);
});

test('vuelta atrás: avisa de lo que no viene de una zona; vuelve a etiquetas con lo cambiado, desarchiva y deja los espacios en la papelera', async () => {
  const lost = (await preview()).data;
  assert.equal(lost.source, 'spaces');
  assert.deepEqual(lost.lost.map((l: any) => [l.name, l.tasks]), [['Sala Olivo', 1]]);
  const refused = await zones('to-labels');
  assert.equal(refused.data.error?.code, 'SPACES_UNMAPPED');
  // Mientras tanto, a «Revisar albergue» se le cambió el Albergue por el Baño Hombres.
  const link = (await rows('tasks.task_spaces')).find((r) => r.task_id === T_ALB && !r.deleted_at);
  await ok([{ op: 'delete', table: 'tasks.task_spaces', id: link.id, expectedRevision: link.revision },
    { op: 'insert', table: 'tasks.task_spaces', id: uuid(), fields: { tab_id: TAB, project_id: P, task_id: T_ALB, space_id: S_BANO } }]);
  const back = await zones('to-labels', { dropUnmapped: true });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  const zonesOf = async (task: string) => (await rows('tasks.task_labels')).filter((r) => r.task_id === task && !r.deleted_at).map((r) => r.label_id).sort();
  assert.deepEqual(await zonesOf(T_ALB), [ALB, BANO].sort(), 'la hija con su madre');
  assert.deepEqual(await zonesOf(T_HAB), [ALB, HAB3].sort());
  assert.deepEqual(await zonesOf(T_PISC), [EXT, PISCINA].sort());
  assert.deepEqual(await zonesOf(T_EXT), [], '«Exteriores» se quitó en la ida y no vuelve');
  assert.equal((await rows('tasks.task_spaces')).filter((r) => !r.deleted_at).length, 0);
  assert.equal((await rows('tasks.families')).find((f) => f.id === ZONA).archived, false);
  assert.ok((await rows('tasks.labels')).filter((l) => l.family_id === ZONA).every((l) => !l.archived && l.archived_before_family === null));
  const view = (await rows('tasks.saved_views')).find((v) => v.id === VIEW);
  assert.deepEqual(view.filters, { [ZONA]: [ALB], _exclude: [HAB3] });
  assert.equal(view.group_by, ZONA);
  assert.deepEqual((await rows('tasks.settings')).map((s) => s.value), ['labels']);
});

test('lo que mueve o crea tareas conoce sus espacios: petición de otra app, convertir un área y vaciar la papelera (0324)', async () => {
  // Petición de otra app a un proyecto con espacio: la tarea lo hereda.
  await ok([{ op: 'insert', table: 'tasks.project_spaces', id: uuid(), fields: { tab_id: TAB, project_id: PS, space_id: S_ROBLE } }]);
  const asked = await app.call('/api/v1/requests/task', { body: { source: 'central', external_ref: 'LEG_R2_001', title: 'Revisar extintor', project_id: PS } });
  assert.equal(asked.status, 200, JSON.stringify(asked.data));
  assert.deepEqual(await liveSpaces('tasks.task_spaces', 'task_id', asked.data.task.id), [S_ROBLE]);

  // Convertir un área en proyecto de otra: los espacios de sus tareas pasan con ellas.
  const OLD = uuid(), OP = uuid(), OT = uuid(), NEWP = uuid();
  await ok(createTabOps({ id: OLD, name: 'Jardinería', position: 9000 }));
  await ok([{ op: 'insert', table: 'tasks.projects', id: OP, fields: { tab_id: OLD, title: 'Setos', position: 2048 } }]);
  await ok([{ op: 'insert', table: 'tasks.tasks', id: OT, fields: { tab_id: OLD, project_id: OP, title: 'Recortar', position: 1024 } }]);
  await ok([{ op: 'insert', table: 'tasks.task_spaces', id: uuid(), fields: { tab_id: OLD, project_id: OP, task_id: OT, space_id: S_ROSA } }]);
  const converted = await app.call(`/api/v1/tabs/${OLD}/convert`, { body: { requestId: `cv-${++seq}`, targetTabId: TAB, projectId: NEWP, title: 'Jardinería' } });
  assert.equal(converted.status, 200, JSON.stringify(converted.data));
  const moved = (await rows('tasks.task_spaces')).find((r) => r.task_id === OT && !r.deleted_at);
  assert.deepEqual([moved.tab_id, moved.project_id, moved.space_id], [TAB, NEWP, S_ROSA]);

  // Vaciar la papelera con una tarea con espacio en ella: el espacio va antes a la papelera y la purga no falla.
  const gone = (await rows('tasks.tasks')).find((t) => t.id === OT);
  await ok([{ op: 'delete', table: 'tasks.tasks', id: OT, expectedRevision: gone.revision }]);
  const emptied = await app.call('/api/v1/trash/empty', { body: { requestId: `tr-${++seq}` } });
  assert.equal(emptied.status, 200, JSON.stringify(emptied.data));
  assert.equal((await rows('tasks.tasks')).some((t) => t.id === OT), false);
  assert.equal((await rows('tasks.task_spaces')).some((r) => r.task_id === OT), false);
});
