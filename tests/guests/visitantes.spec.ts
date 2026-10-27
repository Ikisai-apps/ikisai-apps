/**
 * Visitantes por QR (API.md §9.19), contra la API real sobre PGlite con el núcleo de visitantes (C11, 0096), el código
 * público del evento (Booking 0488) y sus peticiones (Booking #770):
 * - `/e/<código>` abre el evento sin sesión; se entra sin dar ningún dato y el acceso sigue al recargar;
 * - «Apuntarme» con los datos voluntarios queda «Pendiente»; «Mis eventos» lo recuerda en este móvil;
 * - un código que no es de nadie no dice si existió; «Salir de este móvil» lo borra todo.
 */
import { expect, test } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../../packages/test-kit/src/net.ts';
import { startGuestsServer, type GuestsTestServer } from './server.ts';
import { buildGuestsApp } from './build.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/guests/vite.config.ts');

let api: GuestsTestServer;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
  api = await startGuestsServer();
  process.env.VITE_API_PROXY = api.url;
  await buildGuestsApp(); // un solo build entre workers (tests/guests/build.ts)
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

/** Día en Madrid desplazado `offset` días (AAAA-MM-DD). */
const day = (offset: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(Date.now() + offset * 86_400_000));

test('§9.19 · por QR, sin datos: el evento, «Apuntarme» pendiente, «Mis eventos» y «Salir de este móvil»', async ({ page }) => {
  const r = await api.reservation({ title: 'Jornadas de otoño', start: day(3), end: day(4) });
  await api.booking.t.db.query('update booking.reservations set guests_visible = true, public_summary = $2 where id = $1', [r.id, 'Dos días de puertas abiertas.']);
  const code = (await api.booking.t.db.query<{ public_code: string }>('select public_code from booking.events where id = $1', [r.event])).rows[0]!.public_code;

  // El código en minúsculas también vale; la ruta deja de llevarlo.
  await page.goto(`${baseURL}/e/${code.toLowerCase()}`);
  await expect(page).toHaveURL(new RegExp(`/#/v/${code}$`));
  await expect(page.locator('#retreatTitle')).toHaveText('Jornadas de otoño');
  await expect(page.locator('#visitorSummary')).toHaveText('Dos días de puertas abiertas.');
  await expect(page.locator('#visitorWelcome')).toContainText('Entras sin dar ningún dato');
  await page.locator('#visitorEnter').click();

  // «Apuntarme»: el nombre es lo único obligatorio.
  await page.locator('#visitorJoin').click();
  await expect(page.locator('#visitorName')).toBeFocused();
  await page.locator('#visitorName').fill('Iker');
  await page.locator('#visitorJoinContact').fill('iker@example.invalid');
  await page.locator('#visitorJoin').click();
  await expect(page.locator('#visitorSent')).toContainText('Apuntarme · Pendiente');
  await expect(page.locator('#visitorJoinForm')).toHaveCount(0);
  // El contacto nunca vuelve en lo que ve el visitante.
  await expect(page.locator('#visitorRequests')).not.toContainText('iker@example.invalid');

  // Al recargar sigue siendo el mismo visitante, con su petición.
  await page.reload();
  await expect(page.locator('#visitorSent')).toContainText('Pendiente');
  await expect(page.locator('#visitorEnter')).toHaveCount(0);

  // «Mis eventos» de este móvil.
  await page.goto(`${baseURL}/#/v`);
  await expect(page.locator('#visitor-before')).toContainText('Jornadas de otoño');

  // Un código que no es de nadie: sin decir si existió.
  await page.goto(`${baseURL}/e/ZZZZZZZZZZ`);
  await expect(page.locator('#visitorUnknown')).toContainText('Este código no es de ningún evento abierto');

  // «Salir de este móvil»: se borra el acceso y la lista.
  await page.goto(`${baseURL}/#/v/${code}`);
  await page.locator('#visitorForget').click();
  await expect(page.locator('#visitorEmpty')).toBeVisible();
  await page.goto(`${baseURL}/#/v/${code}`);
  await expect(page.locator('#visitorEnter')).toBeVisible();
});
