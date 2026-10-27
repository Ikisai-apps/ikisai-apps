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

test('§9.19 · nunca en blanco: un evento que ya no abre y un acceso de visitante caducado lo dicen', async ({ page }) => {
  const r = await api.reservation({ title: 'Jornada de puertas abiertas', start: day(5), end: day(5) });
  await api.booking.t.db.query('update booking.reservations set guests_visible = true where id = $1', [r.id]);
  const code = (await api.booking.t.db.query<{ public_code: string }>('select public_code from booking.events where id = $1', [r.event])).rows[0]!.public_code;

  // Este móvil recuerda un evento que ya no existe (o cuyo código cambió) y su acceso guardado ya no vale.
  await page.goto(`${baseURL}/#/v`);
  await page.evaluate((c) => {
    localStorage.setItem('ikisai-visitor-events', JSON.stringify([c, 'ZZZZZZZZZZ']));
    localStorage.setItem('ikisai-visitor', 'acceso-que-ya-no-vale');
  }, code);
  await page.reload();
  await expect(page.locator('#visitor-before')).toContainText('Jornada de puertas abiertas');
  await expect(page.locator('#visitorListGone')).toContainText('1 evento ya no se puede abrir');

  // Al abrir el evento, el acceso se renueva solo y se dice por qué no se ve lo de antes; una vez.
  await page.goto(`${baseURL}/#/v/${code}`);
  await expect(page.locator('#visitorRenewed')).toContainText('Tu acceso de visitante anterior ya no valía');
  expect(await page.evaluate(() => localStorage.getItem('ikisai-visitor'))).not.toBe('acceso-que-ya-no-vale');
  await page.reload();
  await expect(page.locator('#visitorLeaveBox')).toBeVisible();
  await expect(page.locator('#visitorRenewed')).toHaveCount(0);
});

test('ENTRADA_PUBLICA · sin invitación ni QR: ven.ikisai.com enseña los eventos abiertos y se entra como visitante', async ({ page }) => {
  const r = await api.reservation({ title: 'Jornada abierta de la finca', start: day(6), end: day(6) });
  await api.booking.t.db.query(`update booking.reservations set guests_visible = true, event_type = 'jornadas_abiertas' where id = $1`, [r.id]);
  const code = (await api.booking.t.db.query<{ public_code: string }>('select public_code from booking.events where id = $1', [r.event])).rows[0]!.public_code;

  await page.goto(`${baseURL}/`);
  const open = page.locator('#openEvents');
  const card = open.locator(`a[data-code="${code}"]`);
  await expect(card).toContainText('Jornada abierta de la finca');
  await expect(card).toContainText('Jornadas abiertas');
  // Mirar no crea identidad: solo al «Entrar».
  expect(await page.evaluate(() => localStorage.getItem('ikisai-visitor'))).toBeNull();
  await card.click();
  await expect(page.locator('#retreatTitle')).toHaveText('Jornada abierta de la finca');
  await page.locator('#visitorEnter').click();
  await expect(page.locator('#visitorLeaveBox')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('ikisai-visitor'))).not.toBeNull();
});

test('ENTRADA_PUBLICA · «Reservar antes de venir»: precios y plazas para todas las noches y la solicitud con la plaza guardada', async ({ page }) => {
  const d = await api.openDays(day(10), day(14), { lodging_pay_mode: 'hold', lodging_hold_hours: 24 });
  // «Reservar antes de venir» va dentro de «Alójate aquí» (abierta por el QR), plegada.
  await page.goto(`${baseURL}/e/${d.code}?alojate`);
  await page.locator('#lodgeLater > summary').click();
  const stay = page.locator('#pubStay');
  await expect(stay).toBeVisible();
  // Mirar no pide nada ni crea identidad.
  await stay.locator('#pubStayFrom').fill(day(11));
  await stay.locator('#pubStayTo').fill(day(13));
  await stay.locator('#pubStayPersons').fill('3');
  await stay.locator('#pubStayLook').click();
  await expect(stay.locator('#pubStayAvailable')).toContainText('Quedan 2 plazas todas esas noches (2 noches)');
  await expect(stay.locator('#pubStayModes button')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('ikisai-visitor'))).toBeNull();

  await stay.locator('#pubStayPersons').fill('1');
  await stay.locator('#pubStayLook').click();
  const mode = stay.locator(`#pubStayModes [data-mode="${d.rate}"]`);
  await expect(mode).toContainText(/20,00.*la noche.*40,00.*en total/);
  await mode.getByRole('button', { name: 'Elegir' }).click();
  await expect(stay.locator('#pubStayPay')).toContainText('Te guardamos la plaza 24 horas y se paga en recepción.');
  // El nombre es lo único obligatorio.
  await stay.locator('#pubStaySend').click();
  await expect(stay.locator('#pubStayName')).toBeFocused();
  await stay.locator('#pubStayName').fill('Noa');
  await stay.locator('#pubStaySend').click();
  await expect(page.locator('#visitorSent')).toContainText('Noches · Pendiente');
  await expect(page.locator('#visitorSent')).toContainText('plaza guardada hasta');
  await expect(page.locator('#visitorSent')).toContainText(/40,00/);
});

test('«Alójate aquí» (como la barra): por QR se abre la pestaña; cama y datos en borrador, «Ir a pagar» y su número', async ({ page, browser }) => {
  const d = await api.openDays(day(0), day(3), { lodging_pay_mode: 'hold', lodging_hold_hours: 2 });
  // Sin QR (desde la raíz pública), no hay pestaña de alojamiento.
  const other = await browser.newPage();
  await other.goto(`${baseURL}/#/v/${d.code}`);
  await expect(other.locator('#retreatTitle')).toBeVisible();
  await expect(other.locator('#visitorTabs')).toHaveCount(0);
  await other.close();

  await page.goto(`${baseURL}/e/${d.code}?alojate`);
  await expect(page).toHaveURL(new RegExp(`/#/v/${d.code}/alojate$`));
  await expect(page.locator('#visitorTabs a[data-tab="alojate"]')).toHaveClass(/on/);
  const beds = page.locator('#lodgeBeds');
  await expect(beds.getByLabel('Asignadme una')).toBeChecked();
  await expect(page.locator('#lodgePrice')).toContainText(/20,00.*la noche/);
  await beds.getByLabel('Cama 1').check();
  // Solo el nombre es obligatorio; el documento, no.
  await page.locator('#lodgeGo').click();
  await expect(page.locator('#lodge_first_name')).toBeFocused();
  await page.locator('#lodge_first_name').fill('Noa');
  await page.locator('#lodgeGo').click();
  await expect(page.locator('#lodgeNumber')).toHaveText(/\S+/);
  await expect(page.locator('#lodgePay')).toContainText('Ve a recepción y di tu número para pagar.');
  await expect(page.locator('#lodgePay')).toContainText('Cama 1');
  await expect(page.locator('#lodgeMissing')).toContainText('Número de documento');
  // Al volver, la misma estancia (no se pide otra vez).
  await page.reload();
  await expect(page.locator('#lodgeNumber')).toHaveText(/\S+/);
  await expect(page.locator('#lodgeForm')).toHaveCount(0);
});
