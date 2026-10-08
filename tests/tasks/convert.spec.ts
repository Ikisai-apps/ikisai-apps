/**
 * Ikisai Tasks · «Convertir en proyecto de…», interfaz (docs/tasks/API.md §24.4): la propietaria lo abre desde «Editar
 * área», ve la vista previa con los recuentos y la lista de líneas de Finance asignadas al área (que hay que reasignar a
 * mano), confirma, y la app la lleva al proyecto nuevo con las mismas tareas. La lógica del servidor la prueba a fondo
 * `convert.test.ts`.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, EDITOR, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const manageTab: any, convertTabSheet: any, state: any;

let server: E2EServer;
let ID: Aliases;
let contextA: BrowserContext, contextB: BrowserContext;
let owner: Page, editor: Page;
const errors: string[] = [];
const JARDIN = crypto.randomUUID(), MANT = crypto.randomUUID(), RIEGO = crypto.randomUUID(), TAREA = crypto.randomUUID(), HECHA = crypto.randomUUID();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  const ok = async (operations: any[]) => { const res = await server.commit(operations); expect(res.status, JSON.stringify(res.data)).toBe(200); };
  await ok([...createTabOps({ name: 'Jardinería', id: JARDIN, position: 90_000 }), ...createTabOps({ name: 'Mantenimiento', id: MANT, position: 91_000 })]);
  await ok([{ op: 'insert', table: 'tasks.projects', id: RIEGO, fields: { tab_id: JARDIN, title: 'Riego', position: 2048 } }]);
  await ok([
    { op: 'insert', table: 'tasks.tasks', id: TAREA, fields: { tab_id: JARDIN, project_id: RIEGO, title: 'Revisar goteros', position: 1024 } },
    { op: 'insert', table: 'tasks.tasks', id: HECHA, fields: { tab_id: JARDIN, project_id: RIEGO, title: 'Podar setos', done: true, position: 2048 } },
  ]);
  contextA = await browser.newContext({ viewport: { width: 390, height: 844 } });
  contextB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  owner = await openApp(contextA, server, { aliases: ID, errors });
  editor = await openApp(contextB, server, { user: EDITOR, aliases: ID, errors });
});
test.afterAll(async () => { await contextA?.close(); await contextB?.close(); await server?.close(); });

test('solo la propietaria con acceso completo puede convertir', async () => {
  // Quien no lo es no abre «Editar área»; y si llamara a la hoja directamente, la app la rechaza.
  await editor.evaluate((id) => convertTabSheet(id), ID.ikisai);
  await expect(editor.locator('#convertConfirm')).toHaveCount(0);
  await owner.evaluate((id) => manageTab(id), JARDIN);
  await expect(owner.locator('#convertTab')).toBeVisible();
});

test('vista previa con recuentos y líneas de Finance; al confirmar, las tareas siguen en el proyecto nuevo', async () => {
  // La lectura es de Invoices (la prueba Invoices); aquí se simula: una línea asignada al área y otra a una tarea.
  await owner.route('**/read/invoices.allocations_by_target', async (route) => {
    const args = route.request().postDataJSON();
    const rows = args.targetKind === 'area' && args.ids.includes(JARDIN) ? [{ target_id: JARDIN, invoice_id: 'f1', invoice_code: 'F-2026-0007', status: 'revisada', invoice_date: '2026-10-01', allocated_amount: 10 }]
      : args.targetKind === 'task' && args.ids.includes(TAREA) ? [{ target_id: TAREA, invoice_id: 'f1', invoice_code: 'F-2026-0007', status: 'revisada', invoice_date: '2026-10-01', allocated_amount: 30 }] : [];
    await route.fulfill({ json: { rows } });
  });
  await owner.locator('#convertTab').click();
  await expect(owner.locator('#convertTarget')).toHaveValue(MANT);
  await expect(owner.locator('#convertTitle')).toHaveValue('Jardinería');
  const preview = owner.locator('#convertPreview');
  await expect(preview).toContainText('2 tareas (pendientes: 1; hechas: 1)');
  await expect(preview).toContainText('2 proyectos (con su Entrada)');
  await expect(preview).toContainText('1 asignación de Finance a una tarea se conserva');
  await expect(owner.locator('#convertFinanceManual')).toContainText('F-2026-0007');
  await expect(owner.locator('#convertFinanceManual')).toContainText('el área');
  await expect(owner.locator('#convertFinanceManual a')).toHaveAttribute('href', 'https://finance.ikisai.com/#/facturas/F-2026-0007');
  await owner.screenshot({ path: '../coordinacion/tasks/convertir-area-movil.png' }).catch(() => {});

  await owner.locator('#convertConfirm').click();
  await expect.poll(async () => (await server.rows('tasks.tabs')).find((t) => t.id === JARDIN)?.deleted_at, { timeout: 15_000 }).toBeTruthy();
  const task = (await server.rows('tasks.tasks')).find((t) => t.id === TAREA);
  expect(task.tab_id).toBe(MANT);
  const project = (await server.rows('tasks.projects')).find((p) => p.id === task.project_id);
  expect([project.title, project.tab_id]).toEqual(['Jardinería', MANT]);
  await settled(owner);
  await expect.poll(() => owner.evaluate(() => [state.activeTab, state.view, state.currentProject]), { timeout: 10_000 }).toEqual([MANT, 'project', project.id]);
  await expect(owner.getByText('Revisar goteros')).toBeVisible();
  expect(errors, 'errores de JavaScript en la página').toEqual([]);
});
