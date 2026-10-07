/**
 * Ikisai Tasks · aceptación V1, incidencia 1: si el arranque falla, la app dice el motivo real y, cuando se puede,
 * ofrece «Reintentar» (antes mostraba «No se puede guardar en este navegador» para cualquier error, también al reabrir
 * la PWA minimizada, y no había forma de salir sin cerrar la app).
 */
import { expect, test } from 'playwright/test';
import { build } from 'vite';
import { VITE_CONFIG, startE2EServer, type E2EServer } from './e2e-server.ts';

let server: E2EServer;
test.beforeAll(async () => {
  test.setTimeout(180_000);
  await build({ configFile: VITE_CONFIG, logLevel: 'silent' });
  server = await startE2EServer();
});
test.afterAll(async () => { await server?.close(); });

test('arranque: un fallo recuperable muestra el motivo y «Reintentar» arranca la app @smoke', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  // La primera apertura de la base local falla como cuando la PWA vuelve de estar congelada.
  await page.addInitScript(() => {
    const open = indexedDB.open.bind(indexedDB);
    let failed = false;
    (indexedDB as any).open = (name: string, version?: number) => {
      if (!failed && name === 'ikisai-tasks-ui-v1') { failed = true; throw new DOMException('La conexión se cerró.', 'InvalidStateError'); }
      return open(name, version);
    };
  });
  await page.goto(server.url + '/');
  await expect(page.locator('#bootFailure h1')).toHaveText('Tasks está abierta en otra ventana');
  await expect(page.locator('#bootFailure')).not.toContainText('No se puede guardar');
  await page.locator('#bootRetry').click();
  await expect(page.locator('#accountLoginForm')).toBeVisible();
  await context.close();
});

test('arranque: sin almacenamiento, el aviso de siempre y sin reintento', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true }); });
  await page.goto(server.url + '/');
  await expect(page.locator('#bootFailure h1')).toHaveText('No se puede guardar en este navegador');
  await expect(page.locator('#bootRetry')).toHaveCount(0);
  await context.close();
});
