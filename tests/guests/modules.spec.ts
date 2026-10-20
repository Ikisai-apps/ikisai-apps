/**
 * Guests · fases 4 y 5 (API.md §13), todo contra la API real sobre PGlite: la guests-api con las lecturas y acciones de
 * Organizers (#333: experiencia, materiales con `portal-files`, preguntas y respuestas), Booking (#328: programa y
 * alojamiento con elección atómica), Food (#327 y #332: menú validado y compartido) y Central (#326: el lugar y el plano),
 * y la vista previa del núcleo (#325). Navegación de O4a: barra «Calendario · Retiros · Más» y, en la pestaña del retiro, sus
 * secciones (Resumen, Programa, Menú y Alojamiento).
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { freePort } from '../food/helpers.ts';
import { startGuestsServer, type GuestsTestServer } from './server.ts';
import { buildGuestsApp } from './build.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/guests/vite.config.ts');
const CAPTURAS = process.env.GUESTS_CAPTURAS ?? '';
const PREFIJO = process.env.GUESTS_CAPTURAS_PREFIJO ?? 'despues';
/** Captura de pantalla entera, solo con GUESTS_CAPTURAS (tanda 31: capturas a 390 px de cada pantalla). */
async function capture(page: Page, name: string): Promise<void> {
  if (!CAPTURAS) return;
  mkdirSync(CAPTURAS, { recursive: true });
  await page.screenshot({ path: path.join(CAPTURAS, `${PREFIJO}-${name}.png`), fullPage: true });
}

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

/** Las URL firmadas apuntan al Supabase simulado (otro origen): el navegador las recibe de aquí. */
async function routeSignedFiles(page: Page): Promise<void> {
  await page.route('https://test.supabase.co/storage/v1/object/sign/**', (route) =>
    route.fulfill({ status: 200, headers: { 'content-type': 'application/pdf', 'Access-Control-Allow-Origin': '*' }, body: Buffer.from('%PDF-1.4 prueba') }));
}

async function enter(page: Page, token: string): Promise<void> {
  await routeSignedFiles(page);
  await page.goto(`${baseURL}/i/${token}`);
  await expect(page).not.toHaveURL(/\/i\//);
  await page.locator('#privacyOk').click();
  await expect(page.locator('#retreatTitle')).toBeVisible();
}

const navMain = (page: Page) => page.locator('nav.nav > a.navbtn:not(.navextra)');
const sections = (page: Page) => page.locator('#sections a');
const go = (page: Page, section: 'inicio' | 'programa' | 'menu' | 'alojamiento') => page.locator(`#sections a[data-section="${section}"]`).click();
/** Lo que iba en «Más» está en el menú lateral (tanda 31): la marca abre el cajón y «Este retiro» despliega sus filas. */
async function goMore(page: Page, label: string): Promise<void> {
  await page.locator('#appLauncher').click();
  const tile = page.locator('.appmenu-drawer .appmenu-tile', { hasText: 'Este retiro' });
  if ((await tile.getAttribute('aria-expanded')) !== 'true') await tile.click();
  await page.locator('.appmenu-drawer .appmenu-panel a.appmenu-row', { hasText: label }).click();
}

const ALL_MODULES = {
  program_visible: true, menu_visible: true, materials_visible: true, questions_visible: true, lodging_visible: true, lodging_capability: 'view',
  organizer_message: '¡Bienvenidas! Traed esterilla.',
};

test('guests · sin configuración del organizador: como la fase 1, solo el Resumen (sin secciones)', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro sencillo' });
  const ana = await api.guest(event, { first_name: 'Ana' });
  await enter(page, await api.guestLink(reservation, ana, 'Ana'));
  // O4a: la barra es siempre «Calendario · Retiros · Más»; sin módulos, el retiro no tiene secciones.
  await expect(navMain(page)).toHaveText(['Calendario', 'Retiros']);
  await expect(page.locator('#sections')).toHaveCount(0);
  await expect(page.locator('#task-data')).toBeVisible();
  await page.goto(`${page.url().split('#')[0]}#/p/${ana}/programa`);
  await expect(page.locator('#retreatTitle')).toBeVisible(); // módulo inactivo: vuelve a Inicio
});

test('guests · durante el retiro: «Hoy», programa, menú con foto, mi habitación y materiales sin conexión', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro en marcha', start: day(0), end: day(2) });
  const leo = await api.guest(event, { first_name: 'Leo' });
  // Reloj fijo a mediodía de Madrid (10:00 UTC = 12:00 en verano, 11:00 en invierno): la prueba no depende de la hora.
  await page.clock.setFixedTime(new Date(`${day(0)}T10:00:00Z`));
  await api.experience(reservation, ALL_MODULES);
  const item = (d: string, starts_at: string, ends_at: string | null, title: string, place_text: string | null, public_note: string | null = null) =>
    api.organizerInvoke(reservation, 'booking.portal_program_save', { item: { id: crypto.randomUUID(), day: d, starts_at, ends_at, title, place_text, public_note, internal_note: 'nota interna', kind: 'actividad' } });
  await item(day(0), '10:00', '13:30', 'Yoga suave', 'Sala grande');
  await item(day(0), '17:00', null, 'Paseo al pinar', 'Pinar', 'Calzado cómodo');
  await item(day(1), '10:00', '12:00', 'Taller de respiración', null);
  await api.menu(event, [
    { date: day(0), type: 'cena', time: '21:00', dishes: [{ name: 'Crema de calabaza', diet: ['vegano'] }, { name: 'Tarta de queso', allergens: ['lacteos', 'gluten'] },
      { name: 'Pan de pueblo', allergens: ['gluten', 'sesamo'], allergensChecked: false }, { name: 'Ensalada verde', allergensChecked: true }] },
    { date: day(1), type: 'desayuno', time: '08:30', dishes: [{ name: 'Fruta y tostadas' }] },
  ]);
  const room = await api.room(event, { name: 'Habitación 3', enSuite: false, beds: ['Cama 1', 'Cama 2'] });
  await api.assign(event, room.spaceId, room.bedIds[1]!, leo);
  await api.material(reservation, { kind: 'file', title: 'Programa en PDF', description: 'Para imprimir', file: { name: 'programa.pdf', mime: 'application/pdf', size: 15 } });
  await api.material(reservation, { kind: 'link', title: 'Grupo de WhatsApp', url: 'https://chat.whatsapp.com/ejemplo' });
  await api.material(reservation, { kind: 'text', title: 'Para después', body: 'Gracias', window: 'after' });
  await enter(page, await api.guestLink(reservation, leo, 'Leo'));

  await expect(page.locator('#organizerMessage')).toContainText('Traed esterilla');
  await expect(sections(page)).toHaveText(['Resumen', 'Programa', 'Menú', 'Alojamiento']);
  await expect(navMain(page)).toHaveText(['Calendario', 'Retiros']);
  await expect(page.locator('nav.nav button.navmore')).toHaveCount(0); // «Más» pasa al menú lateral (tanda 31)
  // Horario del retiro: hoy, con lo de ahora y lo siguiente marcados, y la próxima comida.
  await expect(page.locator('#today')).toContainText('Hoy en Ikisai');
  await expect(page.locator('#todayNow')).toContainText('Yoga suave');
  await expect(page.locator('#todayNext')).toContainText('Paseo al pinar');
  await expect(page.locator('#todayMeal')).toContainText('Crema de calabaza');

  await go(page, 'programa');
  // «Ahora y lo siguiente» (MUELA-025): lo de ahora con lo que queda, y lo siguiente con su cuenta atrás.
  await expect(page.locator('#programList .now-hero')).toContainText('Yoga suave');
  await expect(page.locator('#programList .now-hero')).toContainText('Quedan 1 h 30 min');
  await expect(page.locator('#programList .now-next')).toContainText('Paseo al pinar');
  await expect(page.locator('#programList .now-next')).toContainText('sin hora de fin');
  await capture(page, 'programa');
  await expect(page.locator('#programList')).toContainText('Yoga suave');
  await expect(page.locator('#programList')).not.toContainText('nota interna');
  await page.locator('#programDays [role="tab"]').nth(1).click();
  await expect(page.locator('#programList')).toContainText('Taller de respiración');

  await go(page, 'menu');
  await expect(page.locator('#menuList')).toContainText('Tarta de queso');
  await expect(page.locator('#menuList')).toContainText('Alérgenos declarados por cocina: lácteos, gluten.');
  await expect(page.locator('#menuList')).toContainText('Vegana');
  // Tanda 26: los alérgenos declarados salen siempre; sin revisar por cocina, se dice (también si no declara ninguno).
  const dishOf = (name: string) => page.locator('#menuList .gdish').filter({ has: page.locator('strong', { hasText: name }) });
  await expect(dishOf('Pan de pueblo').locator('.gallergens')).toHaveText('Alérgenos declarados: gluten, sésamo (sin revisar por cocina).');
  await expect(dishOf('Crema de calabaza').locator('.gallergens')).toHaveText('Alérgenos: sin revisar por cocina.');
  await expect(dishOf('Ensalada verde').locator('.gallergens')).toHaveCount(0); // revisada y sin alérgenos
  await expect(dishOf('Tarta de queso').locator('.gallergens')).toHaveText('Alérgenos declarados por cocina: lácteos, gluten.');
  await expect(page.locator('#menuProvisional')).toHaveCount(0); // Guests solo ve menús validados

  await go(page, 'alojamiento');
  await expect(page.locator('#lodgingMine')).toContainText('Habitación 3');
  await expect(page.locator('#lodgingMine')).toContainText('Cama 2');
  await expect(page.locator('#lodgingRooms')).toHaveCount(0);

  await goMore(page, 'Materiales de tu organizador');
  await expect(page.locator('#materialsList')).toContainText('Grupo de WhatsApp');
  await expect(page.locator('#materialsList')).not.toContainText('Para después'); // ventana «después»
  const signed = page.waitForResponse((r) => /\/api\/v1\/portal-files\//.test(r.url()));
  await page.locator('#materialsList button[data-file]').click();
  expect((await signed).status()).toBe(200); // resolutor real de Organizers (C8)
  await expect(page.locator('#materialsList button[data-file]')).toHaveText('Guardado en este dispositivo');
  await capture(page, 'guia-materiales');
});

test('guests · preguntas del organizador: pendiente en Inicio, se responden sin «Guardar» y avisa de quién las ve', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro con preguntas' });
  const eva = await api.guest(event, { first_name: 'Eva' });
  await api.experience(reservation, { questions_visible: true });
  const q1 = await api.question(reservation, { type: 'text', label: '¿Qué esperas del retiro?', required: true });
  const q2 = await api.question(reservation, { type: 'yes_no', label: '¿Vienes en coche?', help: 'Para organizar el aparcamiento' });
  const q3 = await api.question(reservation, { type: 'choice', label: 'Taller del sábado', options: [{ value: 'a', label: 'Cerámica' }, { value: 'b', label: 'Dibujo' }], closes_at: day(-1), opens_at: day(-5) });
  await enter(page, await api.guestLink(reservation, eva, 'Eva'));
  await expect(page.locator('#task-questions')).toContainText('1 pregunta');
  await expect(page.locator('#sections')).toHaveCount(0); // sin Programa, Menú ni Alojamiento: solo el Resumen

  // Tanda 31 (MUELA-037): las preguntas en la «Guía del retiro», pregunta a pregunta; las cerradas, solo en la lista.
  await page.locator('#task-questions').click();
  await expect(page.locator('#guideTop')).toContainText('Te faltan 2 preguntas de tu organizador');
  await expect(page.locator('#questionsNotice')).toHaveText(' Tu organizador verá tus respuestas.');
  await expect(page.locator(`.gq-list [data-question="${q3}"]`)).toContainText('Cerrada');
  await expect(page.locator('.ask-meta')).toHaveText('Pregunta 1 de 2');
  await capture(page, 'guia-preguntas');
  await page.locator('.ask-input').fill('Descansar y aprender a respirar');
  await page.locator('.ask-input').press('Enter');
  await page.locator('.ask-choice', { hasText: 'Sí' }).click();
  await expect(page.locator(`.gq-list [data-question="${q2}"]`)).toContainText('Sí');
  const answers = async () => (await api.booking.t.db.query<{ question_id: string; value: unknown }>(`select question_id, value from organizers.answers where guest_id = $1 and deleted_at is null`, [eva])).rows;
  await expect.poll(async () => (await answers()).length).toBe(2);
  expect(await answers()).toEqual(expect.arrayContaining([{ question_id: q1, value: 'Descansar y aprender a respirar' }, { question_id: q2, value: true }]));
});

test('guests · elegir habitación: atómica, sin nombres ajenos; si otra persona la coge antes, se dice', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro con habitaciones' });
  const iris = await api.guest(event, { first_name: 'Iris' });
  const otra = await api.guest(event, { first_name: 'Otra', last_name_1: 'Persona' });
  const room = await api.room(event, { name: 'Habitación Olivo', enSuite: true, beds: ['Cama 1', 'Cama 2'] });
  await api.organizerInvoke(reservation, 'booking.portal_room_settings', { choice: 'choose', choose_until: day(10), rooms: [{ space_id: room.spaceId, option_key: 'bano', supplement: true }] });
  await api.experience(reservation, { lodging_visible: true, lodging_capability: 'choose',
    lodging_options: [{ key: 'bano', label: 'Habitación con baño (2 plazas)', guest_note: '+40 € por persona, a pagar a tu organizador' }] });
  await enter(page, await api.guestLink(reservation, iris, 'Iris'));
  await expect(page.locator('#task-room')).toContainText('Hasta el');
  await go(page, 'alojamiento');
  // La habitación que se propone, con la nota de suplemento a la vista antes de elegir (PERDIDAS §2).
  await expect(page.locator('#lodgingNone')).toContainText('Te guardamos esta habitación');
  await expect(page.locator('#lodgingRoom')).toContainText('+40 € por persona, a pagar a tu organizador');
  await expect(page.locator('#lodgingRooms')).toContainText('Con baño');
  await expect(page.locator('#lodgingRooms')).toContainText('2 de 2 camas libres');
  // «Cambiar habitación» despliega la lista, con la opción del organizador y su nota.
  await page.locator('.gchange-room').click();
  await expect(page.locator('[data-option="bano"]')).toContainText('+40 € por persona, a pagar a tu organizador');
  await page.locator('.gchange-room').click();

  // Otra persona coge la cama 1 justo antes (Booking real): Iris la ve aún libre y recibe BED_TAKEN.
  await api.guestInvoke(reservation, otra, 'booking.portal_choose_bed', { bed_id: room.bedIds[0] });
  await page.locator(`button[data-bed="${room.bedIds[0]}"]`).click();
  await page.getByRole('button', { name: 'Elegir esta cama' }).click();
  await expect(page.getByText('Alguien acaba de elegir esa cama')).toBeVisible();
  await expect(page.locator(`button[data-bed="${room.bedIds[0]}"]`)).toBeDisabled();
  await expect(page.locator('#lodgingRooms')).not.toContainText('Otra');

  await page.locator(`button[data-bed="${room.bedIds[1]}"]`).click();
  await page.getByRole('button', { name: 'Elegir esta cama' }).click();
  await expect(page.locator('#lodgingMine')).toContainText('Cama 2');
  const rows = await api.booking.t.db.query<{ guest_id: string; source: string; status: string }>(`select guest_id, source, status from booking.room_assignments where bed_id = $1 and deleted_at is null`, [room.bedIds[1]]);
  expect(rows.rows).toEqual([{ guest_id: iris, source: 'guest', status: 'confirmed' }]);
  await go(page, 'inicio');
  await expect(page.locator('#task-room')).toHaveAttribute('title', /Elegida/); // en la línea «Hecho:», con su estado
});

test('guests · supletorias activadas (BG13): se eligen marcadas como «Supletoria», con su recuento aparte; las no activadas no salen', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro con supletorias' });
  const ines = await api.guest(event, { first_name: 'Inés' });
  const room = await api.room(event, { name: 'Habitación Encina', enSuite: true, beds: ['Cama 1', 'Cama 2'], extraBeds: ['Supletoria A', 'Supletoria B'] });
  await api.organizerInvoke(reservation, 'booking.portal_room_settings', { choice: 'choose', choose_until: day(10), rooms: [{ space_id: room.spaceId, option_key: 'bano', supplement: true }] });
  // El organizador activa una de las dos supletorias posibles (Booking §25, sin propuesta aceptada: inmediato).
  await api.organizerInvoke(reservation, 'booking.portal_extra_beds', { space_id: room.spaceId, count: 1 });
  await api.experience(reservation, { lodging_visible: true, lodging_capability: 'choose' });
  await enter(page, await api.guestLink(reservation, ines, 'Inés'));
  await go(page, 'alojamiento');
  const card = page.locator('#lodgingRoom');
  await expect(card).toHaveAttribute('data-space', room.spaceId);
  await expect(card).toContainText('2 de 2 camas libres · 1 de 1 supletorias libres');
  await expect(card.locator('.gbeds button')).toHaveCount(3);
  const extra = card.locator('.gbeds button', { hasText: 'Supletoria' });
  await expect(extra).toHaveCount(1);
  await expect(extra.locator('.gextra')).toHaveText('Supletoria');
  await extra.click();
  await page.getByRole('button', { name: 'Elegir esta cama' }).click();
  await expect(page.locator('#lodgingMine')).toContainText('Supletoria');
  const rows = await api.booking.t.db.query<{ kind: string }>(`select b.kind from booking.room_assignments a join booking.beds b on b.id = a.bed_id where a.guest_id = $1 and a.deleted_at is null`, [ines]);
  expect(rows.rows).toEqual([{ kind: 'supletoria' }]);
});

test('guests · información: el lugar de Central (dirección, mapa y plano en PDF por portal-files)', async ({ page }) => {
  await api.place({ venue: 'Camino del Pinar 3, Segovia', plan: 'application/pdf' });
  const { id: reservation, event } = await api.reservation({ title: 'Retiro con plano' });
  const zoe = await api.guest(event, { first_name: 'Zoe' });
  await enter(page, await api.guestLink(reservation, zoe, 'Zoe'));
  await page.locator('#openInfo').click();
  await expect(page.locator('#infoAddress')).toContainText('Camino del Pinar 3, Segovia');
  await expect(page.locator('#infoPlace')).not.toContainText('Calle Fiscal'); // nunca el domicilio fiscal
  await expect(page.locator('#infoMap')).toHaveAttribute('href', /google\.com\/maps\/search/);
  // Tanda 31: el plano del centro se abre dentro («Ver en el plano»); si es un PDF, se abre desde ahí.
  await page.locator('#infoPlan summary').click();
  const signed = page.waitForResponse((r) => /\/api\/v1\/portal-files\//.test(r.url()));
  await page.locator('#infoPlan').getByRole('button', { name: 'Abrir el plano (PDF)' }).click();
  expect((await signed).status()).toBe(200);
});

test('guests · vista previa del organizador (huésped de muestra): franja visible y nada se guarda', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro en vista previa' });
  const muestra = await api.guest(event, { first_name: 'Huésped de muestra' });
  await api.experience(reservation, ALL_MODULES);
  // Enlace real de vista previa (contrato §3.6, O6): la entrada de ámbito llega marcada `preview` y el kit rechaza escrituras.
  await routeSignedFiles(page);
  await page.goto(`${baseURL}/i/${await api.guestLink(reservation, muestra, 'Muestra', undefined, true)}`);
  await expect(page.locator('#previewBand')).toBeVisible();
  await page.locator('#privacyOk').click();
  await expect(page.locator('#retreatTitle')).toBeVisible();
  expect((await api.row(muestra)).privacy_ack_version).toBeNull();
  await goMore(page, 'Tus datos');
  await page.locator('.ask-input').fill('Prueba');
  await page.locator('.ask-input').press('Enter');
  await expect(page.getByText('Es una vista previa: no se guarda nada.').first()).toBeVisible();
  expect((await api.row(muestra)).last_name_1).toBeNull();
});
