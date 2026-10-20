/**
 * Central · Planos del centro y «Colocar» (tanda 36, MUELA-024): el owner, en el ordenador, sube el dibujo de una planta;
 * si el SVG trae los nombres de las estancias, se colocan solas (limpio con DOMPurify y sin meterlo en la página); las que
 * faltan, «Por revisar», se ponen y se mueven y estiran con el teclado; el dibujo con estancias encima no se quita. En el
 * móvil y para quien no es owner, solo el mapa. Contra la Edge real de Recursos sobre PGlite. Datos ficticios.
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../food/helpers.ts';
import { buildCentralApp } from './e2e-build.ts';
import { startCentralServer, type CentralTestServer } from './server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/central/vite.config.ts');

let api: CentralTestServer;
let server: PreviewServer;
let baseURL: string;
let seq = 0;
const uuid = () => crypto.randomUUID();
const ids = { building: uuid(), room: uuid(), lounge: uuid(), desk: uuid(), bed: uuid() };

// Un SVG con dos estancias con nombre (una con `id`, otra en un grupo con `data-name` y `transform`) y cosas que no
// deben llegar a ejecutarse nunca (script, `onload`, `foreignObject`).
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 500" onload="window.__planPwned=1">
  <script>window.__planPwned=1</script>
  <g id="layer1">
    <rect id="Dormitorio_3" x="100" y="100" width="200" height="150"/>
    <g data-name="Salón" transform="translate(400 50)"><rect x="0" y="0" width="300" height="200"/></g>
  </g>
  <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
</svg>`;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  api = await startCentralServer();
  const db = api.app.t.db;
  const a3 = (await db.query<{ id: string }>(`select id from resources.spaces where name = 'Altura 3'`)).rows[0]!.id;
  const res = await api.app.call('/api/v1/resources/commands', { body: { requestId: `plans-${++seq}`, operations: [
    { op: 'insert', table: 'resources.spaces', id: ids.building, fields: { parent_id: a3, kind: 'edificio', name: 'Albergue de prueba' } },
    { op: 'insert', table: 'resources.spaces', id: ids.room, fields: { parent_id: ids.building, kind: 'habitacion', name: 'Dormitorio 3' } },
    { op: 'insert', table: 'resources.spaces', id: ids.lounge, fields: { parent_id: ids.building, kind: 'habitacion', name: 'Salón' } },
    { op: 'insert', table: 'resources.spaces', id: ids.desk, fields: { parent_id: ids.building, kind: 'sala', name: 'Recepción' } },
    { op: 'insert', table: 'resources.spaces', id: ids.bed, fields: { parent_id: ids.room, kind: 'cama', name: 'Cama 1' } },
  ] } });
  expect(res.status, JSON.stringify(res.data)).toBe(200);
  process.env.VITE_API_PROXY = api.url;
  await buildCentralApp();
  server = await preview({
    configFile,
    logLevel: 'silent',
    preview: { port: await freePort(), strictPort: true, host: '127.0.0.1', proxy: { '/api': { target: api.url, changeOrigin: true } } },
  });
  baseURL = server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? `http://127.0.0.1:${server.config.preview.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server?.httpServer.close(() => resolve()));
  await api?.close();
});

async function login(page: Page, who = 'owner'): Promise<void> {
  await page.goto(`${baseURL}/`);
  await page.getByLabel('Correo electrónico').fill(`${who}@example.invalid`);
  await page.getByLabel('Contraseña').fill(api.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: /^Hola, / })).toBeVisible();
}

const shapeOf = async (id: string) => (await api.app.t.db.query<{ p: string | null; s: { points: number[][] } | null }>(`select plan_id as p, plan_shape as s from resources.spaces where id = $1`, [id])).rows[0]!;

test('planos · el owner sube un SVG con nombres y se colocan solas; lo demás, a mano y con el teclado', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  // Desde la Entidad (y el menú), «Planos del centro».
  await page.goto(`${baseURL}/#/entidad`);
  await page.locator('#entityPlans').click();
  await expect(page.getByRole('heading', { name: 'Planos del centro' })).toBeVisible();
  await expect(page.locator('#planTools')).toContainText('Aún no hay dibujos');

  // Subir el dibujo de la planta baja.
  await page.locator('#newPlan').click();
  await page.locator('#planBuilding').selectOption(ids.building);
  await page.locator('#planFloor').fill('Planta baja');
  await page.locator('#planFile').setInputFiles({ name: 'albergue.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(SVG) });
  await page.locator('#planSubmit').click();
  // El dibujo llega a Recursos (el aviso de «Dibujo subido» lo tapa enseguida el de lo colocado).
  await expect.poll(async () => (await api.app.t.db.query(`select 1 from resources.floor_plans where building_id = $1 and file_id is not null`, [ids.building])).rows.length).toBe(1);
  // Se colocan solas las dos que el SVG nombra (también la del grupo con transformación); el resto, «Por revisar».
  await expect(page.getByText('2 estancias colocadas solas; 2 por revisar.')).toBeVisible();
  await expect.poll(async () => (await shapeOf(ids.room)).s).toEqual({ points: [[0.1, 0.2], [0.3, 0.2], [0.3, 0.5], [0.1, 0.5]] });
  await expect.poll(async () => (await shapeOf(ids.lounge)).s).toEqual({ points: [[0.4, 0.1], [0.7, 0.1], [0.7, 0.5], [0.4, 0.5]] });
  const plan = (await api.app.t.db.query<{ id: string; w: string; h: string; f: string | null }>(`select id, width as w, height as h, file_id as f from resources.floor_plans where building_id = $1`, [ids.building])).rows[0]!;
  expect([Number(plan.w), Number(plan.h)]).toEqual([1000, 500]);
  expect(plan.f).not.toBeNull();
  expect((await shapeOf(ids.room)).p).toBe(plan.id);
  // Nada del SVG se ha ejecutado: nunca entra en la página.
  expect(await page.evaluate(() => (window as unknown as { __planPwned?: number }).__planPwned ?? null)).toBeNull();

  // «Por revisar»: Recepción y la cama. Recepción se pone en el plano y se mueve y estira con el teclado.
  await expect(page.locator('#placeReviewHead')).toHaveText('Por revisar · 2');
  await page.locator('#placeReview').getByRole('button', { name: 'Poner Recepción en el plano' }).click();
  const desk = page.locator(`#placeEditor [data-space-id="${ids.desk}"]`);
  await expect(desk).toBeFocused();
  await expect.poll(async () => (await shapeOf(ids.desk)).p).toBe(plan.id);
  const before = (await shapeOf(ids.desk)).s!.points;
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(async () => (await shapeOf(ids.desk)).s!.points[0]![0]).toBeCloseTo(before[0]![0]! + 0.02, 4);
  await expect.poll(async () => { const p = (await shapeOf(ids.desk)).s!.points; return p[2]![1]! - p[0]![1]!; }).toBeCloseTo(before[2]![1]! - before[0]![1]! + 0.01, 4);
  await expect(page.locator('#placeReviewHead')).toHaveText('Por revisar · 1');

  // Arrastrar con el ratón mueve la estancia; arrastrar una esquina la estira.
  const lounge = page.locator(`#placeEditor [data-space-id="${ids.lounge}"]`);
  const box = (await lounge.boundingBox())!;
  const stage = (await page.locator('#placeEditor .ctl-placesvg').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - stage.width * 0.1, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await shapeOf(ids.lounge)).s!.points[0]![0], { timeout: 5000 }).toBeCloseTo(0.3, 2);
  await page.locator('#placePlaced').getByRole('button', { name: 'Salón' }).click();
  const corner = page.locator('#placeEditor .ctl-placehandle').nth(2);
  const cb = (await corner.boundingBox())!;
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.mouse.down();
  await page.mouse.move(cb.x + cb.width / 2 + stage.width * 0.05, cb.y + cb.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => { const pts = (await shapeOf(ids.lounge)).s!.points; return pts[1]![0]! - pts[0]![0]!; }, { timeout: 5000 }).toBeCloseTo(0.35, 2);

  // El mapa de todas las apps las enseña ya: el dibujo con sus estancias.
  await expect(page.locator('#plansMap .map-shape')).toHaveCount(3);
  // El dibujo con estancias encima no se quita.
  await expect(page.locator(`#planList [data-plan="${plan.id}"]`).getByRole('button', { name: /^Quitar el dibujo/ })).toBeDisabled();

  // Quitar una del plano la devuelve a «Por revisar».
  await page.locator('#placePlaced').getByRole('button', { name: 'Recepción' }).click();
  await page.locator('#unplace').click();
  await expect.poll(async () => (await shapeOf(ids.desk)).p).toBeNull();
  await expect(page.locator('#placeReviewHead')).toHaveText('Por revisar · 2');
});

test('planos · en el móvil, y para quien no es owner, solo el mapa', async ({ browser }) => {
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await login(mobile);
  await mobile.goto(`${baseURL}/#/entidad/planos`);
  await expect(mobile.locator('#placeOnDesktop')).toBeVisible();
  await expect(mobile.locator('#newPlan')).toHaveCount(0);
  await expect(mobile.locator('#plansMap .map-box')).toBeVisible();
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await mobile.close();

  const reader = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await login(reader, 'reader');
  await reader.goto(`${baseURL}/#/entidad/planos`);
  await expect(reader.locator('#plansMap .map-box')).toBeVisible();
  await expect(reader.locator('#planTools')).toBeEmpty();
  await expect(reader.locator('#placeEditor')).toBeHidden();
  await reader.close();
});
