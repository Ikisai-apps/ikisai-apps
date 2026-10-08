/**
 * Ikisai Tasks · agentes de IA (escenario 29 y la mitad del 37 de docs/tasks/API.md §11.1, sobre el núcleo de
 * docs/tasks/AGENTES.md): la propietaria crea un agente desde la interfaz; un borrado del agente espera su revisión,
 * se aprueba con el resumen legible y el agente lo aplica tal cual; archivar exige aprobación por el riesgo de dominio
 * de Tasks; el registro de accesos lo cuenta; revocar la clave lo corta al momento.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';

declare const Sync: any;
declare let state: any;
declare const accessesSheet: any, proposalsSheet: any, accessLogSheet: any, syncNow: any, closeSheet: any, taskLocation: any;

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
let a: Page;
const errors: string[] = [];
const shared: Record<string, string> = {};

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  a = await openApp(context, server, { aliases: ID, errors });
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

let sequence = 0;
const asAgent = (token: string, path: string, body?: unknown) => server.app.call('/api/v1/' + path, { token, ...(body === undefined ? { method: 'GET' } : { body }) });

test('[29][37] agentes: clave desde la interfaz, borrado con revisión humana aplicado tal cual, registro y revocación', async () => {
  test.setTimeout(120_000);
  // El menú de escritorio ya ofrece las tres pantallas a la propietaria con acceso completo.
  for (const action of ['accesses', 'proposals', 'accessLog']) await expect(a.locator(`[data-action="${action}"]`)).toHaveCount(1);

  let token = '';
  await test.step('la propietaria crea un agente editor y ve la clave una sola vez', async () => {
    await a.evaluate(() => accessesSheet());
    await a.locator('#newAgent').click();
    await a.locator('#agentName').fill('Asistente de obra');
    await a.locator('#agentRole').selectOption('editor');
    await a.locator('#saveAgent').click();
    token = await a.locator('#issuedAgentKey').inputValue();
    expect(token).toMatch(/^ika_[A-Za-z0-9_-]{43}$/);
    // «Hecho» sin copiarla pide confirmar que se ha guardado; copiándola, cierra.
    await a.locator('#agentDone').click();
    await expect(a.locator('.so-confirm')).toBeVisible();
    await a.locator('#copyAgentKey').click();
    await expect(a.locator('#copyAgentKey')).toContainText('Copiada');
    await a.locator('#agentDone').click();
    await expect(a.locator('.agentrow')).toHaveCount(1);
    await expect(a.locator('.agentrow')).toContainText(`clave …${token.slice(-4)}`);
    await expect(a.locator('#sheet')).not.toContainText(token);
  });

  // Una tarea sin hijas, viva, para que el borrado sea de una sola fila.
  const tasks = await server.rows('tasks.tasks');
  const target = tasks.find((t) => !t.deleted_at && !t.parent_id && !tasks.some((c) => c.parent_id === t.id && !c.deleted_at))!;
  const operations = [{ op: 'delete', table: 'tasks.tasks', id: target.id, expectedRevision: target.revision }];

  let proposalId = '';
  await test.step('el borrado del agente no se aplica: queda propuesto', async () => {
    const direct = await asAgent(token, 'commands', { requestId: `agente-${++sequence}`, operations });
    expect(direct.status).toBe(428);
    expect(direct.data.error.code).toBe('CONFIRMATION_REQUIRED');
    const requestId = `agente-${++sequence}`;
    const proposal = await asAgent(token, 'proposals', { requestId, operations });
    expect(proposal.status, JSON.stringify(proposal.data)).toBe(200);
    expect(proposal.data.status).toBe('pending');
    proposalId = proposal.data.id;
    shared.requestId = requestId;
    expect((await server.rows('tasks.tasks')).find((t) => t.id === target.id)!.deleted_at).toBeNull();
  });

  await test.step('la propietaria revisa el resumen legible y aprueba; aprobar no ejecuta', async () => {
    await a.evaluate(() => proposalsSheet());
    await expect(a.locator('[data-review-proposal]')).toHaveCount(1);
    await expect(a.locator('[data-review-proposal]')).toContainText('Asistente de obra');
    await expect(a.locator('[data-review-proposal]')).toContainText('Pendiente');
    await a.locator('[data-review-proposal]').click();
    await expect(a.locator('.changelist .cl-group[data-op="delete"]')).toContainText('Borrar 1 tarea');
    await expect(a.locator('.changelist')).toContainText(target.title);
    await expect(a.locator('.risksummary')).toContainText('Incluye borrados');
    await expect(a.locator('#approveProposal')).toHaveText('Aprobar el cambio');
    await a.locator('#approveProposal').click();
    await expect(a.locator('[data-review-proposal]')).toContainText('Aprobada');
    expect((await server.rows('tasks.tasks')).find((t) => t.id === target.id)!.deleted_at).toBeNull();
  });

  await test.step('el agente aplica el mismo lote con la aprobación; la propietaria lo ve en la papelera', async () => {
    const applied = await asAgent(token, 'commands', { requestId: shared.requestId, operations, confirmationId: proposalId });
    expect(applied.status, JSON.stringify(applied.data)).toBe(200);
    expect((await server.rows('tasks.tasks')).find((t) => t.id === target.id)!.deleted_at).not.toBeNull();
    await a.evaluate(() => { closeSheet(); return syncNow(); });
    await settled(a);
    await a.waitForFunction((id) => taskLocation(id)?.t?.deleted === true, target.id, { timeout: 20_000 });
    await a.evaluate(() => proposalsSheet());
    await expect(a.locator('[data-review-proposal]')).toContainText('Aplicada');
  });

  await test.step('archivar un proyecto, aunque sea una sola fila, también espera aprobación (riesgo de Tasks)', async () => {
    const project = (await server.rows('tasks.projects')).find((p) => !p.deleted_at && !p.system && p.status !== 'archived')!;
    const archive = await asAgent(token, 'commands', { requestId: `agente-${++sequence}`, operations: [{ op: 'update', table: 'tasks.projects', id: project.id, expectedRevision: project.revision, fields: { status: 'archived' } }] });
    expect(archive.status).toBe(428);
    expect(archive.data.error.details.risk.reasons).toContain(`archive:project:${project.id}`);
    expect(archive.data.error.details.risk.affected).toBeGreaterThan(1);
  });

  await test.step('[37] el registro de accesos lo cuenta', async () => {
    await a.evaluate(() => accessLogSheet());
    for (const text of ['Clave de agente creada', 'Propuesta preparada', 'Propuesta aprobada', 'Propuesta aplicada']) await expect(a.locator('#sheet')).toContainText(text);
  });

  await test.step('revocar la clave desde la interfaz corta al agente al momento', async () => {
    await a.evaluate(() => accessesSheet());
    await a.locator('[data-revoke-agent]').click();
    await a.locator('#confirmRevokeAgent').click();
    await expect(a.locator('.agentrow')).toContainText('Revocada');
    expect((await asAgent(token, 'bootstrap')).status).toBe(401);
    await a.evaluate(() => closeSheet());
  });

  expect(errors, 'errores de JavaScript en la página').toEqual([]);
  expect(await a.evaluate(() => Sync.mode)).toBe('online');
});
