/**
 * Guests · fases 4 y 5 (API.md §13) con **lecturas simuladas**: lo que aún no publican Organizers, Booking y Food
 * (experiencia, programa, menú, materiales, preguntas, alojamiento y `portal-files`) se intercepta en el navegador con
 * la forma acordada; lo demás (enlace, ficha, aviso legal) va contra la guests-api y la booking-api reales sobre PGlite.
 * Cuando cada app publique su pieza, la prueba de esa pieza pasa a ir contra la API real.
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

interface Calls { [name: string]: unknown[] }

/** Simula las lecturas y acciones de las fases 4 y 5 con las respuestas dadas; registra lo que la app envía. */
async function simulate(page: Page, replies: Record<string, unknown | ((body: any) => { status?: number; body: unknown })>): Promise<Calls> {
  const calls: Calls = {};
  await page.route(/\/api\/v1\/(read|invoke)\/(organizers\.[a-z_]+|booking\.portal_(program|lodging|choose_bed|release_bed|room_preference)|food\.portal_menu)$/, async (route: Route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop()!;
    const body = route.request().postDataJSON() ?? {};
    (calls[name] ??= []).push(body);
    const reply = replies[name];
    if (reply === undefined) return route.fulfill({ status: 403, json: { error: { code: 'READ_NOT_ALLOWED', message: 'no', details: null } } });
    const out = typeof reply === 'function' ? (reply as (b: any) => { status?: number; body: unknown })(body) : { body: reply };
    await route.fulfill({ status: out.status ?? 200, json: out.body });
  });
  await page.route(/\/api\/v1\/portal-files\/[^/]+$/, async (route) => {
    (calls['portal-files'] ??= []).push(route.request().url());
    await route.fulfill({ json: { url: 'https://files.test/programa.pdf', expiresAt: new Date(Date.now() + 300_000).toISOString(), name: 'programa.pdf', mime: 'application/pdf' } });
  });
  await page.route('https://files.test/**', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'application/pdf', 'Access-Control-Allow-Origin': '*' }, body: Buffer.from('%PDF-1.4 prueba') }));
  return calls;
}

async function enter(page: Page, token: string): Promise<void> {
  await page.goto(`${baseURL}/i/${token}`);
  await expect(page).not.toHaveURL(/\/i\//);
  await page.locator('#privacyOk').click();
  await expect(page.locator('#retreatTitle')).toBeVisible();
}

const EXPERIENCE = (lodging: Record<string, unknown> = { visible: true, capability: 'view' }) => ({
  revision: 1,
  modules: { program: { visible: true }, menu: { visible: true }, materials: { visible: true }, questions: { visible: true }, lodging, map: { visible: false } },
  organizer_message: { text: '¡Bienvenidas! Traed esterilla.' },
});

test('guests · sin configuración del organizador: como la fase 1, sin barra inferior @smoke', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro sencillo' });
  const ana = await api.guest(event, { first_name: 'Ana' });
  await simulate(page, {});
  await enter(page, await api.guestLink(reservation, ana, 'Ana'));
  await expect(page.locator('#guestNav')).toHaveCount(0);
  await expect(page.locator('#task-data')).toBeVisible();
  await page.goto(`${page.url().split('#')[0]}#/p/${ana}/programa`);
  await expect(page.locator('#retreatTitle')).toBeVisible(); // módulo inactivo: vuelve a Inicio
});

test('guests · durante el retiro: barra, «Hoy», programa, menú sin promesas, materiales sin conexión y mensaje del organizador', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro en marcha', start: day(0), end: day(2) });
  const leo = await api.guest(event, { first_name: 'Leo' });
  // Reloj fijo a mediodía de Madrid (10:00 UTC = 12:00 en verano, 11:00 en invierno): la prueba no depende de la hora.
  await page.clock.setFixedTime(new Date(`${day(0)}T10:00:00Z`));
  const calls = await simulate(page, {
    'organizers.guest_experience_for': EXPERIENCE(),
    'booking.portal_program': { revision: 1, items: [
      { id: 'p1', day: day(0), starts_at: '10:00', ends_at: '13:30', title: 'Yoga suave', place: 'Sala grande', public_note: null, kind: 'actividad' },
      { id: 'p2', day: day(0), starts_at: '17:00', ends_at: null, title: 'Paseo al pinar', place: 'Pinar', public_note: 'Calzado cómodo', kind: 'actividad' },
      { id: 'p3', day: day(1), starts_at: '10:00', ends_at: '12:00', title: 'Taller de respiración', place: null, public_note: null, kind: 'actividad' },
    ] },
    'food.portal_menu': { status: 'provisional', services: [
      { date: day(0), type: 'cena', time: '21:00', dishes: [{ name: 'Crema de calabaza' }, { name: 'Tortilla de patatas' }] },
      { date: day(1), type: 'desayuno', time: '08:30', dishes: [{ name: 'Fruta y tostadas' }] },
    ] },
    'organizers.guest_materials': { items: [
      { id: 'm1', kind: 'file', title: 'Programa en PDF', description: 'Para imprimir', window: 'always', file: { id: '00000000-0000-4000-8000-000000000001', name: 'programa.pdf', mime: 'application/pdf', size: 15 } },
      { id: 'm2', kind: 'link', title: 'Grupo de WhatsApp', description: null, window: 'always', url: 'https://chat.whatsapp.com/ejemplo' },
      { id: 'm3', kind: 'text', title: 'Para después', description: null, window: 'after', body: 'Gracias' },
    ] },
    'organizers.guest_questions': { items: [] },
    'booking.portal_lodging': { mine: { space_name: 'Habitación 3', zone: 'Posada', bed_label: 'Cama 2', status: 'confirmed' }, preference: null, rooms: [] },
  });
  await enter(page, await api.guestLink(reservation, leo, 'Leo'));

  await expect(page.locator('#organizerMessage')).toContainText('Traed esterilla');
  await expect(page.locator('#guestNav a')).toHaveText(['Inicio', 'Programa', 'Menú', 'Alojamiento', 'Más']);
  await expect(page.locator('#todayNow')).toContainText('Yoga suave');
  await expect(page.locator('#todayNext')).toContainText('Paseo al pinar');
  await expect(page.locator('#todayMeal')).toContainText('Crema de calabaza');

  await page.locator('#nav-program').click();
  await expect(page.locator('#programList')).toContainText('Yoga suave');
  await expect(page.locator('#programList')).not.toContainText('Taller de respiración');
  await page.locator('#programDays button').nth(1).click();
  await expect(page.locator('#programList')).toContainText('Taller de respiración');

  await page.locator('#nav-menu').click();
  await expect(page.locator('#menuProvisional')).toHaveText('Provisional');
  await expect(page.locator('#menuList')).toContainText('Tortilla de patatas');
  await expect(page.locator('#menuNotice')).toContainText('alergias');

  await page.locator('#nav-lodging').click();
  await expect(page.locator('#lodgingMine')).toContainText('Habitación 3');
  await expect(page.locator('#lodgingRooms')).toHaveCount(0);

  await page.locator('#nav-more').click();
  await page.locator('#more-materials').click();
  await expect(page.locator('#materialsList')).toContainText('Grupo de WhatsApp');
  await expect(page.locator('#materialsList')).not.toContainText('Para después'); // ventana «después»
  await page.locator('#materialsList button[data-file]').click();
  await expect(page.locator('#materialsList button[data-file]')).toHaveText('Guardado en este dispositivo');
  expect(calls['portal-files']?.length).toBe(1);
  expect(calls['booking.portal_program']?.[0]).toEqual({ reservation_id: reservation });
});

test('guests · preguntas del organizador: pendiente en Inicio, se responden sin «Guardar» y avisa de quién las ve', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro con preguntas' });
  const eva = await api.guest(event, { first_name: 'Eva' });
  const answers: any[] = [];
  await simulate(page, {
    'organizers.guest_experience_for': { revision: 1, modules: { questions: { visible: true } } },
    'organizers.guest_questions': { items: [
      { id: 'q1', type: 'text', label: '¿Qué esperas del retiro?', help: null, options: [], required: true, open: true, answer: null },
      { id: 'q2', type: 'yes_no', label: '¿Vienes en coche?', help: 'Para organizar el aparcamiento', options: [], required: false, open: true, answer: null },
      { id: 'q3', type: 'choice', label: 'Taller del sábado', help: null, options: [{ value: 'a', label: 'Cerámica' }, { value: 'b', label: 'Dibujo' }], required: false, open: false, answer: { value: 'a' } },
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
  await expect(page.locator('[data-question="q3"] input[value="a"]')).toBeDisabled();
  await expect(page.locator('[data-question="q3"]')).toContainText('Ya no se pueden cambiar');
});

test('guests · elegir habitación: atómica, sin nombres ajenos; si otra persona la coge antes, se dice y se recarga', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro con habitaciones' });
  const iris = await api.guest(event, { first_name: 'Iris' });
  let mine: unknown = null;
  let freeA = true;
  const room = () => ({ space_id: 's1', name: 'Habitación Olivo', zone: 'Posada', en_suite: true, beds_total: 2, beds_free: (freeA ? 1 : 0) + (mine ? 0 : 1), option_key: 'bano',
    beds: [{ bed_id: 'b1', label: 'Cama 1', kind: 'individual', free: freeA }, { bed_id: 'b2', label: 'Cama 2', kind: 'individual', free: !mine }] });
  const calls = await simulate(page, {
    'organizers.guest_experience_for': EXPERIENCE({ visible: true, capability: 'choose', choose_until: day(10),
      options: [{ key: 'bano', label: 'Habitación con baño (2 plazas)', guest_note: '+40 € por persona, a pagar a tu organizador' }] }),
    'booking.portal_lodging': () => ({ body: { mine, preference: null, rooms: [room()] } }),
    'booking.portal_choose_bed': (body: any) => {
      if (body.bed_id === 'b1') { freeA = false; return { status: 409, body: { error: { code: 'BED_TAKEN', message: 'ocupada', details: {} } } }; }
      mine = { space_name: 'Habitación Olivo', zone: 'Posada', bed_label: 'Cama 2', status: 'confirmed' };
      return { body: { revision: 2, status: 'confirmed' } };
    },
  });
  await enter(page, await api.guestLink(reservation, iris, 'Iris'));
  await expect(page.locator('#task-room')).toContainText('Hasta el');
  await page.locator('#nav-lodging').click();
  await expect(page.locator('[data-option="bano"]')).toContainText('+40 € por persona, a pagar a tu organizador');
  await expect(page.locator('#lodgingRooms')).toContainText('Con baño');

  await page.locator('button[data-bed="b1"]').click();
  await page.getByRole('button', { name: 'Elegir esta cama' }).click();
  await expect(page.getByText('Alguien acaba de elegir esa cama')).toBeVisible();
  await expect(page.locator('button[data-bed="b1"]')).toBeDisabled();

  await page.locator('button[data-bed="b2"]').click();
  await page.getByRole('button', { name: 'Elegir esta cama' }).click();
  await expect(page.locator('#lodgingMine')).toContainText('Cama 2');
  expect(calls['booking.portal_choose_bed']).toEqual([{ guest_id: iris, bed_id: 'b1' }, { guest_id: iris, bed_id: 'b2' }]);
  await page.locator('#nav-home').click();
  await expect(page.locator('#task-room')).toContainText('Elegida');
});

test('guests · vista previa del organizador (huésped de muestra): franja visible y nada se guarda', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro en vista previa' });
  const muestra = await api.guest(event, { first_name: 'Huésped de muestra' });
  await simulate(page, { 'organizers.guest_experience_for': EXPERIENCE() });
  // BG11 aún no existe: la ficha real se completa con `preview: true`.
  await page.route('**/api/v1/read/booking.portal_my_guest', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), preview: true } });
  });
  await enter(page, await api.guestLink(reservation, muestra, 'Muestra'));
  await expect(page.locator('#previewBand')).toBeVisible();
  await page.locator('#nav-more').click();
  await page.locator('#more-data').click();
  await page.locator('#f-last_name_1').fill('Prueba');
  await page.locator('#f-first_name').focus();
  await expect(page.getByText('Es una vista previa: no se guarda nada.').first()).toBeVisible();
  expect((await api.row(muestra)).last_name_1).toBeNull();
});
