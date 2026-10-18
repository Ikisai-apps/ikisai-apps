/**
 * Tasks · fase P2, PR 1: la familia «Tipo: Acción» pasa a ser oficios de Central (migración 0326, docs/tasks/API.md §32),
 * contra el núcleo, Central y el hook reales. La correspondencia (por origen y por ruta, con las copias de área), la vista
 * previa con las dudosas y las cubiertas, la ida (lo más hondo, la madre sola, vistas reescritas, familias archivadas, copia
 * de las etiquetas intacta), las reglas del hook con `central.trade_alive`, la vuelta con y sin `dropUnmapped`, Central vacía
 * o ilegible y los permisos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { actionTradeMap, createTabOps, createTaskOps, emptyDataset, normalizeTradeText, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), MEJ = uuid(), RET = uuid(), P = uuid(), PM = uuid(), PR = uuid();
// Catálogo: la familia General, su copia en Mejoras (con otro nombre escrito) y una copia ya archivada en Retiros.
const ACC = uuid(), C_FAM = uuid(), R_FAM = uuid();
const FONT = uuid(), ACS = uuid(), GRIFO = uuid(), PINT = uuid(), ELEC = uuid(), LIMP = uuid(), JARD = uuid(), CESPED = uuid();
const C_PINT = uuid(), C_FONT = uuid(), C_ACS = uuid(), R_PINT = uuid();
// Oficios de Central.
const TR_FONT = uuid(), TR_ACS = uuid(), TR_GRIFO = uuid(), TR_PINT = uuid(), TR_CESPED = uuid(), TR_OLD = uuid(), TR_TMP = uuid(), TR_NEW = uuid();
const T_ACS = uuid(), T_FONT = uuid(), T_GRIFO = uuid(), T_PINT = uuid(), T_ELEC = uuid(), T_LIMP = uuid(), T_JARD = uuid(), T_MEJ = uuid(), T_MEJ2 = uuid(), T_RET = uuid();
const VIEW = uuid(), VIEW2 = uuid(), VIEW3 = uuid();
let app: TestApp;
let seq = 0;
let created = '';

const rows = async (t: string) => (await app.call(`/api/v1/snapshot?tables=${t}&includeDeleted=1&limit=2000`)).data.tables[0].rows as any[];
const commit = (operations: Operation[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `t-${++seq}`, operations } });
const ok = async (operations: Operation[]) => { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res.data; };
const actions = (direction: 'to-trades' | 'to-labels', body: Record<string, unknown> = {}, token?: string) =>
  app.call(`/api/v1/actions/${direction}`, { token, body: { requestId: `tr-${++seq}`, ...body } });
const preview = (args: Record<string, unknown> = {}, token?: string) => app.call('/api/v1/read/tasks.trades_preview', { body: args, token });
const sql = (text: string, params: unknown[] = []) => app.t.db.query(text, params);
const trade = (id: string, name: string, parent: string | null = null, source: string | null = null, active = true) =>
  sql(`insert into central.trades (id, parent_id, name, source_label_id, active) values ($1, $2, $3, $4, $5)`, [id, parent, name, source, active]);
const liveTrades = async (table: 'tasks.task_trades' | 'tasks.project_trades', key: 'task_id' | 'project_id', id: string) =>
  (await rows(table)).filter((r) => r[key] === id && !r.deleted_at).map((r) => r.trade_id).sort();
const labelsOf = async (task: string) => (await rows('tasks.task_labels')).filter((r) => r.task_id === task && !r.deleted_at).map((r) => r.label_id).sort();
const tl = (tab: string, p: string, task: string, label: string): Operation => ({ op: 'insert', table: 'tasks.task_labels', id: uuid(), fields: { tab_id: tab, project_id: p, task_id: task, label_id: label } });
const label = (id: string, tab: string | null, family: string, name: string, parent: string | null = null, extra: Record<string, unknown> = {}): Operation =>
  ({ op: 'insert', table: 'tasks.labels', id, fields: { tab_id: tab, family_id: family, parent_id: parent, name, position: 1, ...extra } });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  await ok(createTabOps({ id: TAB, name: 'Mantenimiento', position: 1024 }));
  await ok(createTabOps({ id: MEJ, name: 'Mejoras', position: 2048 }));
  await ok(createTabOps({ id: RET, name: 'Retiros', position: 3072 }));
  await ok([
    { op: 'insert', table: 'tasks.families', id: ACC, fields: { tab_id: null, name: 'Tipo: Acción', color: '#b76b3d', position: 1 } },
    { op: 'insert', table: 'tasks.families', id: C_FAM, fields: { tab_id: MEJ, name: ' tipo: accion ', color: '#b76b3d', position: 9 } },
    { op: 'insert', table: 'tasks.families', id: R_FAM, fields: { tab_id: RET, name: 'Tipo: Acción', color: '#b76b3d', position: 9 } },
  ]);
  await ok([label(FONT, null, ACC, 'Fontanería'), label(PINT, null, ACC, 'Pintura'), label(ELEC, null, ACC, 'Electricidad'), label(LIMP, null, ACC, 'Limpieza'),
    label(JARD, null, ACC, 'Jardinería'), label(C_PINT, MEJ, C_FAM, 'pintura'), label(C_FONT, MEJ, C_FAM, 'Fontaneria'), label(R_PINT, RET, R_FAM, 'Pintura')]);
  await ok([label(ACS, null, ACC, 'ACS', FONT), label(GRIFO, null, ACC, 'Grifería', FONT), label(CESPED, null, ACC, 'Césped', JARD), label(C_ACS, MEJ, C_FAM, 'acs', C_FONT),
    { op: 'insert', table: 'tasks.projects', id: P, fields: { tab_id: TAB, title: 'Obras', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: PM, fields: { tab_id: MEJ, title: 'Mejoras 2026', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: PR, fields: { tab_id: RET, title: 'Otoño', position: 2048 } }]);
  // La copia de Retiros ya estaba archivada antes de todo esto: no se toca.
  const rf = (await rows('tasks.families')).find((f) => f.id === R_FAM);
  const rl = (await rows('tasks.labels')).find((l) => l.id === R_PINT);
  await ok([{ op: 'update', table: 'tasks.families', id: R_FAM, expectedRevision: rf.revision, fields: { archived: true } },
    { op: 'update', table: 'tasks.labels', id: R_PINT, expectedRevision: rl.revision, fields: { archived: true, archived_before_family: false } }]);
  const t = (id: string, tab: string, p: string, title: string) => ({ op: 'insert', table: 'tasks.tasks', id, fields: { tab_id: tab, project_id: p, title, position: 1024 } } as Operation);
  await ok([t(T_ACS, TAB, P, 'Revisar ACS'), t(T_FONT, TAB, P, 'Llamar al fontanero'), t(T_GRIFO, TAB, P, 'Cambiar grifo'), t(T_PINT, TAB, P, 'Pintar pasillo'),
    t(T_ELEC, TAB, P, 'Revisar cuadro'), t(T_LIMP, TAB, P, 'Limpiar y pintar'), t(T_JARD, TAB, P, 'Segar'), t(T_MEJ, MEJ, PM, 'Pintar porche'), t(T_MEJ2, MEJ, PM, 'Termo nuevo'),
    t(T_RET, RET, PR, 'Pintar sala'),
    { op: 'insert', table: 'tasks.project_labels', id: uuid(), fields: { tab_id: TAB, project_id: P, label_id: PINT } }]);
  await ok([tl(TAB, P, T_ACS, FONT), tl(TAB, P, T_ACS, ACS), tl(TAB, P, T_FONT, FONT), tl(TAB, P, T_GRIFO, GRIFO), tl(TAB, P, T_PINT, PINT), tl(TAB, P, T_ELEC, ELEC),
    tl(TAB, P, T_LIMP, LIMP), tl(TAB, P, T_LIMP, PINT), tl(TAB, P, T_JARD, JARD), tl(TAB, P, T_JARD, CESPED), tl(MEJ, PM, T_MEJ, C_PINT), tl(MEJ, PM, T_MEJ2, C_FONT),
    tl(MEJ, PM, T_MEJ2, C_ACS), tl(RET, PR, T_RET, R_PINT)]);
  await ok([{ op: 'insert', table: 'tasks.saved_views', id: VIEW, fields: { tab_id: TAB, name: 'Fontanería sin ACS', filters: { [ACC]: [FONT], _exclude: [ACS] }, group_by: ACC, position: 1 } },
    { op: 'insert', table: 'tasks.saved_views', id: VIEW2, fields: { tab_id: MEJ, name: 'Pintura', filters: { [C_FAM]: [C_PINT] }, group_by: 'project', position: 1 } }]);
});
test.after(async () => { await app.close(); });

test('dominio · la correspondencia: por origen, por ruta sin mayúsculas ni tildes, las copias con el oficio de la General y las ambiguas', () => {
  assert.equal(normalizeTradeText('  Fontanería ›   ACS '), 'fontaneria › acs');
  const fam = [{ id: 'g', name: 'Tipo: Acción', deleted_at: null }, { id: 'c', name: 'tipo: accion', deleted_at: null }, { id: 'o', name: 'Oficio', deleted_at: null }];
  const l = (id: string, family: string, name: string, parent: string | null = null, tab: string | null = null) => ({ id, family_id: family, name, parent_id: parent, tab_id: tab, deleted_at: null });
  const labels = [l('pint', 'g', 'Pintura'), l('cpint', 'c', 'PINTURA', null, 'mej'), l('font', 'g', 'Fontanería'), l('acs', 'g', 'Acs', 'font'), l('dup', 'g', 'Duplicada'), l('otra', 'o', 'Pintura')];
  const options = [
    { trade_id: 'T1', parent_id: null, name: 'Pintura y barniz', path: 'Pintura y barniz', source_label_id: 'pint' },
    { trade_id: 'T2', parent_id: null, name: 'Fontaneria', path: 'Fontaneria', source_label_id: null },
    { trade_id: 'T3', parent_id: 'T2', name: 'ACS', path: 'Fontaneria › ACS', source_label_id: null },
    { trade_id: 'T4', parent_id: null, name: 'Duplicada', path: 'Duplicada', source_label_id: null },
    { trade_id: 'T5', parent_id: null, name: 'Duplicáda', path: 'Duplicáda', source_label_id: null },
  ];
  const map = Object.fromEntries(actionTradeMap(fam, labels, options).map((m) => [m.labelId, [m.tradeId, m.by, m.reason]]));
  assert.deepEqual(map.pint, ['T1', 'source', null]);
  assert.deepEqual(map.cpint, ['T1', 'path', null], 'la copia de área casa con el oficio de la General aunque Central lo renombró');
  assert.deepEqual(map.font, ['T2', 'path', null]);
  assert.deepEqual(map.acs, ['T3', 'path', null]);
  assert.deepEqual(map.dup, [null, null, 'several_trades']);
  assert.equal(map.otra, undefined, 'solo la familia «Tipo: Acción»');
});

test('Central vacía o ilegible: la vista previa lo dice y la ida se niega; nunca «todo dudoso»', async () => {
  const empty = await preview();
  assert.equal(empty.status, 200, JSON.stringify(empty.data));
  assert.equal(empty.data.centralEmpty, true);
  assert.equal((await actions('to-trades', { remove: [ELEC] })).data.error?.code, 'CENTRAL_TRADES_EMPTY');
  // Sin permiso de lectura de Central (o caída): error claro.
  const saved = (await sql(`select * from core.allowed_reads where app = 'tasks' and name = 'central.trade_options'`)).rows[0] as any;
  await sql(`delete from core.allowed_reads where app = 'tasks' and name = 'central.trade_options'`);
  try {
    const down = await preview();
    assert.equal(down.status, 503);
    assert.equal(down.data.error.code, 'CENTRAL_UNAVAILABLE');
  } finally {
    await sql(`insert into core.allowed_reads (app, name, kind, roles) values ($1, $2, $3, $4)`, [saved.app, saved.name, saved.kind, saved.roles]);
  }
});

test('vista previa: por origen y por ruta, las copias con el mismo oficio, la dudosa y las cubiertas; solo la propietaria con acceso a todo', async () => {
  await trade(TR_FONT, 'Fontanería');
  await trade(TR_ACS, 'ACS', TR_FONT, ACS);
  await trade(TR_GRIFO, 'Griferia', TR_FONT);
  await trade(TR_PINT, 'Pintura y barniz', null, PINT);
  await trade(TR_CESPED, 'Césped', null, CESPED);
  await trade(TR_OLD, 'Electricidad', null, null, false);
  await trade(TR_TMP, 'Temporal');

  assert.equal((await preview({}, app.tokens.editor)).status, 403);
  await sql(`update core.memberships set role = 'owner', scopes = $2::jsonb where app = 'tasks' and user_id = $1`, [app.users.editor, JSON.stringify({ tabs: [TAB] })]);
  try {
    assert.equal((await preview({}, app.tokens.editor)).status, 403, 'una propietaria sin acceso a todo, tampoco');
    assert.equal((await actions('to-trades', { remove: [ELEC] }, app.tokens.editor)).status, 403);
  } finally {
    await sql(`update core.memberships set role = 'editor', scopes = '"*"'::jsonb where app = 'tasks' and user_id = $1`, [app.users.editor]);
  }

  const out = (await preview()).data;
  assert.equal(out.source, 'labels');
  assert.equal(out.centralEmpty, undefined);
  assert.deepEqual([...out.families].sort(), [ACC, C_FAM].sort(), 'la copia archivada de Retiros no entra');
  const mapped = Object.fromEntries(out.mapped.map((m: any) => [m.labelId, [m.tradeId, m.tasks, m.projects]]));
  assert.deepEqual(mapped[ACS], [TR_ACS, 1, 0], 'por origen');
  assert.deepEqual(mapped[FONT], [TR_FONT, 1, 0], 'por ruta; en «Revisar ACS» cuenta la hija');
  assert.deepEqual(mapped[GRIFO], [TR_GRIFO, 1, 0], 'por ruta, sin tildes');
  assert.deepEqual(mapped[PINT], [TR_PINT, 2, 1]);
  assert.deepEqual(mapped[CESPED], [TR_CESPED, 1, 0]);
  assert.deepEqual(mapped[C_PINT], [TR_PINT, 1, 0], 'la copia de área, con el oficio de la General');
  assert.deepEqual(mapped[C_ACS], [TR_ACS, 1, 0]);
  assert.deepEqual(mapped[C_FONT], [TR_FONT, 0, 0]);
  assert.equal(out.mapped.find((m: any) => m.labelId === ACS).tradePath, 'Fontanería › ACS');
  // Electricidad: su oficio está archivado en Central (no sale en trade_options) y deja a «Revisar cuadro» sin oficio.
  assert.deepEqual(out.doubtful.map((d: any) => [d.labelId, d.reason, d.tasks, d.withoutTrade, d.sample]), [[ELEC, 'no_trade', 1, 1, ['Revisar cuadro']]]);
  assert.deepEqual(out.removed.map((r: any) => [r.name, r.reason, r.withoutTrade]).sort(), [['Jardinería', 'covered', 0], ['Limpieza', 'covered', 0]]);
  assert.deepEqual(out.counts, { tasks: 8, projects: 1, withoutTrade: 1, views: 2 });
  const marked = (await preview({ remove: [ELEC] })).data;
  assert.deepEqual(marked.doubtful, []);
  assert.deepEqual(marked.removed.map((r: any) => [r.name, r.reason]).sort(), [['Electricidad', 'marked'], ['Jardinería', 'covered'], ['Limpieza', 'covered']]);
});

test('ida: no se aplica con dudosas; con ellas marcadas, lo más hondo, la madre sola, vistas, archivado sin borrar y copia intacta', async () => {
  const refused = await actions('to-trades');
  assert.equal(refused.status, 422);
  assert.equal(refused.data.error.code, 'TRADES_DOUBTFUL', JSON.stringify(refused.data));
  assert.deepEqual(refused.data.error.details.labels.map((l: any) => l.labelId), [ELEC]);
  assert.equal((await actions('to-trades', { remove: [ELEC] }, app.tokens.editor)).status, 403);
  // Una correspondencia falsificada con un oficio archivado no pasa: el procedimiento lo revalida con central.trade_alive.
  const forged = await app.t.rpc('core_commit', { p_app: 'tasks', p_actor: app.users.owner, p_request_id: 'forged', p_digest: 'forged', p_expected_cursor: null,
    p_operations: [{ op: 'call', procedure: 'tasks.actions_to_trades', args: { remove: [], map: [{ labelId: ELEC, tradeId: TR_OLD }] } }] }).then(() => null, (e: any) => e);
  assert.equal(forged?.code, 'INVALID_TRADE');

  const done = await actions('to-trades', { remove: [ELEC] });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.deepEqual(done.data.counts, { taskTrades: 8, projectTrades: 1, views: 2, labels: 11, families: 2 });

  assert.deepEqual(await liveTrades('tasks.task_trades', 'task_id', T_ACS), [TR_ACS], 'con madre e hija, solo la hija');
  assert.deepEqual(await liveTrades('tasks.task_trades', 'task_id', T_FONT), [TR_FONT], 'la madre sola pasa a su propio oficio');
  assert.deepEqual(await liveTrades('tasks.task_trades', 'task_id', T_GRIFO), [TR_GRIFO]);
  assert.deepEqual(await liveTrades('tasks.task_trades', 'task_id', T_LIMP), [TR_PINT], 'la cubierta no impide la ida');
  assert.deepEqual(await liveTrades('tasks.task_trades', 'task_id', T_JARD), [TR_CESPED]);
  assert.deepEqual(await liveTrades('tasks.task_trades', 'task_id', T_ELEC), [], 'la marcada para quitar no da oficio');
  assert.deepEqual(await liveTrades('tasks.task_trades', 'task_id', T_MEJ), [TR_PINT], 'la copia de área, con el mismo oficio');
  assert.deepEqual(await liveTrades('tasks.task_trades', 'task_id', T_MEJ2), [TR_ACS]);
  assert.deepEqual(await liveTrades('tasks.task_trades', 'task_id', T_RET), [], 'la copia archivada no se toca');
  assert.deepEqual(await liveTrades('tasks.project_trades', 'project_id', P), [TR_PINT]);
  assert.equal((await rows('tasks.task_trades')).find((r) => r.task_id === T_MEJ).tab_id, MEJ);

  const views = await rows('tasks.saved_views');
  assert.deepEqual(views.find((v) => v.id === VIEW).filters, { _trade: [TR_FONT], _exclude: [TR_ACS] });
  assert.equal(views.find((v) => v.id === VIEW).group_by, '_trade');
  assert.deepEqual(views.find((v) => v.id === VIEW2).filters, { _trade: [TR_PINT] });

  const families = await rows('tasks.families');
  assert.deepEqual([ACC, C_FAM, R_FAM].map((id) => families.find((f) => f.id === id).archived), [true, true, true]);
  const labels = await rows('tasks.labels');
  assert.ok(labels.filter((l) => [ACC, C_FAM].includes(l.family_id)).every((l) => l.archived && l.archived_before_family === false && !l.deleted_at), 'archivadas, nunca borradas');
  assert.deepEqual([labels.find((l) => l.id === R_PINT).archived, labels.find((l) => l.id === R_PINT).revision], [true, 2], 'la copia archivada de antes, intacta');
  assert.deepEqual(await labelsOf(T_ACS), [FONT, ACS].sort(), 'la copia en etiquetas sigue intacta');
  assert.deepEqual(await labelsOf(T_ELEC), [ELEC]);
  const settings = Object.fromEntries((await rows('tasks.settings')).filter((s) => !s.deleted_at).map((s) => [s.key, s.value]));
  assert.equal(settings.trade_source, 'central');
  assert.deepEqual([...settings.trade_families].sort(), [ACC, C_FAM].sort());
  assert.equal((await actions('to-trades', { remove: [ELEC] })).status, 409, 'una sola vez');
});

test('hook: oficio vivo y activo (central.trade_alive), sin repetir, con las claves de su tarea; vistas con `_trade`; la tarea nueva hereda el del proyecto', async () => {
  const add = (task: string, tradeId: string, project = P, tab = TAB) => commit([{ op: 'insert', table: 'tasks.task_trades', id: uuid(), fields: { tab_id: tab, project_id: project, task_id: task, trade_id: tradeId } }]);
  assert.equal((await add(T_ELEC, uuid())).data.error?.code, 'INVALID_TRADE', 'no existe');
  assert.equal((await add(T_ELEC, TR_OLD)).data.error?.code, 'INVALID_TRADE', 'archivado en Central');
  assert.equal((await add(T_ACS, TR_ACS)).data.error?.code, 'INVALID_TRADES', 'repetido');
  assert.equal((await add(T_ELEC, TR_GRIFO, PM, MEJ)).data.error?.code, 'INCONSISTENT_KEYS');
  assert.equal((await add(T_ELEC, TR_GRIFO)).status, 200);
  assert.equal((await commit([{ op: 'insert', table: 'tasks.project_trades', id: uuid(), fields: { tab_id: TAB, project_id: P, trade_id: TR_OLD } }])).data.error?.code, 'INVALID_TRADE');

  // Vistas: `_trade` y agrupar por `_trade`, con oficios vivos; uno que Central archive después no impide editar la vista.
  const bad = await commit([{ op: 'insert', table: 'tasks.saved_views', id: uuid(), fields: { tab_id: TAB, name: 'Vieja', filters: { _trade: [TR_OLD] }, group_by: '_trade', position: 3 } }]);
  assert.equal(bad.data.error?.code, 'INVALID_VIEW');
  await ok([{ op: 'insert', table: 'tasks.saved_views', id: VIEW3, fields: { tab_id: TAB, name: 'Temporal', filters: { _trade: [TR_TMP], _exclude: [TR_GRIFO] }, group_by: '_trade', position: 3 } }]);
  await sql(`update central.trades set active = false where id = $1`, [TR_TMP]);
  const v3 = (await rows('tasks.saved_views')).find((v) => v.id === VIEW3);
  await ok([{ op: 'update', table: 'tasks.saved_views', id: VIEW3, expectedRevision: v3.revision, fields: { name: 'Temporal (archivado)' } }]);

  // La tarea nueva de un proyecto con oficio lo hereda, como el espacio.
  const data = emptyDataset();
  data['tasks.projects'] = await rows('tasks.projects');
  data['tasks.tasks'] = await rows('tasks.tasks');
  data['tasks.project_trades'] = await rows('tasks.project_trades');
  created = uuid();
  await ok(createTaskOps(data, { id: created, project_id: P, title: 'Pintar puerta', labelIds: [] }));
  assert.deepEqual(await liveTrades('tasks.task_trades', 'task_id', created), [TR_PINT]);
});

test('vuelta atrás: avisa de lo que se perdería; vuelve a etiquetas con lo cambiado, desarchiva lo que archivó y deja los oficios en la papelera', async () => {
  // Un oficio que no viene de ninguna etiqueta: se perdería.
  await trade(TR_NEW, 'Carpintería');
  assert.equal((await commit([{ op: 'insert', table: 'tasks.task_trades', id: uuid(), fields: { tab_id: TAB, project_id: P, task_id: T_ELEC, trade_id: TR_NEW } }])).status, 200);
  const lost = (await preview()).data;
  assert.equal(lost.source, 'central');
  assert.deepEqual(lost.lost.map((l: any) => [l.tradeId, l.tradePath, l.tasks]), [[TR_NEW, 'Carpintería', 1]]);
  assert.equal((await actions('to-labels', {}, app.tokens.editor)).status, 403);
  const refused = await actions('to-labels');
  assert.equal(refused.data.error?.code, 'TRADES_UNMAPPED');
  assert.deepEqual(refused.data.error.details.tradeIds, [TR_NEW]);

  // Mientras tanto, a «Pintar pasillo» se le cambió la pintura por el ACS.
  const link = (await rows('tasks.task_trades')).find((r) => r.task_id === T_PINT && !r.deleted_at);
  await ok([{ op: 'delete', table: 'tasks.task_trades', id: link.id, expectedRevision: link.revision },
    { op: 'insert', table: 'tasks.task_trades', id: uuid(), fields: { tab_id: TAB, project_id: P, task_id: T_PINT, trade_id: TR_ACS } }]);

  const back = await actions('to-labels', { dropUnmapped: true });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.deepEqual(await labelsOf(T_PINT), [FONT, ACS].sort(), 'lo cambiado vuelve, la hija con su madre');
  assert.deepEqual(await labelsOf(T_ACS), [FONT, ACS].sort());
  assert.deepEqual(await labelsOf(T_FONT), [FONT]);
  assert.deepEqual(await labelsOf(T_JARD), [JARD, CESPED].sort());
  assert.deepEqual(await labelsOf(T_LIMP), [PINT], '«Limpieza», sin oficio, se quitó en la ida y no vuelve');
  assert.deepEqual(await labelsOf(T_ELEC), [FONT, GRIFO].sort(), 'la marcada se fue; la carpintería se pierde con dropUnmapped');
  assert.deepEqual(await labelsOf(T_MEJ), [C_PINT], 'la copia de área que ya tenía, no la General');
  assert.deepEqual(await labelsOf(T_MEJ2), [C_FONT, C_ACS].sort());
  assert.deepEqual(await labelsOf(T_RET), [R_PINT]);
  assert.deepEqual(await labelsOf(created), [PINT], 'la tarea creada con oficio vuelve con su etiqueta');
  assert.deepEqual((await rows('tasks.project_labels')).filter((r) => r.project_id === P && !r.deleted_at).map((r) => r.label_id), [PINT]);
  assert.equal((await rows('tasks.task_trades')).filter((r) => !r.deleted_at).length, 0);
  assert.equal((await rows('tasks.project_trades')).filter((r) => !r.deleted_at).length, 0);

  const families = await rows('tasks.families');
  assert.deepEqual([ACC, C_FAM, R_FAM].map((id) => families.find((f) => f.id === id).archived), [false, false, true], 'Retiros sigue como estaba');
  const labels = await rows('tasks.labels');
  assert.ok(labels.filter((l) => [ACC, C_FAM].includes(l.family_id)).every((l) => !l.archived && l.archived_before_family === null));
  const views = await rows('tasks.saved_views');
  assert.deepEqual(views.find((v) => v.id === VIEW).filters, { [ACC]: [FONT], _exclude: [ACS] });
  assert.equal(views.find((v) => v.id === VIEW).group_by, ACC);
  assert.deepEqual(views.find((v) => v.id === VIEW2).filters, { [C_FAM]: [C_PINT] }, 'en Mejoras, su copia');
  assert.deepEqual(views.find((v) => v.id === VIEW3).filters, { _exclude: [GRIFO] }, 'el oficio archivado sin etiqueta se cae');
  const settings = Object.fromEntries((await rows('tasks.settings')).filter((s) => !s.deleted_at).map((s) => [s.key, s.value]));
  assert.equal(settings.trade_source, 'labels');
  assert.deepEqual(settings.trade_families, []);
  assert.equal((await actions('to-labels')).status, 409);
  // Y otra vez a oficios: la copia sigue sirviendo.
  assert.equal((await actions('to-trades', { remove: [ELEC] })).status, 200);
  assert.deepEqual(await liveTrades('tasks.task_trades', 'task_id', T_PINT), [TR_ACS]);
});

test('lo que mueve o crea tareas conoce sus oficios: petición de otra app, convertir un área y vaciar la papelera', async () => {
  const asked = await app.call('/api/v1/requests/task', { body: { source: 'central', external_ref: 'LEG_P2_001', title: 'Revisar pintura', project_id: P } });
  assert.equal(asked.status, 200, JSON.stringify(asked.data));
  const project = (await liveTrades('tasks.project_trades', 'project_id', P));
  assert.deepEqual(await liveTrades('tasks.task_trades', 'task_id', asked.data.task.id), project);

  const OLD = uuid(), OP = uuid(), OT = uuid(), NEWP = uuid();
  await ok(createTabOps({ id: OLD, name: 'Taller', position: 9000 }));
  await ok([{ op: 'insert', table: 'tasks.projects', id: OP, fields: { tab_id: OLD, title: 'Bancos', position: 2048 } }]);
  await ok([{ op: 'insert', table: 'tasks.tasks', id: OT, fields: { tab_id: OLD, project_id: OP, title: 'Lijar', position: 1024 } }]);
  await ok([{ op: 'insert', table: 'tasks.task_trades', id: uuid(), fields: { tab_id: OLD, project_id: OP, task_id: OT, trade_id: TR_GRIFO } }]);
  const converted = await app.call(`/api/v1/tabs/${OLD}/convert`, { body: { requestId: `cv-${++seq}`, targetTabId: TAB, projectId: NEWP, title: 'Taller' } });
  assert.equal(converted.status, 200, JSON.stringify(converted.data));
  const moved = (await rows('tasks.task_trades')).find((r) => r.task_id === OT && !r.deleted_at);
  assert.deepEqual([moved.tab_id, moved.project_id, moved.trade_id], [TAB, NEWP, TR_GRIFO]);

  const gone = (await rows('tasks.tasks')).find((t) => t.id === OT);
  await ok([{ op: 'delete', table: 'tasks.tasks', id: OT, expectedRevision: gone.revision }]);
  const emptied = await app.call('/api/v1/trash/empty', { body: { requestId: `tt-${++seq}` } });
  assert.equal(emptied.status, 200, JSON.stringify(emptied.data));
  assert.equal((await rows('tasks.tasks')).some((t) => t.id === OT), false);
  assert.equal((await rows('tasks.task_trades')).some((r) => r.task_id === OT), false);
});
