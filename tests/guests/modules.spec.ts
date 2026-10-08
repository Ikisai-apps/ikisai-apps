/**
 * Guests · fases 4 y 5 (API.md §13). Contra la guests-api y la booking-api reales sobre PGlite: programa (Booking §23),
 * alojamiento con elección atómica (Booking §23.1), menú (Food §7.5, sembrado validado y compartido), el lugar y el plano
 * (Central §2.9, con `portal-files`) y la vista previa (núcleo, O6). Lo de Organizers, que aún no está publicado
 * (experiencia, materiales y preguntas), se **simula** en el navegador con su forma de datos (docs/organizers/API.md §15),
 * que Guests normaliza (`app/normalize.ts`).
 */
import { expect, test, type Page, type Route } from 'playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../food/helpers.ts';
import { startGuestsServer, type GuestsTestServer } from './server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/guests/vite.config.ts');

let api: GuestsTestServer;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
  api = await startGuestsServer();
  process.env.VITE_API_PROXY = api.url;
  await build({ configFile, logLevel: 'silent' });
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

type Reply = unknown | ((body: any) => { status?: number; body: unknown });

/** Simula las lecturas y la acción de Organizers (aún sin publicar); registra lo que la app envía. */
async function simulateOrganizers(page: Page, replies: Record<string, Reply>): Promise<Record<string, unknown[]>> {
  const calls: Record<string, unknown[]> = {};
  await page.route(/\/api\/v1\/(read|invoke)\/organizers\.[a-z_]+$/, async (route: Route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop()!;
    const body = route.request().postDataJSON() ?? {};
    (calls[name] ??= []).push(body);
    const reply = replies[name];
    if (reply === undefined) return route.fulfill({ status: 403, json: { error: { code: 'READ_NOT_ALLOWED', message: 'no', details: null } } });
    const out = typeof reply === 'function' ? (reply as (b: any) => { status?: number; body: unknown })(body) : { body: reply };
    await route.fulfill({ status: out.status ?? 200, json: out.body });
  });
  return calls;
}

/** Los materiales de Organizers se abren con `portal-files`; su resolutor aún no existe, así que también se simula. */
async function simulateMaterialFiles(page: Page): Promise<string[]> {
  const opened: string[] = [];
  await page.route(/\/api\/v1\/portal-files\/[^/]+$/, async (route) => {
    opened.push(route.request().url());
    await route.fulfill({ json: { url: 'https://files.test/programa.pdf', expiresAt: new Date(Date.now() + 300_000).toISOString(), name: 'programa.pdf', mime: 'application/pdf' } });
  });
  await page.route('https://files.test/**', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'application/pdf', 'Access-Control-Allow-Origin': '*' }, body: Buffer.from('%PDF-1.4 prueba') }));
  return opened;
}

async function enter(page: Page, token: string): Promise<void> {
  await page.goto(`${baseURL}/i/${token}`);
  await expect(page).not.toHaveURL(/\/i\//);
  await page.locator('#privacyOk').click();
  await expect(page.locator('#retreatTitle')).toBeVisible();
}

/** Experiencia en la forma de Organizers (filas de `experience_modules`, §15.1). */
const EXPERIENCE = (lodgingParams: Record<string, unknown> = {}) => ({
  revision: 3,
  items: [
    { module: 'programa', visible: true, capability: 'ver', window: 'siempre', position: 1 },
    { module: 'menu', visible: true, capability: 'ver', window: 'siempre', position: 2 },
    { module: 'alojamiento', visible: true, capability: 'elegir', window: 'siempre', params: lodgingParams, position: 3 },
    { module: 'materiales', visible: true, capability: 'ver', window: 'siempre', position: 4 },
    { module: 'preguntas', visible: true, capability: 'responder', window: 'antes', position: 5 },
  ],
  organizer_message: { text: '¡Bienvenidas! Traed esterilla.' },
});

test('guests · sin configuración del organizador: como la fase 1, sin barra inferior @smoke', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro sencillo' });
  const ana = await api.guest(event, { first_name: 'Ana' });
  await simulateOrganizers(page, {});
  await enter(page, await api.guestLink(reservation, ana, 'Ana'));
  await expect(page.locator('#guestNav')).toHaveCount(0);
  await expect(page.locator('#task-data')).toBeVisible();
  await page.goto(`${page.url().split('#')[0]}#/p/${ana}/programa`);
  await expect(page.locator('#retreatTitle')).toBeVisible(); // módulo inactivo: vuelve a Inicio
});

test('guests · durante el retiro: «Hoy», programa (Booking), menú (Food), mi habitación y materiales sin conexión', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro en marcha', start: day(0), end: day(2) });
  const leo = await api.guest(event, { first_name: 'Leo' });
  // Reloj fijo a mediodía de Madrid (10:00 UTC = 12:00 en verano, 11:00 en invierno): la prueba no depende de la hora.
  await page.clock.setFixedTime(new Date(`${day(0)}T10:00:00Z`));
  const item = (id: string, d: string, starts_at: string, ends_at: string | null, title: string, place_text: string | null, public_note: string | null = null) =>
    api.organizerInvoke(reservation, 'booking.portal_program_save', { item: { id, day: d, starts_at, ends_at, title, place_text, public_note, internal_note: 'nota interna', kind: 'actividad' } });
  await item(crypto.randomUUID(), day(0), '10:00', '13:30', 'Yoga suave', 'Sala grande');
  await item(crypto.randomUUID(), day(0), '17:00', null, 'Paseo al pinar', 'Pinar', 'Calzado cómodo');
  await item(crypto.randomUUID(), day(1), '10:00', '12:00', 'Taller de respiración', null);
  await api.menu(event, [
    { date: day(0), type: 'cena', time: '21:00', dishes: [{ name: 'Crema de calabaza', diet: ['vegano'] }, { name: 'Tarta de queso', allergens: ['lacteos', 'gluten'] }] },
    { date: day(1), type: 'desayuno', time: '08:30', dishes: [{ name: 'Fruta y tostadas' }] },
  ]);
  const room = await api.room(event, { name: 'Habitación 3', enSuite: false, beds: ['Cama 1', 'Cama 2'] });
  await api.assign(event, room.spaceId, room.bedIds[1]!, leo);
  await simulateOrganizers(page, {
    'organizers.guest_experience_for': { ...EXPERIENCE(), items: EXPERIENCE().items.map((m) => (m.module === 'alojamiento' ? { ...m, capability: 'ver' } : m)) },
    'organizers.guest_materials': { items: [
      { id: 'm1', kind: 'archivo', title: 'Programa en PDF', description: 'Para imprimir', window: 'siempre', file_id: '00000000-0000-4000-8000-000000000001', mime: 'application/pdf', size: 15 },
      { id: 'm2', kind: 'enlace', title: 'Grupo de WhatsApp', description: null, window: 'siempre', url: 'https://chat.whatsapp.com/ejemplo' },
      { id: 'm3', kind: 'texto', title: 'Para después', description: null, window: 'despues', body: 'Gracias' },
    ] },
    'organizers.guest_questions': { items: [] },
  });
  const opened = await simulateMaterialFiles(page);
  await enter(page, await api.guestLink(reservation, leo, 'Leo'));

  await expect(page.locator('#organizerMessage')).toContainText('Traed esterilla');
  await expect(page.locator('#guestNav a')).toHaveText(['Inicio', 'Programa', 'Menú', 'Alojamiento', 'Más']);
  await expect(page.locator('#todayNow')).toContainText('Yoga suave');
  await expect(page.locator('#todayNext')).toContainText('Paseo al pinar');
  await expect(page.locator('#todayMeal')).toContainText('Crema de calabaza');

  await page.locator('#nav-program').click();
  await expect(page.locator('#programList')).toContainText('Yoga suave');
  await expect(page.locator('#programList')).not.toContainText('nota interna');
  await page.locator('#programDays button').nth(1).click();
  await expect(page.locator('#programList')).toContainText('Taller de respiración');

  await page.locator('#nav-menu').click();
  await expect(page.locator('#menuList')).toContainText('Tarta de queso');
  await expect(page.locator('#menuList')).toContainText('Alérgenos declarados por cocina: lácteos, gluten.');
  await expect(page.locator('#menuList')).toContainText('Vegana');
  await expect(page.locator('#menuProvisional')).toHaveCount(0); // Guests solo ve menús validados

  await page.locator('#nav-lodging').click();
  await expect(page.locator('#lodgingMine')).toContainText('Habitación 3');
  await expect(page.locator('#lodgingMine')).toContainText('Cama 2');
  await expect(page.locator('#lodgingRooms')).toHaveCount(0);

  await page.locator('#nav-more').click();
  await page.locator('#more-materials').click();
  await expect(page.locator('#materialsList')).toContainText('Grupo de WhatsApp');
  await expect(page.locator('#materialsList')).not.toContainText('Para después'); // ventana «después»
  await page.locator('#materialsList button[data-file]').click();
  await expect(page.locator('#materialsList button[data-file]')).toHaveText('Guardado en este dispositivo');
  expect(opened.length).toBe(1);
});

test('guests · preguntas del organizador (forma de Organizers): pendiente en Inicio, sin «Guardar» y con aviso', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro con preguntas' });
  const eva = await api.guest(event, { first_name: 'Eva' });
  const answers: any[] = [];
  await simulateOrganizers(page, {
    'organizers.guest_experience_for': { revision: 1, items: [{ module: 'preguntas', visible: true, capability: 'responder', window: 'antes', position: 1 }] },
    'organizers.guest_questions': { items: [
      { id: 'q1', kind: 'texto', prompt: '¿Qué esperas del retiro?', required: true, value: null },
      { id: 'q2', kind: 'si_no', prompt: '¿Vienes en coche?', help: 'Para organizar el aparcamiento', required: false },
      { id: 'q3', kind: 'opcion', prompt: 'Taller del sábado', options: ['Cerámica', 'Dibujo'], required: false, open: false, value: 'Cerámica' },
    ] },
    'organizers.guest_answer': (body: any) => { answers.push(body); return { body: { revision: answers.length } }; },
  });
  await enter(page, await api.guestLink(reservation, eva, 'Eva'));
  await expect(page.locator('#task-questions')).toContainText('1 pregunta');
  await expect(page.locator('#guestNav a')).toHaveText(['Inicio', 'Más']);

  await page.locator('#task-questions').click();
  await expect(page.locator('#questionsNotice')).toHaveText(' Tu organizador verá tus respuestas.');
  await page.locator('#q-q1').fill('Descansar y aprender a respirar');
  await page.locator('[data-question="q2"] input[value="true"]').check();
  await expect.poll(() => answers.length).toBeGreaterThanOrEqual(2);
  expect(answers).toEqual(expect.arrayContaining([
    { guest_id: eva, question_id: 'q1', value: 'Descansar y aprender a respirar' },
    { guest_id: eva, question_id: 'q2', value: true },
  ]));
  await expect(page.locator('[data-question="q3"] input[value="Cerámica"]')).toBeChecked();
  await expect(page.locator('[data-question="q3"] input[value="Cerámica"]')).toBeDisabled();
  await expect(page.locator('[data-question="q3"]')).toContainText('Ya no se pueden cambiar');
});

test('guests · elegir habitación (Booking real): atómica, sin nombres ajenos; si otra persona la coge antes, se dice', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro con habitaciones' });
  const iris = await api.guest(event, { first_name: 'Iris' });
  const otra = await api.guest(event, { first_name: 'Otra', last_name_1: 'Persona' });
  const room = await api.room(event, { name: 'Habitación Olivo', enSuite: true, beds: ['Cama 1', 'Cama 2'] });
  await api.organizerInvoke(reservation, 'booking.portal_room_settings', { choice: 'choose', choose_until: day(10), rooms: [{ space_id: room.spaceId, option_key: 'bano', supplement: true }] });
  await simulateOrganizers(page, { 'organizers.guest_experience_for': EXPERIENCE({ guest_price_text: '+40 € por persona, a pagar a tu organizador' }) });
  await enter(page, await api.guestLink(reservation, iris, 'Iris'));
  await expect(page.locator('#task-room')).toContainText('Hasta el');
  await page.locator('#nav-lodging').click();
  await expect(page.locator('[data-option="bano"]')).toContainText('+40 € por persona, a pagar a tu organizador');
  await expect(page.locator('#lodgingRooms')).toContainText('Con baño');
  await expect(page.locator('#lodgingRooms')).toContainText('2 de 2 camas libres');

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
  await page.locator('#nav-home').click();
  await expect(page.locator('#task-room')).toContainText('Elegida');
});

test('guests · información: el lugar de Central (dirección, mapa y plano en PDF por portal-files)', async ({ page }) => {
  await api.place({ venue: 'Camino del Pinar 3, Segovia', plan: 'application/pdf' });
  const { id: reservation, event } = await api.reservation({ title: 'Retiro con plano' });
  const zoe = await api.guest(event, { first_name: 'Zoe' });
  await simulateOrganizers(page, {});
  await enter(page, await api.guestLink(reservation, zoe, 'Zoe'));
  await page.locator('#openInfo').click();
  await expect(page.locator('#infoAddress')).toContainText('Camino del Pinar 3, Segovia');
  await expect(page.locator('#infoPlace')).not.toContainText('Calle Fiscal'); // nunca el domicilio fiscal
  await expect(page.locator('#infoMap')).toHaveAttribute('href', /google\.com\/maps\/search/);
  await expect(page.locator('#infoPlan')).toHaveText('Ver el plano del centro (PDF)');
  const signed = page.waitForResponse((r) => /\/api\/v1\/portal-files\//.test(r.url()));
  await page.locator('#infoPlan').click();
  expect((await signed).status()).toBe(200);
});

test('guests · vista previa del organizador (huésped de muestra): franja visible y nada se guarda', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro en vista previa' });
  const muestra = await api.guest(event, { first_name: 'Huésped de muestra' });
  await simulateOrganizers(page, { 'organizers.guest_experience_for': EXPERIENCE() });
  // Enlace real de vista previa (contrato §3.6, O6): la entrada de ámbito llega marcada `preview` y el kit rechaza escrituras.
  await page.goto(`${baseURL}/i/${await api.guestLink(reservation, muestra, 'Muestra', undefined, true)}`);
  await expect(page.locator('#previewBand')).toBeVisible();
  await page.locator('#privacyOk').click();
  await expect(page.locator('#retreatTitle')).toBeVisible();
  expect((await api.row(muestra)).privacy_ack_version).toBeNull();
  await page.locator('#nav-more').click();
  await page.locator('#more-data').click();
  await page.locator('#f-last_name_1').fill('Prueba');
  await page.locator('#f-first_name').focus();
  await expect(page.getByText('Es una vista previa: no se guarda nada.').first()).toBeVisible();
  expect((await api.row(muestra)).last_name_1).toBeNull();
});
