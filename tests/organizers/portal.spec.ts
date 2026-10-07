/**
 * Organizers · recorrido de aceptación en móvil (API.md §11) contra la organizers-api y la booking-api reales sobre PGlite
 * (server.ts): entrada por enlace, retiro, asistentes con declaración, enlace de huésped, privacidad de lo que escribe el
 * huésped, cocina, recordatorio del grupo, baja, modo sin registro de viajeros y lectura sin red.
 */
import { expect, test, type Page } from 'playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../food/helpers.ts';
import { startOrganizersServer, type OrganizersTestServer } from './server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/organizers/vite.config.ts');

let api: OrganizersTestServer;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
  api = await startOrganizersServer();
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

/** Abre un bloque plegable de la ficha sin cerrarlo si ya estaba abierto. */
async function openGroup(page: Page, group: string): Promise<void> {
  await page.locator(`details[data-group="${group}"]`).evaluate((node) => { (node as HTMLDetailsElement).open = true; });
}

async function enter(page: Page, token: string): Promise<void> {
  await page.goto(`${baseURL}/i/${token}`);
  await expect(page).not.toHaveURL(/\/i\//);
  expect(page.url()).not.toContain(token);
}

test('organizers · enlace no válido: pantalla clara, sin sesión @smoke', async ({ page }) => {
  await page.goto(`${baseURL}/i/${'A'.repeat(43)}`);
  await expect(page.locator('#entryTitle')).toHaveText('Este enlace no funciona');
  await expect(page).not.toHaveURL(/\/i\//);
  await page.goto(`${baseURL}/`);
  await expect(page.locator('#entryTitle')).toHaveText('Entra con tu enlace');
});

test('organizers · un retiro: entrada, asistentes, enlace, privacidad, cocina, recordatorio y baja', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const reservation = await api.reservation({ title: 'Retiro de primavera', confirm: true });
  await enter(page, await api.organizerLink([reservation], 'marta@example.invalid'));

  // Con un solo retiro se abre su ficha directamente.
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro de primavera');
  await expect(page.locator('#retreatStatus')).toHaveText('Confirmada');
  await expect(page.locator('#summaryIncludes')).toContainText('Pensión completa, menú vegetariano');
  await expect(page.locator('#retreatOrganizers')).toHaveText('Organizas este retiro');

  // Coorganizador: su propio enlace y su cuenta; los dos ven lo mismo.
  await api.organizerLink([reservation], 'pablo@example.invalid', 'Pablo');
  await page.reload();
  await expect(page.locator('#retreatOrganizers')).toHaveText('Organizáis tú y Pablo');

  // Alta: la primera vez pide la declaración.
  await page.locator('#tab-asistentes').click();
  await expect(page.locator('#guestRows')).toContainText('Aún no has añadido a nadie');
  await page.locator('#addGuest').click();
  await page.locator('#f-first_name').fill('Ana');
  await page.locator('#f-last_name_1').fill('Sintética');
  await expect(page.locator('#declarationBox')).toBeVisible();
  // «Más información» es el texto `portal.privacy` de Central (#281), no un texto fijo del código.
  await expect(page.locator('#declarationBox details strong').first()).toContainText('protección de datos');
  await page.locator('#saveNewGuest').click();
  await expect(page.locator('#newGuestError')).toContainText('marca la casilla');
  await page.locator('#declaration').check();
  await page.locator('#saveNewGuest').click();
  await expect(page.locator('#guestName')).toHaveText('Ana S.');
  await expect(page.locator('#guestState')).toHaveText('Faltan datos');
  await expect(page.locator('#declarationBox')).toHaveCount(0);

  // Datos que escribe quien organiza.
  await openGroup(page, 'Contacto');
  // Guardado automático: sin botón; al salir del campo se guarda y la ficha lo dice.
  await expect(page.locator('#saveGuest')).toHaveCount(0);
  await page.locator('#f-phone').fill('600 000 000');
  await page.locator('#f-email').focus();
  await expect(page.locator('#saveState')).toContainText('Guardado');
  await page.reload();
  await openGroup(page, 'Contacto');
  await expect(page.locator('#f-phone')).toHaveValue('600 000 000');

  // Enlace personal: hoja de compartir con WhatsApp a su número.
  await expect(page.locator('#linkState')).toHaveText('Enlace sin enviar');
  await page.locator('#sendLink').click();
  await expect(page.locator('#shareText')).toContainText('https://guests.ikisai.com/i/');
  await expect(page.locator('#shareWhatsapp')).toHaveAttribute('href', /^https:\/\/wa\.me\/34600000000\?text=/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#linkState')).toContainText('Enlace enviado el');
  await expect(page.locator('#sendLink')).toHaveText('Reenviar enlace');

  // Lo que escribe el propio huésped: «Rellenado», nunca el valor.
  const guestId = page.url().split('/').pop()!;
  await api.guestWrites(reservation, guestId, { document_type: 'DNI', document_number: '00000000T' });
  await page.reload();
  await openGroup(page, 'Documento');
  await expect(page.locator('[data-field="document_number"]')).toContainText('Rellenado');
  await expect(page.locator('#f-document_number')).toHaveCount(0);
  expect(await page.content()).not.toContain('00000000T');

  // Alimentación: una alergia que escribe quien organiza aparece con nombre en Cocina.
  await page.locator('#addRestriction').click();
  await page.locator('.orgrestriction .r-subject').fill('frutos secos');
  await page.locator('.orgrestriction .r-severity').selectOption('grave');
  await expect(page.locator('#saveState')).toContainText('Guardado');
  await page.locator('#backToGuests').click();
  await page.locator('#tab-cocina').click();
  await expect(page.locator('#kitchenTotals')).toContainText('Alergia a frutos secos');
  await expect(page.locator('#kitchenNamed')).toContainText('Ana S.');

  // Recordatorio del grupo: sin nombres.
  await page.locator('#tab-asistentes').click();
  await page.locator('#groupReminder').click();
  const reminder = await page.evaluate(() => navigator.clipboard.readText());
  expect(reminder).toContain('Retiro de primavera');
  expect(reminder).not.toContain('Ana');

  // Baja.
  await page.locator(`#guestRows [data-id="${guestId}"]`).click();
  await page.locator('#removeGuest').click();
  await page.getByRole('button', { name: 'Dar de baja' }).last().click();
  await expect(page.locator('#guestRows')).toContainText('Aún no has añadido a nadie');
});

test('organizers · varios retiros: sin confirmar no se añaden asistentes; sin registro de viajeros, solo nombre y contacto @smoke', async ({ page }) => {
  const pending = await api.reservation({ title: 'Retiro de otoño', confirm: false, start: '2027-10-01', end: '2027-10-03' });
  const simple = await api.reservation({ title: 'Encuentro de invierno', confirm: true, start: '2027-12-01', end: '2027-12-02', ses: false });
  await enter(page, await api.organizerLink([pending, simple], 'lucia@example.invalid'));

  await expect(page.locator('.orgretreat')).toHaveCount(2);
  await expect(page.locator('.orgretreat').first()).toContainText('Retiro de otoño');
  await expect(page.locator('.orgretreat').first()).toContainText('Prerreservada');

  await page.locator('.orgretreat', { hasText: 'Retiro de otoño' }).click();
  await page.locator('#tab-asistentes').click();
  await expect(page.locator('#guestsNotConfirmed')).toContainText('cuando la reserva esté confirmada');

  await page.locator('#backToRetreats').click();
  await page.locator('.orgretreat', { hasText: 'Encuentro de invierno' }).click();
  await page.locator('#tab-asistentes').click();
  await page.locator('#addGuest').click();
  await page.locator('#f-first_name').fill('Leo');
  await page.locator('#declaration').check();
  await page.locator('#saveNewGuest').click();
  await expect(page.locator('#guestName')).toHaveText('Leo');
  // Modo operativo: nunca documento, dirección, nacimiento ni firma.
  await expect(page.locator('#f-document_number')).toHaveCount(0);
  await expect(page.locator('#f-residence_address')).toHaveCount(0);
  await expect(page.locator('#f-birth_date')).toHaveCount(0);
  await expect(page.locator('#signatureNote')).toHaveCount(0);
  await expect(page.locator('#guestState')).toHaveText('Faltan datos');
});

test('organizers · sin red: última copia con aviso; lo escrito se guarda solo al volver la conexión @smoke', async ({ page, context }) => {
  const reservation = await api.reservation({ title: 'Retiro sin cobertura', confirm: true });
  await enter(page, await api.organizerLink([reservation], 'nuria@example.invalid'));
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro sin cobertura');
  await page.locator('#tab-asistentes').click();
  await page.locator('#addGuest').click();
  await page.locator('#f-first_name').fill('Rosa');
  await page.locator('#declaration').check();
  await page.locator('#saveNewGuest').click();
  await expect(page.locator('#guestName')).toHaveText('Rosa');
  const guestUrl = page.url();

  await context.setOffline(true);
  await page.locator('#backToGuests').click();
  await expect(page.locator('#staleNote')).toBeVisible();
  await expect(page.locator('#guestRows')).toContainText('Rosa');
  await page.goto(guestUrl).catch(() => undefined);
  await page.evaluate(() => { location.hash = location.hash; });
  await expect(page.locator('#staleNote')).toBeVisible();
  await expect(page.locator('#sendLink')).toBeDisabled();

  // Lo que se escribe sin red no se pierde: aviso, borrador local y envío solo al volver la conexión.
  await openGroup(page, 'Contacto');
  await page.locator('#f-email').fill('rosa@example.invalid');
  await page.locator('#f-phone').focus();
  await expect(page.locator('#saveState')).toContainText('se guardará al recuperar la conexión');
  await context.setOffline(false);
  await expect(page.locator('#saveState')).toContainText('Guardado');
  await page.reload();
  await openGroup(page, 'Contacto');
  await expect(page.locator('#f-email')).toHaveValue('rosa@example.invalid');
});

test('organizers · ayuda y sugerencias: un comentario sobre «Mi retiro» llega y se ve en lo enviado', async ({ page }) => {
  const reservation = await api.reservation({ title: 'Retiro con comentario', confirm: true });
  await enter(page, await api.organizerLink([reservation], 'eva@example.invalid'));
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro con comentario');
  await page.locator('#appLauncher').click();
  await page.getByText('Ayuda y sugerencias').click();
  await page.getByRole('button', { name: 'Mi retiro' }).click();
  await page.getByRole('button', { name: 'Limpieza' }).click();
  await page.locator('#helpSheet textarea').fill('Faltan toallas en la sala grande');
  await page.getByRole('button', { name: 'Enviar' }).click();
  await expect(page.getByText('Gracias. Lo hemos recibido.')).toBeVisible();
  await expect(page.locator('#helpMine')).toContainText('Faltan toallas en la sala grande');
  const stored = await api.booking.t.db.query<{ subject: string; category: string; scope: any }>(`select subject, category, scope from core.feedback_reports where message like '%toallas%'`);
  expect(stored.rows[0]).toMatchObject({ subject: 'event', category: 'cleaning' });
  expect(stored.rows[0]!.scope.reservation_id).toBe(reservation);
});
