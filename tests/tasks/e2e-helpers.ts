/**
 * Ayudas de las pruebas de extremo a extremo de Tasks: semilla de demostración (la del repo antiguo, con uuid
 * deterministas y un mapa alias → uuid para conservar los nombres de los escenarios originales) y apertura de la app.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from 'playwright/test';
import { decompose, emptyDataset, chunkOperations, type LegacyTab } from '../../packages/domain-tasks/src/index.ts';
import { OWNER, type E2EServer } from './e2e-server.ts';

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
    await page.waitForFunction(() => typeof Sync !== 'undefined' && Sync.ready && Sync.mode === 'online' && !Sync.busy && Sync.record.queue.length === 0, null, { timeout: 20_000 });
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
