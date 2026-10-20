/**
 * Ikisai Tasks · O1, pasos 3 y 4 (docs/tasks/API.md §31), en móvil de 390 px. La cuenta de lectura de las pruebas pasa a
 * outsider por SQL con un proyecto abierto. Comprueba que:
 * - su menú está reducido y las pantallas prohibidas no se abren ni por hash;
 * - el «+» propone una tarea, que sale «Pendiente» en «Mis propuestas»;
 * - la propietaria la aprueba en «Por clasificar» y el outsider la ve «Aprobada», con la tarea en su lista;
 * - «Proponer un cambio» en la ficha y el descarte con comentario;
 * - la propietaria abre otro proyecto con «Abrir a…» y el outsider pasa a verlo.
 * Nombres inventados. Capturas en `coordinacion/tasks/o1-despues/` (07 en adelante).
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, READER, startE2EServer, type E2EServer } from './e2e-server.ts';
import { menuRows, openApp, openMenu, routeStorage, settled } from './e2e-helpers.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const Sync: any, state: any, render: any, openProjectEditor: any, syncNow: any, navigateView: any, handleTopAction: any;

let server: E2EServer;
let outsiderContext: BrowserContext, ownerContext: BrowserContext;
let outsider: Page, owner: Page;
const errors: string[] = [];
const id = () => crypto.randomUUID();
const CASA = id(), JARDIN = id(), HUERTO = id(), CUENTAS = id(), T_SETO = id();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAa0lEQVR4nBXMQQ0AQQgAsRWGCEQgAhEVgQhEIOty32YyL0SKEi2IEStOvJApS7YkR648+UKlKtWKGrXq1AudunRrevTq0y/8i/IzhuV4YdKU6R9nzJozL2zasv2nO3bt2RcuXbn+Bzdu3bkPM+RkAfSGHXAAAAAASUVORK5CYII=', 'base64');

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  const ok = async (operations: any[]) => { const res = await server.commit(operations); expect(res.status, JSON.stringify(res.data)).toBe(200); };
  await ok(createTabOps({ id: CASA, name: 'Casa de campo', position: 1024 }));
  await ok([
    { op: 'insert', table: 'tasks.projects', id: JARDIN, fields: { tab_id: CASA, title: 'Jardín', position: 2048 } },
    { op: 'insert', table: 'tasks.projects', id: HUERTO, fields: { tab_id: CASA, title: 'Huerto', position: 3072 } },
    { op: 'insert', table: 'tasks.projects', id: CUENTAS, fields: { tab_id: CASA, title: 'Cuentas reservadas', position: 4096 } },
  ]);
  await ok([{ op: 'insert', table: 'tasks.tasks', id: T_SETO, fields: { tab_id: CASA, project_id: JARDIN, title: 'Podar el seto', note: 'El de la entrada.', position: 1024 } }]);
  const q = (sql: string, args: unknown[]) => server.app.t.db.query(sql, args);
  await q(`update core.memberships set role = 'outsider', scopes = $2::jsonb where app = 'tasks' and user_id = $1`, [server.app.users.reader, JSON.stringify({ tabs: [], projects: { [CASA]: [JARDIN] } })]);
  await q(`update core.profiles set display_name = 'Voluntaria Lúa' where user_id = $1`, [server.app.users.reader]);
  await q(`update core.profiles set display_name = 'Marta (propietaria)' where user_id = $1`, [server.app.users.owner]);
  outsiderContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  ownerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await routeStorage(outsiderContext, server);
  await routeStorage(ownerContext, server);
  outsider = await openApp(outsiderContext, server, { user: READER, errors });
});
test.afterAll(async () => { await outsiderContext?.close(); await ownerContext?.close(); await server?.close(); });

const openProject = (page: Page, project = JARDIN) => page.evaluate(([t, p]) => { state.taskScope = 'area'; state.activeTab = t; state.view = 'project'; state.currentProject = p; state.filters = {}; state.search = ''; state.groupBy = 'project'; render(); }, [CASA, project]);
const go = (page: Page, view: string) => page.evaluate((v) => navigateView(v), view);
const shot = async (page: Page, name: string, focus?: string) => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(2000); // que se vaya el aviso
  if (focus) await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), focus);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `../coordinacion/tasks/o1-despues/${name}.png` }).catch(() => {});
};
const suggestions = async () => (await server.app.t.db.query<any>(`select * from core.suggestions where app = 'tasks' order by created_at`)).rows;
const tasksNamed = async (title: string) => (await server.rows('tasks.tasks')).filter((r: any) => r.title === title && !r.deleted_at);

test('el menú del outsider está reducido y las pantallas prohibidas no se abren ni por hash', async () => {
  // Menú corto: Inicio, Proyectos y Tareas van en la barra de abajo; en el menú, «Mis propuestas» y «Mi cuenta».
  const drawer = await openMenu(outsider);
  await expect(drawer.locator('.appmenu-tile')).toHaveCount(2);
  expect(await menuRows(outsider, 'work')).toEqual(['tasks.menu.mis_propuestas']);
  expect(await menuRows(outsider, 'people')).toEqual(['tasks.menu.mi_cuenta']);
  for (const text of ['Compras', 'Etiquetas', 'Importar', 'Exportar', 'Papelera', 'Archivados', 'Historial', 'Accesos', 'Pasar las']) await expect(drawer.locator('.appmenu-body')).not.toContainText(text);
  await shot(outsider, '07-outsider-menu');
  await drawer.locator('.appmenu-close').click();
  await expect(drawer).toBeHidden();
  await expect(outsider.locator('[data-nav="labels"]')).toBeHidden();
  for (const view of ['purchases', 'triage', 'supplies']) {
    await outsider.evaluate((v) => { location.hash = '#/' + v; }, view);
    await expect.poll(() => outsider.evaluate(() => state.view)).toBe('projects');
  }
  for (const view of ['labels', 'trash', 'archive', 'views', 'spaces']) {
    await go(outsider, view);
    expect(await outsider.evaluate(() => state.view)).toBe('projects');
  }
  // Ni las acciones de otras pantallas.
  await outsider.evaluate(() => handleTopAction('history'));
  await expect(outsider.locator('#sheetBack.show')).toHaveCount(0);
});

test('el «+» propone una tarea (con foto) y sale «Pendiente» en «Mis propuestas»', async () => {
  await openProject(outsider);
  const add = outsider.locator(`[data-add-task="${JARDIN}"]`);
  await expect(add).toBeEnabled();
  await expect(add).toHaveText('+ Proponer tarea');
  await add.click();
  await expect(outsider.locator('#proposeTitle')).toBeVisible();
  await expect(outsider.locator('#proposeProject option')).toHaveText(['Jardín']);
  await outsider.locator('#proposeTitle').fill('Limpiar el estanque');
  await outsider.locator('#proposeNote').fill('Tiene muchas hojas desde la tormenta.');
  await outsider.locator('#proposePhoto').setInputFiles({ name: 'estanque.png', mimeType: 'image/png', buffer: PNG });
  await expect(outsider.locator('#proposePhotoPreview img')).toBeVisible();
  await shot(outsider, '08-outsider-proponer-tarea');
  await outsider.locator('#proposeSend').click();
  await expect(outsider.locator('#proposeTitle')).toHaveCount(0);
  await expect.poll(async () => (await suggestions()).length).toBe(1);
  const [s] = await suggestions();
  expect([s.kind, s.status, s.summary, s.author_id]).toEqual(['tarea', 'pending', 'Limpiar el estanque', server.app.users.reader]);
  expect(s.operations.some((o: any) => o.table === 'tasks.attachments')).toBe(true);
  // No se ha creado nada todavía.
  expect(await tasksNamed('Limpiar el estanque')).toHaveLength(0);
  await go(outsider, 'myproposals');
  const card = outsider.locator('#myProposalsMount .pl-card');
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute('data-status', 'pending');
  await expect(card).toContainText('Limpiar el estanque');
  await expect(card).toContainText('Pendiente');
  await shot(outsider, '09-outsider-mis-propuestas-pendiente');
});

test('«Proponer un cambio» en la ficha: una línea en la nota', async () => {
  await openProject(outsider);
  await outsider.locator(`[data-edit-task="${T_SETO}"]`).click();
  await outsider.locator('#proposeChange').click();
  await outsider.locator('[data-change-mode="note"]').click();
  await outsider.locator('#proposeChangeText').fill('Ojo con el nido del mirlo.');
  await shot(outsider, '10-outsider-proponer-cambio');
  await outsider.locator('#proposeChangeSend').click();
  await expect.poll(async () => (await suggestions()).length).toBe(2);
  expect((await suggestions())[1].kind).toBe('anadido');
});

test('la propietaria aprueba en «Por clasificar» y descarta con comentario', async () => {
  owner = await openApp(ownerContext, server, { errors });
  await go(owner, 'triage');
  const review = owner.locator('#proposalReview');
  await expect(review.locator('.pl-card[data-status="pending"]')).toHaveCount(2);
  await expect(owner.locator('#proposalReviewTitle')).toHaveText('Propuestas (2)');
  await shot(owner, '11-propietaria-por-clasificar');
  // Aprobar la tarea (desde la hoja de detalle, con el destino a la vista).
  await review.locator('.pl-card[data-kind="tarea"] .pl-open').click();
  const sheet = owner.getByRole('dialog', { name: 'Tarea nueva' });
  await expect(sheet.locator('[data-proposal-target]')).toHaveValue(JARDIN);
  await expect(sheet.locator('.proposalphoto')).toHaveAttribute('src', /.+/);
  await shot(owner, '12-propietaria-detalle-destino');
  await sheet.locator('button.primary', { hasText: 'Aprobar' }).click();
  await owner.locator('#proposalComment').fill('¡Bien visto, Lúa!');
  await owner.locator('#dialogConfirm').click();
  await expect.poll(async () => (await tasksNamed('Limpiar el estanque')).length).toBe(1);
  const [task] = await tasksNamed('Limpiar el estanque');
  expect([task.project_id, task.note, task.updated_by]).toEqual([JARDIN, 'Tiene muchas hojas desde la tormenta.', server.app.users.owner]);
  expect((await server.rows('tasks.attachments')).filter((a: any) => a.task_id === task.id)).toHaveLength(1);
  // Descartar el añadido, con un comentario.
  await review.locator('.pl-card[data-kind="anadido"] button', { hasText: 'Descartar' }).click();
  await owner.locator('#proposalComment').fill('El nido ya se fue.');
  await owner.locator('#dialogConfirm').click();
  await expect.poll(async () => (await suggestions()).map((s) => s.status)).toEqual(['approved', 'rejected']);
  expect((await server.rows('tasks.tasks')).find((r: any) => r.id === T_SETO).note).toBe('El de la entrada.');
  await settled(owner);
  await openProject(owner);
  await expect(owner.locator('article.task[data-row]', { hasText: 'Limpiar el estanque' })).toHaveCount(1);
});

test('el outsider ve «Aprobada» con el comentario, «Descartada», y la tarea en su lista', async () => {
  await outsider.evaluate(() => syncNow());
  await settled(outsider);
  await go(outsider, 'myproposals');
  const list = outsider.locator('#myProposalsMount');
  await expect(list.locator('.pl-card[data-status="approved"]')).toContainText('Aprobada');
  await expect(list.locator('.pl-card[data-status="approved"]')).toContainText('¡Bien visto, Lúa!');
  await expect(list.locator('.pl-card[data-status="rejected"]')).toContainText('El nido ya se fue.');
  await shot(outsider, '13-outsider-aprobada');
  await openProject(outsider);
  await expect(outsider.locator('article.task[data-row]', { hasText: 'Limpiar el estanque' })).toHaveCount(1);
});

test('la propietaria abre «Huerto» con «Abrir a…» y el outsider lo ve', async () => {
  expect(await outsider.evaluate(() => state.tabs.flatMap((t: any) => t.projects.map((p: any) => p.title)))).toEqual(['Jardín']);
  await openProject(owner, HUERTO);
  await owner.evaluate((p) => openProjectEditor(p), HUERTO);
  const box = owner.locator(`#openToField [data-open-to="${server.app.users.reader}"]`);
  await expect(box).not.toBeChecked();
  await box.check();
  await shot(owner, '14-propietaria-abrir-a', '#openToField');
  await owner.locator('#saveProjectBtn').click();
  await expect.poll(async () => (await server.app.t.db.query<any>(`select role, scopes from core.memberships where app = 'tasks' and user_id = $1`, [server.app.users.reader])).rows[0])
    .toEqual({ role: 'outsider', scopes: { tabs: [], projects: { [CASA]: [JARDIN, HUERTO] } } });
  // Su cliente rehace el espejo al ver que cambió su pertenencia (al volver a la app, o cada minuto).
  await expect.poll(async () => { await outsider.evaluate(() => Sync.core.refreshMembership()); return outsider.evaluate(() => state.tabs.flatMap((t: any) => t.projects.map((p: any) => p.title)).sort()); }, { timeout: 20_000 })
    .toEqual(['Huerto', 'Jardín']);
  await go(outsider, 'projects');
  await shot(outsider, '15-outsider-ve-huerto');
  // Y en «Cuentas de personas», su ficha es la de outsider: áreas y proyectos, sin «Todas las áreas».
  await owner.evaluate(() => handleTopAction('users'));
  await owner.locator(`[data-edit-user="${server.app.users.reader}"]`).click();
  await expect(owner.locator('#userAll')).toHaveCount(0);
  await expect(owner.locator(`[data-outsider-project="${CASA}|${HUERTO}"]`)).toBeChecked();
  await expect(owner.locator(`[data-outsider-project="${CASA}|${CUENTAS}"]`)).not.toBeChecked();
  expect(errors).toEqual([]);
});
