/**
 * Ikisai Tasks · O1, paso 2 (docs/tasks/API.md §31), en móvil de 390 px. La cuenta de lectura de las pruebas pasa a
 * outsider por SQL (pertenencia `outsider` con un proyecto abierto en sus `scopes`, como la deja Central). Comprueba que:
 * solo ve ese proyecto; marca hecha con la casilla y se guarda en el servidor; la ficha es de solo lectura salvo el hilo;
 * comenta y adjunta una foto pequeña; la propietaria ve el comentario y la foto y responde, y el outsider ve la respuesta.
 * Nombres inventados. Capturas en `coordinacion/tasks/o1-despues/`.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, READER, startE2EServer, type E2EServer } from './e2e-server.ts';
import { fichaBloque, openApp, routeStorage, settled } from './e2e-helpers.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const Sync: any, state: any, render: any, openTaskEditor: any, syncNow: any;

let server: E2EServer;
let outsiderContext: BrowserContext, ownerContext: BrowserContext;
let outsider: Page, owner: Page;
const errors: string[] = [];
const id = () => crypto.randomUUID();
const CASA = id(), JARDIN = id(), CUENTAS = id(), T_SETO = id(), T_RIEGO = id(), T_SECRETA = id();
// PNG de 8×8 píxeles (un degradado): la interfaz lo recomprime a WebP como cualquier foto.
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
    { op: 'insert', table: 'tasks.projects', id: CUENTAS, fields: { tab_id: CASA, title: 'Cuentas reservadas', position: 3072 } },
  ]);
  await ok([
    { op: 'insert', table: 'tasks.tasks', id: T_SETO, fields: { tab_id: CASA, project_id: JARDIN, title: 'Podar el seto', note: 'El de la entrada.', position: 1024 } },
    { op: 'insert', table: 'tasks.tasks', id: T_RIEGO, fields: { tab_id: CASA, project_id: JARDIN, title: 'Revisar el riego', position: 2048 } },
    { op: 'insert', table: 'tasks.tasks', id: T_SECRETA, fields: { tab_id: CASA, project_id: CUENTAS, title: 'Pagar al gestor', position: 1024 } },
  ]);
  // La cuenta de lectura pasa a outsider con solo «Jardín» abierto (como la deja el nivel de casa más «Abrir a…»).
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

const openProject = (page: Page) => page.evaluate(([t, p]) => { state.taskScope = 'area'; state.activeTab = t; state.view = 'project'; state.currentProject = p; state.filters = {}; state.search = ''; state.groupBy = 'project'; render(); }, [CASA, JARDIN]);
const shot = async (page: Page, name: string) => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(350);
  await page.evaluate(() => document.querySelector('#taskComments')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(2000); // que se vaya el aviso
  await page.screenshot({ path: `../coordinacion/tasks/o1-despues/${name}.png` }).catch(() => {});
};
const serverRow = async (table: string, rowId: string) => (await server.rows(table)).find((r) => r.id === rowId);
const comments = async (taskId: string) => (await server.rows('tasks.task_comments')).filter((r) => r.task_id === taskId && !r.deleted_at);

test('el outsider solo ve el proyecto abierto y sigue siendo lector para todo lo demás', async () => {
  const seen = await outsider.evaluate(() => ({ role: Sync.actor.role, outsider: Sync.actor.outsider, projects: state.tabs.flatMap((t: any) => t.projects.map((p: any) => p.title)) }));
  expect(seen).toEqual({ role: 'reader', outsider: true, projects: ['Jardín'] });
  await openProject(outsider);
  const rows = outsider.locator('article.task[data-row]');
  await expect(rows).toHaveCount(2);
  await expect(outsider.locator('body')).not.toContainText('Cuentas reservadas');
  await expect(outsider.locator('body')).not.toContainText('Pagar al gestor');
  // Lo de editar sigue apagado (arrastrar, añadir); la casilla de hecha no.
  await expect(outsider.locator(`[data-drag="${T_SETO}"]`)).toBeDisabled();
  await expect(outsider.locator(`article[data-row="${T_SETO}"] [data-toggle-task]`)).toBeEnabled();
  await shot(outsider, '01-outsider-lista');
});

test('marca hecha con la casilla de siempre y se guarda en el servidor; también la desmarca', async () => {
  await outsider.locator(`article[data-row="${T_RIEGO}"] [data-toggle-task]`).click();
  await settled(outsider);
  await expect.poll(async () => (await serverRow('tasks.tasks', T_RIEGO))?.done).toBe(true);
  // La terminada se va al plegable «1 tarea terminada»: se abre para desmarcarla.
  await outsider.locator('details.donefold > summary').click();
  await shot(outsider, '02-outsider-hecha');
  await outsider.locator(`article[data-row="${T_RIEGO}"] [data-toggle-task]`).click();
  await settled(outsider);
  await expect.poll(async () => (await serverRow('tasks.tasks', T_RIEGO))?.done).toBe(false);
  expect((await serverRow('tasks.tasks', T_RIEGO)).title).toBe('Revisar el riego');
});

test('la ficha es de solo lectura salvo el hilo y la casilla de hecha', async () => {
  await outsider.locator(`[data-edit-task="${T_SETO}"]`).click();
  // Ficha «Portada y foco» (MUELA-083 §1, tanda 31): el motivo a la vista, sin lápiz en la portada, «Hecha» arriba junto a
  // prioridad y fecha, y ningún control activo que no se guarde (O5). «Quién» sin «Quién sabe hacerlo».
  await expect(outsider.locator('#tkfReadOnly')).toHaveText('Puedes marcarla hecha, comentar y proponer cambios. Lo demás lo cambian staff o dirección.');
  await expect(outsider.locator('#tkfTitleEdit')).toHaveCount(0);
  await expect(outsider.locator('.tkf-portada #outsiderDone')).toBeEnabled();
  await expect(outsider.locator('#priorityStar')).toBeDisabled();
  await expect(outsider.locator('#teDue')).toBeDisabled();
  await expect(outsider.locator('#teText')).toBeDisabled();
  await expect(outsider.locator('#teNote')).toBeDisabled();
  await expect(outsider.locator('#saveTaskBtn')).toHaveCount(0);
  await expect(outsider.locator('#whoKnows')).toHaveCount(0);
  const active = await outsider.evaluate(() => [...document.querySelectorAll('#sheet .tkf-portada :is(button,input,select,textarea), #sheet .tkf-store :is(button,input,select,textarea)')]
    .filter((c: any) => !c.disabled && !c.closest('#taskComments') && c.id !== 'outsiderDone' && !c.matches('[data-child-toggle], [data-child-open], .tkf-tile'))
    .map((c: any) => c.id || c.getAttribute('data-feedback-id') || c.className));
  expect(active, 'controles activos que no guardan').toEqual([]);
  // «Hecha» con «Deshacer»: la casilla marca de verdad y el aviso la reabre.
  await outsider.locator('#outsiderDone').check();
  await settled(outsider);
  await expect.poll(async () => (await serverRow('tasks.tasks', T_SETO))?.done).toBe(true);
  await outsider.locator('.ikisai-toast span', { hasText: 'Tarea completada' }).locator('xpath=following-sibling::button').click();
  await settled(outsider);
  await expect.poll(async () => (await serverRow('tasks.tasks', T_SETO))?.done).toBe(false);
  await expect(outsider.locator('#outsiderDone')).not.toBeChecked();
  // La casilla también desmarca.
  await outsider.locator('#outsiderDone').check();
  await settled(outsider);
  await expect.poll(async () => (await serverRow('tasks.tasks', T_SETO))?.done).toBe(true);
  await outsider.locator('#outsiderDone').uncheck();
  await settled(outsider);
  await expect.poll(async () => (await serverRow('tasks.tasks', T_SETO))?.done).toBe(false);
  expect((await serverRow('tasks.tasks', T_SETO)).title).toBe('Podar el seto');
  // El hilo, en su baldosa.
  await fichaBloque(outsider, 'comentarios');
  await expect(outsider.locator('#taskComments')).toBeVisible();
  await expect(outsider.locator('#commentText')).toBeEnabled();
  await expect(outsider.locator('#commentSend')).toBeEnabled();
  await expect(outsider.locator('#taskComments')).toContainText('Sin comentarios todavía.');
});

test('comenta y adjunta una foto pequeña; la propietaria ve el comentario y la foto y responde', async () => {
  await outsider.locator('#commentText').fill('He podado la mitad; mañana termino. Os dejo cómo va.');
  await outsider.locator('#commentPhoto').setInputFiles({ name: 'seto.png', mimeType: 'image/png', buffer: PNG });
  await expect(outsider.locator('#commentPhotoPreview img')).toBeVisible();
  await outsider.locator('#commentSend').click();
  await expect(outsider.locator('#taskComments .comment')).toHaveCount(1);
  await expect(outsider.locator('#commentText')).toHaveValue('');
  await settled(outsider);
  await expect.poll(async () => (await comments(T_SETO)).length).toBe(1);
  const [saved] = await comments(T_SETO);
  expect(saved.author_id).toBe(server.app.users.reader);
  expect(saved.author_name).toBe('Voluntaria Lúa');
  expect(typeof saved.file_id).toBe('string');
  const file = (await server.app.t.db.query<{ mime: string; status: string }>('select mime, status from core.files where id = $1', [saved.file_id])).rows[0]!;
  expect(file).toEqual({ mime: 'image/webp', status: 'verified' });
  await expect(outsider.locator('#taskComments .comment .commentauthor')).toHaveText('Voluntaria Lúa');
  await expect(outsider.locator('#taskComments .commentphoto')).toHaveAttribute('src', /^blob:/);
  await shot(outsider, '03-outsider-ficha-comentario');

  owner = await openApp(ownerContext, server, { errors });
  await openProject(owner);
  await expect(owner.locator(`article[data-row="${T_SETO}"] .commentcount`)).toHaveText('💬 1');
  await shot(owner, '04-propietaria-contador');
  await owner.locator(`[data-edit-task="${T_SETO}"]`).click();
  await expect(owner.locator('[data-tkf-tile="comentarios"]')).toContainText('Voluntaria Lúa');
  await fichaBloque(owner, 'comentarios');
  const thread = owner.locator('#taskComments');
  await expect(thread.locator('.comment')).toHaveCount(1);
  await expect(thread.locator('.comment .commentauthor')).toHaveText('Voluntaria Lúa');
  await expect(thread.locator('.comment .commentbody')).toHaveText('He podado la mitad; mañana termino. Os dejo cómo va.');
  await expect(thread.locator('.commentphoto')).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => owner.evaluate(() => (document.querySelector('#taskComments .commentphoto') as HTMLImageElement | null)?.naturalWidth ?? 0)).toBeGreaterThan(0);
  // La propietaria puede borrar lo ajeno, pero no editarlo.
  await expect(thread.locator('[data-comment-delete]')).toHaveCount(1);
  await expect(thread.locator('[data-comment-edit]')).toHaveCount(0);
  await owner.locator('#commentText').fill('¡Gracias, Lúa! Queda genial.');
  await owner.locator('#commentSend').click();
  await expect(thread.locator('.comment')).toHaveCount(2);
  await settled(owner);
  await expect.poll(async () => (await comments(T_SETO)).length).toBe(2);
  await thread.scrollIntoViewIfNeeded();
  await shot(owner, '05-propietaria-responde');
});

test('el outsider ve la respuesta en el hilo, solo edita lo suyo y el contador sube a 💬 2', async () => {
  await outsider.evaluate(() => syncNow());
  await settled(outsider);
  const thread = outsider.locator('#taskComments');
  await expect(thread.locator('.comment')).toHaveCount(2);
  await expect(thread.locator('.comment').nth(1).locator('.commentauthor')).toHaveText('Marta (propietaria)');
  await expect(thread.locator('.comment').nth(1).locator('.commentbody')).toHaveText('¡Gracias, Lúa! Queda genial.');
  // Sus botones solo en lo suyo.
  await expect(thread.locator('.comment').nth(0).locator('[data-comment-edit]')).toHaveCount(1);
  await expect(thread.locator('.comment').nth(1).locator('[data-comment-edit], [data-comment-delete]')).toHaveCount(0);
  await thread.scrollIntoViewIfNeeded();
  await shot(outsider, '06-outsider-ve-respuesta');
  await outsider.locator('#closeDialog').click();
  await expect(outsider.locator(`article[data-row="${T_SETO}"] .commentcount`)).toHaveText('💬 2');
  expect(errors).toEqual([]);
});

test('«Mi trabajo» (MUELA-083 §2): saludo, «Proponer algo», sus tareas (sin ficha, donde es responsable) con «Hecha» y «Deshacer», sus propuestas y lo demás que ve', async () => {
  // Sin ficha de Central: valen las tareas donde es responsable (la etiqueta de la familia Persona con su nombre).
  const family = (await server.app.t.db.query<{ id: string }>(`select id from tasks.families where tab_id = $1 and system_key = 'person'`, [CASA])).rows[0]!.id;
  const LUA = id();
  const ok = async (operations: any[]) => { const res = await server.commit(operations); expect(res.status, JSON.stringify(res.data)).toBe(200); };
  await ok([{ op: 'insert', table: 'tasks.labels', id: LUA, fields: { tab_id: CASA, family_id: family, name: 'Voluntaria Lúa' } }]);
  const seto = await serverRow('tasks.tasks', T_SETO);
  await ok([{ op: 'update', table: 'tasks.tasks', id: T_SETO, expectedRevision: seto.revision, fields: { owner_label_id: LUA, due: '2030-01-15' } }]);
  await outsider.evaluate(() => syncNow());
  await settled(outsider);
  await outsider.evaluate(() => { state.view = 'home'; render(); });
  const main = outsider.locator('main.inicio-outsider');
  await expect(main.locator('.homehead .title')).toHaveText('Hola, Voluntaria');
  await expect(outsider.locator('#homePropose')).toBeVisible();
  // Sin carga ni actividad del staff, ni cifras.
  await expect(outsider.locator('.homepeople, .homeactivity, #homeStats, #homeLead')).toHaveCount(0);
  const mine = main.locator('.inicio-mine');
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText('Podar el seto');
  await expect(mine).toContainText('💬 2');
  // «Hecha» a un toque y «Deshacer».
  await mine.locator('[data-out-done]').click();
  await expect(main.locator('.inicio-mine')).toHaveCount(0);
  await outsider.locator('.ikisai-toast button', { hasText: 'Deshacer' }).last().click();
  await expect(main.locator('.inicio-mine')).toHaveCount(1);
  await settled(outsider);
  expect((await serverRow('tasks.tasks', T_SETO)).done).toBe(false);
  // Sus propuestas: «Ver todas» (46 px) lleva a «Mis propuestas».
  const all = outsider.locator('#homeProposalsAll');
  expect((await all.boundingBox())!.height).toBeGreaterThanOrEqual(46);
  await expect(outsider.locator('#homeProposals')).not.toContainText('Cargando');
  // Lo demás que ve: el proyecto abierto, no el reservado.
  await expect(main).toContainText('Jardín');
  await expect(main).not.toContainText('Cuentas reservadas');
  await shot(outsider, '07-outsider-mi-trabajo');
  await all.click();
  await expect.poll(() => outsider.evaluate(() => state.view)).toBe('myproposals');
  expect(errors).toEqual([]);
});

test('Oficios, Personas y Espacios (MUELA-090) siguen cerrados al outsider: ni por el estado guardado ni por la URL', async () => {
  // Con las tres pantallas encendidas (oficios y personas de Central, espacios de Recursos), para que el cierre sea el del outsider.
  await outsider.evaluate(() => { const w = window as any; w.__modes = [w.tradesMode, w.peopleMode, w.spacesMode]; w.tradesMode = () => true; w.peopleMode = () => true; w.spacesMode = () => true; });
  for (const view of ['trades', 'people', 'spaces']) {
    // Como si lo hubiera dejado guardado en el dispositivo.
    await outsider.evaluate((v) => { state.view = v; render(); }, view);
    await expect.poll(() => outsider.evaluate(() => state.view)).not.toBe(view);
    await expect(outsider.locator('.trades-screen, .people-screen, .spaces-screen, .tko-groups, #tkoPlan, #tkoBack')).toHaveCount(0);
    // Por la URL: `#/<vista>` (y los nombres en español) no abren nada que no le toque.
    for (const hash of [`#/${view}`, `#/${({ trades: 'oficios', people: 'personas', spaces: 'espacios' } as Record<string, string>)[view]}`]) {
      await outsider.evaluate((h) => { location.hash = h; }, hash);
      await outsider.waitForTimeout(150);
      await expect(outsider.locator('.trades-screen, .people-screen, .spaces-screen, .tko-groups, #tkoPlan')).toHaveCount(0);
      expect(await outsider.evaluate(() => state.view)).not.toBe(view);
    }
  }
  await outsider.evaluate(() => { const w = window as any; [w.tradesMode, w.peopleMode, w.spacesMode] = w.__modes; history.replaceState(null, '', location.pathname + location.search); state.view = 'home'; render(); });
  expect(errors).toEqual([]);
});
