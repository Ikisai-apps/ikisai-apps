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
import { mkdirSync, readFileSync } from 'node:fs';
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
  // Reloj fijo a mediodía de Madrid, en verano y en invierno (10:00 UTC solo es mediodía en verano: desde el cambio de hora
  // del 25-10 salía «Quedan 2 h 30 min»).
  const utcNoon = new Date(`${day(0)}T12:00:00Z`);
  const madridHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23' }).format(utcNoon));
  await page.clock.setFixedTime(new Date(utcNoon.getTime() - (madridHour - 12) * 3_600_000));
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

test('guests · «Ver en el plano» con el mapa de zonas (MUELA-024): la sala resaltada con «Aquí»; tu cama sin disposición en Booking, en su habitación', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro con mapa', start: day(0), end: day(2) });
  const ona = await api.guest(event, { first_name: 'Ona' });
  await page.clock.setFixedTime(new Date(`${day(0)}T10:00:00Z`));
  await api.experience(reservation, ALL_MODULES);
  await api.organizerInvoke(reservation, 'booking.portal_program_save', { item: { id: crypto.randomUUID(), day: day(0), starts_at: '09:00', ends_at: '15:00', title: 'Yoga en el jardín', place_text: 'Sala del jardín', kind: 'actividad' } });
  const room = await api.room(event, { name: 'Habitación del mapa', enSuite: false, beds: ['Cama 1', 'Cama 2'] });
  await api.assign(event, room.spaceId, room.bedIds[1]!, ona);
  const square = (x: number, y: number, s = 0.2): Array<[number, number]> => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
  const { ids } = await api.floorPlan([
    { name: 'Sala del jardín', points: square(0.05, 0.05, 0.3) },
    { name: 'Comedor', points: square(0.4, 0.05, 0.3) },
    { name: 'Habitación del mapa', kind: 'habitacion', points: square(0.05, 0.5, 0.4) },
    // La cama, sin forma en Recursos y sin disposición en Booking: no se pinta.
    { name: 'Cama 2', kind: 'cama', parent: 'Habitación del mapa' },
  ]);
  await enter(page, await api.guestLink(reservation, ona, 'Ona'));

  // Resumen: «Tu habitación en el plano» la encuentra por nombre y, como su cama no se pinta, señala su habitación.
  await expect(page.locator('#roomPlan')).toHaveAttribute('data-space', ids['Habitación del mapa']!);
  expect(ids['Cama 2']).toBeTruthy();
  await go(page, 'programa');
  const plan = page.locator('#nowPlan');
  await expect(plan).toHaveAttribute('data-space', ids['Sala del jardín']!);
  await plan.locator('summary').click();
  const here = plan.locator('.map-svg [role="button"][aria-pressed="true"]');
  await expect(here).toHaveCount(1);
  await expect(here).toHaveAttribute('aria-label', /Sala del jardín/);
  await expect(here).toHaveAttribute('aria-label', /Aquí/);
  await expect(plan.locator('.map-svg [role="button"]')).toHaveCount(3);
  // El plano del centro de Central (si otra prueba lo sembró), debajo y plegado: nunca en lugar del mapa.
  for (const backup of await plan.locator('.gplan-backup').all()) await expect(backup).not.toHaveAttribute('open', /.*/);
  await plan.scrollIntoViewIfNeeded();
  await capture(page, 'plano-mapa');
});

/** Las estancias de un dibujo real (`MUELA/planos`, trazado sin cotas ni datos del pliego): `data-name` y su contorno en 0..1. */
function drawing(file: string): { width: number; height: number; rooms: Array<{ name: string; points: Array<[number, number]> }> } {
  const text = readFileSync(path.join(here, 'fixtures/planos', file), 'utf8');
  const [, width, height] = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(text)!.map(Number);
  const rooms = [...text.matchAll(/data-name="([^"]+)" d="([^"]+)"/g)].map(([, name, d]) => ({
    name: name!,
    points: [...d!.matchAll(/([\d.]+) ([\d.]+)/g)].map(([, x, y]) => [Number(x) / width!, Number(y) / height!] as [number, number]),
  }));
  return { width: width!, height: height!, rooms };
}

test('guests · «Ver en el plano» con los dibujos reales del Albergue y de Salas, en el móvil: tu cama con su icono y la sala de la actividad', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { id: reservation, event } = await api.reservation({ title: 'Retiro en el Albergue', start: day(0), end: day(2) });
  const ona = await api.guest(event, { first_name: 'Ona' });
  await page.clock.setFixedTime(new Date(`${day(0)}T07:00:00Z`));
  await api.experience(reservation, ALL_MODULES);
  const room = await api.room(event, { name: 'Dormitorio del dibujo', enSuite: false, beds: ['Litera 1', 'Cama 2'] });
  await api.assign(event, room.spaceId, room.bedIds[0]!, ona);
  // Las camas se colocan en Booking (un solo modelo): la habitación en 4 × 6 cuadrantes y las dos a lo largo.
  await api.bedLayout(room.spaceId, { cols: 4, rows: 6 }, [[room.bedIds[0]!, { x: 0, y: 0, rot: 90 }], [room.bedIds[1]!, { x: 2, y: 0, rot: 90 }]]);
  // Su disposición llega en `portal_lodging`, que lista las habitaciones abiertas.
  await api.organizerInvoke(reservation, 'booking.portal_room_settings', { choice: 'choose', choose_until: day(10), rooms: [{ space_id: room.spaceId }] });

  // Albergue: sus 20 estancias con nombre; «Hab 1» es la habitación de Booking, con una litera (la de Ona) y una cama.
  const albergue = drawing('albergue.svg');
  expect(albergue.rooms).toHaveLength(20);
  const { ids } = await api.floorPlan([
    ...albergue.rooms.map((r) => (r.name === 'Hab 1'
      ? { ...r, kind: 'habitacion', refs: [`booking.space:${room.spaceId}`] }
      : { ...r, kind: r.name.startsWith('Hab ') ? 'habitacion' : 'sala' })),
    // Las camas, sin forma en Recursos: la saca Guests de su disposición en Booking.
    { name: 'Litera 1', kind: 'cama', parent: 'Hab 1', refs: [`booking.bed:${room.bedIds[0]}`], attributes: { bed_kind: 'litera' } },
    { name: 'Cama 2', kind: 'cama', parent: 'Hab 1', refs: [`booking.bed:${room.bedIds[1]}`], attributes: { bed_kind: 'individual' } },
  ], { width: albergue.width, height: albergue.height, mime: 'image/svg+xml' });
  // Salas: el «Museo» del dibujo del centro, donde es la actividad de ahora.
  const centro = drawing('centro.svg');
  expect(centro.rooms).toHaveLength(5);
  const salas = await api.floorPlan(centro.rooms.map((r) => ({ ...r, kind: 'sala' })), { width: centro.width, height: centro.height, mime: 'image/svg+xml' });
  await api.organizerInvoke(reservation, 'booking.portal_program_save', { item: { id: crypto.randomUUID(), day: day(0), starts_at: '06:00', ends_at: '23:00', title: 'Visita guiada', place_text: 'Museo', kind: 'actividad' } });

  await enter(page, await api.guestLink(reservation, ona, 'Ona'));
  // Los dibujos firmados, servidos como SVG (después de `enter`, para que manden sobre el PDF de prueba).
  await page.route('https://test.supabase.co/storage/v1/object/sign/**', (route) => route.fulfill({
    status: 200, headers: { 'content-type': 'image/svg+xml', 'Access-Control-Allow-Origin': '*' },
    body: readFileSync(path.join(here, 'fixtures/planos', route.request().url().includes(salas.fileId!) ? 'centro.svg' : 'albergue.svg')),
  }));

  // Resumen: «Tu habitación en el plano», sobre el dibujo, con la litera de Ona marcada y su icono.
  const plan = page.locator('#roomPlan');
  await expect(plan).toHaveAttribute('data-space', ids['Litera 1']!);
  await plan.locator('summary').click();
  await expect(plan.locator('.map-svg image.map-bg')).toHaveAttribute('href', /.+/);
  await expect(plan.locator(`.map-svg [data-space-id="${ids['Litera 1']}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(plan.locator('.map-svg use.map-bedicon[data-bed-kind="litera"]')).toHaveCount(1);
  await expect(plan.locator('.map-svg use.map-bedicon[data-bed-kind="individual"]')).toHaveCount(1);
  // En el móvil, el mapa cabe en el ancho y la página no se desplaza de lado.
  const box = await plan.locator('.map-svg').boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await plan.scrollIntoViewIfNeeded();
  await capture(page, 'plano-real-cama');

  // Programa: la actividad en el Museo, resaltada sobre el dibujo de Salas.
  await go(page, 'programa');
  const now = page.locator('#nowPlan');
  await expect(now).toHaveAttribute('data-space', salas.ids['Museo']!);
  await now.locator('summary').click();
  await expect(now.locator('.map-svg image.map-bg')).toHaveAttribute('href', /.+/);
  await expect(now.locator('.map-svg [role="button"][aria-pressed="true"]')).toHaveAttribute('aria-label', /Museo/);
});

test('guests · silueta de cabecera: la que Central eligió para Guests (Recursos 0816) sale bajo la portada; las demás, no', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro con silueta', start: day(1), end: day(3) });
  const ona = await api.guest(event, { first_name: 'Ona' });
  const db = api.booking.t.db;
  const building = (await db.query<{ id: string }>(`insert into resources.spaces (kind, name) values ('edificio', 'Albergue de la silueta') returning id`)).rows[0]!.id;
  const file = async () => (await db.query<{ id: string }>(`insert into core.files (app, bucket, path, filename, mime, size, sha256, status, hash_verified) values ('resources', 'resources-plans', $1, 'silueta', 'image/svg+xml', 300, $2, 'verified', true) returning id`,
    [`resources/${crypto.randomUUID()}`, 'e'.repeat(64)])).rows[0]!.id;
  // Una para Central y otra para Guests: solo se ve la de Guests.
  await db.query(`insert into resources.space_images (space_id, kind, title, file_id, header_for) values ($1, 'silueta', 'Para Central', $2, '{central}'), ($1, 'silueta', 'Para Guests', $3, '{guests}')`, [building, await file(), await file()]);
  await enter(page, await api.guestLink(reservation, ona, 'Ona'));
  await page.route('https://test.supabase.co/storage/v1/object/sign/**', (route) => route.fulfill({
    status: 200, headers: { 'content-type': 'image/svg+xml', 'Access-Control-Allow-Origin': '*' },
    body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 40"><path d="M0 40V20h60V5h80v15h60v20z" fill="#333"/></svg>',
  }));
  await page.reload();
  const skyline = page.locator('#headerSilhouette');
  await expect(skyline).toBeVisible();
  await expect(skyline).toHaveAttribute('aria-hidden', 'true');
  await expect(skyline.locator('img')).toHaveAttribute('alt', '');
  await db.query(`update resources.space_images set deleted_at = now() where space_id = $1`, [building]);
});

test('guests · Alojamiento con el mapa de zonas (MUELA-056 y 024): las habitaciones abiertas en el plano, con su estado en texto; tocar una la enseña abajo', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro con plano de habitaciones' });
  const eli = await api.guest(event, { first_name: 'Eli' });
  const olmo = await api.room(event, { name: 'Habitación Olmo', enSuite: true, beds: ['Cama 1', 'Cama 2'] });
  const roble = await api.room(event, { name: 'Habitación Roble', enSuite: true, beds: ['Cama 1', 'Cama 2', 'Cama 3', 'Cama 4', 'Cama 5'] });
  await api.organizerInvoke(reservation, 'booking.portal_room_settings', { choice: 'choose', choose_until: day(10), rooms: [{ space_id: olmo.spaceId }, { space_id: roble.spaceId }] });
  // Dos camas de Roble colocadas en Booking; las otras, sin colocar, no salen en el plano.
  await api.bedLayout(roble.spaceId, { cols: 6, rows: 4 }, [[roble.bedIds[0]!, { x: 0, y: 0, rot: 0 }], [roble.bedIds[1]!, { x: 3, y: 0, rot: 0 }]]);
  await api.experience(reservation, { lodging_visible: true, lodging_capability: 'choose' });
  const square = (x: number, y: number, s = 0.3): Array<[number, number]> => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
  const { ids } = await api.floorPlan([
    { name: 'Habitación Olmo', kind: 'habitacion', points: square(0.05, 0.1) },
    // Otro nombre en Recursos: solo casa por el id que da Booking (#680).
    { name: 'Dormitorio grande', kind: 'habitacion', points: square(0.5, 0.1), refs: [`booking.space:${roble.spaceId}`] },
    { name: 'Comedor de abajo', kind: 'comedor', points: square(0.05, 0.6) },
    // Las camas de Roble en Recursos, sin forma (otro nombre en Recursos: casan por el id que da Booking).
    { name: 'Cama de la ventana', kind: 'cama', parent: 'Dormitorio grande', refs: [`booking.bed:${roble.bedIds[0]}`] },
    { name: 'Cama de la puerta', kind: 'cama', parent: 'Dormitorio grande', refs: [`booking.bed:${roble.bedIds[1]}`] },
    { name: 'Cama 3', kind: 'cama', parent: 'Dormitorio grande', refs: [`booking.bed:${roble.bedIds[2]}`] },
  ]);
  await enter(page, await api.guestLink(reservation, eli, 'Eli'));
  await go(page, 'alojamiento');

  const map = page.locator('#lodgingMap');
  // Solo las habitaciones abiertas se tocan (el comedor sale apagado y sin tocar).
  await expect(map.locator('.map-svg [role="button"]')).toHaveCount(2);
  const olmoZone = map.locator('.map-svg [role="button"][aria-label^="Habitación Olmo"]');
  await expect(olmoZone).toHaveAttribute('aria-label', /2 libres/);
  // «Poca gente»: la de cinco deja de cumplir, y lo dice en texto.
  await page.locator('#lodgingRooms .gfilters button', { hasText: 'Poca gente' }).click();
  await expect(map.locator('.map-svg [role="button"][aria-label^="Dormitorio grande"]')).toHaveAttribute('aria-label', /No cumple/);
  // Tocar una en el plano la enseña abajo, resaltada.
  await map.locator('.map-svg [role="button"][aria-label^="Dormitorio grande"]').click();
  await expect(page.locator('#lodgingRoom')).toHaveAttribute('data-space', roble.spaceId);
  await expect(map.locator('.map-svg [role="button"][aria-pressed="true"]')).toHaveAttribute('aria-label', /Dormitorio grande/);
  expect(ids['Dormitorio grande']).toBeTruthy();
  // La elegida ampliada: sus camas sobre su dibujo, con el estado en texto; tocar una la elige como su botón.
  const beds = page.locator('#lodgingBedsMap .map-svg [role="button"]');
  await expect(beds).toHaveCount(2);
  await expect(page.locator(`#lodgingBedsMap .map-svg [role="button"][aria-label*="Libre"]`)).toHaveCount(2);
  await expect(page.locator('#lodgingBedsMap .map-bed-txt')).toHaveCount(0); // sin números en las camas
  await capture(page, 'alojamiento-mapa');
  await page.locator('#lodgingBedsMap .map-svg [role="button"]').first().click();
  await page.getByRole('button', { name: 'Elegir esta cama' }).click();
  await expect(page.locator('#lodgingMine')).toContainText('Cama 1');
  await expect.poll(async () => (await api.booking.t.db.query<{ bed_id: string }>(`select bed_id from booking.room_assignments where guest_id = $1 and deleted_at is null`, [eli])).rows.map((r) => r.bed_id)).toEqual([roble.bedIds[0]]);
});
