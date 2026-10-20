/**
 * Guests por persona, O4a (RECURSOS.md §17; decisión del usuario del 13-10-2026), contra la API real sobre PGlite:
 * - **regla de entrada**: el retiro del enlace (C10); si no, el que está en curso; si no, el próximo; si no, el calendario;
 * - **calendario** con los retiros de la persona: tocar uno abre su pestaña, y «Retiros» vuelve al último visto;
 * - **pestañas de retiros** que conservan la sección (Programa en uno → Programa en otro);
 * - **la familia junta** («Todos»): retiros de todos con el nombre de a quién toca, la cama de cada uno y el selector;
 * - **el menú de la familia** (G13, seguridad alimentaria) cruza cada plato con **cada persona**, con su nombre.
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

test('O4a · entrada por el retiro del enlace y, sin enlace, en el que está en curso; el calendario abre cualquier retiro y «Retiros» vuelve al último visto', async ({ page }) => {
  const curso = await api.reservation({ title: 'Retiro en curso', start: day(-1), end: day(1) });
  const proximo = await api.reservation({ title: 'Retiro próximo', start: day(30), end: day(32) });
  const a = await api.guest(curso.event, { first_name: 'Lola', last_name_1: 'Sanz' });
  const b = await api.guest(proximo.event, { first_name: 'Lola', last_name_1: 'Sanz' });
  await api.guestLink(curso.id, a, 'Lola', 'lola@example.invalid');
  // Por enlace, ese retiro (C10: `loginWithLink` devuelve su `grant`), aunque haya otro en curso.
  await page.goto(`${baseURL}/i/${await api.guestLink(proximo.id, b, 'Lola', 'lola@example.invalid')}`);
  await page.locator('#privacyOk').click();
  await expect(page).toHaveURL(new RegExp(`#/p/${b}$`));
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro próximo');
  // Tanda 31 (MUELA-059, añadido de VG): hay un retiro en curso y se ve otro: aviso fijo que se minimiza pero no se cierra.
  const away = page.locator('#otherRetreat');
  await expect(away).toContainText('Estás viendo «Retiro próximo», no el retiro en el que estás ahora (Retiro en curso).');
  await away.getByRole('button', { name: 'Minimizar el aviso' }).click();
  await expect(away).toHaveClass(/min/);
  await expect(away.getByRole('button', { name: 'Ir a mi retiro' })).toBeVisible();
  await away.getByRole('button', { name: 'Estás en otro retiro. Mostrar el aviso' }).click();
  await expect(away).toContainText('Estás viendo «Retiro próximo»');
  // Sin enlace (la sesión guardada al volver a abrir la app), el que está en curso.
  await page.goto(`${baseURL}/`);
  await page.locator('#privacyOk').click();
  await expect(page).toHaveURL(new RegExp(`#/p/${a}$`));
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro en curso');
  // Tanda 31: durante el retiro, «Necesito ayuda» en el cuadro del retiro (el horario sale solo con programa o menú).
  await expect(page.locator('#urgentHelp')).toBeVisible();
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
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro próximo');

  // Desde el calendario, «Retiros» vuelve al último visto; tocar la barra del calendario abre su pestaña.
  await bar(page, 'Calendario').click();
  await bar(page, 'Retiros').click();
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro próximo');
  await bar(page, 'Calendario').click();
  await page.locator(`#calendar .cal-event[data-event-id="${curso.id}"]`).first().click();
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro en curso');
});

test('O4a · solo retiros pasados: el enlace abre su retiro («Cuéntanos qué tal»); sin enlace, el calendario, y «Retiros» abre el último', async ({ page }) => {
  const viejo = await api.reservation({ title: 'Retiro de hace un año', start: day(-400), end: day(-398) });
  // Terminó ayer: su enlace sigue valiendo unos días (los de retiros más viejos ya han caducado).
  const reciente = await api.reservation({ title: 'Retiro de esta semana', start: day(-3), end: day(-1) });
  const a = await api.guest(viejo.event, { first_name: 'Pau' });
  const b = await api.guest(reciente.event, { first_name: 'Pau' });
  await api.guestLink(viejo.id, a, 'Pau', 'pau@example.invalid');
  await page.goto(`${baseURL}/i/${await api.guestLink(reciente.id, b, 'Pau', 'pau@example.invalid')}`);
  await page.locator('#privacyOk').click();
  await expect(page).toHaveURL(new RegExp(`#/p/${b}$`));
  await expect(page.locator('#tellUs')).toBeVisible();
  // Sin enlace (al volver a abrir la app), ningún retiro en curso ni próximo: el calendario.
  await page.goto(`${baseURL}/`);
  await expect(page).toHaveURL(/#\/calendario$/);
  await expect(page.locator('#calendarList a')).toHaveCount(2);
  await bar(page, 'Retiros').click();
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
  // Tanda 31: se pasa de retiro con la portada (punto, flecha o deslizando) y se queda en la misma sección.
  await page.locator('#retreatTabs .cover-dot[aria-label^="Retiro dos"]').click();
  await expect(page).toHaveURL(new RegExp(`#/p/${b}/programa$`));
  await expect(page.locator('#programList')).toContainText('Yoga de dos');
  await expect(page.locator('#sections a[aria-current="page"]')).toHaveText('Programa');
});

test('G13 · el menú de la familia cruza a cada persona: la alergia de la segunda sale con su nombre, revisada o no', async ({ page }) => {
  const r = await api.reservation({ title: 'Retiro con niños', start: day(25), end: day(27) });
  const ana = await api.guest(r.event, { first_name: 'Ana', last_name_1: 'Gil' });
  const lucia = await api.guest(r.event, { first_name: 'Lucía', last_name_1: 'Gil' });
  await api.experience(r.id, { menu_visible: true });
  // La alergia es de la segunda persona; la primera solo tiene una preferencia.
  await api.restriction(r.event, ana, { type: 'preferencia', subject: 'cilantro' });
  await api.restriction(r.event, lucia, { type: 'alergia', subject: 'frutos secos', severity: 'grave' });
  await api.menu(r.event, [{ date: day(25), type: 'cena', time: '21:00', dishes: [
    { name: 'Bizcocho', allergens: ['frutos_de_cascara', 'gluten'], allergensChecked: false },
    { name: 'Tarta de almendra', allergensChecked: true },
    { name: 'Crema con cilantro', allergensChecked: true },
    { name: 'Arroz blanco', allergensChecked: true },
  ] }]);
  await api.guestLink(r.id, lucia, 'Lucía', 'gil@example.invalid');
  await page.goto(`${baseURL}/i/${await api.guestLink(r.id, ana, 'Ana', 'gil@example.invalid')}`);
  await page.locator('#privacyOk').click();
  await expect(page).toHaveURL(new RegExp(`#/r/${r.id}$`));
  await page.locator('#sections a[data-section="menu"]').click();

  const dishOf = (name: string) => page.locator('#menuList .gdish').filter({ has: page.locator('strong', { hasText: name }) });
  // Lo que tiene registrado cocina, persona a persona.
  await expect(page.locator(`#menuKitchen [data-guest="${lucia}"]`)).toContainText('Cocina tiene registrado lo que indicó Lucía: frutos secos.');
  await expect(page.locator(`#menuKitchen [data-guest="${ana}"]`)).toContainText('Cocina tiene registrado lo que indicó Ana: cilantro.');
  // Declarado aunque sin revisar: avisa con el nombre de Lucía, y la línea de #597 sigue.
  await expect(dishOf('Bizcocho').locator('.gcross')).toHaveText('⚠ Lucía: lleva frutos de cáscara (alergia grave). Pregunta en cocina.');
  await expect(dishOf('Bizcocho').locator('.gallergens')).toHaveText('Alérgenos declarados: frutos de cáscara, gluten (sin revisar por cocina).');
  // Sin declarar, pero el nombre del plato lo dice (la regla común de Food).
  await expect(dishOf('Tarta de almendra').locator('.gcross')).toHaveText('⚠ Lucía: lleva frutos secos (alergia grave). Pregunta en cocina.');
  // La preferencia de Ana, como información.
  await expect(dishOf('Crema con cilantro').locator('.gcross')).toHaveText('Ana: lleva cilantro (preferencia).');
  // Sin coincidencias, nada: nunca «apto».
  await expect(dishOf('Arroz blanco').locator('.gcross')).toHaveCount(0);
  await expect(page.locator('#menuList')).not.toContainText(/apto/i);
  // «Lo que vigilar, persona a persona» (065): solo quien tiene algo que vigilar ese día; la preferencia no cuenta.
  await expect(page.locator(`#familyWatch [data-guest="${lucia}"]`)).toContainText('Bizcocho');
  await expect(page.locator('#familyWatch')).toContainText('Nada que vigilar este día: Ana.');
  await capture(page, 'g13-menu-familia');

  // Solo Lucía: su aviso, sin nombre.
  await page.locator('#persons button', { hasText: 'Lucía' }).click();
  await expect(page).toHaveURL(new RegExp(`#/p/${lucia}/menu$`));
  await expect(dishOf('Bizcocho').locator('.gcross')).toHaveText('⚠ Lleva frutos de cáscara, que nos indicaste (alergia grave). Pregunta en cocina.');
  await expect(dishOf('Crema con cilantro').locator('.gcross')).toHaveCount(0);

  // Lo personal nunca se abre con la familia junta (serían los datos de la primera persona): la ruta de familia no lo admite.
  await page.locator('#persons button', { hasText: 'Todos' }).click();
  await expect(page).toHaveURL(new RegExp(`#/r/${r.id}/menu$`));
  await page.evaluate((hash) => { location.hash = hash; }, `#/r/${r.id}/alimentacion`);
  await expect(page.locator('#todoFamily .gperson')).toHaveCount(2);
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
  await expect(page.locator('#persons button > span:last-child')).toHaveText(['Todos', 'Marta', 'Nico']); // la cara va delante (tanda 31)
  // Tanda 31: los dos retiros en la portada que se pasa, con las caras de quien va.
  await expect(page.locator('#retreatTabs .cover-dot')).toHaveCount(2);
  await expect(page.locator('#retreatHero .cover-faces .medal-disc')).toHaveCount(2);
  await expect(page.locator('#todoFamily .gperson')).toHaveText([/^Marta/, /^Nico/]);
  await capture(page, 'familia-resumen');

  // Alojamiento con «Todos» (065): la cama de cada uno arriba; tocar a alguien enseña la suya, en la misma página.
  await page.locator('#sections a[data-section="alojamiento"]').click();
  await expect(page.locator(`#lodgingFamily [data-guest="${marta}"]`)).toContainText('Cama 1');
  await expect(page.locator(`#lodgingFamily [data-guest="${nico}"]`)).toContainText('Cama 2');
  await expect(page.locator('#lodgingFamily')).toContainText('Toda la familia, en la misma habitación.');
  await capture(page, 'familia-alojamiento');
  await page.locator(`#lodgingFamily [data-guest="${nico}"]`).click();
  await expect(page.locator(`#lodgingFamily [data-guest="${nico}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#lodgingMine')).toContainText('Cama 2');

  // El retiro que no es de todos dice a quién toca, en texto (y con su cara).
  await page.locator('#retreatTabs .cover-dot[aria-label^="Retiro de Marta"]').click();
  await page.locator('#privacyOk').click();
  await expect(page.locator('#retreatHero .cover-stats')).toContainText('Marta');
  await page.locator('#retreatTabs .cover-dot[aria-label^="Retiro en familia"]').click();

  // Solo Nico: solo su retiro (sin portada que pasar) y su Resumen, como antes.
  await page.locator('#persons button', { hasText: 'Nico' }).click();
  await page.locator('#sections a[data-section="inicio"]').click();
  await expect(page.locator('#persons button[aria-pressed="true"] > span:last-child')).toHaveText('Nico');
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
