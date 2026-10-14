/**
 * Guests por persona, O4a (RECURSOS.md §17; decisión del usuario del 13-10-2026), contra la API real sobre PGlite:
 * - **regla de entrada**: el retiro en curso; si no, el próximo; si no, el calendario;
 * - **calendario** con los retiros de la persona: tocar uno abre su pestaña, y «Retiros» vuelve al último visto;
 * - **pestañas de retiros** que conservan la sección (Programa en uno → Programa en otro);
 * - **la familia junta** («Todos»): retiros de todos con el nombre de a quién toca, la cama de cada uno y el selector.
 * Con `GUESTS_CAPTURAS=<carpeta>` guarda las capturas de lo nuevo (como `caracterizacion.spec.ts`).
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { freePort } from '../../packages/test-kit/src/net.ts';
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
const navMain = (page: Page) => page.locator('nav.nav > a.navbtn:not(.navextra)');
const bar = (page: Page, label: string) => navMain(page).filter({ hasText: label });

async function capture(page: Page, name: string): Promise<void> {
  if (CAPTURAS) await page.screenshot({ path: path.join(CAPTURAS, `${PREFIJO}-${name}.png`), fullPage: true });
}

test('O4a · entrada en el retiro en curso; el calendario abre cualquier retiro y «Retiros» vuelve al último visto', async ({ page }) => {
  const curso = await api.reservation({ title: 'Retiro en curso', start: day(-1), end: day(1) });
  const proximo = await api.reservation({ title: 'Retiro próximo', start: day(30), end: day(32) });
  const a = await api.guest(curso.event, { first_name: 'Lola', last_name_1: 'Sanz' });
  const b = await api.guest(proximo.event, { first_name: 'Lola', last_name_1: 'Sanz' });
  await api.guestLink(curso.id, a, 'Lola', 'lola@example.invalid');
  // El enlace es del próximo, pero hoy no se sabe de qué entrada es un enlace (petición a Core): manda el que está en curso.
  await page.goto(`${baseURL}/i/${await api.guestLink(proximo.id, b, 'Lola', 'lola@example.invalid')}`);
  await page.locator('#privacyOk').click();
  await expect(page).toHaveURL(new RegExp(`#/p/${a}$`));
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro en curso');
  await expect(page.locator('#today')).toBeVisible();
  await expect(navMain(page)).toHaveText(['Calendario', 'Retiros']);
  await expect(bar(page, 'Retiros')).toHaveAttribute('aria-current', 'page');
  // Una sola persona: sin selector.
  await expect(page.locator('#persons')).toHaveCount(0);

  await bar(page, 'Calendario').click();
  await expect(page).toHaveURL(/#\/calendario$/);
  await expect(bar(page, 'Calendario')).toHaveAttribute('aria-current', 'page');
  // La barra del retiro en curso, en el mes de hoy; y la lista con todos y su momento.
  await expect(page.locator(`#calendar .cal-event[data-event-id="${curso.id}"]`).first()).toBeVisible();
  await expect(page.locator('#calendarList a')).toHaveCount(2);
  await expect(page.locator('#calendarList a').first()).toContainText('En curso');
  await expect(page.locator('#calendarList a').nth(1)).toContainText('Próximo');
  await capture(page, 'calendario');
  await page.locator('#calendarList a', { hasText: 'Retiro próximo' }).click();
  await page.locator('#privacyOk').click();
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro próximo');

  // Desde el calendario, «Retiros» vuelve al último visto; tocar la barra del calendario abre su pestaña.
  await bar(page, 'Calendario').click();
  await bar(page, 'Retiros').click();
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro próximo');
  await bar(page, 'Calendario').click();
  await page.locator(`#calendar .cal-event[data-event-id="${curso.id}"]`).first().click();
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro en curso');
});

test('O4a · solo retiros pasados: se entra en el calendario y «Retiros» abre el último', async ({ page }) => {
  const viejo = await api.reservation({ title: 'Retiro de hace un año', start: day(-400), end: day(-398) });
  // Terminó ayer: su enlace sigue valiendo unos días (los de retiros más viejos ya han caducado).
  const reciente = await api.reservation({ title: 'Retiro de esta semana', start: day(-3), end: day(-1) });
  const a = await api.guest(viejo.event, { first_name: 'Pau' });
  const b = await api.guest(reciente.event, { first_name: 'Pau' });
  await api.guestLink(viejo.id, a, 'Pau', 'pau@example.invalid');
  await page.goto(`${baseURL}/i/${await api.guestLink(reciente.id, b, 'Pau', 'pau@example.invalid')}`);
  await expect(page).toHaveURL(/#\/calendario$/);
  await expect(page.locator('#calendarList a')).toHaveCount(2);
  await bar(page, 'Retiros').click();
  await page.locator('#privacyOk').click();
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro de esta semana');
  await expect(page.locator('#after')).toBeVisible();
});

test('O4a · las pestañas de retiros conservan la sección: Programa en uno → Programa en el otro', async ({ page }) => {
  const uno = await api.reservation({ title: 'Retiro uno', start: day(10), end: day(11) });
  const dos = await api.reservation({ title: 'Retiro dos', start: day(20), end: day(21) });
  const a = await api.guest(uno.event, { first_name: 'Rita' });
  const b = await api.guest(dos.event, { first_name: 'Rita' });
  for (const r of [uno, dos]) await api.experience(r.id, { program_visible: true });
  await api.organizerInvoke(uno.id, 'booking.portal_program_save', { item: { id: crypto.randomUUID(), day: day(10), starts_at: '10:00', ends_at: null, title: 'Yoga de uno', place_text: null, kind: 'actividad' } });
  await api.organizerInvoke(dos.id, 'booking.portal_program_save', { item: { id: crypto.randomUUID(), day: day(20), starts_at: '10:00', ends_at: null, title: 'Yoga de dos', place_text: null, kind: 'actividad' } });
  await api.guestLink(dos.id, b, 'Rita', 'rita@example.invalid');
  await page.goto(`${baseURL}/i/${await api.guestLink(uno.id, a, 'Rita', 'rita@example.invalid')}`);
  await page.locator('#privacyOk').click();
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro uno');
  await page.locator('#sections a[data-section="programa"]').click();
  await expect(page.locator('#programList')).toContainText('Yoga de uno');
  await page.locator('#retreatTabs a', { hasText: 'Retiro dos' }).click();
  await expect(page).toHaveURL(new RegExp(`#/p/${b}/programa$`));
  await expect(page.locator('#programList')).toContainText('Yoga de dos');
  await expect(page.locator('#sections a[aria-current="page"]')).toHaveText('Programa');
});

test('O4a · la familia junta: retiros de todos con a quién toca, la cama de cada uno y el selector de persona', async ({ page }) => {
  const juntos = await api.reservation({ title: 'Retiro en familia', start: day(15), end: day(17) });
  const sola = await api.reservation({ title: 'Retiro de Marta', start: day(45), end: day(47) });
  const marta = await api.guest(juntos.event, { first_name: 'Marta', last_name_1: 'Ruiz' });
  const nico = await api.guest(juntos.event, { first_name: 'Nico', last_name_1: 'Ruiz' });
  const marta2 = await api.guest(sola.event, { first_name: 'Marta', last_name_1: 'Ruiz' });
  await api.experience(juntos.id, { program_visible: true, lodging_visible: true });
  const room = await api.room(juntos.event, { name: 'Habitación 2', enSuite: true, beds: ['Cama 1', 'Cama 2'] });
  await api.assign(juntos.event, room.spaceId, room.bedIds[0]!, marta);
  await api.assign(juntos.event, room.spaceId, room.bedIds[1]!, nico);
  await api.guestLink(sola.id, marta2, 'Marta', 'ruiz@example.invalid');
  await api.guestLink(juntos.id, nico, 'Nico', 'ruiz@example.invalid');
  await page.goto(`${baseURL}/i/${await api.guestLink(juntos.id, marta, 'Marta', 'ruiz@example.invalid')}`);
  // Próximo retiro, con la familia junta: un aviso legal para las dos fichas de ese retiro.
  await page.locator('#privacyOk').click();
  await expect(page).toHaveURL(new RegExp(`#/r/${juntos.id}$`));
  await expect(page.locator('#persons button')).toHaveText(['Todos', 'Marta', 'Nico']);
  await expect(page.locator('#retreatTabs a')).toHaveCount(2);
  // El retiro que no es de todos lleva el nombre de a quién toca.
  await expect(page.locator('#retreatTabs a', { hasText: 'Retiro de Marta' })).toContainText('Marta');
  await expect(page.locator('#todoFamily .gperson')).toHaveText([/^Marta/, /^Nico/]);
  await capture(page, 'familia-resumen');

  // Alojamiento con «Todos»: la cama de cada uno, y un toque lleva a la de esa persona.
  await page.locator('#sections a[data-section="alojamiento"]').click();
  await expect(page.locator(`#lodgingFamily [data-guest="${marta}"]`)).toContainText('Cama 1');
  await expect(page.locator(`#lodgingFamily [data-guest="${nico}"]`)).toContainText('Cama 2');
  await capture(page, 'familia-alojamiento');
  await page.locator(`#lodgingFamily [data-guest="${nico}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#/p/${nico}/alojamiento$`));
  await expect(page.locator('#lodgingMine')).toContainText('Cama 2');

  // Solo Nico: solo su retiro (sin pestañas) y su Resumen, como antes.
  await page.locator('#sections a[data-section="inicio"]').click();
  await expect(page.locator('#persons button[aria-pressed="true"]')).toHaveText('Nico');
  await expect(page.locator('#retreatTabs')).toHaveCount(0);
  await expect(page.locator('#hello')).toHaveText('Hola, Nico');

  // El calendario con «Todos» enseña los dos retiros; el de Marta, con su nombre.
  await page.locator('#persons button', { hasText: 'Todos' }).click();
  await expect(page).toHaveURL(new RegExp(`#/r/${juntos.id}$`));
  await bar(page, 'Calendario').click();
  await expect(page.locator('#calendarList a')).toHaveCount(2);
  await expect(page.locator('#calendarList a', { hasText: 'Retiro de Marta' })).toContainText('Marta');
  await capture(page, 'familia-calendario');
  await page.locator('#persons button', { hasText: 'Nico' }).click();
  await expect(page.locator('#calendarList a')).toHaveCount(1);
});
