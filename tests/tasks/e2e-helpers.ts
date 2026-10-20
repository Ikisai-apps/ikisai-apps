/**
 * Ayudas de las pruebas de extremo a extremo de Tasks: semilla de demostración (la del repo antiguo, con uuid
 * deterministas y un mapa alias → uuid para conservar los nombres de los escenarios originales) y apertura de la app.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type BrowserContext, type Locator, type Page } from 'playwright/test';
import { decompose, emptyDataset, chunkOperations, type LegacyTab } from '../../packages/domain-tasks/src/index.ts';
import { OWNER, type E2EServer } from './e2e-server.ts';
import { acceptUsageNotice, longPress, simulateKeyboard } from '../../packages/ui-kit/testing/feedback-smoke.ts';

// Globales de la interfaz heredada, visibles dentro de page.evaluate.
declare const Sync: any;
declare const state: any;

const here = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_FAMILIES = ['person', 'trade', 'phase', 'building', 'space'];

/** Alias de la demo antigua (`p1`, `t2`, `juan`, `trade`…) → uuid. Las familias sin prefijo son las del área `ikisai`. */
export type Aliases = Record<string, string>;

export async function seedDemo(server: E2EServer): Promise<Aliases> {
  const source = JSON.parse(readFileSync(path.join(here, 'fixtures/demo.json'), 'utf8')) as { tabs: any[] };
  const ID: Aliases = {};
  let counter = 0x1000;
  const mk = (alias: string): string => (ID[alias] ??= `00000000-0000-4000-8000-${(counter++).toString(16).padStart(12, '0')}`);
  const tabs: LegacyTab[] = source.tabs.map((tab) => {
    const family = (key: string) => mk(`${tab.id}:${key}`);
    const projects = [...tab.projects];
    if (!projects.some((p) => p.system === 'inbox')) projects.unshift({ id: `${tab.id}:inbox`, system: 'inbox', title: 'Entrada', note: '', status: 'active', priority: 'normal', due: '', ownLabels: [], tasks: [] });
    return {
      id: mk(tab.id), name: tab.name, color: null, deleted: false, version: 1, updatedAt: '', views: [],
      families: tab.families.map((f: any) => ({ id: family(f.id), name: f.name, color: f.color, archived: false, system: SYSTEM_FAMILIES.includes(f.id) ? f.id : null, version: 1 })),
      labels: tab.labels.map((l: any) => ({ id: mk(l.id), text: l.text, family: family(l.family), parent: l.parent ? mk(l.parent) : null, archived: !!l.archived, version: 1 })),
      projects: projects.map((p: any, projectIndex: number) => ({
        id: mk(p.id), title: p.title, note: p.note ?? '', status: p.status ?? 'active', priority: p.priority ?? 'normal', due: p.due ?? '', owner: p.owner ? mk(p.owner) : null,
        ownLabels: (p.ownLabels ?? []).map(mk), attachments: [], deleted: false, deletedAt: null, order: (projectIndex + 1) * 1024, color: null, budget: null,
        system: p.system ?? null, version: 1, updatedAt: '',
        tasks: p.tasks.map((t: any, taskIndex: number) => ({
          id: mk(t.id), text: t.text, note: t.note ?? '', done: !!t.done, priority: t.priority ?? 'normal', due: t.due ?? '', labels: (t.labels ?? []).map(mk), owner: t.owner ? mk(t.owner) : null,
          parentId: t.parentId ? mk(t.parentId) : null, order: (taskIndex + 1) * 1024, attachments: [], deleted: false, deletedAt: null, deleteBatch: null,
          dependsOn: (t.dependsOn ?? []).map(mk), cost: null, version: 1, updatedAt: '',
        })),
      })),
    };
  });
  for (const key of SYSTEM_FAMILIES) ID[key] = ID[`${source.tabs[0].id}:${key}`]!;
  for (const batch of decompose(emptyDataset(), tabs).flatMap((b) => chunkOperations(b))) {
    const result = await server.commit(batch, server.app.tokens.owner);
    if (result.status !== 200) throw new Error('Semilla de demostración rechazada: ' + JSON.stringify(result.data));
  }
  return ID;
}

/** Espera a que la interfaz quede al día con el servidor; si no llega, explica en qué estado se quedó. */
export async function settled(page: Page): Promise<void> {
  try {
    await page.waitForFunction(() => typeof Sync !== 'undefined' && Sync.ready && Sync.mode === 'online' && !Sync.busy && Sync.record.queue.length === 0 && (!Sync.core?.idle || Sync.core.idle()), null, { timeout: 20_000 });
  } catch {
    const snapshot = await page.evaluate(() => JSON.stringify({ ready: Sync.ready, tabs: state.tabs.length, mode: Sync.mode, busy: Sync.busy, queue: Sync.record.queue.length, conflict: Sync.record.conflict, failure: Sync.record.failure, status: Sync.core?.status() })).catch(() => 'sin página');
    throw new Error(`La interfaz no quedó al día: ${snapshot}`);
  }
}

/** Abre la app, entra con la cuenta indicada y espera al primer modelo. `ID` queda disponible en la página. */
/**
 * El aviso de «Uso» del kit sale la primera vez para cada cuenta, con retraso, y tapa la pantalla: en las pruebas se da
 * por aceptado. Sin esto, una prueba lenta lo encontraba encima del botón que iba a pulsar y esperaba hasta cortarse por
 * tiempo (la «archivar una familia» de app.spec.ts, 8-10-2026). Vale para una página o para todo un contexto.
 */
export async function quietUsageNotice(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(`{const get=Storage.prototype.getItem;Storage.prototype.getItem=function(k){return String(k).startsWith('ikisai-usage-notice:')?'aceptado-en-pruebas':get.call(this,k)}}`);
}
export async function openApp(context: BrowserContext, server: E2EServer, options: { user?: { email: string; password: string }; aliases?: Aliases; errors?: string[]; autoUpdate?: boolean } = {}): Promise<Page> {
  const page = await context.newPage();
  // La versión nueva se aplica sola al abrir si es seguro (updates.js). En las pruebas va apagada salvo que se pida: las que
  // publican una versión nueva a mitad comprueban el aviso y el veto, y una recarga inesperada las rompería.
  if (!options.autoUpdate) await page.addInitScript('window.TASKS_UPDATE_AUTO_MS = 0;');
  await quietUsageNotice(page);
  page.on('pageerror', (error) => { (options.errors ?? []).push(error.message); if (!options.errors) throw new Error('Error de JavaScript en la página: ' + error.message); });
  if (options.aliases) await page.addInitScript(`window.ID = ${JSON.stringify(options.aliases)};`);
  const user = options.user ?? OWNER;
  await page.goto(server.url + '/');
  await page.locator('#loginUsername').fill(user.email);
  await page.locator('#loginPassword').fill(user.password);
  await page.locator('#accountLogin').click();
  await settled(page);
  return page;
}

/**
 * Storage simulado: `sync-client` sube cada blob con un PUT a la URL firmada de Supabase Storage. Aquí se intercepta
 * esa petición del navegador y el contenido se guarda en el almacén del arnés, donde `uploads/:id/verify` lo encuentra.
 */
export async function routeStorage(context: BrowserContext, server: E2EServer): Promise<void> {
  const prefix = '/storage/v1/object/upload/sign/';
  await context.route((url) => url.origin === server.app.supabase.url && url.pathname.startsWith(prefix), async (route) => {
    const request = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'PUT, OPTIONS', 'access-control-allow-headers': '*' };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
    const objectPath = decodeURIComponent(new URL(request.url()).pathname.slice(prefix.length)).split('/').slice(1).join('/');
    server.app.supabase.storage.set(objectPath, new Uint8Array(request.postDataBuffer() ?? Buffer.alloc(0)));
    await route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ Key: objectPath }) });
  });
}

/**
 * Menú común del kit (MUELA-083 §4, tanda 31): la marca (#appLauncher) abre el cajón; en el ordenador, además, la columna fija.
 * Las secciones son azulejos que despliegan sus filas debajo, y cada fila lleva su marca de feedback (`MENU_MARKS`).
 */
export type MenuHost = 'drawer' | 'column';
export async function openMenu(page: Page): Promise<Locator> {
  const drawer = page.locator('.appmenu-drawer');
  if (!(await drawer.isVisible().catch(() => false))) await page.locator('#appLauncher').click();
  await expect(drawer).toBeVisible();
  return drawer;
}
/** Despliega la sección `key` (id del grupo: `work`, `transfer`, `people`, `system`, `purchases`…) y devuelve su panel. */
export async function openMenuSection(page: Page, key: string, host: MenuHost = 'drawer'): Promise<Locator> {
  const box = host === 'drawer' ? await openMenu(page) : page.locator('#shellTop .appmenu-column');
  const tile = box.locator(`.appmenu-tile[data-feedback-id="tasks.menu.secciones.${key}"]`);
  if ((await tile.getAttribute('aria-expanded')) !== 'true') await tile.click();
  const panel = box.locator('.appmenu-panel');
  await expect(panel).toBeVisible();
  return panel;
}
/** Las marcas de las filas de una sección, en su orden. */
export async function menuRows(page: Page, key: string, host: MenuHost = 'drawer'): Promise<string[]> {
  const panel = await openMenuSection(page, key, host);
  return panel.locator('.appmenu-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-feedback-id') ?? ''));
}
/** Una fila del menú por su marca (`tasks.menu.oficios`), dentro de la sección `key` ya desplegada si se da. */
export async function menuRow(page: Page, feedbackId: string, key?: string, host: MenuHost = 'drawer'): Promise<Locator> {
  const box = key ? await openMenuSection(page, key, host) : host === 'drawer' ? await openMenu(page) : page.locator('#shellTop .appmenu-column');
  return box.locator(`.appmenu-row[data-feedback-id="${feedbackId}"]`);
}

/**
 * «Señalar para comentar» desde el cajón del menú común. Con la columna del ordenador, los bloques del lanzador están dos
 * veces en la página (columna y cajón): se mira solo el cajón, como hace Central (tests/central/menu-helpers.ts, P11).
 */
export async function setSignal(page: Page, on: boolean): Promise<void> {
  const drawer = await openMenu(page);
  const toggle = drawer.locator('.launcher-signal input');
  await expect(toggle).toBeVisible();
  if ((await toggle.isChecked()) !== on) await drawer.locator('.launcher-signal').click();
  await expect(toggle).toBeChecked({ checked: on });
  await page.keyboard.press('Escape');
  await expect(page.locator('.appmenu-drawer')).toHaveCount(0);
}
/** `feedbackRoundTrip` del kit con el interruptor del cajón del menú común (la única diferencia). */
export async function feedbackRoundTrip(page: Page, options: { target: string; text?: string; keyboard?: number; timeout?: number }): Promise<{ code: string }> {
  const timeout = options.timeout ?? 8000;
  await acceptUsageNotice(page);
  await setSignal(page, true);
  await longPress(page, page.locator(options.target).first());
  const composer = page.locator('.fb-composer');
  await expect(composer).toBeVisible();
  await composer.locator('.fb-message').fill(options.text ?? 'Prueba de humo del feedback');
  if (options.keyboard) await simulateKeyboard(page, options.keyboard);
  await composer.locator('.fb-send').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter').catch(() => undefined);
  await expect(composer).toHaveCount(0, { timeout });
  const toast = page.locator('.toast.show').filter({ hasText: /Enviado · FB_/ });
  await expect(toast).toBeVisible({ timeout });
  const fit = await toast.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const vv = window.visualViewport;
    const top = vv ? vv.offsetTop : 0;
    const bottom = vv ? vv.offsetTop + vv.height : innerHeight;
    return { h: r.height, inside: r.top >= top && r.bottom <= bottom && r.left >= 0 && r.right <= innerWidth };
  });
  expect(fit.inside, 'el aviso tiene que verse dentro de la pantalla').toBe(true);
  expect(fit.h, 'el aviso no puede estirarse en columna').toBeLessThan(90);
  const code = /FB_\d{4}_\d+/.exec((await toast.textContent()) ?? '')?.[0] ?? '';
  if (options.keyboard) await simulateKeyboard(page, null);
  if (!(await page.locator('.sheetback.show, .dialogback').count())) await setSignal(page, false);
  return { code };
}

/**
 * Ficha de tarea «Portada y foco» (MUELA-083 §1, tanda 31): cada bloque (`quien`, `nota`, `comentarios`, `pasos`, `material`,
 * `etiquetas`, `depende`, `adjuntos`, `mas`) se abre en foco desde su baldosa, con «‹ Portada» para volver. Abre el bloque
 * pedido (volviendo antes a la portada si hay otro abierto) y devuelve la zona del foco.
 */
export async function fichaBloque(page: Page, key: string): Promise<Locator> {
  const stage = page.locator('#sheet .tkf-stage');
  const tile = page.locator(`#sheet [data-tkf-tile="${key}"]`);
  if (await stage.isVisible().catch(() => false)) {
    if ((await stage.getAttribute('data-tkf-open')) === key) return stage;
    await stage.locator('.tkf-back').click();
  }
  await tile.click();
  await expect(stage).toBeVisible();
  return stage;
}
/** Vuelve de un bloque a la portada de la ficha. */
export async function fichaPortada(page: Page): Promise<void> {
  const stage = page.locator('#sheet .tkf-stage');
  if (await stage.isVisible().catch(() => false)) await stage.locator('.tkf-back').click();
  await expect(page.locator('#sheet .tkf-portada')).toBeVisible();
}
/** El lápiz de la portada enseña el campo del título (#teText) en el sitio. */
export async function fichaTitulo(page: Page): Promise<Locator> {
  await fichaPortada(page);
  if (!(await page.locator('#teText').isVisible())) await page.locator('#tkfTitleEdit').click();
  await expect(page.locator('#teText')).toBeVisible();
  return page.locator('#teText');
}
