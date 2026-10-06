/**
 * Arranque común de los tests de navegador de Booking: compila la app con la API de Vite, la sirve con `vite preview`
 * y reenvía /api a una API falsa en memoria (fake-api.ts).
 */
import { expect, type Page } from 'playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeApi, type FakeApi } from './fake-api.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/booking/vite.config.ts');

export const USER = { email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' };
export const RESERVATIONS = 'booking.reservations';
export const FINANCE = 'booking.reservation_finance';
export const EVENTS = 'booking.events';
export const GUESTS = 'booking.guests';
export const RESTRICTIONS = 'booking.dietary_restrictions';
export const CHECKLIST = 'booking.checklist_items';

export interface Harness {
  api: FakeApi;
  server: PreviewServer;
  baseURL: string;
  close(): Promise<void>;
}

/** Compila la app (una vez por archivo de tests basta). */
export async function buildApp(apiUrl: string): Promise<void> {
  process.env.VITE_API_PROXY = apiUrl;
  await build({ configFile, logLevel: 'silent' });
}

/** API falsa nueva + servidor de previsualización que le reenvía /api. Con `compile: false` reutiliza la compilación anterior. */
/**
 * Puerto libre elegido por el sistema. Un puerto al azar puede caer en los rangos que Windows reserva
 * (Hyper-V, WSL): `listen` falla con EACCES y Vite no prueba otro.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

export async function startHarness(options: { compile?: boolean } = {}): Promise<Harness> {
  const api = await startFakeApi({ users: [USER] });
  if (options.compile !== false) await buildApp(api.url);
  const server = await preview({
    configFile,
    logLevel: 'silent',
    preview: { port: await freePort(), strictPort: true, host: '127.0.0.1', proxy: { '/api': { target: api.url, changeOrigin: true } } },
  });
  const baseURL = server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? `http://127.0.0.1:${server.config.preview.port}`;
  return {
    api, server, baseURL,
    close: async () => {
      await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
      await api.close();
    },
  };
}

export async function login(page: Page, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/`);
  await expect(page.getByRole('heading', { name: 'Ikisai Booking' })).toBeVisible();
  await page.getByLabel('Correo electrónico').fill(USER.email);
  await page.getByLabel('Contraseña').fill(USER.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: `Hola, ${USER.displayName}` })).toBeVisible();
}

/** Fecha AAAA-MM-DD a `days` días de hoy (hora local), para que la reserva caiga en «Próximas». */
export function inDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
