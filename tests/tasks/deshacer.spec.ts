/**
 * Ikisai Tasks · tanda 31, MUELA-073 «Tareas (Deshacer)»: completar, enviar a la papelera y enviar varias a la papelera se
 * hacen al momento, con el aviso del kit (`toastWithAction`) y «Deshacer» local (la operación inversa sobre el modelo), sin
 * confirmar y sin red. Al volver la red, el servidor queda como si no se hubiera hecho nada. El aviso del lote sale una vez.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const state: any, render: any, taskLocation: any, syncNow: any;

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const TAB = crypto.randomUUID(), P = crypto.randomUUID(), T1 = crypto.randomUUID(), T2 = crypto.randomUUID(), T3 = crypto.randomUUID(), HIJA = crypto.randomUUID();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  const ok = async (operations: any[]) => { const res = await server.commit(operations); expect(res.status, JSON.stringify(res.data)).toBe(200); };
  await ok(createTabOps({ id: TAB, name: 'Casa', position: 90_000 }));
  await ok([{ op: 'insert', table: 'tasks.projects', id: P, fields: { tab_id: TAB, title: 'Jardín', position: 2048 } }]);
  await ok([
    { op: 'insert', table: 'tasks.tasks', id: T1, fields: { tab_id: TAB, project_id: P, title: 'Regar', position: 1024 } },
    { op: 'insert', table: 'tasks.tasks', id: T2, fields: { tab_id: TAB, project_id: P, title: 'Podar', position: 2048 } },
    { op: 'insert', table: 'tasks.tasks', id: T3, fields: { tab_id: TAB, project_id: P, title: 'Abonar', position: 3072 } },
    { op: 'insert', table: 'tasks.tasks', id: HIJA, fields: { tab_id: TAB, project_id: P, parent_id: T3, title: 'Comprar abono', position: 1024 } },
  ]);
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await openApp(context, server, { aliases: ID, errors });
  await page.evaluate(([tab, p]) => { state.taskScope = 'area'; state.activeTab = tab; state.view = 'project'; state.currentProject = p; render(); }, [TAB, P]);
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

/** El «Deshacer» del aviso que dice `message` (los avisos con acción se apilan). */
const undoButton = (message: string) => page.locator('.ikisai-toast span', { hasText: message }).locator('xpath=following-sibling::button');
const local = (id: string) => page.evaluate((x) => { const loc = taskLocation(x); return loc ? { done: !!loc.t.done, deleted: !!loc.t.deleted } : null; }, id);
const serverRow = async (id: string) => (await server.rows('tasks.tasks')).find((t) => t.id === id);

test('sin red, los tres «Deshacer» de Tareas: completar, papelera y papelera de varias', async () => {
  await settled(page);
  await context.setOffline(true);

  // 1 · Completar, al momento, y «Deshacer» la reabre.
  await page.locator(`[data-toggle-task="${T1}"]`).click();
  expect(await local(T1)).toEqual({ done: true, deleted: false });
  await expect(page.locator('.ikisai-toast')).toContainText('Tarea completada');
  await undoButton('Tarea completada').click();
  expect(await local(T1)).toEqual({ done: false, deleted: false });

  // 2 · Papelera de una, sin confirmar, y «Deshacer» la devuelve.
  await page.evaluate((id) => (window as any).deleteTask(id), T2);
  expect(await local(T2)).toEqual({ done: false, deleted: true });
  await expect(page.locator('.ikisai-toast')).toContainText('Enviada a la papelera');
  await undoButton('Enviada a la papelera').click();
  expect(await local(T2)).toEqual({ done: false, deleted: false });
  await expect(page.locator(`.task[data-row="${T2}"]`)).toHaveCount(1);

  // 3 · Papelera de varias (una con su hija): sin hoja de confirmar, un solo aviso al final y «Deshacer» las restaura.
  await page.locator('#batchToggle').click();
  for (const id of [T1, T3]) await page.locator(`[data-select="${id}"]`).click();
  await page.locator('#batchTrash').click();
  await expect(page.locator('#sheet')).toHaveCount(0);
  expect(await local(T1)).toEqual({ done: false, deleted: true });
  expect(await local(HIJA)).toEqual({ done: false, deleted: true });
  await expect(page.locator('.ikisai-toast')).toContainText('2 tareas en la papelera');
  await expect(page.locator('.ikisai-toast span', { hasText: 'tareas en la papelera' })).toHaveCount(1);
  await undoButton('2 tareas en la papelera').click();
  for (const id of [T1, T3, HIJA]) expect(await local(id)).toEqual({ done: false, deleted: false });

  // Con la red de vuelta, el servidor no ha visto nada borrado ni completado.
  await context.setOffline(false);
  await page.evaluate(() => syncNow());
  await settled(page);
  for (const id of [T1, T2, T3, HIJA]) {
    const row = await serverRow(id);
    expect(row.done, id).toBe(false);
    expect(row.deleted_at, id).toBeNull();
  }
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});

test('completar varias tiene «Deshacer» que devuelve a cada una lo que tenía', async () => {
  await page.locator(`[data-toggle-task="${T2}"]`).click();
  await settled(page);
  await page.locator('#batchToggle').click();
  for (const id of [T1, T3]) await page.locator(`[data-select="${id}"]`).click();
  await page.locator('#batchDone').click();
  await expect(page.locator('.ikisai-toast')).toContainText('2 tareas completadas');
  expect((await local(T1))!.done).toBe(true);
  expect((await local(HIJA))!.done).toBe(true);
  await undoButton('2 tareas completadas').click();
  expect((await local(T1))!.done).toBe(false);
  expect((await local(HIJA))!.done).toBe(false);
  // La que ya estaba hecha antes del lote sigue hecha.
  expect((await local(T2))!.done).toBe(true);
  await settled(page);
  expect((await serverRow(T1)).done).toBe(false);
  expect((await serverRow(T2)).done).toBe(true);
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
