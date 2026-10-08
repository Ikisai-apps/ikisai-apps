/**
 * Guests · recorrido de aceptación en móvil (API.md §11) contra la guests-api y la booking-api reales sobre PGlite
 * (server.ts): entrada por enlace, aviso de protección de datos, Inicio, Mis datos con procedencia y autoguardado,
 * alimentación con consentimiento, firma (propia y de acompañante), modo operativo en inglés, sin red, conflicto con el
 * organizador, varias entradas en una cuenta y ayuda.
 */
import { expect, test, type Page } from 'playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../food/helpers.ts';
import { startGuestsServer, type GuestsTestServer } from './server.ts';
import { portalHelpRoundTrip } from '../../packages/ui-kit/testing/feedback-smoke.ts';

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

async function openGroup(page: Page, group: string): Promise<void> {
  await page.locator(`details[data-group="${group}"]`).evaluate((node) => { (node as HTMLDetailsElement).open = true; });
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

  // Mis datos: la marca del organizador; al corregirlo pasa a ser suyo, sin botón «Guardar».
  await page.locator('#task-data').click();
  await expect(page.locator('#src-last_name_1')).toHaveText('Lo indicó tu organizador');
  await page.locator('#f-last_name_1').fill('Sintética');
  await expect(page.locator('#s-last_name_1')).toHaveText('Guardado ✓');
  await expect(page.locator('#src-last_name_1')).toHaveText('');
  expect((await api.row(ana)).field_sources.last_name_1.by).toBe('guest');

  await page.locator('#f-birth_date').fill('1990-05-01');
  await page.locator('#f-nationality').selectOption('ESP');
  await openGroup(page, 'document');
  await page.locator('#f-document_type').selectOption('Pasaporte');
  await page.locator('#f-document_number').fill('xa 123456');
  await openGroup(page, 'residence');
  await page.locator('#f-residence_address').fill('Calle Falsa 1');
  await page.locator('#f-residence_postal_code').fill('40001');
  await page.locator('#f-residence_city').fill('Segovia');
  await page.locator('#f-residence_country').selectOption('ESP');
  await openGroup(page, 'contact');
  await page.locator('#f-email').fill('ana@example.invalid');
  await page.locator('#f-phone').focus();
  await expect(page.locator('#saveState')).toHaveText('Todo guardado');
  await expect.poll(async () => (await api.row(ana)).document_number).toBe('XA123456');

  // Inicio: datos completos; la firma ya se puede hacer.
  await page.locator('#back').click();
  await expect(page.locator('#task-data')).toContainText('Completos');
  await expect(page.locator('#task-sign')).toContainText('Pendiente');

  // Alimentación: una alergia grave y el interruptor para compartirla.
  await page.locator('#task-diet').click();
  await page.locator('#dietAdd').click();
  await page.locator('#r-type').selectOption('alergia');
  await page.locator('#r-subject').fill('frutos secos');
  await page.locator('#r-severity').selectOption('grave');
  await page.locator('#dietAddSave').click();
  await expect(page.locator('#dietList')).toContainText('frutos secos');
  await page.locator('#shareAllergies').check();
  await expect.poll(async () => (await api.row(ana)).allergies_visible_to_organizer).toBe(true);
  expect((await api.row(ana)).diet_reviewed_at).not.toBeNull();

  // Firma: resumen, firma con el dedo y «Firmado».
  await page.locator('#back').click();
  await expect(page.locator('#task-diet')).toContainText('Revisada');
  await page.locator('#task-sign').click();
  await expect(page.locator('#signSummary')).toContainText('XA123456');
  await expect(page.locator('#signerName')).toHaveValue('Ana Sintética');
  await page.locator('#signSubmit').click();
  await expect(page.locator('#signError')).toHaveText('Firma dentro del recuadro.');
  await draw(page);
  await page.locator('#signSubmit').click();
  await expect(page.locator('#signDone')).toBeVisible();
  const signed = await api.row(ana);
  expect(signed.signed_by_name).toBe('Ana Sintética');
  expect(signed.signature_file_id).toBeTruthy();
  await page.locator('#back').click();
  await expect(page.locator('#todo h3')).toHaveText('¡Todo listo!');

  // Cambiar un dato del registro después de firmar invalida la firma (BG5) y se avisa.
  await page.locator('#task-data').click();
  await openGroup(page, 'residence');
  await page.locator('#f-residence_city').fill('Madrid');
  await page.locator('#f-residence_postal_code').focus();
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
    await page.locator('#task-data').click();
    await expect(page.locator('#f-document_number')).toHaveCount(0);
    await expect(page.locator('#f-birth_date')).toHaveCount(0);
    await page.locator('#f-phone').fill('600 000 000');
    await page.locator('#f-email').focus();
    await expect(page.locator('#s-phone')).toHaveText('Saved ✓');
    // Cambio de idioma a mano: se recuerda en el dispositivo.
    await page.locator('#language button[data-locale="es"]').click();
    await expect(page.locator('.pagehead h2')).toHaveText('Mis datos');
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
  await openGroup(page, 'contact');

  await context.setOffline(true);
  await page.locator('#f-phone').fill('611 222 333');
  await page.locator('#f-email').focus();
  await expect(page.locator('#s-phone')).toHaveText('Se guardará al volver la conexión');
  await expect(page.locator('#saveState')).toContainText('Sin conexión');
  expect((await api.row(rosa)).phone).toBeNull();

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await api.row(rosa)).phone, { timeout: 20_000 }).toBe('611 222 333');
  await expect(page.locator('#saveState')).toHaveText('Todo guardado');
});

test('guests · conflicto: el organizador cambia un dato mientras el huésped lo edita y el huésped elige', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro con cambios' });
  const iris = await api.guest(event, { first_name: 'Iris' });
  await enter(page, await api.guestLink(reservation, iris, 'Iris'));
  await acceptPrivacy(page);
  await page.locator('#task-data').click();
  await openGroup(page, 'contact');
  await api.organizerWrites(reservation, iris, { phone: '699 000 111' });
  await page.locator('#f-phone').fill('622 333 444');
  await page.locator('#f-email').focus();
  await expect(page.locator('#conflicts')).toContainText('699 000 111');
  await expect(page.locator('#conflicts')).toContainText('622 333 444');
  await page.getByRole('button', { name: 'Quedarme con el mío' }).click();
  await expect.poll(async () => (await api.row(iris)).phone).toBe('622 333 444');
  expect((await api.row(iris)).field_sources.phone.by).toBe('guest');
});

test('guests · una cuenta con dos personas: elige a quién ver y nunca ve a otros huéspedes', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro con hijos' });
  const madre = await api.guest(event, { first_name: 'Marta' });
  const hijo = await api.guest(event, { first_name: 'Nico' });
  await api.guest(event, { first_name: 'Ajena', last_name_1: 'Nadie' });
  await api.guestLink(reservation, hijo, 'Nico', 'marta@example.invalid');
  await enter(page, await api.guestLink(reservation, madre, 'Marta', 'marta@example.invalid'));
  await expect(page.locator('#people a')).toHaveCount(2);
  await expect(page.locator('#people')).toContainText('Marta');
  await expect(page.locator('#people')).toContainText('Nico');
  await expect(page.locator('body')).not.toContainText('Ajena');
  await page.locator('#people a', { hasText: 'Nico' }).click();
  await acceptPrivacy(page);
  await expect(page.locator('#hello')).toHaveText('Hola, Nico');
});

const reportsWith = async (text: string) =>
  (await api.booking.t.db.query<{ subject: string; category: string; scope: any; destination: string }>(`select subject, category, scope, destination from core.feedback_reports where message like $1`, [`%${text}%`])).rows;

test('guests · «Ayuda y sugerencias»: «Mi retiro» con doble toque, un solo reporte para el organizador y se ve en lo enviado @smoke', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro con comentario' });
  const eva = await api.guest(event, { first_name: 'Eva' });
  await enter(page, await api.guestLink(reservation, eva, 'Eva'));
  await acceptPrivacy(page);
  // Prueba común del kit (0.25.2): entrada del lanzador, respuestas, doble toque en «Enviar», hoja cerrada y aviso visible.
  await portalHelpRoundTrip(page, { choices: ['Mi retiro', 'Horarios'], text: 'La cena empieza muy tarde' });
  const stored = await reportsWith('cena empieza');
  expect(stored).toHaveLength(1); // `id` y `requestId` estables del formulario: el doble toque no duplica
  expect(stored[0]).toMatchObject({ subject: 'event', category: 'schedule', destination: 'organizer' });
  expect(stored[0]!.scope).toMatchObject({ reservation_id: reservation, guest_id: eva });
  await page.locator('#openHelp').click();
  await expect(page.locator('#helpMine')).toContainText('La cena empieza muy tarde');
});

test('guests · «Ayuda y sugerencias» con el teclado abierto en el móvil: se envía, se cierra y el aviso se ve @smoke', async ({ page }) => {
  const { id: reservation, event } = await api.reservation({ title: 'Retiro con teclado' });
  const leo = await api.guest(event, { first_name: 'Leo' });
  await enter(page, await api.guestLink(reservation, leo, 'Leo'));
  await acceptPrivacy(page);
  await portalHelpRoundTrip(page, { open: (p) => p.locator('#openHelp').click(), choices: ['Un espacio de Ikisai', 'Baños', 'Agua o electricidad'], text: 'No sale agua caliente', keyboard: 686 });
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
