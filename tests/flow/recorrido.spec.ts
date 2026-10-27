/**
 * Flow · recorrido de la primera entrega real (FLOW-DIR-001 §9): cliente con número estable → caja → preparación →
 * entrega parcial y final, sin perder pedidos, dinero ni estados entre sesiones. Dos navegadores: el del público (carta,
 * sin sesión, en /recorridos/carta) y el del personal (raíz). Contra la `flow-api` real sobre PGlite. Datos ficticios.
 */
import { expect, test, type Browser, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../food/helpers.ts';
import { buildFlowApp } from './e2e-build.ts';
import { startFlowServer, type FlowTestServer } from './server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/flow/vite.config.ts');

let api: FlowTestServer;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  api = await startFlowServer();
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

async function staff(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'es-ES', timezoneId: 'Europe/Madrid' })).newPage();
  await page.goto(`${baseURL}/`);
  await page.getByLabel('Correo electrónico').fill('owner@example.invalid');
  await page.getByLabel('Contraseña').fill(api.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Flujos' })).toBeVisible();
  await page.getByRole('button', { name: /Barra · v1/ }).first().click();
  await expect(page.locator('a.navbtn', { hasText: 'Pedido y cobro' })).toBeVisible();
  return page;
}

const tab = (page: Page, name: string) => page.locator('a.navbtn', { hasText: name }).first().click();

test('recorrido · cliente 100 → caja cobra → preparación → entrega parcial y final → el cliente lo ve entregado', async ({ browser }) => {
  test.setTimeout(180_000);
  // 1. Público: carta en la raíz, sin login. Dos serranos y un agua; enviar a barra da un número.
  const pub = await (await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'es-ES' })).newPage();
  await pub.goto(`${baseURL}/recorridos/carta`);
  await expect(pub.getByRole('heading', { name: 'Carta' })).toBeVisible();
  await expect(pub.getByRole('heading', { name: 'Clásicos' })).toBeVisible();
  const serrano = pub.locator('[data-product="clasico:A"]');
  await serrano.getByRole('button', { name: 'Sumar' }).click();
  await serrano.getByRole('button', { name: 'Sumar' }).click();
  await pub.locator('[data-product="barra:A"]').getByRole('button', { name: 'Sumar' }).click();
  await expect(pub.locator('#cartaTotal')).toHaveText(/6,00/);
  await pub.locator('#miPedido').click();
  await pub.getByRole('button', { name: 'Enviar a barra' }).click();
  await expect(pub.locator('#numeroCliente')).toHaveText('Soy el 100');
  // El número se conserva en este navegador.
  await pub.reload();
  await expect(pub.locator('#misPedidos')).toHaveText('Soy el 100');

  // 2. Caja: busca el 100, revisa y cobra en efectivo.
  const desk = await staff(browser);
  await tab(desk, 'Pedido y cobro');
  await desk.getByLabel('Buscar por número de cliente').fill('100');
  const card = desk.locator('.order-card', { hasText: 'Cliente 100' });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Por cobrar');
  await card.locator('.qcard-main').click();
  await desk.getByRole('button', { name: 'Cobrado: efectivo' }).click();
  await expect(desk.locator('.order-head')).toContainText('Pedido 1', { timeout: 15_000 });
  await desk.keyboard.press('Escape');

  // 3. Preparación: dos serranos, en orden; cada uno, tomar y terminar.
  await tab(desk, 'Preparación');
  const cards = desk.locator('.fqueue .qcard');
  await expect(cards).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    const c = cards.nth(i);
    await c.locator('.qcard-main').click();
    await expect(c).toHaveAttribute('data-status', 'in_progress', { timeout: 15_000 });
    await c.locator('.qcard-main').click();
    await expect(c).toHaveAttribute('data-status', 'done', { timeout: 15_000 });
  }
  // Lo hecho no se mueve: siguen en su sitio, terminados.
  await expect(cards).toHaveCount(2);

  // 4. Servicio: entrega parcial (solo el agua): el pedido sigue por entregar; luego el resto y «Menú entregado».
  await tab(desk, 'Servicio y entrega');
  const order = desk.locator('.order-card', { hasText: 'Cliente 100' });
  await expect(order).toContainText('Listo para entregar');
  await order.locator('.qcard-main').click();
  const water = desk.locator('.delivery-line', { hasText: 'Agua' });
  await water.getByRole('button', { name: 'Sumar' }).click();
  await expect(water).toContainText('1 de 1 entregados', { timeout: 15_000 });
  await desk.keyboard.press('Escape');
  await expect(order).toContainText('Listo para entregar');
  await order.locator('.qcard-main').click();
  const ham = desk.locator('.delivery-line', { hasText: 'Serrano' });
  await ham.getByRole('button', { name: 'Sumar' }).click();
  await ham.getByRole('button', { name: 'Sumar' }).click();
  await expect(ham).toContainText('2 de 2 entregados', { timeout: 15_000 });
  await desk.getByRole('button', { name: 'Menú entregado' }).click();
  await expect(order).toContainText('Entregado', { timeout: 15_000 });

  // 5. El cliente ve su pedido entregado.
  await pub.locator('#misPedidos').click();
  await expect(pub.locator('.carta-mine-order').first()).toContainText('Entregado');
  await expect(pub.locator('.carta-mine-order').first()).toContainText('2 de 2 entregados');
});
