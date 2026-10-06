/**
 * Ikisai Tasks · aceptación V1 del usuario, decisiones 7 y 9 (docs/tasks/ESTADO.md):
 * 7) «Familia de responsables»: se elige en el editor de familia; mover la marca quita en el mismo guardado los
 *    responsables de la familia anterior y el selector de responsable pasa a ofrecer las etiquetas de la nueva.
 * 9) Etiquetas padre e hija: se ven como «Padre: Hija», elegir una hija añade su padre (filtrar por el padre la
 *    incluye) y se pueden elegir varias hijas de padres distintos; no hay tercer nivel.
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { build } from 'vite';
import { VITE_CONFIG, startE2EServer, type E2EServer } from './e2e-server.ts';
import { openApp, seedDemo, settled, type Aliases } from './e2e-helpers.ts';

declare const Sync: any;
declare let state: any;
declare const tab: any, label: any, save: any, render: any, openFamilyEditor: any, openTaskEditor: any, closeSheet: any, navigateView: any, taskLocation: any, filteredTasks: any, project: any, labelName: any, touch: any;

let server: E2EServer;
let ID: Aliases;
let context: BrowserContext;
let a: Page;
const errors: string[] = [];

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await build({ configFile: VITE_CONFIG, logLevel: 'silent' });
  server = await startE2EServer();
  ID = await seedDemo(server);
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  a = await openApp(context, server, { aliases: ID, errors });
});
test.afterAll(async () => { await context?.close(); await server?.close(); });

test('[V1·7] familia de responsables: se mueve desde el editor de familia y quita los responsables anteriores', async () => {
  // Una familia nueva, «Grupo: Persona», con una etiqueta; una tarea con responsable de la familia de personas actual.
  const ids = await a.evaluate(() => {
    const scope = tab(), person = scope.families.find((f: any) => f.system === 'person');
    const fid = crypto.randomUUID(), vera = crypto.randomUUID();
    scope.families.push({ id: fid, name: 'Grupo: Persona', color: '#4e6f72', archived: false, system: null, version: 1 });
    scope.labels.push({ id: vera, text: 'Vera Grupo', family: fid, parent: null, archived: false });
    const loc = taskLocation((window as any).ID.t2), owner = scope.labels.find((l: any) => l.family === person.id && !l.archived);
    loc.t.owner = owner.id; touch(loc.t);
    save(); render();
    return { fid, vera, old: person.id, owner: owner.id };
  });
  await settled(a);
  expect((await server.rows('tasks.tasks')).find((r) => r.id === ID.t2)!.owner_label_id).toBe(ids.owner);

  await a.evaluate((fid) => openFamilyEditor(fid), ids.fid);
  await expect(a.locator('#feOwners')).not.toBeChecked();
  await a.locator('#feOwners').check();
  await expect(a.locator('#feOwnersHint')).toContainText('sin responsable');
  await a.locator('#saveFamily').click();
  await settled(a);

  const families = await server.rows('tasks.families');
  expect(families.find((f) => f.id === ids.fid)!.system_key).toBe('person');
  expect(families.find((f) => f.id === ids.old)!.system_key).toBeNull();
  expect((await server.rows('tasks.tasks')).find((r) => r.id === ID.t2)!.owner_label_id, 'el responsable anterior se quita').toBeNull();
  // El selector de responsable ofrece ahora las etiquetas de la nueva familia.
  await a.evaluate(() => { state.currentProject = (window as any).ID.p1; openTaskEditor((window as any).ID.t2); });
  await expect(a.locator('#teOwner option')).toContainText(['Vera Grupo']);
  await a.evaluate(() => closeSheet());
  expect(errors).toEqual([]);
});

test('[V1·9] etiquetas padre e hija: «Padre: Hija», elegir una hija añade su padre y filtrar por el padre la incluye', async () => {
  const ids = await a.evaluate(() => {
    const scope = tab(), family = scope.families.find((f: any) => f.system === 'space');
    const zona = crypto.randomUUID(), espacio = crypto.randomUUID(), planta = crypto.randomUUID(), sotano = crypto.randomUUID();
    scope.labels.push(
      { id: zona, text: 'Zona', family: family.id, parent: null, archived: false },
      { id: planta, text: 'Planta', family: family.id, parent: null, archived: false },
      { id: espacio, text: 'Espacio', family: family.id, parent: zona, archived: false },
      { id: sotano, text: 'Sótano', family: family.id, parent: planta, archived: false });
    save(); render();
    return { family: family.id, zona, espacio, planta, sotano };
  });
  await settled(a);
  expect(await a.evaluate((id) => labelName(label(id)), ids.espacio)).toBe('Zona: Espacio');

  // Dos hijas de padres distintos en la misma tarea: se guardan con sus dos padres.
  await a.evaluate((x) => { const loc = taskLocation((window as any).ID.t2); loc.t.labels = [...loc.t.labels.filter((l: string) => !([x.zona, x.planta] as string[]).includes(l)), x.espacio, x.sotano]; touch(loc.t); save(); render(); }, ids);
  await settled(a);
  const bridges = (await server.rows('tasks.task_labels')).filter((r) => r.task_id === ID.t2 && !r.deleted_at).map((r) => r.label_id);
  for (const id of [ids.espacio, ids.sotano, ids.zona, ids.planta]) expect(bridges).toContain(id);

  // Filtrar por el padre incluye la tarea etiquetada con su hija; las chips dicen «Padre: Hija».
  await a.evaluate((x) => { state.view = 'project'; state.currentProject = (window as any).ID.p1; state.filters = { [x.family]: [x.zona] }; render(); }, ids);
  expect(await a.evaluate(() => filteredTasks(project()).some((t: any) => t.id === (window as any).ID.t2))).toBe(true);
  await expect(a.locator(`.task[data-row="${ID.t2}"] .chip`, { hasText: 'Zona: Espacio' })).toBeVisible();

  // No hay tercer nivel: una hija no puede ser padre.
  await a.evaluate((x) => { const scope = tab(); scope.labels.push({ id: crypto.randomUUID(), text: 'Rincón', family: x.family, parent: x.espacio, archived: false }); save(); }, ids);
  await a.waitForFunction(() => !!Sync.record.failure || Sync.mode === 'error', null, { timeout: 20_000 });
  expect(await a.evaluate(() => Sync.record.failure?.code)).toBe('INVALID_LABEL_PARENT');
  expect(errors).toEqual([]);
});
