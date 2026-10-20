/**
 * Guests · **pruebas de caracterización** antes de O4 (RECURSOS.md §15.4 y §17: Guests por persona, con calendario y
 * pestañas). Fijan lo que hace hoy cada pantalla que va a cambiar, para que siga en verde después:
 * - la entrada por enlace, hasta Inicio, y los enlaces directos;
 * - el cambio de retiro (una persona en varios retiros);
 * - el alojamiento;
 * - el menú;
 * - el horario (programa) y «Hoy».
 * Todo contra la API real sobre PGlite. Con `GUESTS_CAPTURAS=<carpeta>` guarda además las capturas de la tabla «hoy / después»
 * (coordinacion/guests/o4), con el prefijo de `GUESTS_CAPTURAS_PREFIJO` (por defecto `despues`).
 *
 * O4a (14-10-2026) cambia a propósito, y solo eso: la barra («Calendario · Retiros · Más»), Programa, Menú y Alojamiento
 * como secciones de la pestaña del retiro (mismo número de toques) y el cambio de retiro con pestañas en lugar de la
 * lista «¿Qué quieres ver?». Cada cambio va marcado con «O4a».
 *
 * La tanda 31 (rediseño de La Muela, MUELA-071) cambia a propósito, y solo eso: el cambio de retiro con la portada que se
 * pasa (puntos y flechas del kit) en lugar de las pestañas; el Menú con la próxima comida abierta y las demás plegadas
 * («La carta»); y el Programa con «Ahora y lo siguiente» («Empieza en N días» antes del retiro). Marcado con «Tanda 31».
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { freePort } from '../food/helpers.ts';
import { startGuestsServer, type GuestsTestServer } from './server.ts';
import { buildGuestsApp } from './build.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/guests/vite.config.ts');
const CAPTURAS = process.env.GUESTS_CAPTURAS ?? '';
const PREFIJO = process.env.GUESTS_CAPTURAS_PREFIJO ?? 'despues';

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
  if (CAPTURAS) mkdirSync(CAPTURAS, { recursive: true });
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server?.httpServer.close(() => resolve()));
  await api?.close();
});

/** Día en Madrid desplazado `offset` días (AAAA-MM-DD). */
const day = (offset: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(Date.now() + offset * 86_400_000));

async function capture(page: Page, name: string): Promise<void> {
  if (CAPTURAS) await page.screenshot({ path: path.join(CAPTURAS, `${PREFIJO}-${name}.png`), fullPage: true });
}

const navMain = (page: Page) => page.locator('nav.nav > a.navbtn:not(.navextra)');
const sections = (page: Page) => page.locator('#sections a');

test('caracterización · entrada: aviso, Inicio del retiro en #/p/<id>, recarga sin repetir el aviso y enlaces directos', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro de otoño', start: day(20), end: day(22) });
  const ana = await api.guest(event, { first_name: 'Ana' });
  await api.experience(reservation, { program_visible: true, menu_visible: true, lodging_visible: true });
  await page.goto(`${baseURL}/i/${await api.guestLink(reservation, ana, 'Ana')}`);
  await expect(page.locator('#privacy')).toBeVisible();
  await capture(page, 'entrada-aviso');
  await page.locator('#privacyOk').click();
  // Con una sola entrada de ámbito se abre directamente su Inicio.
  await expect(page).toHaveURL(new RegExp(`#/p/${ana}$`));
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro de otoño');
  // O4a: antes la barra era «Inicio · Programa · Menú · Alojamiento»; ahora son las secciones del retiro, en el mismo orden.
  await expect(sections(page)).toHaveText(['Resumen', 'Programa', 'Menú', 'Alojamiento']);
  await expect(navMain(page)).toHaveText(['Calendario', 'Retiros']);
  await capture(page, 'inicio-antes');
  // Al recargar sigue en Inicio y el aviso ya no vuelve a salir.
  await expect.poll(async () => (await api.row(ana)).privacy_ack_version).not.toBeNull();
  await page.reload();
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro de otoño');
  await expect(page.locator('#privacy')).toHaveCount(0);
  // Los enlaces directos de cada sección funcionan (marcadores y enlaces compartidos): no se pueden romper con O4.
  for (const [section, check] of [['programa', '#programEmpty'], ['menu', '#menuEmpty'], ['alojamiento', '#lodgingNone'], ['info', '#infoSections, #infoSoon'], ['datos', '#dataForm'], ['alimentacion', '#dietList']] as const) {
    await page.goto(`${baseURL}/#/p/${ana}/${section}`);
    await expect(page.locator(check).first()).toBeVisible();
  }
});

test('caracterización · cambio de retiro: la misma persona en dos retiros cambia con las pestañas y #/ vuelve al de entrada', async ({ page }) => {
  const pasado = await api.reservation({ title: 'Retiro de primavera', start: day(-30), end: day(-28) });
  const futuro = await api.reservation({ title: 'Retiro de invierno', start: day(40), end: day(42) });
  const g1 = await api.guest(pasado.event, { first_name: 'Marta' });
  const g2 = await api.guest(futuro.event, { first_name: 'Marta' });
  // Mismo correo: la misma cuenta acumula las dos entradas de ámbito (#278).
  await api.guestLink(pasado.id, g1, 'Marta', 'marta@example.invalid');
  await page.goto(`${baseURL}/i/${await api.guestLink(futuro.id, g2, 'Marta', 'marta@example.invalid')}`);
  // O4a: sin retiro en curso, se entra en el próximo (antes, la lista «¿Qué quieres ver?»; ahora, sin toques).
  // El aviso legal se acepta por cada retiro (cada retiro es una ficha de Booking).
  await page.locator('#privacyOk').click();
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro de invierno');
  // Tanda 31: los dos retiros, por fecha, en la portada que se pasa (antes, pestañas; un toque igual que antes).
  const dots = page.locator('#retreatTabs .cover-dot');
  await expect(dots).toHaveCount(2);
  await expect(dots.first()).toHaveAttribute('aria-label', /Retiro de primavera, Ya pasó/);
  await expect(dots.nth(1)).toHaveAttribute('aria-label', /Retiro de invierno/);
  await expect(page.locator('#retreatTabs .cover-dot[aria-current="true"]')).toHaveAttribute('aria-label', /Retiro de invierno/);
  await capture(page, 'cambio-de-retiro');
  // #/ vuelve al retiro de entrada.
  await page.goto(`${baseURL}/#/`);
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro de invierno');
  // Un toque en su punto cambia de retiro (antes: #/ y elegir la tarjeta; con O4a, la pestaña).
  await page.locator('#retreatTabs .cover-dot[aria-label^="Retiro de primavera"]').click();
  await page.locator('#privacyOk').click();
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro de primavera');
  // Un retiro pasado enseña «Gracias por venir».
  await expect(page.locator('#after')).toBeVisible();
  await capture(page, 'inicio-despues');
});

test('caracterización · alojamiento: «Tu habitación» con zona y cama, en la 4.ª sección del retiro', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro con cuarto', start: day(20), end: day(22) });
  const leo = await api.guest(event, { first_name: 'Leo' });
  await api.experience(reservation, { program_visible: true, menu_visible: true, lodging_visible: true });
  const room = await api.room(event, { name: 'Habitación 5', enSuite: false, beds: ['Cama 1', 'Cama 2'], zone: 'Casa principal' });
  await api.assign(event, room.spaceId, room.bedIds[0]!, leo);
  await page.goto(`${baseURL}/i/${await api.guestLink(reservation, leo, 'Leo')}`);
  await page.locator('#privacyOk').click();
  // O4a: antes, 4.ª posición de la barra; ahora, 4.ª sección de la pestaña del retiro (un toque, igual que antes).
  await expect(sections(page).nth(3)).toHaveText('Alojamiento');
  await sections(page).nth(3).click();
  await expect(page).toHaveURL(new RegExp(`#/p/${leo}/alojamiento$`));
  await expect(page.locator('#lodgingMine')).toContainText('Habitación 5');
  await expect(page.locator('#lodgingMine')).toContainText('Casa principal');
  await expect(page.locator('#lodgingMine')).toContainText('Cama 1');
  await capture(page, 'alojamiento');
});

test('caracterización · menú: un día por pestaña (el primero si el retiro no ha empezado), servicios por hora y platos en su orden', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro con menú', start: day(20), end: day(21) });
  const eva = await api.guest(event, { first_name: 'Eva' });
  await api.experience(reservation, { menu_visible: true });
  await api.menu(event, [
    { date: day(20), type: 'cena', time: '21:00', dishes: [{ name: 'Sopa de verduras' }, { name: 'Flan' }] },
    { date: day(20), type: 'comida', time: '14:00', dishes: [{ name: 'Lentejas' }] },
    { date: day(21), type: 'desayuno', time: '08:30', dishes: [{ name: 'Tostadas' }] },
  ]);
  await page.goto(`${baseURL}/i/${await api.guestLink(reservation, eva, 'Eva')}`);
  await page.locator('#privacyOk').click();
  await page.locator('#sections a[data-section="menu"]').click(); // O4a: sección del retiro (antes, la barra)
  await expect(page.locator('#menuDays [role="tab"]')).toHaveCount(2);
  await expect(page.locator('#menuDays [role="tab"]').first()).toHaveAttribute('aria-selected', 'true');
  // Tanda 31 («La carta»): la primera comida del día abierta y las siguientes plegadas, por hora; al tocarla, sus platos en su orden.
  await expect(page.locator('#menuNext h3')).toHaveText(/^Comida/);
  await expect(page.locator('#menuNext .gdish strong')).toHaveText(['Lentejas']);
  await expect(page.locator('#menuList .gmeal-fold summary strong')).toHaveText([/^Cena/]);
  await page.locator('#menuList .gmeal-fold summary').click();
  await expect(page.locator('#menuList .gmeal-fold .gdish strong')).toHaveText(['Sopa de verduras', 'Flan']);
  await capture(page, 'menu');
  await page.locator('#menuDays [role="tab"]').nth(1).click();
  await expect(page.locator('#menuList')).toContainText('Tostadas');
});

test('caracterización · horario: días en pestañas, actividades por hora, «Durante el día» sin hora y sin «Hoy» antes del retiro', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro con horario', start: day(20), end: day(21) });
  const zoe = await api.guest(event, { first_name: 'Zoe' });
  await api.experience(reservation, { program_visible: true });
  const item = (d: string, starts_at: string | null, ends_at: string | null, title: string) =>
    api.organizerInvoke(reservation, 'booking.portal_program_save', { item: { id: crypto.randomUUID(), day: d, starts_at, ends_at, title, place_text: 'Sala', kind: 'actividad' } });
  await item(day(20), '18:00', '19:30', 'Bienvenida');
  await item(day(20), '10:00', '11:00', 'Llegadas');
  await item(day(21), null, null, 'Paseo libre');
  await page.goto(`${baseURL}/i/${await api.guestLink(reservation, zoe, 'Zoe')}`);
  await page.locator('#privacyOk').click();
  await expect(page.locator('#today')).toHaveCount(0); // «Hoy en Ikisai» solo durante el retiro
  await page.locator('#sections a[data-section="programa"]').click(); // O4a: sección del retiro (antes, la barra)
  await expect(page.locator('#programDays [role="tab"]').first()).toHaveAttribute('aria-selected', 'true');
  // Tanda 31 («Ahora y lo siguiente»): antes del retiro, «Empieza en N días» con la primera actividad; el resto, por hora.
  await expect(page.locator('#programList .now-hero')).toContainText('Empieza en 20 días');
  await expect(page.locator('#programList .now-hero')).toContainText('Llegadas');
  await expect(page.locator('#programList .now-slot')).toHaveText([/Bienvenida/]);
  await capture(page, 'horario');
  await page.locator('#programDays [role="tab"]').nth(1).click();
  await expect(page.locator('#programList')).toContainText('Durante el día');
  await expect(page.locator('#programList')).toContainText('Paseo libre');
});
