/**
 * Humo de Ikisai Booking (esqueleto): login → bootstrap → espejo local → crear y editar reservas sin red → sincronizar.
 *
 * Cómo correrlo:   npx playwright test tests/booking            (desde la raíz del repo)
 * Compila la app con la API de Vite, la sirve con `vite preview` y reenvía /api a una API falsa en memoria (fake-api.ts).
 */
import { expect, test, type Page } from 'playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeApi, type FakeApi } from './fake-api.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/booking/vite.config.ts');
const USER = { email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' };
const RESERVATIONS = 'booking.reservations';
const FINANCE = 'booking.reservation_finance';

let api: FakeApi;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
  api = await startFakeApi({ users: [USER] });
  process.env.VITE_API_PROXY = api.url;
  await build({ configFile, logLevel: 'silent' });
  server = await preview({
    configFile,
    logLevel: 'silent',
    preview: { port: 4800 + Math.floor(Math.random() * 500), strictPort: false, host: '127.0.0.1', proxy: { '/api': { target: api.url, changeOrigin: true } } },
  });
  baseURL = server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? `http://127.0.0.1:${server.config.preview.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server?.httpServer.close(() => resolve()));
  await api?.close();
});

async function login(page: Page): Promise<void> {
  await page.goto(`${baseURL}/`);
  await expect(page.getByRole('heading', { name: 'Ikisai Booking' })).toBeVisible();
  await page.getByLabel('Correo electrónico').fill(USER.email);
  await page.getByLabel('Contraseña').fill(USER.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: `Hola, ${USER.displayName}` })).toBeVisible();
}

/** Fecha AAAA-MM-DD a `days` días de hoy (hora local), para que la reserva caiga en «Próximas». */
function inDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('login → Inicio → reservas sin red → sincronizar', async ({ page, context }) => {
  test.setTimeout(120_000);

  await test.step('login contra la API, bootstrap y las cuatro entradas de navegación', async () => {
    await login(page);
    await expect(page.locator('#syncStatus')).toContainText('En línea');
    expect(api.requests.some((r) => r.path.startsWith('/api/v1/bootstrap'))).toBeTruthy();
    expect(api.requests.some((r) => r.path.startsWith('/api/v1/snapshot'))).toBeTruthy();
    for (const label of ['Inicio', 'Reservas', 'Calendario', 'Huéspedes']) await expect(page.locator('.nav').getByText(label, { exact: true })).toBeVisible();
    await expect(page.getByText('No hay pre-reservas ni reservas confirmadas próximas.')).toBeVisible();
  });

  await test.step('lista vacía de reservas', async () => {
    await page.locator('.nav').getByText('Reservas', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Reservas', level: 2 })).toBeVisible();
    await expect(page.getByText('Todavía no hay reservas')).toBeVisible();
  });

  await test.step('la app explica qué falta para pre-reservar', async () => {
    await page.getByRole('button', { name: 'Nueva reserva' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nueva reserva' });
    await expect(dialog).toBeVisible();
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.locator('#reservationError')).toContainText('«title»');
    await dialog.getByLabel('Nombre del grupo o evento').fill('Retiro Test');
    await dialog.getByLabel('Estado').selectOption('pre_reservada');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.locator('#reservationError')).toContainText('falta la fecha de entrada');
    expect(api.rows(RESERVATIONS)).toHaveLength(0);
  });

  await test.step('crear la pre-reserva y verla confirmada por el servidor, con su fila de importes', async () => {
    const dialog = page.getByRole('dialog', { name: 'Nueva reserva' });
    await dialog.getByLabel('Entrada').fill(inDays(10));
    await dialog.getByLabel('Salida').fill(inDays(12));
    await dialog.getByLabel('Personas previstas').fill('20');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(dialog).toBeHidden();

    const row = page.locator('#reservationList .row', { hasText: 'Retiro Test' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('20 personas');
    await expect(row).toContainText('2 noches');
    await expect(row).toContainText('Pre-reserva');
    await expect(row).toHaveAttribute('data-pending', 'false');
    await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');

    const rows = api.rows(RESERVATIONS);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Retiro Test', status: 'pre_reservada', expected_guests: 20, start_date: inDays(10), revision: 1 });
    expect(api.rows(FINANCE).map((r) => r.id)).toEqual([rows[0]!.id]);
  });

  await test.step('recargar y seguir viéndola desde el espejo local; Inicio la lista como próxima', async () => {
    await page.reload();
    await expect(page.locator('#reservationList .row', { hasText: 'Retiro Test' })).toBeVisible();
    await page.locator('.nav').getByText('Inicio', { exact: true }).click();
    await expect(page.locator('#upcomingList .row', { hasText: 'Retiro Test' })).toBeVisible();
    await expect(page.locator('#notices')).toContainText('pre-reserva pendiente de confirmar');
    await page.locator('.nav').getByText('Reservas', { exact: true }).click();
  });

  await test.step('sin red: editar y ver «pendiente»', async () => {
    await context.setOffline(true);
    await expect(page.locator('#syncStatus')).toContainText('Sin conexión');

    await page.getByRole('button', { name: 'Editar Retiro Test' }).click();
    const dialog = page.getByRole('dialog', { name: 'Editar reserva' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Revisión 1');
    // «Guardar» solo aparece cuando hay cambios.
    await expect(page.locator('#saveReservation')).toBeHidden();
    await dialog.getByLabel('Personas previstas').fill('22');
    await expect(page.locator('#saveReservation')).toBeVisible();
    await page.locator('#saveReservation').click();
    await expect(dialog).toBeHidden();

    const row = page.locator('#reservationList .row', { hasText: 'Retiro Test' });
    await expect(row).toContainText('22 personas');
    await expect(row).toHaveAttribute('data-pending', 'true');
    await expect(row).toContainText('Pendiente de sincronizar');
    await expect(page.locator('#syncStatus')).toContainText('1 cambio pendiente');
    expect(api.rows(RESERVATIONS)[0]!.expected_guests).toBe(20);
  });

  await test.step('volver a la red y ver sincronizado: solo viajó el campo cambiado', async () => {
    await context.setOffline(false);
    await page.waitForFunction(() => navigator.onLine);
    await page.getByRole('button', { name: 'Sincronizar ahora' }).click();

    const row = page.locator('#reservationList .row', { hasText: 'Retiro Test' });
    await expect(row).toHaveAttribute('data-pending', 'false', { timeout: 15_000 });
    await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');
    expect(api.rows(RESERVATIONS)[0]).toMatchObject({ expected_guests: 22, revision: 2, status: 'pre_reservada' });
  });

  await test.step('filtros y búsqueda', async () => {
    await page.locator('.filters').getByRole('button', { name: 'Canceladas' }).click();
    await expect(page.getByText('Ninguna reserva coincide')).toBeVisible();
    await page.locator('.filters').getByRole('button', { name: 'Pre-reservas' }).click();
    await expect(page.locator('#reservationList .row')).toHaveCount(1);
    await page.getByLabel('Buscar reservas').fill('yoga');
    await expect(page.getByText('Ninguna reserva coincide')).toBeVisible();
    await page.getByLabel('Buscar reservas').fill('retiro');
    await expect(page.locator('#reservationList .row')).toHaveCount(1);
  });
});

test('PWA: manifest, service worker y shell en caché', async ({ page }) => {
  await login(page);
  const manifest = await page.request.get(`${baseURL}/manifest.webmanifest`);
  expect(manifest.ok()).toBeTruthy();
  expect(await manifest.json()).toMatchObject({ name: 'Ikisai Booking', short_name: 'Booking', display: 'standalone' });
  const sw = await page.request.get(`${baseURL}/sw.js`);
  expect(sw.ok()).toBeTruthy();
  expect(await sw.text()).toContain('ikisai-booking-shell-');
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return Boolean(registration?.active);
  }, null, { timeout: 15_000 });
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const cache = await caches.open(keys.find((k) => k.startsWith('ikisai-booking-shell-')) ?? '');
    return (await cache.keys()).map((r) => new URL(r.url).pathname);
  });
  expect(cached).toEqual(expect.arrayContaining(['/', '/manifest.webmanifest', '/fonts/inter.woff2']));
  expect(cached.some((p) => p.startsWith('/api/'))).toBeFalsy();
});
