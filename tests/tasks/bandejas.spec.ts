/**
 * Ikisai Tasks · tanda 31, zona 3 (MUELA-057, 061, 064, con el 073 y el 083), en móvil de 390 px:
 * - «Por clasificar» por origen: una banda por app, la más urgente primero, con el espacio a la vista y sin la referencia «R…»;
 *   ✓ clasifica al momento y «Deshacer» (con clic real) la devuelve; «✓ Clasificar las N»; «Siempre a …» abre la regla.
 * - Reporte: recorrido del kit (Recibido · En marcha · Resuelto); tocar una etapa cambia el estado con «Deshacer»; lo
 *   descartado para el recorrido y nunca sale como «Resuelto»; sin el código a la vista; el lector, sin mandos.
 * - Etiquetas en fichas: la cifra de tareas abiertas, «0 · sin uso», tocar lleva a Tareas filtradas y el catálogo de siempre
 *   detrás de «Editar el catálogo»; la lectora, sin mandos en el DOM.
 * Nombres inventados. Capturas en `coordinacion/tasks/t31-capturas/` (zona3-*).
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, E2E_WORKER_KEY, READER, startE2EServer, type E2EServer } from './e2e-server.ts';
import { simulateServiceIdentity } from './fixtures.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';

declare const state: any, navigateView: any, Sync: any, render: any;

let server: E2EServer;
let ID: Aliases;
let ownerContext: BrowserContext, readerContext: BrowserContext;
let owner: Page, reader: Page;
const errors: string[] = [];
const ids: Record<string, string> = {};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  ownerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  readerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  owner = await openApp(ownerContext, server, { aliases: ID, errors });
});
test.afterAll(async () => { await ownerContext?.close(); await readerContext?.close(); await server?.close(); });

const go = (page: Page, view: string) => page.evaluate((v) => navigateView(v), view);
const sync = async (page: Page) => { await page.evaluate(() => (window as any).syncNow?.()); await settled(page); };
/** Lo que pide otra app. Booking y Feedback son fuentes de sistema: entran por `worker/requests/task` con su identidad de
 *  servicio (simulada aquí la primera vez), como en producción; las demás, por la ruta de personas. */
const SYSTEM = new Set(['booking', 'feedback']);
const ask = async (key: string, body: Record<string, unknown>) => {
  const source = String(body.source);
  if (!SYSTEM.has(source)) {
    const res = await server.app.call('/api/v1/requests/task', { body });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    ids[key] = res.data.task?.id ?? res.data.id ?? res.data.requestId;
    return res.data;
  }
  const exists = (await server.app.t.db.query(`select 1 from core.profiles where service_name = $1`, [source])).rows.length;
  if (!exists) await simulateServiceIdentity(server.app.t.db, crypto.randomUUID(), source);
  const ref = String(body.external_ref);
  const extra = source === 'feedback' ? { external_url: `https://tasks.ikisai.com/#/feedback/${ref}`, on_behalf_of: { kind: 'guest', report_code: ref } } : {};
  const res = await server.app.handler(new Request('http://localhost/api/v1/worker/requests/task', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': E2E_WORKER_KEY }, body: JSON.stringify({ ...body, ...extra }) }));
  const data = await res.json() as any;
  expect(res.status, JSON.stringify(data)).toBe(200);
  ids[key] = data.taskId;
  return data;
};
const request = async (ref: string) => (await server.rows('tasks.requests')).find((r: any) => r.external_ref === ref);
const taskRow = async (id: string | undefined) => (await server.rows('tasks.tasks')).find((t: any) => t.id === id);
/** El «Deshacer» del último aviso (los avisos con acción se apilan, kit 0.41). */
const undo = (page: Page) => page.locator('.ikisai-toast button', { hasText: 'Deshacer' }).last().click();
const shot = async (page: Page, name: string) => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(6500); // que se vayan los avisos
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `../coordinacion/tasks/t31-capturas/zona3-${name}.png` }).catch(() => {});
};

test('«Por clasificar» por origen: la banda más urgente primero, el espacio a la vista y sin la referencia «R…»', async () => {
  const space = (await server.app.t.db.query<{ id: string }>(`select id from resources.spaces where deleted_at is null and active order by name limit 1`)).rows[0]!.id;
  await ask('organizador', { source: 'booking', kind: 'booking.organizer_dates', kind_label: 'Organizador · Fechas posibles', external_ref: 'R106', title: 'Fechas para el retiro de yoga' });
  await ask('vencimiento', { source: 'central', kind: 'central.compliance_due', kind_label: 'Vencimientos', external_ref: 'VTO_9', title: 'Renovar el seguro de la furgoneta', priority: 'high' });
  await ask('averia', { source: 'feedback', kind: 'feedback.space.damage', kind_label: 'Espacio · Avería', external_ref: 'FB_2026_000500', title: 'Ducha sin agua caliente', priority: 'critical', space_id: space });
  await ask('limpieza1', { source: 'feedback', kind: 'feedback.space.cleaning', kind_label: 'Espacio · Limpieza', external_ref: 'FB_2026_000501', title: 'Barrer la terraza' });
  await ask('limpieza2', { source: 'feedback', kind: 'feedback.space.cleaning', kind_label: 'Espacio · Limpieza', external_ref: 'FB_2026_000502', title: 'Limpiar los cristales' });
  await sync(owner);
  await go(owner, 'triage');
  const bands = owner.locator('.tkc-bands .worst-group');
  // La avería crítica va antes que lo de Booking (antes el orden era alfabético por tipo).
  await expect.poll(() => bands.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.group))).toEqual(['feedback', 'central', 'booking']);
  await expect(bands.first().locator('.worst-summary')).toHaveText('3 peticiones · 1 urge');
  await expect(bands.first().locator('.medal-disc')).toHaveCount(1);
  const averia = owner.locator(`[data-request-row="${ids.averia}"]`);
  await expect(averia.locator('[data-request-space]')).toContainText('Sitio:');
  await expect(averia.locator('.pstate.alert')).toHaveText('Urge');
  await expect(averia.locator('.tkc-dest')).toContainText('Va a');
  await expect(owner.locator('main')).not.toContainText('R106');
  // Cada tipo con su regla a la vista.
  await expect(owner.locator('[data-tkc-kind="central.compliance_due"] h2')).toContainText('Vencimientos');
  await expect(owner.locator('[data-tkc-kind="central.compliance_due"] h2')).toContainText('Sin regla');
  await shot(owner, 'por-clasificar');
  expect(errors).toEqual([]);
});

test('✓ crea la tarea al momento y la quita de la lista; «Deshacer» (clic real) la devuelve; volver a clasificar la recupera', async () => {
  const row = owner.locator(`[data-request-row="${ids.vencimiento}"]`);
  await row.locator('[data-request-classify]').click();
  await expect(row).toHaveCount(0);
  await settled(owner);
  expect((await request('central:VTO_9')).status).toBe('routed');
  expect((await taskRow(ids.vencimiento)).deleted_at).toBeNull();
  await undo(owner);
  await expect(row).toHaveCount(1);
  await settled(owner);
  expect((await request('central:VTO_9')).status).toBe('pending');
  expect((await taskRow(ids.vencimiento)).deleted_at).not.toBeNull();
  await row.locator('[data-request-classify]').click();
  await expect(row).toHaveCount(0);
  await settled(owner);
  expect((await request('central:VTO_9')).status).toBe('routed');
  expect((await taskRow(ids.vencimiento)).deleted_at).toBeNull();
  expect(errors).toEqual([]);
});

test('«✓ Clasificar las N» y «Siempre a …»; «Descartar» con «Deshacer»', async () => {
  const kind = owner.locator('[data-tkc-kind="feedback.space.cleaning"]');
  await kind.locator('[data-route-new]').click();
  await expect(owner.locator('#routeKind')).toHaveValue('feedback.space.cleaning');
  await expect(owner.locator('#routeKind')).toBeDisabled();
  await owner.evaluate(() => (window as any).closeSheet());
  await kind.locator('[data-classify-kind]').click();
  await expect(owner.locator('[data-tkc-kind="feedback.space.cleaning"]')).toHaveCount(0);
  await settled(owner);
  expect([(await request('feedback:FB_2026_000501')).status, (await request('feedback:FB_2026_000502')).status]).toEqual(['routed', 'routed']);
  await undo(owner);
  await expect(owner.locator('[data-tkc-kind="feedback.space.cleaning"]')).toHaveCount(1);
  await settled(owner);
  expect([(await request('feedback:FB_2026_000501')).status, (await request('feedback:FB_2026_000502')).status]).toEqual(['pending', 'pending']);
  // Descartar, y «Deshacer».
  await owner.locator(`[data-request-row="${ids.organizador}"] [data-request-dismiss]`).click();
  await expect(owner.locator(`[data-request-row="${ids.organizador}"]`)).toHaveCount(0);
  await settled(owner);
  expect((await request('booking:R106')).status).toBe('dismissed');
  await undo(owner);
  await expect(owner.locator(`[data-request-row="${ids.organizador}"]`)).toHaveCount(1);
  await settled(owner);
  expect((await request('booking:R106')).status).toBe('pending');
  expect(errors).toEqual([]);
});

test('Reporte: el recorrido del kit, tocar una etapa con «Deshacer», y lo descartado nunca es «Resuelto»', async () => {
  const stage = (key: string) => owner.locator(`.tkr-stages li[data-stage="${key}"]`);
  await owner.goto(server.url + '/#/feedback/FB_2026_000500');
  await settled(owner);
  await expect(owner.locator('main h1')).toHaveText('Ducha sin agua caliente');
  await expect(owner.locator('#tkrState')).toHaveText('Recibido');
  await expect(stage('pending')).toHaveAttribute('aria-current', 'step');
  await expect(owner.locator('main')).not.toContainText('FB_2026_000500');
  await expect(owner.locator('[data-tkr-copy]')).toHaveAttribute('aria-label', 'Copiar el enlace del reporte');
  await expect(owner.locator('.tkr-gap')).toContainText('Lo que contó quien informó');
  // Lo imposible se explica y no cambia nada.
  await stage('done').locator('button').click();
  await expect(owner.locator('.ikisai-toast')).toContainText('Primero tiene que pasar a «En marcha»');
  await expect(owner.locator('#tkrState')).toHaveText('Recibido');
  // Recibido → En marcha abre «Mover a…».
  await stage('open').locator('button').click();
  await owner.locator('#moveRequest').click();
  await expect(owner.locator('#tkrState')).toHaveText('En marcha');
  await settled(owner);
  // En marcha → Resuelto marca la tarea; «Deshacer» la reabre.
  await stage('done').locator('button').click();
  await expect(owner.locator('#tkrState')).toHaveText('Resuelto');
  await settled(owner);
  expect((await taskRow(ids.averia)).done).toBe(true);
  await undo(owner);
  await expect(owner.locator('#tkrState')).toHaveText('En marcha');
  await settled(owner);
  expect((await taskRow(ids.averia)).done).toBe(false);
  await shot(owner, 'reporte');
  // «No lo vamos a hacer»: el recorrido se para, nunca «Resuelto».
  await owner.locator('[data-tkr-action="dismiss"]').click();
  await expect(owner.locator('#tkrState')).toHaveText('No lo vamos a hacer');
  await expect(stage('done')).toHaveAttribute('data-state', 'stop');
  await expect(owner.locator('.tkr-stages')).toContainText('No lo vamos a hacer.');
  await settled(owner);
  expect((await request('feedback:FB_2026_000500')).status).toBe('dismissed');
  expect((await taskRow(ids.averia)).deleted_at).not.toBeNull();
  // «Recuperar» vuelve a Recibido.
  await owner.locator('[data-tkr-action="recover"]').click();
  await expect(owner.locator('#tkrState')).toHaveText('Recibido');
  await settled(owner);
  expect((await request('feedback:FB_2026_000500')).status).toBe('pending');
  expect(errors).toEqual([]);
});

test('Etiquetas en fichas: la cifra de tareas abiertas, «0 · sin uso», tocar lleva a Tareas filtradas y el catálogo detrás', async () => {
  const unused = crypto.randomUUID();
  await server.commit([{ op: 'insert', table: 'tasks.labels', id: unused, fields: { tab_id: ID.ikisai, family_id: ID.phase, name: 'Sin estrenar', position: 99_000 } }], server.app.tokens.owner);
  await sync(owner);
  await owner.evaluate((t) => { state.activeTab = t; state.taskScope = 'area'; render(); }, ID.ikisai);
  await go(owner, 'labels');
  await expect(owner.locator('.tke-groups .tile-box').first()).toBeVisible();
  await expect(owner.locator(`[data-tke-label="${unused}"]`)).toContainText('0 · sin uso');
  // Sin mandos de edición hasta «Editar el catálogo».
  await expect(owner.locator('[data-edit-label], #newFamily')).toHaveCount(0);
  await shot(owner, 'etiquetas');
  // Tocar una etiqueta con uso abre «Tareas» filtradas por ella.
  const used = owner.locator('.tke-groups .tile-box[data-tke-label]').filter({ hasNotText: 'sin uso' }).first();
  const [label, family] = await used.evaluate((b) => [(b as HTMLElement).dataset.tkeLabel, (b as HTMLElement).dataset.tkeFamily]);
  await used.click();
  await expect.poll(() => owner.evaluate(() => state.view)).toBe('tasks');
  expect(await owner.evaluate(() => state.filters)).toEqual({ [family!]: [label] });
  // «Editar el catálogo»: el de siempre, con sus mandos; «‹ Volver a las fichas».
  await go(owner, 'labels');
  await owner.locator('#labelsCatalog').click();
  await expect(owner.locator('#newFamily')).toBeEnabled();
  await expect(owner.locator(`[data-edit-label="${unused}"]`)).toBeVisible();
  await owner.locator('#labelsTiles').click();
  await expect(owner.locator('#newFamily')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('el lector: Etiquetas sin mandos y el reporte sin etapas que tocar; un pendiente, «No lo encuentro»', async () => {
  reader = await openApp(readerContext, server, { user: READER, aliases: ID, errors });
  await reader.evaluate((t) => { state.activeTab = t; state.taskScope = 'area'; render(); }, ID.ikisai);
  await go(reader, 'labels');
  await expect(reader.locator('.tke-groups .tile-box').first()).toBeVisible();
  await expect(reader.locator('[data-edit-label], #newFamily')).toHaveCount(0);
  await expect(reader.locator('#labelsCatalog')).toHaveText('Ver el catálogo completo');
  await ask('nuevo', { source: 'feedback', kind: 'feedback.space.other', external_ref: 'FB_2026_000503', title: 'Falta una bombilla' });
  await sync(reader);
  await reader.goto(server.url + '/#/feedback/FB_2026_000503');
  await settled(reader);
  // Por clasificar: «Recibido» si le llegan las peticiones, o «No lo encuentro» si no; nunca la frase de antes, y sin etapas que tocar.
  await expect(reader.locator('main')).toContainText(/Recibido|No lo encuentro/);
  await expect(reader.locator('.tkr-stages button')).toHaveCount(0);
  await expect(reader.locator('main')).not.toContainText('No hay ninguna tarea tuya enlazada');
  // Con la tarea, el estado sin etapas que tocar.
  await owner.goto(server.url + '/#/feedback/FB_2026_000500');
  await settled(owner);
  await owner.locator('.tkr-stages li[data-stage="open"] button').click();
  await owner.locator('#moveRequest').click();
  await settled(owner);
  await sync(reader);
  await reader.evaluate(() => { state.feedbackCode = 'FB_2026_000500'; state.view = 'feedback'; render(); });
  await expect(reader.locator('#tkrState')).toHaveText('En marcha');
  await expect(reader.locator('.tkr-stages button')).toHaveCount(0);
  await expect(reader.locator('[data-tkr-action], [data-tkr-edit]')).toHaveCount(0);
  expect(errors).toEqual([]);
});
