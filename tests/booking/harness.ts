/**
 * Arranque común de los tests de navegador de Booking: compila la app con la API de Vite, la sirve con `vite preview`
 * y reenvía /api a una API falsa en memoria (fake-api.ts).
 */
import { expect, type Page } from 'playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
export const SPACES = 'booking.spaces';
export const BEDS = 'booking.beds';
export const ASSIGNMENTS = 'booking.room_assignments';
export const STAFF = 'booking.staff_assignments';
export const NEEDS = 'booking.staff_needs';
export const RATES = 'booking.rates';
export const CONDITIONS = 'booking.conditions';
export const TIERS = 'booking.cancellation_tiers';
export const PROPOSALS = 'booking.proposals';
export const PROPOSAL_LINES = 'booking.proposal_lines';

export interface Harness {
  api: FakeApi;
  server: PreviewServer;
  baseURL: string;
  close(): Promise<void>;
}

const DIST = path.resolve(here, '../../apps/booking/dist');
const BUILD_SOURCES = ['../../apps/booking/public', '../../apps/booking/src', '../../apps/booking/index.html', '../../apps/booking/vite.config.ts',
  '../../packages/ui-kit/src', '../../packages/sync-client/src', '../../packages/domain-booking/src', '../../supabase/functions/_domain'].map((p) => path.resolve(here, p));

function sourceStamp(): string {
  const hash = createHash('sha256');
  const walk = (p: string) => {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.isDirectory()) { for (const name of readdirSync(p).sort()) walk(path.join(p, name)); return; }
    hash.update(`${p}|${st.size}|${st.mtimeMs};`);
  };
  for (const p of BUILD_SOURCES) walk(p);
  return hash.digest('hex');
}

/**
 * Compila la app para las pruebas **una sola vez** aunque haya varios workers (patrón de `tests/tasks/e2e-server.ts`,
 * 8-10-2026). Antes cada spec hacía su `vite build`, que vacía `dist/`: con `--workers=2`, una página podía cargar a medias.
 * Ahora se compila solo si las fuentes cambiaron (huella en `dist/.e2e-stamp`) y con un cerrojo entre procesos; quien llega
 * mientras otro compila, espera. La URL de la API no entra en la compilación (`VITE_API_PROXY` solo sirve al servidor de
 * desarrollo; `vite preview` recibe su proxy en cada arranque), así que todos comparten el mismo `dist`.
 */
export async function buildApp(_apiUrl?: string): Promise<void> {
  const stampFile = path.join(DIST, '.e2e-stamp'), stamp = sourceStamp();
  const fresh = () => existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp;
  const lock = path.join(tmpdir(), `ikisai-booking-e2e-build-${createHash('sha256').update(DIST).digest('hex').slice(0, 12)}`);
  for (const started = Date.now(); ;) {
    if (fresh()) return;
    let mine = false;
    try { mkdirSync(lock); mine = true; } catch {
      // Un cerrojo de un proceso que murió a medias no bloquea para siempre.
      try { if (Date.now() - statSync(lock).mtimeMs > 180_000) rmSync(lock, { recursive: true, force: true }); } catch { /* ya no está */ }
    }
    if (mine) {
      try {
        if (!fresh()) { await build({ configFile, logLevel: 'silent' }); writeFileSync(stampFile, stamp); }
      } finally { rmSync(lock, { recursive: true, force: true }); }
      return;
    }
    if (Date.now() - started > 240_000) throw new Error('Esperando el build de Booking de otro worker más de 4 minutos.');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
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
  if (options.compile !== false) await buildApp();
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
