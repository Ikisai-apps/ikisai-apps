/**
 * Central · Planos del centro y «Colocar» (tanda 36, MUELA-024): el owner, en el ordenador, sube el dibujo de una planta;
 * si el SVG trae los nombres de las estancias, se colocan solas (limpio con DOMPurify y sin meterlo en la página); las que
 * faltan, «Por revisar», se ponen y se mueven y estiran con el teclado; el dibujo con estancias encima no se quita. En el
 * móvil y para quien no es owner, solo el mapa. Contra la Edge real de Recursos sobre PGlite. Datos ficticios.
 * Tanda 37 (MUELA-092): se sube el SVG limpio, las camas acompañan a su habitación (un «Deshacer»), sin red se apaga lo
 * que escribe dibujos, el aviso dice los nombres que no son de ninguna estancia y un giro que no se lee va a «Por revisar».
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
const ids = { finca: uuid(), building: uuid(), room: uuid(), lounge: uuid(), desk: uuid(), bed: uuid(), annex: uuid(), kitchen: uuid(), pantry: uuid() };

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

// Anexo: la cocina girada 90° sobre su centro (se coloca con sus esquinas giradas), la despensa con una transformación que
// no se puede leer (va a «Por revisar» con el motivo), un nombre que no es de ninguna estancia y los del programa.
const ANNEX_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <g id="layer1">
    <rect id="Cocina" x="100" y="100" width="200" height="100" transform="rotate(90 200 150)"/>
    <rect id="Despensa" x="500" y="500" width="100" height="100" transform="rotate(10deg)"/>
    <rect id="Cuarto_de_calderas" x="700" y="700" width="100" height="100"/>
    <rect id="rect123" x="800" y="100" width="50" height="50"/>
  </g>
</svg>`;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  api = await startCentralServer();
  const db = api.app.t.db;
  const a3 = (await db.query<{ id: string }>(`select id from resources.spaces where name = 'Altura 3'`)).rows[0]!.id;
  const res = await api.app.call('/api/v1/resources/commands', { body: { requestId: `plans-${++seq}`, operations: [
    { op: 'insert', table: 'resources.spaces', id: ids.finca, fields: { parent_id: null, kind: 'exterior', name: 'Finca de prueba' } },
    { op: 'insert', table: 'resources.spaces', id: ids.building, fields: { parent_id: a3, kind: 'edificio', name: 'Albergue de prueba' } },
    { op: 'insert', table: 'resources.spaces', id: ids.room, fields: { parent_id: ids.building, kind: 'habitacion', name: 'Dormitorio 3' } },
    { op: 'insert', table: 'resources.spaces', id: ids.lounge, fields: { parent_id: ids.building, kind: 'habitacion', name: 'Salón' } },
    { op: 'insert', table: 'resources.spaces', id: ids.desk, fields: { parent_id: ids.building, kind: 'sala', name: 'Recepción' } },
    { op: 'insert', table: 'resources.spaces', id: ids.bed, fields: { parent_id: ids.room, kind: 'cama', name: 'Cama 1' } },
    { op: 'insert', table: 'resources.spaces', id: ids.annex, fields: { parent_id: a3, kind: 'edificio', name: 'Anexo de prueba' } },
    { op: 'insert', table: 'resources.spaces', id: ids.kitchen, fields: { parent_id: ids.annex, kind: 'sala', name: 'Cocina' } },
    { op: 'insert', table: 'resources.spaces', id: ids.pantry, fields: { parent_id: ids.annex, kind: 'sala', name: 'Despensa' } },
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
  // Lo que se ha subido es el SVG limpio, con sus nombres: sin script, manejadores ni foreignObject.
  const stored = [...api.app.supabase.storage.values()].map((b) => new TextDecoder().decode(b)).find((s) => s.includes('viewBox="0 0 1000 500"'));
  expect(stored).toBeTruthy();
  expect(stored).not.toMatch(/<script|onload|foreignObject|__planPwned/i);
  expect(stored).toContain('Dormitorio_3');
  expect(stored).toContain('data-name="Salón"');

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
  // El dibujo con estancias encima no se quita, y el botón dice por qué.
  const removeBtn = page.locator(`#planList [data-plan="${plan.id}"]`).getByRole('button', { name: /^Quitar el dibujo/ });
  await expect(removeBtn).toBeDisabled();
  await expect(removeBtn).toHaveAccessibleDescription('Tiene estancias encima: para quitarlo, quítalas antes del plano.');

  // Quitar una del plano la devuelve a «Por revisar».
  await page.locator('#placePlaced').getByRole('button', { name: 'Recepción' }).click();
  await page.locator('#unplace').click();
  await expect.poll(async () => (await shapeOf(ids.desk)).p).toBeNull();
  await expect(page.locator('#placeReviewHead')).toHaveText('Por revisar · 2');

  // Las camas acompañan a su habitación: la cama, dentro del dormitorio; al mover y estirar el dormitorio, va con él.
  await page.locator('#placeReview').getByRole('button', { name: 'Poner Cama 1 en el plano' }).click();
  await expect.poll(async () => (await shapeOf(ids.bed)).p).toBe(plan.id);
  const roomBefore = (await shapeOf(ids.room)).s!.points;
  const bedBefore = (await shapeOf(ids.bed)).s!.points;
  await page.locator(`#placeEditor [data-space-id="${ids.room}"]`).focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await shapeOf(ids.bed)).s!.points[0]![1]).toBeCloseTo(bedBefore[0]![1]! + 0.02, 4);
  expect((await shapeOf(ids.room)).s!.points[0]![1]).toBeCloseTo(roomBefore[0]![1]! + 0.02, 4);
  // Un solo «Deshacer» devuelve las dos a su sitio.
  // (Los avisos con «Deshacer» de los arrastres de antes se apilan con este: se pulsa el suyo.)
  await page.locator('.ikisai-toast .toast-item').filter({ hasText: 'Movida «Dormitorio 3» con su cama.' }).getByRole('button', { name: 'Deshacer' }).click();
  await expect.poll(async () => (await shapeOf(ids.room)).s!.points).toEqual(roomBefore);
  await expect.poll(async () => (await shapeOf(ids.bed)).s!.points).toEqual(bedBefore);
  // Estirar con el ratón el dormitorio estira también la cama (la misma escala desde la misma esquina).
  await page.locator('#placePlaced').getByRole('button', { name: 'Dormitorio 3' }).click();
  const handle = page.locator('#placeEditor .ctl-placehandle').nth(2);
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + stage.width * 0.2, hb.y + hb.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => { const p = (await shapeOf(ids.room)).s!.points; return p[1]![0]! - p[0]![0]!; }, { timeout: 5000 }).toBeCloseTo(0.4, 2);
  const bedW = (bedBefore[1]![0]! - bedBefore[0]![0]!) * 2;
  await expect.poll(async () => { const p = (await shapeOf(ids.bed)).s!.points; return p[1]![0]! - p[0]![0]!; }, { timeout: 5000 }).toBeCloseTo(bedW, 2);
  await expect(page.locator('.ikisai-toast')).toContainText('Estirada «Dormitorio 3» con su cama.');
  // El rótulo lleva el halo de la pieza del kit sobre el dibujo.
  const halo = await page.locator('#placeEditor .ctl-placelabel').first().evaluate((n) => { const cs = getComputedStyle(n); return { order: cs.paintOrder, stroke: cs.stroke }; });
  expect(halo.order).toContain('stroke');
  expect(halo.stroke).not.toBe('none');

  // Decoración (encargo de VG del 27-10): sin escala no se decora; con ella, la pieza del kit con la capa editable.
  await page.locator('#placeTabs [data-tab="decoracion"]').click();
  await expect(page.locator('#placeEditor')).toContainText('necesita su escala');
  await expect(page.locator('#decorIcons')).toHaveCount(0);
  await expect(page.locator('#placeEditor')).toContainText('Aún no hay iconos');
  await page.locator('#decorPlanScale').fill('0.05');
  await page.locator('#saveDecorScale').click();
  await expect.poll(async () => (await api.app.t.db.query<{ g: unknown }>(`select grid as g from resources.floor_plans where id = $1`, [plan.id])).rows[0]!.g).toEqual({ metersPerUnit: 0.05, originX: 0, originY: 0 });
  await expect(page.locator('#decorStage .map-box')).toBeVisible();
  await page.locator('#placeTabs [data-tab="estancias"]').click();
  await expect(page.locator('#placeReviewHead')).toBeVisible();

  // Imágenes del centro: el owner las sube por edificio (una silueta en PNG).
  await page.locator('#newCenterImage').click();
  await page.locator('#imageBuilding').selectOption(ids.building);
  await page.locator('#imageKind').selectOption('silueta');
  await page.locator('#imageTitle').fill('Alzado norte');
  await page.locator('#imageFile').setInputFiles({ name: 'alzado.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
  await page.locator('#imageSubmit').click();
  await expect.poll(async () => (await api.app.t.db.query<{ k: string; t: string }>(`select kind as k, title as t from resources.space_images where space_id = $1 and deleted_at is null`, [ids.building])).rows).toEqual([{ k: 'silueta', t: 'Alzado norte' }]);
  await expect(page.locator(`#centerImageList [data-space="${ids.building}"]`)).toContainText('Alzado norte');
});

test('planos · un giro se coloca bien; lo que no se lee, «Por revisar» con el motivo; sin red, apagado con su motivo', async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  await page.goto(`${baseURL}/#/entidad/planos`);
  await page.locator('#newPlan').click();
  await page.locator('#planBuilding').selectOption(ids.annex);
  await page.locator('#planFile').setInputFiles({ name: 'anexo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(ANNEX_SVG) });
  await page.locator('#planSubmit').click();
  // La cocina, girada: sus cuatro esquinas giradas 90° sobre su centro.
  await expect.poll(async () => (await shapeOf(ids.kitchen)).s?.points.map((p) => p.map((n) => Math.round(n * 1000) / 1000)) ?? null)
    .toEqual([[0.25, 0.05], [0.25, 0.25], [0.15, 0.25], [0.15, 0.05]]);
  // El aviso dice qué nombre del SVG no es de ninguna estancia (no los del programa de dibujo).
  await expect(page.locator('.ikisai-toast')).toContainText('Sin estancia con ese nombre: «Cuarto_de_calderas».');
  await expect(page.locator('#placeUnmatched')).toContainText('«Cuarto_de_calderas»');
  await expect(page.locator('#placeUnmatched')).not.toContainText('layer1');
  await expect(page.locator('#placeUnmatched')).not.toContainText('rect123');
  // La despensa no se coloca mal: va a «Por revisar» con el motivo.
  expect((await shapeOf(ids.pantry)).p).toBeNull();
  const pantry = page.locator(`#placeReview [data-space="${ids.pantry}"]`);
  await expect(pantry).toContainText('No se ha colocado sola: el SVG la gira o la deforma de una manera que no se puede leer.');
  await expect(pantry.getByRole('button', { name: 'Poner Despensa en el plano' })).toHaveAccessibleDescription(/no se puede leer/);

  // Sin red: subir, sustituir, quitar y «Colocar solo» se apagan con su motivo.
  await context.setOffline(true);
  await expect(page.locator('#newPlan')).toHaveAttribute('aria-disabled', 'true');
  const annexRow = page.locator('#planList li').filter({ hasText: 'Anexo de prueba' });
  await expect(annexRow.getByRole('button', { name: /^Sustituir el dibujo/ })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#planOffline')).toBeVisible();
  await expect(page.locator('#planOffline')).toContainText('necesita conexión');
  await expect(page.locator('#autoPlace')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#autoPlace')).toHaveAccessibleDescription('Colocar solo lee el dibujo con conexión.');
  await context.setOffline(false);
  await expect(page.locator('#newPlan')).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#autoPlace')).not.toHaveAttribute('aria-disabled', 'true');
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
  // Las imágenes del centro se ven, pero solo el owner las sube.
  await expect(reader.locator('#centerImages')).toBeVisible();
  await expect(reader.locator('#newCenterImage')).toHaveCount(0);
  await reader.close();
});

test('planos · la finca: escala y cotas del SVG, y sus curvas de nivel se ajustan con el teclado (0815)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  const altura1 = (await api.app.t.db.query<{ id: string }>(`select id from resources.spaces where name = 'Altura 1' and deleted_at is null`)).rows[0]!.id;
  const FINCA = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" data-meters-per-unit="1">
    <path data-name="Parcela" d="M10 10 L390 10 L390 290 L10 290 Z"/>
    <path data-contour="Altura 1" d="M10 250 L200 240 L390 250"/>
    <path data-contour="Altura 2" d="M10 200 C100 180 300 180 390 200"/>
    <path data-contour="Altura 3" d="M10 150 C100 130 300 130 390 150"/>
    <path data-contour="Altura 4" d="M10 100 c90 -20 290 -20 380 0"/>
    <path data-contour="Altura 5" d="M10 50 C100 30 300 30 390 50"/>
  </svg>`;
  const alturas = (await api.app.t.db.query<{ id: string; name: string }>(`select id, name from resources.spaces where kind = 'altura' and deleted_at is null order by name`)).rows;
  const idOf = (n: number) => alturas.find((a) => a.name === `Altura ${n}`)!.id;
  await page.goto(`${baseURL}/#/entidad/planos`);
  await page.locator('#newPlan').click();
  await page.locator('#planKind').selectOption('estate');
  await page.locator('#planBuilding').selectOption(ids.finca);
  await page.locator('#planFile').setInputFiles({ name: 'finca.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(FINCA) });
  await page.locator('#planSubmit').click();
  const estate = async () => (await api.app.t.db.query<{ id: string; k: string; g: unknown; c: Array<{ spaceId: string; x: number; y: number; points?: number[][] }> | null }>(
    `select id, kind as k, grid as g, contours as c from resources.floor_plans where building_id = $1 and deleted_at is null`, [ids.finca])).rows[0] ?? null;
  await expect.poll(async () => (await estate())?.k ?? null).toBe('estate');
  const first = (await estate())!;
  expect(first.g).toEqual({ metersPerUnit: 1, originX: 0, originY: 0 });
  // La cota de cada altura, en el punto medio de su curva; las Bézier (absolutas o relativas), por su punto medio y no por los de control.
  expect(first.c).toEqual([
    { spaceId: altura1, x: 0.5, y: 0.8 }, { spaceId: idOf(2), x: 0.5, y: 0.6167 }, { spaceId: idOf(3), x: 0.5, y: 0.45 },
    { spaceId: idOf(4), x: 0.5, y: 0.2833 }, { spaceId: idOf(5), x: 0.5, y: 0.1167 },
  ]);
  // En «Colocar», las cinco curvas con tres asas cada una y su nombre con la cota.
  await expect(page.locator('#placeEditor [data-contour-point]')).toHaveCount(15);
  await expect(page.locator('#placeEditor [data-contour-label]')).toHaveCount(5);
  await expect(page.locator(`#placeEditor [data-contour-label="${idOf(2)}"]`)).toHaveText('Altura 2 · sin cota');

  // «Colocar» de la finca: la curva con sus puntos; con el teclado, el del medio baja y se guarda la curva entera.
  const mid = page.locator(`#placeEditor [data-contour-point="${altura1}:1"]`);
  await expect(mid).toBeVisible();
  await mid.focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await estate())?.c?.[0]?.points ?? null).toEqual([[0.025, 0.8333], [0.5, 0.805], [0.975, 0.8333]]);
  await expect(page.locator('.ikisai-toast')).toContainText('Curva de «Altura 1» ajustada.');
  // «Deshacer» la devuelve como estaba (sin puntos: la del SVG).
  await page.locator('.ikisai-toast').getByRole('button', { name: 'Deshacer' }).click();
  await expect.poll(async () => (await estate())?.c?.[0]?.points ?? null).toBeNull();
});

