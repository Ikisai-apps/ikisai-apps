/**
 * Guests · recorrido de aceptación en móvil (API.md §11) contra la guests-api y la booking-api reales sobre PGlite
 * (server.ts): entrada por enlace, aviso de protección de datos, Inicio, Mis datos con procedencia y autoguardado,
 * alimentación con consentimiento, firma (propia y de acompañante), modo operativo en inglés, sin red, conflicto con el
 * organizador, varias entradas en una cuenta y ayuda.
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../food/helpers.ts';
import { startGuestsServer, type GuestsTestServer } from './server.ts';
import { buildGuestsApp } from './build.ts';
import { simulateKeyboard } from '../../packages/ui-kit/testing/feedback-smoke.ts';

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

/** El PUT firmado va al Supabase simulado (otro origen): se intercepta y el objeto se deja en su almacén. */
async function routeStorage(page: Page): Promise<void> {
  await page.route('https://test.supabase.co/storage/v1/object/upload/sign/**', async (route) => {
    const url = new URL(route.request().url());
    const objectPath = decodeURIComponent(url.pathname.slice('/storage/v1/object/upload/sign/'.length)).split('/').slice(1).join('/');
    if (route.request().method() === 'PUT') api.booking.supabase.storage.set(objectPath, new Uint8Array(route.request().postDataBuffer() ?? Buffer.alloc(0)));
    await route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'PUT', 'Access-Control-Allow-Headers': '*' }, body: '{}' });
  });
}

async function enter(page: Page, token: string): Promise<void> {
  await routeStorage(page);
  await page.goto(`${baseURL}/i/${token}`);
  await expect(page).not.toHaveURL(/\/i\//);
  expect(page.url()).not.toContain(token);
}

async function acceptPrivacy(page: Page): Promise<void> {
  await expect(page.locator('#privacy')).toBeVisible();
  await page.locator('#privacyOk').click();
}

/** Pregunta a pregunta del kit (tanda 31, MUELA-018): responde la pregunta que se ve (texto con Intro u opción). */
async function answer(page: Page, question: string | RegExp, value: string, kind: 'text' | 'choice' = 'text'): Promise<void> {
  await expect(page.locator('.ask-question')).toHaveText(question);
  if (kind === 'choice') await page.locator('.ask-choice', { hasText: value }).click();
  else { await page.locator('.ask-input').fill(value); await page.locator('.ask-input').press('Enter'); }
}

/** Firma con el ratón dentro del recuadro. */
async function draw(page: Page): Promise<void> {
  await page.locator('#signaturePad').scrollIntoViewIfNeeded();
  const box = (await page.locator('#signaturePad').boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 30 + i * 18, box.y + box.height / 2 + (i % 2 ? -25 : 25));
  await page.mouse.up();
}

test('guests · enlace no válido: pantalla clara, sin sesión @smoke', async ({ page }) => {
  await page.goto(`${baseURL}/i/${'A'.repeat(43)}`);
  await expect(page.locator('#entryTitle')).toHaveText('Este enlace no funciona');
  await expect(page.locator('#entryContact')).toContainText('ven@ikisai.com'); // correo de los huéspedes, nunca organiza@
  await expect(page).not.toHaveURL(/\/i\//);
  await page.goto(`${baseURL}/`);
  await expect(page.locator('#entryTitle')).toHaveText('Entra con tu enlace');
});

test('guests · recorrido completo: aviso, procedencia, autoguardado, alimentación y firma @smoke', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro de primavera', arrival: '17:00' });
  const ana = await api.guest(event, { first_name: 'Ana' });
  await api.organizerWrites(reservation, ana, { last_name_1: 'Sintetica' });
  await enter(page, await api.guestLink(reservation, ana, 'Ana'));

  // Lo primero, el aviso de protección de datos; después, Inicio con lo que falta.
  await acceptPrivacy(page);
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro de primavera');
  await expect(page.locator('#retreatTimes')).toContainText('17:00');
  await expect(page.locator('#task-data')).toContainText('Faltan');
  await expect(page.locator('#task-sign')).toContainText('Primero completa tus datos');
  await expect.poll(async () => (await api.row(ana)).privacy_ack_version).toBe('reserva-1');

  // Tanda 31 (MUELA-018): Tus datos, pregunta a pregunta y solo lo que falta (el apellido que puso el organizador se salta).
  await page.locator('#task-data').click();
  await expect(page.locator('#fillLeft')).toContainText('Te faltan:');
  await answer(page, 'Fecha de nacimiento', '1990-05-01');
  await answer(page, 'Tipo de documento', 'Pasaporte', 'choice');
  await answer(page, 'Número de documento', 'xa 123456');
  await answer(page, /Dirección/, 'Calle Falsa 1');
  await answer(page, 'Código postal', '40001');
  await answer(page, /Ciudad/, 'Segovia');
  await answer(page, 'País', 'España');
  // Teléfono o correo: basta con uno; con el teléfono en blanco se pregunta el correo.
  await answer(page, 'Teléfono', '');
  await answer(page, /Correo/, 'ana@example.invalid');
  await expect.poll(async () => (await api.row(ana)).document_number).toBe('XA123456');
  expect((await api.row(ana)).residence_country).toBe('ESP');

  // Al acabar, la comida: una alergia grave y, aparte, si la sabe el organizador.
  await expect(page).toHaveURL(new RegExp(`#/p/${ana}/alimentacion$`));
  await page.locator('#dietAdd').click();
  await page.locator('#r-subject').fill('frutos secos');
  await page.locator('#dietForm .ask-choice', { hasText: 'Grave' }).click();
  await page.locator('#dietAddSave').click();
  await expect(page.locator('#dietList')).toContainText('frutos secos');
  await page.locator('#shareAllergies').click();
  await expect.poll(async () => (await api.row(ana)).allergies_visible_to_organizer).toBe(true);
  expect((await api.row(ana)).diet_reviewed_at).not.toBeNull();

  // «Comprueba tus respuestas» y la firma: con la marca del organizador y «Cambiar», que vuelve aquí.
  await page.locator('#nextTask').click();
  await expect(page).toHaveURL(new RegExp(`#/p/${ana}/firma$`));
  await expect(page.locator('#signSummary')).toContainText('XA123456');
  await expect(page.locator('#signSummary dd[data-field="last_name_1"]')).toContainText('Lo indicó tu organizador');
  await page.locator('#signSummary button[data-key="last_name_1"]').click();
  await answer(page, 'Primer apellido', 'Sintética');
  await expect(page).toHaveURL(new RegExp(`#/p/${ana}/firma$`));
  await expect.poll(async () => (await api.row(ana)).field_sources.last_name_1.by).toBe('guest');
  await expect(page.locator('#signerName')).toHaveValue('Ana Sintética');
  await page.locator('#signSubmit').click();
  await expect(page.locator('#signError')).toHaveText('Firma dentro del recuadro.');
  await draw(page);
  await page.locator('#signSubmit').click();
  await expect(page.locator('#signDone')).toBeVisible();
  const signed = await api.row(ana);
  expect(signed.signed_by_name).toBe('Ana Sintética');
  expect(signed.signature_file_id).toBeTruthy();
  await page.locator('#nextTask').click();
  await expect(page.locator('#todo .step-readytitle')).toContainText('¡Todo listo!'); // paso a paso del kit (tanda 31)

  // Cambiar un dato del registro después de firmar invalida la firma (BG5) y se avisa: «Ver todos mis datos» y «Cambiar».
  await page.locator('#task-data').click();
  await page.locator('#allData').click();
  await page.locator('#dataReview button[data-key="residence_city"]').click();
  await answer(page, /Ciudad/, 'Madrid');
  await expect(page.locator('#signatureReset')).toBeVisible();
  await expect.poll(async () => (await api.row(ana)).signed_at).toBeNull();
});

test('guests · modo operativo en inglés: solo nombre y contacto, sin firma @smoke', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-GB', viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    const { id: reservation, event } = await api.reservation({ title: 'Private retreat', ses: false });
    const leo = await api.guest(event, { first_name: 'Leo' });
    await enter(page, await api.guestLink(reservation, leo, 'Leo'));
    await expect(page.locator('#privacyOk')).toHaveText('Got it, continue');
    await page.locator('#privacyOk').click();
    await expect(page.locator('#hello')).toHaveText('Hello, Leo');
    await expect(page.locator('#retreatDates')).toContainText('March');
    await expect(page.locator('#task-sign')).toHaveCount(0);
    // Pregunta a pregunta: sin registro de viajeros solo el contacto (ni documento ni fecha de nacimiento).
    await page.locator('#task-data').click();
    await expect(page.locator('.ask-meta')).toHaveText('Question 1 of 1');
    await answer(page, 'Phone', '600 000 000');
    await expect.poll(async () => (await api.row(leo)).phone).toBe('600 000 000');
    // Al acabar, la comida.
    await expect(page.locator('.pagehead h2')).toHaveText('Food');
    // Cambio de idioma a mano: se recuerda en el dispositivo.
    await page.locator('#language button[data-locale="es"]').click();
    await expect(page.locator('.pagehead h2')).toHaveText('Alimentación');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  } finally {
    await context.close();
  }
});

test('guests · menor de 14: firma quien le acompaña, con su nombre', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro en familia' });
  const nico = await api.guest(event, {
    first_name: 'Nico', last_name_1: 'Sintético', birth_date: '2016-04-02', is_minor: true, guardian_name: 'Marta Sintética', kinship: 'PM',
    residence_address: 'Calle Falsa 1', residence_postal_code: '40001', residence_city: 'Segovia', residence_country: 'ESP', phone: '600000001',
  });
  await enter(page, await api.guestLink(reservation, nico, 'Nico'));
  await acceptPrivacy(page);
  await expect(page.locator('#task-sign')).toContainText('Firma de quien te acompaña');
  await page.locator('#task-sign').click();
  await expect(page.locator('#signWho')).toContainText('menor de 14 años');
  await expect(page.locator('#signerName')).toHaveValue('Marta Sintética');
  await draw(page);
  await page.locator('#signSubmit').click();
  await expect(page.locator('#signDone')).toBeVisible();
  expect((await api.row(nico)).signed_by_name).toBe('Marta Sintética');
});

test('guests · sin red: lo escrito espera y se guarda solo al volver la conexión', async ({ page, context }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro sin cobertura' });
  const rosa = await api.guest(event, { first_name: 'Rosa' });
  await enter(page, await api.guestLink(reservation, rosa, 'Rosa'));
  await acceptPrivacy(page);
  await page.locator('#task-data').click();

  // Sin red, la respuesta se queda en el móvil y la pregunta sigue (tanda 31: pregunta a pregunta).
  await context.setOffline(true);
  await answer(page, 'Primer apellido', 'Sanz');
  await expect(page.locator('#saveState')).toContainText('Sin conexión');
  await expect(page.locator('.ask-question')).toHaveText('Fecha de nacimiento');
  expect((await api.row(rosa)).last_name_1).toBeNull();

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await api.row(rosa)).last_name_1, { timeout: 20_000 }).toBe('Sanz');
  await expect(page.locator('#saveState')).toHaveText('Todo guardado');
});

test('guests · conflicto: el organizador cambia un dato mientras el huésped lo edita y el huésped elige', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro con cambios' });
  const iris = await api.guest(event, { first_name: 'Iris' });
  await enter(page, await api.guestLink(reservation, iris, 'Iris'));
  await acceptPrivacy(page);
  // Desde la lista, el botón del dato que falta abre esa pregunta (tanda 31).
  await page.locator('#task-data').click();
  await page.locator('#back').click();
  await page.locator('#missingLinks button[data-key="phone"]').click();
  await expect(page.locator('.ask-question')).toHaveText('Teléfono');
  await api.organizerWrites(reservation, iris, { phone: '699 000 111' });
  await page.locator('.ask-input').fill('622 333 444');
  await page.locator('.ask-input').press('Enter');
  await expect(page.locator('#conflicts')).toContainText('699 000 111');
  await expect(page.locator('#conflicts')).toContainText('622 333 444');
  await page.getByRole('button', { name: 'Quedarme con el mío' }).click();
  await expect.poll(async () => (await api.row(iris)).phone).toBe('622 333 444');
  expect((await api.row(iris)).field_sources.phone.by).toBe('guest');
});

test('guests · una cuenta con dos personas: la familia junta por defecto, se elige a quién ver y nunca ve a otros huéspedes', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro con hijos' });
  const madre = await api.guest(event, { first_name: 'Marta' });
  const hijo = await api.guest(event, { first_name: 'Nico' });
  await api.guest(event, { first_name: 'Ajena', last_name_1: 'Nadie' });
  await api.guestLink(reservation, hijo, 'Nico', 'marta@example.invalid');
  await enter(page, await api.guestLink(reservation, madre, 'Marta', 'marta@example.invalid'));
  // O4a: «Todos» por defecto; un solo aviso legal para el retiro y lo que falta de cada persona, con su nombre.
  await acceptPrivacy(page);
  await expect(page).toHaveURL(new RegExp(`#/r/${reservation}$`));
  await expect(page.locator('#persons button > span:last-child')).toHaveText(['Todos', 'Marta', 'Nico']); // la cara va delante (tanda 31)
  await expect(page.locator('#persons button[aria-pressed="true"] > span:last-child')).toHaveText('Todos');
  await expect(page.locator('#hello')).toHaveText('Hola, Marta y Nico');
  await expect(page.locator('#todoFamily .gperson')).toHaveCount(2);
  await expect(page.locator('body')).not.toContainText('Ajena');
  await expect.poll(async () => [(await api.row(madre)).privacy_ack_version, (await api.row(hijo)).privacy_ack_version].every(Boolean)).toBe(true);
  // Un toque en «Nico» y solo lo suyo, como antes.
  await page.locator('#persons button', { hasText: 'Nico' }).click();
  await expect(page).toHaveURL(new RegExp(`#/p/${hijo}$`));
  await expect(page.locator('#hello')).toHaveText('Hola, Nico');
  await expect(page.locator('#todo')).toBeVisible();
});

const reportsWith = async (text: string) =>
  (await api.booking.t.db.query<{ subject: string; category: string; scope: any; destination: string }>(`select subject, category, scope, destination from core.feedback_reports where message like $1`, [`%${text}%`])).rows;

/**
 * «Ayuda y sugerencias» (tanda 31, MUELA-054): la hoja nueva con tarjetas. Las mismas garantías que la prueba común del kit:
 * un doble toque en «Enviar» no duplica el aviso, y el aviso de «Enviado» se ve dentro de lo visible (también con el teclado).
 */
async function sendHelp(page: Page, picks: string[], text: string, keyboard?: number): Promise<void> {
  const sheet = page.locator('#helpSheet');
  await expect(sheet).toBeVisible();
  for (const pick of picks) await sheet.locator(pick).click();
  await page.locator('#helpText').fill(text);
  if (keyboard) await simulateKeyboard(page, keyboard);
  await page.locator('#helpSend').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter').catch(() => undefined);
  const toast = page.locator('.toast.show').filter({ hasText: /Enviado|Sent|Sin conexión|Offline/ });
  await expect(toast).toBeVisible();
  const fit = await toast.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const vv = window.visualViewport;
    const top = vv ? vv.offsetTop : 0;
    const bottom = vv ? vv.offsetTop + vv.height : innerHeight;
    return r.top >= top && r.bottom <= bottom && r.left >= 0 && r.right <= innerWidth;
  });
  expect(fit, 'el aviso tiene que verse dentro de lo visible').toBe(true);
  if (keyboard) await simulateKeyboard(page, null);
}

test('guests · «Ayuda y sugerencias»: «Tu retiro» con doble toque, un solo reporte para el organizador y se ve en lo enviado @smoke', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro con comentario' });
  const eva = await api.guest(event, { first_name: 'Eva' });
  await enter(page, await api.guestLink(reservation, eva, 'Eva'));
  await acceptPrivacy(page);
  await page.locator('#openHelp').click();
  // Orden de VG: Tu retiro · Un sitio · La app; arriba, siempre el teléfono.
  await expect(page.locator('#helpSheet > .ghelp-block h3')).toHaveText([/Tu retiro/, /Un sitio/, /La app/]);
  await expect(page.locator('#helpCall')).toHaveAttribute('href', /^tel:/);
  await sendHelp(page, ['#blockEvent [data-value="schedule"]'], 'La cena empieza muy tarde');
  await expect(page.locator('#helpWho')).toHaveCount(0); // vuelve al estado de partida
  const stored = await reportsWith('cena empieza');
  expect(stored).toHaveLength(1); // `id` y `requestId` estables: el doble toque no duplica
  expect(stored[0]).toMatchObject({ subject: 'event', category: 'schedule', destination: 'organizer' });
  expect(stored[0]!.scope).toMatchObject({ reservation_id: reservation, guest_id: eva });
  await expect(page.locator('#helpMine')).toContainText('La cena empieza muy tarde');
  await expect(page.locator('#helpMine')).toContainText('Recibido');
});

test('guests · «Ayuda y sugerencias» con el teclado abierto en el móvil: un sitio, lo urgente con «Llama ya», y el aviso se ve @smoke', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro con teclado' });
  const leo = await api.guest(event, { first_name: 'Leo' });
  await enter(page, await api.guestLink(reservation, leo, 'Leo'));
  await acceptPrivacy(page);
  await page.locator('#openHelp').click();
  // Con retiro, «Mi habitación» ya elegida; aquí, los baños y «Agua o luz», que es urgente.
  await expect(page.locator('#blockSpace [data-value="habitacion"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#blockSpace [data-value="banos"]').click();
  await page.locator('#blockSpace [data-value="utilities"]').click();
  await expect(page.locator('#helpUrgentKind')).toContainText('Si hay peligro, llama ya.');
  await expect(page.locator('#helpWho')).toContainText('el equipo de Ikisai');
  await sendHelp(page, [], 'No sale agua caliente', 686);
  const stored = await reportsWith('agua caliente');
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ subject: 'space', category: 'utilities', destination: 'operations' });
});

// Último: siembra los textos de Central para el resto del archivo (los anteriores usan los textos de reserva).
test('guests · textos de Central: aviso en inglés con su versión, vale en los dos idiomas, e información práctica', async ({ browser }) => {
  await api.seedCentralTexts();
  const context = await browser.newContext({ locale: 'en-GB', viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    const { id: reservation, event } = await api.reservation({ title: 'Retreat with texts' });
    const zoe = await api.guest(event, { first_name: 'Zoe' });
    await enter(page, await api.guestLink(reservation, zoe, 'Zoe'));
    await expect(page.locator('#privacy h2')).toHaveText('Data protection');
    await expect(page.locator('#privacyText strong').first()).toHaveText('Data protection information');
    await page.locator('#privacyOk').click();
    // La versión vigente del aviso en inglés (Central la sube al cambiar el texto; la semilla de contactos lo cambia).
    await expect.poll(async () => (await api.row(zoe)).privacy_ack_version).toMatch(/^en-v\d+$/);
    // En español no vuelve a pedirlo: la aceptación vale para las dos versiones vigentes.
    await page.locator('#language button[data-locale="es"]').click();
    await expect(page.locator('#hello')).toHaveText('Hola, Zoe');
    await page.locator('#openInfo').click();
    await expect(page.locator('#infoSections details[data-key="info.arrival"] summary')).toHaveText('Llegada y salida');
    await expect(page.locator('#infoSections')).toContainText('Qué traer');
    await expect(page.locator('#infoContact')).toContainText('614 76 57 96');
    await expect(page.locator('#infoContact')).toContainText('ven@ikisai.com');
    await expect(page.locator('#infoContact')).not.toContainText('organiza@');
  } finally {
    await context.close();
  }
});
