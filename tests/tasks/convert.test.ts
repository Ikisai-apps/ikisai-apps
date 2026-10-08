/**
 * Tasks · convertir un área en proyecto de otra (`POST tabs/:id/convert`, docs/tasks/API.md §24.4), de extremo a extremo
 * contra el núcleo y el hook reales. Prueba fuerte pedida por el usuario el 8-10-2026: un área con tareas, dependencias,
 * fotos, comentarios, compras, suministros, una regla y una línea de Finance enlazada a una tarea. Todo sigue con los
 * mismos ids y restaurar el área antigua desde la papelera no rompe nada.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
// Origen «Jardinería» (con su Entrada y un proyecto «Riego») y destino «Mantenimiento».
const JARDIN = uuid(), JARDIN_INBOX = uuid(), RIEGO = uuid(), MANT = uuid(), MANT_INBOX = uuid();
const ANA_J = uuid(), PODA = uuid(), ANA_M = uuid();
const T_REGAR = uuid(), T_PODAR = uuid(), T_SUB = uuid(), T_BORRADA = uuid(), T_ENTRADA = uuid();
const DEP = uuid(), DEP_BORRADA = uuid(), TL_PODA = uuid(), TL_ANA = uuid();
const FOTO = uuid(), PLANO = uuid(), FILE = uuid();
const ABONO = uuid(), CLORO_J = uuid(), CLORO_M = uuid(), MOV = uuid(), PLAN = uuid(), STOP = uuid(), COMPRA = uuid(), COMPRA_SUELTA = uuid();
const ROUTE = uuid();
const SUPPLIER = uuid(), INVOICE = uuid(), LINE = uuid(), ALLOC_TASK = uuid(), ALLOC_AREA = uuid();
let app: TestApp;
let seq = 0;

const rows = async (table: string) => (await app.call(`/api/v1/snapshot?tables=${table}&includeDeleted=1&limit=2000`)).data.tables[0].rows as any[];
const row = async (table: string, id: string) => (await rows(table)).find((r) => r.id === id);
// Las altas de la siembra llevan posición si su tabla la tiene (la API la exige).
const POSITIONED = new Set(['tasks.tasks', 'tasks.labels', 'tasks.task_dependencies', 'tasks.attachments', 'tasks.supply_items', 'tasks.purchase_requests', 'tasks.purchase_plan_stops', 'tasks.request_routes']);
const commit = (operations: Operation[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `seed-${++seq}`,
  operations: operations.map((o) => (o.op === 'insert' && POSITIONED.has(o.table ?? '') && o.fields?.position === undefined ? { ...o, fields: { ...o.fields, position: ++seq * 1024 } } : o)) } });
const ok = async (operations: Operation[]) => { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); return res; };
const convert = (body: Record<string, unknown>, token?: string, tab = JARDIN) => app.call(`/api/v1/tabs/${tab}/convert`, { token, body: { requestId: `convert-${++seq}`, ...body } });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  const jardin = createTabOps({ id: JARDIN, name: 'Jardinería', position: 1024, inboxId: JARDIN_INBOX });
  const mant = createTabOps({ id: MANT, name: 'Mantenimiento', position: 2048, inboxId: MANT_INBOX });
  const fam = (ops: Operation[], key: string) => ops.find((o) => o.fields?.system_key === key)!.id!;
  await ok([...jardin, ...mant]);
  await ok([
    { op: 'insert', table: 'tasks.projects', id: RIEGO, fields: { tab_id: JARDIN, title: 'Riego', position: 2048 } },
    { op: 'insert', table: 'tasks.labels', id: ANA_J, fields: { tab_id: JARDIN, family_id: fam(jardin, 'person'), name: 'Ana' } },
    { op: 'insert', table: 'tasks.labels', id: PODA, fields: { tab_id: JARDIN, family_id: fam(jardin, 'phase'), name: 'Poda' } },
    // En el destino ya hay una «Ana» en Persona: se reutiliza; «Poda» no existe y se crea.
    { op: 'insert', table: 'tasks.labels', id: ANA_M, fields: { tab_id: MANT, family_id: fam(mant, 'person'), name: 'ana' } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.tasks', id: T_REGAR, fields: { tab_id: JARDIN, project_id: RIEGO, title: 'Revisar goteros', note: 'Comentario: el sector norte pierde agua.', owner_label_id: ANA_J } },
    { op: 'insert', table: 'tasks.tasks', id: T_PODAR, fields: { tab_id: JARDIN, project_id: RIEGO, title: 'Podar setos' } },
    { op: 'insert', table: 'tasks.tasks', id: T_SUB, fields: { tab_id: JARDIN, project_id: RIEGO, parent_id: T_PODAR, title: 'Afilar tijeras' } },
    { op: 'insert', table: 'tasks.tasks', id: T_BORRADA, fields: { tab_id: JARDIN, project_id: RIEGO, title: 'Vieja' } },
    { op: 'insert', table: 'tasks.tasks', id: T_ENTRADA, fields: { tab_id: JARDIN, project_id: JARDIN_INBOX, title: 'Llamar al jardinero', done: true } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.task_dependencies', id: DEP, fields: { tab_id: JARDIN, project_id: RIEGO, task_id: T_PODAR, depends_on_id: T_REGAR } },
    { op: 'insert', table: 'tasks.task_dependencies', id: DEP_BORRADA, fields: { tab_id: JARDIN, project_id: RIEGO, task_id: T_REGAR, depends_on_id: T_BORRADA } },
    { op: 'insert', table: 'tasks.task_labels', id: TL_PODA, fields: { tab_id: JARDIN, project_id: RIEGO, task_id: T_PODAR, label_id: PODA } },
    { op: 'insert', table: 'tasks.task_labels', id: TL_ANA, fields: { tab_id: JARDIN, project_id: RIEGO, task_id: T_PODAR, label_id: ANA_J } },
  ]);
  // La tarea vieja, a la papelera (su dependencia queda viva hasta la conversión).
  await ok([{ op: 'delete', table: 'tasks.tasks', id: T_BORRADA, expectedRevision: (await row('tasks.tasks', T_BORRADA)).revision }]);
  // Fotos: una de la tarea y un plano del proyecto.
  const sha = 'cd'.repeat(32);
  await app.t.db.query(`insert into core.files (id, app, bucket, path, filename, mime, size, sha256, status) values ($1, 'tasks', 'ikisai-files', 'tasks/2026/c/foto.jpg', 'foto.jpg', 'image/jpeg', 900, $2, 'verified')`, [FILE, sha]);
  await ok([
    { op: 'insert', table: 'tasks.attachments', id: FOTO, fields: { tab_id: JARDIN, project_id: RIEGO, task_id: T_REGAR, name: 'goteo.jpg', mime: 'image/jpeg', size: 900, sha256: sha, file_id: FILE } },
    { op: 'insert', table: 'tasks.attachments', id: PLANO, fields: { tab_id: JARDIN, project_id: RIEGO, name: 'plano.jpg', mime: 'image/jpeg', size: 900, sha256: sha, file_id: FILE } },
  ]);
  // Suministros (uno con el mismo nombre que uno del destino), un plan con su parada y compras.
  await ok([
    { op: 'insert', table: 'tasks.supply_items', id: ABONO, fields: { tab_id: JARDIN, name: 'Abono', unit: 'kg' } },
    { op: 'insert', table: 'tasks.supply_items', id: CLORO_J, fields: { tab_id: JARDIN, name: 'Cloro' } },
    { op: 'insert', table: 'tasks.supply_items', id: CLORO_M, fields: { tab_id: MANT, name: 'cloro' } },
    { op: 'insert', table: 'tasks.purchase_plans', id: PLAN, fields: { tab_id: JARDIN, title: 'Vivero del sábado' } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.purchase_plan_stops', id: STOP, fields: { tab_id: JARDIN, plan_id: PLAN, supplier_name: 'Vivero Sur' } },
    { op: 'insert', table: 'tasks.purchase_requests', id: COMPRA, fields: { tab_id: JARDIN, project_id: RIEGO, task_id: T_REGAR, supply_item_id: ABONO, title: 'Goteros nuevos', status: 'requested' } },
    { op: 'insert', table: 'tasks.purchase_requests', id: COMPRA_SUELTA, fields: { tab_id: JARDIN, title: 'Guantes', status: 'requested' } },
  ]);
  await ok([{ op: 'update', table: 'tasks.purchase_requests', id: COMPRA, expectedRevision: 1, fields: { status: 'approved', plan_stop_id: STOP } }]);
  await ok([{ op: 'insert', table: 'tasks.supply_movements', id: MOV, fields: { tab_id: JARDIN, supply_item_id: ABONO, kind: 'in', delta: 5 } }]);
  // Una regla de entrada al proyecto «Riego» con Ana de responsable.
  await ok([{ op: 'insert', table: 'tasks.request_routes', id: ROUTE, fields: { kind: 'feedback.space.garden', tab_id: JARDIN, project_id: RIEGO, owner_label_id: ANA_J } }]);
  // Finance: una línea asignada a la tarea (se conserva) y otra al área (la vista previa la avisa: hay que reasignarla).
  await app.t.db.query(`insert into invoices.suppliers (id, name, slug) values ($1, 'Vivero Sur', 'vivero_sur')`, [SUPPLIER]);
  await app.t.db.query(`insert into invoices.invoices (id, supplier_id, invoice_date, object, code) values ($1, $2, '2026-10-01', 'Material de riego', 'F-2026-0001')`, [INVOICE, SUPPLIER]);
  await app.t.db.query(`insert into invoices.invoice_lines (id, invoice_id, position, description, net_amount) values ($1, $2, 0, 'Goteros', 40)`, [LINE, INVOICE]);
  await app.t.db.query(`insert into invoices.allocations (id, invoice_line_id, invoice_id, target_app, target_kind, target_id, target_label, allocated_amount) values
    ($1, $3, $4, 'tasks', 'task', $5, 'Revisar goteros', 30), ($2, $3, $4, 'tasks', 'area', $6, 'Jardinería', 10)`, [ALLOC_TASK, ALLOC_AREA, LINE, INVOICE, T_REGAR, JARDIN]);
});
test.after(async () => { await app.close(); });

test('solo la propietaria con acceso completo, a un área distinta y viva, con nombre', async () => {
  assert.equal((await convert({ targetTabId: MANT, title: 'Jardinería' }, app.tokens.editor)).status, 403);
  assert.equal((await convert({ targetTabId: JARDIN, title: 'Jardinería' })).status, 422);
  assert.equal((await convert({ targetTabId: MANT, title: '  ' })).status, 422);
  assert.equal((await convert({ targetTabId: uuid(), title: 'Jardinería' })).status, 404);
  assert.equal((await row('tasks.tabs', JARDIN)).deleted_at, null, 'nada cambia si se rechaza');
});

test('convertir: mismos ids en un proyecto nuevo, con etiquetas, dependencias, fotos, compras, suministros, regla y Finance', async () => {
  const before = await rows('tasks.tasks');
  const res = await convert({ targetTabId: MANT, title: 'Jardinería' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const project = res.data.projectId as string;
  assert.deepEqual(res.data.counts, { tasks: 4, labelsCreated: 1, dependencies: 1, attachments: 2, supplies: 2, suppliesRenamed: 1, purchaseRequests: 2, routes: 1 });

  const created = await row('tasks.projects', project);
  assert.deepEqual([created.tab_id, created.title, created.deleted_at], [MANT, 'Jardinería', null]);
  // Tareas vivas (de «Riego» y de la Entrada), con sus mismos ids, comentario, estado y subtarea.
  for (const id of [T_REGAR, T_PODAR, T_SUB, T_ENTRADA]) {
    const t = await row('tasks.tasks', id);
    assert.deepEqual([t.tab_id, t.project_id, t.deleted_at], [MANT, project, null], id);
    assert.equal(t.created_at, before.find((b) => b.id === id).created_at);
  }
  assert.equal((await row('tasks.tasks', T_REGAR)).note, 'Comentario: el sector norte pierde agua.');
  assert.equal((await row('tasks.tasks', T_REGAR)).owner_label_id, ANA_M, 'la responsable, la «Ana» del destino');
  assert.equal((await row('tasks.tasks', T_SUB)).parent_id, T_PODAR);
  assert.equal((await row('tasks.tasks', T_ENTRADA)).done, true);
  // Lo que estaba en la papelera se queda con el área antigua.
  assert.deepEqual([(await row('tasks.tasks', T_BORRADA)).tab_id, (await row('tasks.tasks', T_BORRADA)).project_id], [JARDIN, RIEGO]);

  // Etiquetas por nombre: «Ana» reutilizada, «Poda» creada en la familia Fase del destino.
  const labels = (await rows('tasks.task_labels')).filter((l) => l.task_id === T_PODAR && !l.deleted_at);
  const poda = (await rows('tasks.labels')).find((l) => l.tab_id === MANT && l.name === 'Poda' && !l.deleted_at);
  assert.ok(poda, 'se crea «Poda» en Mantenimiento');
  assert.deepEqual(labels.map((l) => l.label_id).sort(), [ANA_M, poda.id].sort());
  assert.ok(labels.every((l) => l.tab_id === MANT && l.project_id === project));
  assert.deepEqual(labels.map((l) => l.id).sort(), [TL_ANA, TL_PODA].sort(), 'mismas filas');

  // Dependencias: la viva sigue; la que apuntaba a la tarea borrada se retira.
  assert.deepEqual([(await row('tasks.task_dependencies', DEP)).tab_id, (await row('tasks.task_dependencies', DEP)).project_id], [MANT, project]);
  assert.ok((await row('tasks.task_dependencies', DEP_BORRADA)).deleted_at);

  // Fotos: la de la tarea y la del proyecto, al proyecto nuevo, con el mismo archivo.
  for (const id of [FOTO, PLANO]) {
    const a = await row('tasks.attachments', id);
    assert.deepEqual([a.tab_id, a.project_id, a.file_id, a.deleted_at], [MANT, project, FILE, null]);
  }
  assert.equal((await row('tasks.attachments', FOTO)).task_id, T_REGAR);

  // Compras y almacén: al destino, con sus enlaces; el «Cloro» repetido se renombra.
  const compra = await row('tasks.purchase_requests', COMPRA);
  assert.deepEqual([compra.tab_id, compra.project_id, compra.task_id, compra.supply_item_id, compra.plan_stop_id, compra.status], [MANT, project, T_REGAR, ABONO, STOP, 'approved']);
  assert.deepEqual([(await row('tasks.purchase_requests', COMPRA_SUELTA)).tab_id, (await row('tasks.purchase_requests', COMPRA_SUELTA)).project_id], [MANT, null]);
  assert.equal((await row('tasks.purchase_plans', PLAN)).tab_id, MANT);
  assert.equal((await row('tasks.purchase_plan_stops', STOP)).tab_id, MANT);
  assert.equal((await row('tasks.supply_movements', MOV)).tab_id, MANT);
  assert.equal((await row('tasks.supply_items', ABONO)).name, 'Abono');
  assert.deepEqual([(await row('tasks.supply_items', CLORO_J)).tab_id, (await row('tasks.supply_items', CLORO_J)).name], [MANT, 'Cloro · Jardinería']);

  // La regla, al proyecto nuevo con la «Ana» del destino.
  const route = await row('tasks.request_routes', ROUTE);
  assert.deepEqual([route.tab_id, route.project_id, route.owner_label_id], [MANT, project, ANA_M]);

  // El área antigua, a la papelera; sus proyectos quedan con ella.
  assert.ok((await row('tasks.tabs', JARDIN)).deleted_at);
  assert.equal((await row('tasks.projects', RIEGO)).tab_id, JARDIN);

  // Finance: la línea de la tarea sigue apuntando al mismo id, que ahora está en Mantenimiento.
  const target = await app.call('/api/v1/read/tasks.targets', { body: { kind: 'task', id: T_REGAR } });
  assert.equal(target.status, 200, JSON.stringify(target.data));
  assert.equal(target.data.id, T_REGAR);
  assert.equal((await app.t.db.query<{ target_id: string }>(`select target_id from invoices.allocations where id = $1`, [ALLOC_TASK])).rows[0]!.target_id, T_REGAR);

  // Con historial: un solo lote, con un cambio por fila.
  const changes = await app.t.db.query<{ cursor: string; n: string }>(`select cursor, count(*) n from core.changes where app = 'tasks' and table_name = 'tasks' and row_id = $1 group by cursor order by cursor desc limit 1`, [T_REGAR]);
  assert.equal(Number(changes.rows[0]!.cursor), Number(res.data.cursor));

  // Todo sigue funcionando: «Podar setos» sigue esperando a «Revisar goteros», y se puede editar.
  const sub = await row('tasks.tasks', T_SUB);
  const blocked = await commit([{ op: 'update', table: 'tasks.tasks', id: T_SUB, expectedRevision: sub.revision, fields: { done: true } }]);
  assert.equal(blocked.status, 422, JSON.stringify(blocked.data));
  assert.equal(blocked.data.error.code, 'TASK_BLOCKED');
  const regar = await row('tasks.tasks', T_REGAR);
  await ok([{ op: 'update', table: 'tasks.tasks', id: T_REGAR, expectedRevision: regar.revision, fields: { title: 'Revisar goteros del norte' } }]);
});

test('restaurar el área antigua desde la papelera no rompe nada', async () => {
  const tab = await row('tasks.tabs', JARDIN);
  await ok([{ op: 'restore', table: 'tasks.tabs', id: JARDIN, expectedRevision: tab.revision }]);
  const projects = (await rows('tasks.projects')).filter((p) => p.tab_id === JARDIN && !p.deleted_at).map((p) => p.title).sort();
  assert.deepEqual(projects, ['Entrada', 'Riego'], 'vuelve con su Entrada y sus proyectos, vacíos');
  assert.deepEqual([(await row('tasks.tasks', T_REGAR)).tab_id, (await row('tasks.purchase_requests', COMPRA)).tab_id], [MANT, MANT], 'lo convertido sigue en Mantenimiento');
  // Se puede trabajar en las dos áreas: una tarea nueva en «Riego» y la tarea vieja restaurada.
  await ok([{ op: 'insert', table: 'tasks.tasks', id: uuid(), fields: { tab_id: JARDIN, project_id: RIEGO, title: 'Nueva en el área restaurada' } }]);
  await ok([{ op: 'restore', table: 'tasks.tasks', id: T_BORRADA, expectedRevision: (await row('tasks.tasks', T_BORRADA)).revision }]);
  await ok([{ op: 'insert', table: 'tasks.tasks', id: uuid(), fields: { tab_id: MANT, project_id: (await row('tasks.tasks', T_REGAR)).project_id, title: 'Otra de jardinería', owner_label_id: ANA_M } }]);
});

test('fuera de la conversión, tab_id sigue siendo inmutable', async () => {
  const t = await row('tasks.tasks', T_REGAR);
  const res = await commit([{ op: 'update', table: 'tasks.tasks', id: T_REGAR, expectedRevision: t.revision, fields: { tab_id: JARDIN, project_id: RIEGO } }]);
  assert.equal(res.status, 422, JSON.stringify(res.data));
  assert.equal(res.data.error.code, 'IMMUTABLE_FIELD');
});
