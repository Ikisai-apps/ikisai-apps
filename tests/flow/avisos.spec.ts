/**
 * Flow · avisos del sábado: lo que podría «salir vacío» o fallar en silencio lo dice en pantalla.
 * - Caja profunda sin direcciones de Bitcoin: los dos métodos salen apagados con «pendiente de dirección» y una nota de
 *   dónde se ponen (no un error al tocarlos); la tarjeta, apagada.
 * - Pantalla que deja de actualizarse (el pull no vuelve): aviso visible con «Actualizar».
 * Contra la `flow-api` real sobre PGlite. Datos ficticios.
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../food/helpers.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/flow/mod.ts';
import { seedBookingEvent, seedBookingGuests } from './booking-event.ts';
import { buildFlowApp } from './e2e-build.ts';
import { startFlowServer, type FlowTestServer } from './server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/flow/vite.config.ts');
const V1 = '0f10a000-0000-4000-8000-000000000001';
const FLOW_NAME = 'Barra · avisos';

let api: FlowTestServer;
let server: PreviewServer;
let baseURL: string;
let number = 0;
let seq = 0;

async function ok(operations: unknown[]): Promise<any> {
  const r = await api.app.call('/api/v1/commands', { body: { requestId: `avisos-${++seq}-${crypto.randomUUID()}`, operations } });
  if (r.status !== 200) throw new Error(JSON.stringify(r.data));
  return r.data.results[0].result;
}
async function rows(table: string): Promise<any[]> { return (await api.app.call(`/api/v1/snapshot?tables=${table}`)).data.tables[0].rows; }
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  api = await startFlowServer();
  // Una v2 (caja profunda) con un cliente numerado y dos pedidos abiertos; sin direcciones de Bitcoin.
  const v2 = crypto.randomUUID();
  await ok([call(PROCEDURES.newVersion, { source_project_id: V1, project_id: v2, name: FLOW_NAME })]);
  const guest = crypto.randomUUID();
  // FL12 (0935): el flujo, ligado a un evento de Booking con ese huésped.
  const event = crypto.randomUUID();
  await seedBookingEvent(api.app.t.db, event, [api.app.users.owner]);
  await seedBookingGuests(api.app.t.db, event, [guest]);
  const p = (await rows(TABLES.projects)).find((x) => x.id === v2);
  await ok([{ op: 'update', table: TABLES.projects, id: v2, expectedRevision: p.revision, fields: { booking_event_id: event } }]);
  await ok([call(PROCEDURES.assignGuestNumbers, { project_id: v2, guests: [{ guest_id: guest, display_name: 'Cliente de prueba' }] })]);
  const customer = (await rows(TABLES.customers)).find((c) => c.project_id === v2 && c.number != null);
  number = customer.number;
  const product = (await rows(TABLES.products)).find((p) => p.project_id === v2 && p.prepared && p.active);
  for (let i = 0; i < 2; i += 1) {
    const id = crypto.randomUUID();
    await ok([{ op: 'insert', table: TABLES.orders, id, fields: { project_id: v2, origin: 'counter', customer_id: customer.id } },
      { op: 'insert', table: TABLES.orderLines, id: crypto.randomUUID(), fields: { order_id: id, product_id: product.id, quantity: 1 } }]);
  }
  await buildFlowApp();
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

async function enter(page: Page): Promise<void> {
  await page.goto(`${baseURL}/`);
  await page.getByLabel('Correo electrónico').fill('owner@example.invalid');
  await page.getByLabel('Contraseña').fill(api.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Flujos' })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(FLOW_NAME) }).first().click();
  // Barra inferior de la v2 con nombres cortos (revisión móvil 27-10): caben a 390 px sin cortarse.
  // A 390 px los nombres enteros no caben: el kit pasa la barra a la forma apretada y enseña los cortos (`short`); el
  // nombre entero sigue para el lector (oculto a la vista, no a la accesibilidad).
  await expect(page.locator('.nav.navtight')).toHaveCount(1);
  const shorts = await page.locator('a.navbtn .navshort').allInnerTexts();
  expect(shorts.length).toBeGreaterThanOrEqual(5);
  for (const l of shorts) expect(l.trim().length, l).toBeLessThanOrEqual(9);
  await expect(page.getByRole('link', { name: /Pedido y cobro/ }).first()).toBeAttached();
  await page.locator('a.navbtn', { hasText: 'Caja' }).first().click();
}

test('avisos · caja sin direcciones de Bitcoin: «pendiente de dirección», no un error', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page);
  await page.getByLabel('Buscar por número de cliente').first().fill(String(number));
  await page.getByRole('button', { name: 'Ficha del cliente' }).first().click();
  const boxes = page.getByRole('checkbox', { name: /Elegir pedido/ });
  await expect(boxes).toHaveCount(2);
  await boxes.nth(0).check(); await boxes.nth(1).check();
  await page.getByRole('button', { name: 'Pagar (2)' }).click();
  const methods = page.locator('.checkout-methods');
  for (const m of ['btc_ln', 'btc_chain']) {
    const b = methods.locator(`[data-method="${m}"]`);
    await expect(b).toBeDisabled();
    await expect(b).toContainText('pendiente de dirección');
  }
  await expect(methods.locator('[data-method="card"]')).toBeDisabled();
  await expect(methods.locator('[data-method="bizum"]')).toBeEnabled();
  await expect(page.locator('[data-note="bitcoin"]')).toContainText('Cobro con Bitcoin');
});

test('avisos · si la pantalla deja de actualizarse, lo dice', async ({ page }) => {
  await page.clock.install();
  await enter(page);
  await expect(page.locator('.banner[data-banner]')).toHaveCount(0);
  // El servidor deja de contestar: el pull se queda colgado (sin error de red que lo delate).
  await page.route('**/api/v1/**', () => { /* sin respuesta */ });
  await page.clock.fastForward(2 * 60_000);
  await expect(page.locator('.banner[data-banner="stale"], .banner[data-banner="error"]').first()).toBeVisible();
});
