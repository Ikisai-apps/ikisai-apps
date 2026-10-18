/**
 * Ikisai Tasks · P2, PR 4: «Quién sabe hacerlo» (docs/tasks/API.md §34), en móvil de 390 px. Siembra con SQL las personas de
 * Central (`central.people`, con iniciales, nivel de casa y disponibilidad), los oficios (`central.trades`) y las capacidades
 * (`central.person_trades`, grado 0..2), y pasa oficios y personas a Central con las rutas reales (`actions/to-trades` y
 * `actions/people-to-central`). Comprueba: al poner un oficio salen las personas capaces, en orden (grado y después
 * disponibilidad); los aprendices solo con «Ver también aprendices»; quien sabe el oficio madre sale en la hija (la herencia la
 * resuelve Central); al tocar una chip la persona entra en «Personas» y se guarda; nada se asigna solo; con varios oficios se
 * juntan sin repetir; y con las personas en etiquetas no sale. Nombres inventados. Capturas en `coordinacion/tasks/p2-despues/`.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { buildTasksApp, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

declare const Sync: any, state: any, render: any, openTaskEditor: any, openProjectEditor: any;

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const id = () => crypto.randomUUID();
const MANT = id(), OBRA = id(), PERSON_VG = id(), ACCION = id(), FONT = id(), ACS = id(), ELEC = id();
const T_GRIFO = id(), T_NADA = id(), T_LUZ = id();
const TR_FONT = id(), TR_ACS = id(), TR_ELEC = id(), TR_PINT = id();
// Personas de Central (inventadas). VG solo tiene puesto el oficio madre (Fontanería): en ACS sale por la herencia de Central.
const P_VG = id(), P_AN = id(), P_LP = id(), P_MARTA = id(), P_NV = id();
let PERSON = '', seq = 0;

async function seedCentral() {
  const q = (sql: string, args: unknown[]) => server.app.t.db.query(sql, args);
  const person = (pid: string, name: string, level: string, initials: string | null, availability: string) =>
    q(`insert into central.people (id, display_name, relation, house_level, initials, active, availability) values ($1, $2, 'equipo', $3, $4, true, $5)`, [pid, name, level, initials, availability]);
  await person(P_VG, 'Valeria Gómez', 'staff', 'VG', 'media');
  await person(P_AN, 'Andrés Navarro', 'staff', 'AN', 'alta');
  await person(P_LP, 'Lucía Pardo', 'staff', 'LP', 'baja');
  await person(P_MARTA, 'Marta Ruiz', 'outsider', null, 'alta');
  await person(P_NV, 'Nora Vidal', 'staff', 'NV', 'segun_calendario');
  const trade = (tid: string, name: string, parent: string | null, label: string | null, position: number) =>
    q(`insert into central.trades (id, parent_id, name, source_label_id, position) values ($1, $2, $3, $4, $5)`, [tid, parent, name, label, position]);
  await trade(TR_FONT, 'Fontanería', null, FONT, 1);
  await trade(TR_ELEC, 'Electricidad', null, ELEC, 2);
  await trade(TR_PINT, 'Pintura', null, null, 3);
  await trade(TR_ACS, 'ACS', TR_FONT, ACS, 1);
  const can = (pid: string, tid: string, level: number) => q(`insert into central.person_trades (person_id, trade_id, level) values ($1, $2, $3)`, [pid, tid, level]);
  await can(P_VG, TR_FONT, 2);   // Experta en la madre → Experta en ACS (heredado)
  await can(P_LP, TR_ACS, 2);    // Experta en ACS, disponibilidad baja
  await can(P_AN, TR_ACS, 1);    // Sabe ACS, disponibilidad alta
  await can(P_MARTA, TR_ACS, 0); // Aprende ACS
  await can(P_NV, TR_ELEC, 2);   // Experta en Electricidad
  await can(P_AN, TR_ELEC, 1);   // Sabe Electricidad (con varios oficios, una sola vez)
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await buildTasksApp();
  server = await startE2EServer();
  ID = await seedDemo(server);
  const ok = async (operations: any[]) => { const res = await server.commit(operations); expect(res.status, JSON.stringify(res.data)).toBe(200); };
  const mant = createTabOps({ id: MANT, name: 'Mantenimiento', position: 90_000 });
  PERSON = mant.find((o) => o.fields?.system_key === 'person')!.id!;
  await ok(mant);
  await ok([{ op: 'insert', table: 'tasks.labels', id: PERSON_VG, fields: { tab_id: MANT, family_id: PERSON, name: 'VG', position: 1024 } }]);
  await ok([{ op: 'insert', table: 'tasks.families', id: ACCION, fields: { tab_id: null, name: 'Tipo: Acción', color: '#5a7a8a', position: 2 } }]);
  await ok([
    { op: 'insert', table: 'tasks.labels', id: FONT, fields: { tab_id: null, family_id: ACCION, name: 'Fontanería', position: 1024 } },
    { op: 'insert', table: 'tasks.labels', id: ELEC, fields: { tab_id: null, family_id: ACCION, name: 'Electricidad', position: 2048 } },
  ]);
  await ok([{ op: 'insert', table: 'tasks.labels', id: ACS, fields: { tab_id: null, family_id: ACCION, parent_id: FONT, name: 'ACS', position: 1024 } }]);
  await ok([{ op: 'insert', table: 'tasks.projects', id: OBRA, fields: { tab_id: MANT, title: 'Puesta a punto', position: 2048 } }]);
  await ok([
    { op: 'insert', table: 'tasks.tasks', id: T_GRIFO, fields: { tab_id: MANT, project_id: OBRA, title: 'Cambiar el grifo del ACS', position: 1024 } },
    { op: 'insert', table: 'tasks.tasks', id: T_NADA, fields: { tab_id: MANT, project_id: OBRA, title: 'Comprar material', position: 2048 } },
    { op: 'insert', table: 'tasks.tasks', id: T_LUZ, fields: { tab_id: MANT, project_id: OBRA, title: 'Revisar la luz del patio', position: 3072 } },
  ]);
  // La tarea del grifo ya lleva a VG (etiqueta de persona que pasa a su ficha): su chip sale como «ya está».
  await ok([
    { op: 'insert', table: 'tasks.task_labels', id: id(), fields: { tab_id: MANT, project_id: OBRA, task_id: T_GRIFO, label_id: PERSON_VG } },
  ]);
  await seedCentral();
  // Las idas reales, como las hacen los botones (oficios-boton.spec.ts y personas-boton.spec.ts).
  const trades = await server.app.call('/api/v1/actions/to-trades', { body: { requestId: `qs-${++seq}` } });
  expect(trades.status, JSON.stringify(trades.data)).toBe(200);
  const mapping: Record<string, string> = { [PERSON_VG]: P_VG };
  const preview = await server.app.call('/api/v1/read/tasks.people_preview', { body: {} });
  expect(preview.status, JSON.stringify(preview.data)).toBe(200);
  for (const l of preview.data.labels) if (!(l.labelIds as string[]).some((x) => x in mapping)) mapping[l.labelId] = 'remove';
  const people = await server.app.call('/api/v1/actions/people-to-central', { body: { requestId: `qs-${++seq}`, mapping } });
  expect(people.status, JSON.stringify(people.data)).toBe(200);
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  page = await openApp(context, server, { aliases: ID, errors });
  await expect.poll(() => page.evaluate(() => (window as any).eval('Sync.core.tradeSource()+":"+Sync.core.peopleSource()+":"+Sync.core.capabilities.length'))).toBe('central:central:7');
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

const openProject = (tab: string, p: string) => page.evaluate(([t, pr]) => { state.taskScope = 'area'; state.activeTab = t; state.view = 'project'; state.currentProject = pr; state.filters = {}; state.search = ''; state.groupBy = 'project'; render(); }, [tab, p]);
// La captura con «Quién sabe hacerlo» a la vista (la lista de resultados del buscador, cerrada).
const shot = async (name: string) => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(250);
  await page.evaluate(() => document.querySelector('#sheet .whoknows:not([hidden])')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `../coordinacion/tasks/p2-despues/${name}.png` }).catch(() => {});
};
const who = () => page.locator('#sheet .whoknows');
const whoChips = () => page.locator('#sheet .whoknows .whochip');
const whoNames = () => page.locator('#sheet .whoknows .whochip .whoname');
const picked = () => page.locator('#sheet .personfield .space-chip');
const pickTrade = async (q: string, name: string) => {
  await page.locator('#sheet .tradefield .space-search').fill(q);
  await page.locator('#sheet .tradefield .space-result:not(.empty)', { has: page.locator('.space-result-name', { hasText: new RegExp(`^${name}`) }) }).first().click();
};
const rows = async (table: string, key: string, owner: string, col: string) => (await server.rows(table)).filter((r) => r[key] === owner && !r.deleted_at).map((r) => r[col]).sort();

test('sin oficio no sale nada; al poner ACS salen las personas capaces, en orden, y nada se asigna solo', async () => {
  await openProject(MANT, OBRA);
  await page.evaluate((t) => openTaskEditor(t), T_NADA);
  await expect(page.locator('#sheet .tradefield')).toBeVisible();
  await expect(who()).toBeHidden();
  await pickTrade('acs', 'ACS');
  await expect(who()).toBeVisible();
  await expect(who().locator('.whotitle')).toHaveText('Quién sabe hacerlo');
  // Experta (VG, por la herencia de Fontanería; disponibilidad media), Experta (LP, baja), Sabe (AN, alta). Marta aprende: fuera.
  await expect(whoNames()).toHaveText(['VG', 'LP', 'AN']);
  await expect(whoChips().nth(0)).toHaveAttribute('title', 'Valeria Gómez · Experto · disponibilidad media');
  await expect(whoChips().nth(2)).toHaveAttribute('title', 'Andrés Navarro · Sabe · disponibilidad alta');
  await expect(whoChips().nth(0).locator('.level-star')).toHaveAttribute('aria-label', 'Experto');
  await expect(whoChips().nth(0).locator('.whodot')).toHaveAttribute('data-availability', 'media');
  await expect(picked()).toHaveCount(0);
  await shot('40-quien-sabe-ficha');
  // «Ver también aprendices»: Marta (sin iniciales: el nombre de pila), al final.
  await page.locator('#sheet [data-who-apprentices]').click();
  await expect(whoNames()).toHaveText(['VG', 'LP', 'AN', 'Marta']);
  await expect(page.locator('#sheet [data-who-apprentices]')).toHaveText('Ocultar aprendices');
  await shot('40-quien-sabe-aprendices');
  await page.locator('#sheet [data-who-apprentices]').click();
  await expect(whoNames()).toHaveText(['VG', 'LP', 'AN']);
  // Guardar sin tocar ninguna chip: el oficio se guarda y nadie queda puesto.
  await page.locator('#saveTaskBtn').click();
  await settled(page);
  expect(await rows('tasks.task_trades', 'task_id', T_NADA, 'trade_id')).toEqual([TR_ACS]);
  expect(await rows('tasks.task_people', 'task_id', T_NADA, 'person_id')).toEqual([]);
});

test('al tocar una chip, la persona entra en «Personas» (un toque) y se guarda; la que ya estaba sale marcada', async () => {
  await openProject(MANT, OBRA);
  await page.evaluate((t) => openTaskEditor(t), T_GRIFO);
  await expect(picked()).toHaveText(['Valeria Gómez']);
  await pickTrade('acs', 'ACS');
  await expect(whoNames()).toHaveText(['VG', 'LP', 'AN']);
  await expect(whoChips().nth(0)).toHaveClass(/on/);
  await expect(whoChips().nth(0)).toHaveAttribute('aria-pressed', 'true');
  await whoChips().nth(1).click();
  await expect(picked()).toHaveText(['Valeria Gómez', 'Lucía Pardo']);
  await expect(whoChips().nth(1)).toHaveClass(/on/);
  // Tocar otra vez la misma no la quita ni la repite (ya está: `aria-disabled`).
  await expect(whoChips().nth(1)).toHaveAttribute('aria-disabled', 'true');
  await whoChips().nth(1).dispatchEvent('click');
  await expect(picked()).toHaveCount(2);
  await shot('40-quien-sabe-elegida');
  await page.locator('#saveTaskBtn').click();
  await settled(page);
  expect(await rows('tasks.task_people', 'task_id', T_GRIFO, 'person_id')).toEqual([P_VG, P_LP].sort());
  expect(await rows('tasks.task_trades', 'task_id', T_GRIFO, 'trade_id')).toEqual([TR_ACS]);
});

test('varios oficios: se juntan sin repetir, con el mejor grado; sin nadie capaz, el aviso con el enlace a Central', async () => {
  await openProject(MANT, OBRA);
  await page.evaluate((t) => openTaskEditor(t), T_LUZ);
  await pickTrade('acs', 'ACS');
  await pickTrade('electr', 'Electricidad');
  // VG (2, media), NV (2, según calendario), LP (2, baja), AN (1 en los dos: una sola vez).
  await expect(whoNames()).toHaveText(['VG', 'NV', 'LP', 'AN']);
  await shot('40-quien-sabe-varios-oficios');
  // Quitar los dos y poner Pintura, que nadie tiene.
  await page.locator('#sheet .tradefield .space-chip-x').first().click();
  await page.locator('#sheet .tradefield .space-chip-x').first().click();
  await expect(who()).toBeHidden();
  await pickTrade('pint', 'Pintura');
  await expect(who().locator('.whoempty')).toContainText('Nadie tiene este oficio todavía');
  await expect(whoChips()).toHaveCount(0);
  await shot('40-quien-sabe-nadie');
  await page.evaluate(() => (window as any).closeSheet?.());
  expect(await rows('tasks.task_people', 'task_id', T_LUZ, 'person_id')).toEqual([]);
});

test('ficha de proyecto: también sale debajo de «Oficio del proyecto» y la chip va a «Personas del proyecto»', async () => {
  await openProject(MANT, OBRA);
  await page.evaluate((p) => openProjectEditor(p), OBRA);
  await expect(who()).toBeHidden();
  await pickTrade('electr', 'Electricidad');
  await expect(whoNames()).toHaveText(['NV', 'AN']);
  await whoChips().nth(0).click();
  await expect(picked()).toHaveText(['Nora Vidal']);
  await shot('40-quien-sabe-proyecto');
  await page.locator('#saveProjectBtn').click();
  await settled(page);
  expect(await rows('tasks.project_people', 'project_id', OBRA, 'person_id')).toEqual([P_NV]);
});

test('con las personas en etiquetas no sale (aunque los oficios sigan en Central)', async () => {
  const back = await server.app.call('/api/v1/actions/people-to-labels', { body: { requestId: `qs-${++seq}`, dropUnmapped: true } });
  expect(back.status, JSON.stringify(back.data)).toBe(200);
  await page.evaluate(() => (window as any).syncNow());
  await settled(page);
  await expect.poll(() => page.evaluate(() => (window as any).eval('Sync.core.tradeSource()+":"+Sync.core.peopleSource()'))).toBe('central:labels');
  await openProject(MANT, OBRA);
  await page.evaluate((t) => openTaskEditor(t), T_NADA);
  await expect(page.locator('#sheet .tradefield')).toBeVisible();
  await expect(page.locator('#sheet .tradefield .space-chip')).toContainText(['ACS']);
  await expect(who()).toHaveCount(0);
  await expect(page.locator('#sheet .personfield')).toHaveCount(0);
  await page.evaluate(() => (window as any).closeSheet?.());
  expect(errors).toEqual([]);
});
