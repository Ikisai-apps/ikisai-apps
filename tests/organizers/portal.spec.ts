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

// La hoja «Instala la app» se ofrece al entrar por enlace; en estas pruebas se da por vista («Ahora no»), salvo en la suya.
test.beforeEach(async ({ context }, info) => {
  if (info.title.includes('instalar')) return;
  await context.addInitScript(() => { try { localStorage.setItem('ikisai-install-dismissed:organizers', String(Date.now())); } catch { /* */ } });
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
  await expect(page.locator('#saveState')).toContainText('se guardará con conexión');
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

test('organizers · en inglés: navegador en inglés, selector ES | EN y textos de Central en el idioma elegido', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-GB', viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => { try { localStorage.setItem('ikisai-install-dismissed:organizers', String(Date.now())); } catch { /* */ } });
  const page = await context.newPage();
  await page.goto(`${baseURL}/i/${'C'.repeat(43)}`);
  await expect(page.locator('#entryTitle')).toHaveText('This link does not work');
  await expect(page.locator('#entryContact')).toContainText('Email us at');

  const reservation = await api.reservation({ title: 'Spring retreat', confirm: true });
  await enter(page, await api.organizerLink([reservation], 'emma@example.invalid', 'Emma'));
  await expect(page.locator('#retreatTitle')).toHaveText('Spring retreat');
  await expect(page.locator('#retreatStatus')).toHaveText('Confirmed');
  // ICU escribe el rango con o sin espacios finos según la plataforma (Windows «12–15», Linux «12 – 15»).
  await expect(page.locator('#retreatHead')).toContainText(/12\s?–\s?15 March 2027/);
  await expect(page.locator('#tab-asistentes')).toHaveText('Attendees');

  // Cambio manual a español: se repinta y se recuerda en el dispositivo.
  await page.locator('#langSelect [data-locale="es"]').click();
  await expect(page.locator('#retreatStatus')).toHaveText('Confirmada');
  await expect(page.locator('#tab-asistentes')).toHaveText('Asistentes');
  await page.reload();
  await expect(page.locator('#retreatStatus')).toHaveText('Confirmada');
  await page.locator('#langSelect [data-locale="en"]').click();
  await page.locator('#tab-asistentes').click();
  await page.locator('#addGuest').click();
  await expect(page.locator('#declarationText')).toContainText('this information with the knowledge of my attendees');
  await context.close();
});

test('organizers · instalar: al entrar por enlace se ofrece instalar la app y «Ahora no» se recuerda', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'es-ES' });
  const page = await context.newPage();
  const reservation = await api.reservation({ title: 'Retiro para instalar', confirm: true });
  await enter(page, await api.organizerLink([reservation], 'ines@example.invalid', 'Inés'));
  await expect(page.getByRole('heading', { name: 'Instala la app' })).toBeVisible();
  await page.locator('.install-later').click();
  await expect(page.getByRole('heading', { name: 'Instala la app' })).toHaveCount(0);
  const dismissed = await page.evaluate(() => localStorage.getItem('ikisai-install-dismissed:organizers'));
  expect(Number(dismissed)).toBeGreaterThan(0);
  await context.close();
});

const plusDays = (d: string, days: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + days); return x.toISOString().slice(0, 10); };

test('organizers · fechas (fase 2): calendario de fines de semana, fechas de Ikisai y fecha definitiva; se guarda solo', async ({ page }) => {
  const [w2, w3, w4, w6] = [await api.friday(2), await api.friday(3), await api.friday(4), await api.friday(6)];
  await api.block(w3, plusDays(w3, 2));
  const calendar = await api.draftReservation({ title: 'Retiro por decidir' });
  const offered = await api.draftReservation({ title: 'Retiro con propuestas', status: 'negociacion' });
  await api.ikisaiOptions(offered, [[w4, plusDays(w4, 2)], [w6, plusDays(w6, 2)]]);
  const fixed = await api.draftReservation({ title: 'Retiro con fecha', status: 'negociacion', start_date: w2, end_date: plusDays(w2, 2), dates_definitive: true });
  await enter(page, await api.organizerLink([calendar, offered, fixed], 'disena@example.invalid', 'Lola'));

  // Calendario: lo ocupado no se puede marcar; lo marcado se guarda solo y sigue al volver.
  await page.locator('.orgretreat', { hasText: 'Retiro por decidir' }).click();
  await expect(page.locator('#summaryDates')).toContainText('Ikisai confirmará');
  await page.locator('#tab-fechas').click();
  await expect(page.locator('#datesCalendar')).toBeVisible();
  await expect(page.locator(`.orgweekend[data-start="${w3}"]`)).toBeDisabled();
  await page.locator(`.orgweekend[data-start="${w2}"]`).click();
  await page.locator(`.orgweekend[data-start="${w4}"]`).click();
  await expect(page.locator('#datesCount')).toHaveText('Has marcado 2 fines de semana.');
  await expect(page.locator('#datesSaveState')).toContainText('Guardado');
  await page.reload();
  await expect(page.locator(`.orgweekend[data-start="${w2}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`.orgweekend[data-start="${w4}"]`)).toHaveAttribute('aria-pressed', 'true');

  // Propuestas de Ikisai: se marcan las que vienen bien.
  await page.goto(`${baseURL}/#/retiro/${offered}/fechas`);
  await expect(page.locator('#datesIkisai')).toBeVisible();
  await expect(page.locator('#datesIkisai .orgdateoption')).toHaveCount(2);
  await page.locator('#datesIkisai .orgdateoption').first().locator('input').check();
  await expect(page.locator('#datesSaveState')).toContainText('Guardado');
  await page.reload();
  await expect(page.locator('#datesIkisai .orgdateoption').first().locator('input')).toBeChecked();

  // Fecha definitiva: solo se lee.
  await page.goto(`${baseURL}/#/retiro/${fixed}/fechas`);
  await expect(page.locator('#datesFixed')).toBeVisible();
  await expect(page.locator('#datesFixed input, #datesFixed .orgweekend')).toHaveCount(0);
});

test('organizers · diseño (fase 2): datos, extras y precio orientativo; calculadora privada; propuesta con «Quiero confirmar»', async ({ page }) => {
  const { extraId } = await api.seedRates();
  const w = await api.friday(8);
  const reservation = await api.draftReservation({ title: 'Retiro a diseñar', status: 'negociacion' });
  await api.ikisaiOptions(reservation, [[w, plusDays(w, 2)]]);
  await enter(page, await api.organizerLink([reservation], 'diseno@example.invalid', 'Tere'));

  await expect(page.locator('#summaryDesign')).toBeVisible();
  await page.locator('#goDesign').click();
  await expect(page.locator('#designPeople')).toBeVisible();
  await page.locator('#d-expected_guests').fill('20');
  // 20 personas × 2 noches × 60 € + 3 días de sala × 200 € = 3000 € (IVA incluido)
  await expect(page.locator('#quoteTotal')).toHaveText(/3\.?000,00/);
  await page.locator(`.orgextra[data-rate="${extraId}"] input[type=checkbox]`).check();
  await expect(page.locator('#quoteTotal')).toHaveText(/3\.?150,00/);
  await expect(page.locator('#quoteDeposit')).toHaveText(/945,00/);
  await expect(page.locator('#designSaveState')).toContainText('Guardado');

  // Calculadora privada: 20 asistentes a 300 € frente a 3150 € de Ikisai.
  await page.locator('#margin-price').fill('300');
  await expect(page.locator('#marginValue')).toHaveText(/2\.?850,00/);
  await expect(page.locator('#marginBreakEven')).toHaveText('11 asistentes');

  await page.reload();
  await expect(page.locator('#d-expected_guests')).toHaveValue('20');
  await expect(page.locator(`.orgextra[data-rate="${extraId}"] input[type=checkbox]`)).toBeChecked();
  await expect(page.locator('#margin-price')).toHaveValue('300');

  // Propuesta enviada por el personal: el organizador no la acepta; pide confirmarla.
  await api.sendProposal(reservation, 20);
  await page.locator('#tab-propuesta').click();
  await expect(page.locator('#proposal-1')).toContainText('Pendiente de confirmar');
  await expect(page.locator('#proposal-1 .proposalTotal')).toHaveText(/2\.?800,00/);
  // Condiciones: el texto de Booking con las cifras resueltas, negritas y un tramo por línea; sin repetir la lista del portal.
  await page.locator('#proposal-1 .orgconditions summary').click();
  const conditions = page.locator('#proposal-1 .orgconditions-text');
  await expect(conditions.locator('strong').first()).toHaveText('Señal:');
  await expect(conditions).toContainText('30 %');
  await expect(conditions).toContainText('Con 60 días o más de antelación');
  await expect(conditions).not.toContainText('{{');
  await expect(page.locator('#proposal-1 .orgconditions ul')).toHaveCount(0);
  await page.locator('#wantConfirm').click();
  await page.getByRole('button', { name: 'Quiero confirmar' }).last().click();
  await expect(page.locator('#myRequests')).toContainText('Quiero confirmar');
  await expect(page.locator('#myRequests')).toContainText('Enviada');
});

test('organizers · pagos y facturas (fase 3): facturado, cobrado y pendiente de Finance; factura sin documento; cómo pagar', async ({ page }) => {
  const reservation = await api.reservation({ title: 'Retiro con facturas', confirm: true });
  await api.seedRates();
  const proposal = await api.sendProposal(reservation, 20);
  await api.acceptProposal(proposal);
  await api.registeredInvoice(reservation, '2026-0101', 300, true);
  await api.registeredInvoice(reservation, '2026-0102', 700, false);
  await enter(page, await api.organizerLink([reservation], 'pagos@example.invalid', 'Nora'));

  await page.locator('#tab-pagos').click();
  await expect(page.locator('#moneyInvoiced')).toHaveText(/1\.?000,00/);
  await expect(page.locator('#moneyCollected')).toHaveText(/300,00/);
  await expect(page.locator('#moneyPending')).toHaveText(/700,00/);
  await expect(page.locator('#moneyInvoices .orginvoice')).toHaveCount(2);
  await expect(page.locator('#moneyInvoices')).toContainText('Cobrada');
  await expect(page.locator('#paymentInstructions')).toContainText('Por transferencia');

  // Lo contratado (Booking): 2800 € con señal de 840 €; pagado 300 € (Finance); saldo 2500 €; la señal aún no está cubierta.
  await expect(page.locator('#contractTotal')).toHaveText(/2\.?800,00/);
  await expect(page.locator('#contractPaid')).toHaveText(/300,00/);
  await expect(page.locator('#contractBalance')).toHaveText(/2\.?500,00/);
  await expect(page.locator('#contractDue li[data-kind="senal"]')).toContainText('840,00');
  await expect(page.locator('#contractDue li[data-kind="senal"]')).toContainText('Pendiente');
  // El plazo del saldo es interno de Ikisai: el saldo sale sin fecha.
  await expect(page.locator('#contractDue li[data-kind="saldo"]')).not.toContainText('antes del');

  // Registrada de otra herramienta: aún no se abre desde el portal; se pide a Ikisai.
  await page.locator('#moneyInvoices .orginvoice').first().click();
  // El correo de organizadores de Central (`contact.organizers.email`), no el de reserva.
  await expect(page.locator('#askInvoice')).toContainText('hola-organizadores@ikisai.com');
});

test('organizers · factura emitida desde Finance: la copia congelada se pinta e imprime con la página del kit', async ({ page }) => {
  const reservation = await api.reservation({ title: 'Retiro con factura emitida', confirm: true });
  const invoice = crypto.randomUUID();
  // Lecturas de Finance simuladas (emitir de verdad exige la entidad de Central completa).
  await page.route('**/api/v1/read/invoices.portal_reservation_money', (route) => route.fulfill({ json: {
    reservation_id: reservation, currency: 'EUR', totals: { invoiced: 1100, collected: 0, pending: 1100 },
    invoices: [{ id: invoice, number: 'F2026-0001', issue_date: '2026-10-08', type: 'F1', rectifies: null, base: 1000, tax: 100, withholding: 0, total: 1100, status: 'emitida', collected: false, collected_at: null, has_document: true, purpose: 'saldo' }],
  } }));
  await page.route('**/api/v1/read/invoices.portal_invoice_document', (route) => route.fulfill({ json: {
    id: invoice, number: 'F2026-0001', issue_date: '2026-10-08', status: 'emitida', files: [],
    document: {
      full_number: 'F2026-0001', series: 'F', number: '0001', issue_date: '2026-10-08', operation_date: null, invoice_type: 'F1',
      issuer: { entity_id: 'e', entity_revision: 1, legal_name: 'Ikisai Asociación', trade_name: 'Ikisai', tax_id: 'G00000000', address_line: 'Camino 1', postal_code: '00000', city: 'Sierra', province: null, country: 'ES', email: null, phone: null, website: null, logo_file_id: null },
      recipient: { name: 'Asociación Organiza', tax_id: 'G87654321', id_type: 'NIF', country: 'ES', address: { line: 'Calle Retiro 1', postal_code: '28001', city: 'Madrid' }, kind: 'empresa' },
      description: 'Retiro de otoño',
      lines: [{ position: 1, description: 'Alojamiento', quantity: 1, unit: null, unit_price: 1000, discount_amount: null, net_amount: 1000, tax: 'iva', vat_rate: 10, vat_amount: 100 }],
      breakdown: [{ tax: 'iva', rate: 10, base: 1000, quota: 100, exemption: null, surcharge_rate: null, surcharge_quota: null }],
      withholdings: [], prices_include_vat: false, totals: { base: 1000, quota: 100, surcharge: 0, withholding: 0, total: 1100, vf_amount: 1100 },
      rectification: null, currency: 'EUR', issued_at: '2026-10-08T10:00:00Z',
    },
  } }));
  await enter(page, await api.organizerLink([reservation], 'emitida@example.invalid', 'Olga'));
  await page.locator('#tab-pagos').click();
  // Concepto del cobro (Finance #313): rótulo «Saldo».
  await expect(page.locator('#moneyInvoices .orgpurpose')).toHaveText('Saldo');
  await page.locator('#moneyInvoices .orginvoice').first().click();
  await expect(page.locator('#invoiceDocumentView')).toContainText('Factura F2026-0001');
  await expect(page.locator('#docRecipient')).toContainText('Asociación Organiza');
  await expect(page.locator('#docTotal')).toHaveText(/1\.?100,00/);
  await expect(page.locator('#printPage')).toBeVisible();
});

test('organizers · experiencia (fase 4): qué ven los asistentes, mensaje, enlace publicado y pregunta con aviso de datos sensibles @smoke', async ({ page }) => {
  const reservation = await api.reservation({ title: 'Retiro con experiencia', confirm: true });
  await enter(page, await api.organizerLink([reservation], 'experiencia@example.invalid', 'Irene'));
  const rows = async (table: string) => (await api.booking.t.db.query<Record<string, any>>(`select * from organizers.${table} where reservation_id = $1 and deleted_at is null order by created_at`, [reservation])).rows;

  await page.locator('#tab-experiencia').click();
  await page.locator('#exp-materials_visible').check();
  await page.locator('#exp-program_visible').check();
  await page.locator('#exp-program_window').selectOption('during');
  await page.locator('#exp-message').fill('¡Bienvenidas al retiro!');
  await expect.poll(async () => (await rows('experiences'))[0]?.organizer_message, { timeout: 15_000 }).toBe('¡Bienvenidas al retiro!');
  const [experience] = await rows('experiences');
  expect(experience!.materials_visible).toBe(true);
  expect(experience!.program_window).toBe('during');

  // Material: enlace al grupo, publicado antes del retiro.
  await page.locator('#expnav-materiales').click();
  await page.locator('#expAddLink').click();
  await page.locator('#mat-title').fill('Grupo de WhatsApp');
  await page.locator('#mat-url').fill('http://chat.example');
  await page.locator('#mat-save').click();
  await expect(page.locator('#mat-error')).toContainText('https');
  await page.locator('#mat-url').fill('https://chat.whatsapp.com/abc');
  await page.locator('#mat-published').check();
  await page.locator('#mat-window').selectOption('before');
  await page.locator('#mat-save').click();
  await expect(page.locator('#expMaterials .orgitem')).toHaveCount(1);
  await expect(page.locator('#expMaterials .orgitem')).toContainText('Antes del retiro');
  await expect.poll(async () => (await rows('materials')).map((m) => [m.title, m.published, m.window])).toEqual([['Grupo de WhatsApp', true, 'before']]);

  // Pregunta: el editor avisa si parece pedir salud o alergias (O7); se guarda con sus opciones.
  await page.locator('#expnav-preguntas').click();
  await page.locator('#expAddQuestion').click();
  await page.locator('#q-label').fill('¿Tienes alguna alergia?');
  await expect(page.locator('#q-sensitive')).toBeVisible();
  await page.locator('#q-label').fill('¿Qué turno de yoga prefieres?');
  await expect(page.locator('#q-sensitive')).toBeHidden();
  await page.locator('#q-type').selectOption('choice');
  await page.locator('#q-options').fill('Mañana\nTarde');
  await page.locator('#q-published').check();
  await page.locator('#q-save').click();
  await expect(page.locator('#expQuestions .orgitem')).toContainText('Una opción');
  await expect.poll(async () => (await rows('questions')).map((q) => [q.label, q.options])).toEqual([['¿Qué turno de yoga prefieres?', [{ value: 'manana', label: 'Mañana' }, { value: 'tarde', label: 'Tarde' }]]]);
  await page.locator('#expAnswers').click();
  await expect(page.locator('#answersBody')).toContainText('Sin respuestas todavía.');
});

test('organizers · ofertas y cartel (fase 5): ofertas privadas, calculadora con lo contratado y cartel en JPG', async ({ page }) => {
  const reservation = await api.reservation({ title: 'Retiro con cartel', confirm: true });
  await api.seedRates();
  await api.acceptProposal(await api.sendProposal(reservation, 20));
  await enter(page, await api.organizerLink([reservation], 'ofertas@example.invalid', 'Olga'));

  await page.locator('#tab-ofertas').click();
  await expect(page.locator('#offersEmpty')).toBeVisible();
  await page.locator('#offersAdd').click();
  await page.locator('#of-name').fill('Estándar');
  await page.locator('#of-price').fill('450');
  await page.locator('#of-expected').fill('10');
  await page.locator('#of-includes').fill('Alojamiento, comidas y talleres');
  await page.locator('#of-save').click();
  await expect(page.locator('#offersList .orgitem')).toHaveCount(1);
  await expect(page.locator('#offersRevenue')).toHaveText(/4\.?500,00/);
  // Lo contratado con Ikisai (2800 €) entra en los gastos: 4500 − 2800 = 1700.
  await expect(page.locator('#offersMargin')).toHaveText(/1\.?700,00/);
  await page.locator('#offersOther').fill('200');
  await expect(page.locator('#offersMargin')).toHaveText(/1\.?500,00/);

  await page.locator('#posterOpen').click();
  await expect(page.locator('#posterCanvas')).toBeVisible();
  expect(await page.locator('#posterCanvas').evaluate((c: HTMLCanvasElement) => [c.width, c.height])).toEqual([1240, 1754]);
  await page.locator('#poster-format').selectOption('cuadrado');
  await expect.poll(() => page.locator('#posterCanvas').evaluate((c: HTMLCanvasElement) => c.width === c.height)).toBe(true);
  const download = page.waitForEvent('download');
  await page.locator('#posterJpg').click();
  expect((await download).suggestedFilename()).toBe('cartel-retiro-con-cartel.jpg');
});

test('organizers · experiencia (fases 4 y 5): programa por días, menú aún sin compartir, alojamiento y vista previa', async ({ page, context }) => {
  const reservation = await api.reservation({ title: 'Retiro con programa', confirm: true, start: '2027-05-14', end: '2027-05-16' });
  await enter(page, await api.organizerLink([reservation], 'programa@example.invalid', 'Pablo'));
  await page.locator('#tab-experiencia').click();

  // Programa (Booking): actividad del sábado por la mañana.
  await page.locator('#expnav-programa').click();
  await page.locator('[data-add-day="2027-05-15"]').click();
  await page.locator('#pr-title').fill('Meditación');
  await page.locator('#pr-starts').fill('08:00');
  await page.locator('#pr-ends').fill('07:00');
  await page.locator('#pr-save').click();
  await expect(page.locator('#pr-error')).toContainText('posterior');
  await page.locator('#pr-ends').fill('09:00');
  await page.locator('#pr-place').fill('Sala grande');
  await page.locator('#pr-save').click();
  await expect(page.locator('[data-day="2027-05-15"] .orgitem')).toContainText('08:00–09:00');
  await expect(page.locator('[data-day="2027-05-15"] .orgitem')).toContainText('Sala grande');

  // Menú (Food): cocina aún no lo ha compartido.
  await page.locator('#expnav-menu').click();
  await expect(page.locator('#menuPending')).toBeVisible();

  // Alojamiento (Booking): «piden su cama y tú la apruebas» se guarda en los dos lados.
  await page.locator('#expnav-alojamiento').click();
  await page.locator('#lodging-capability').selectOption('request');
  await expect(page.locator('#lodgingOpen')).toBeVisible();
  await expect.poll(async () => (await api.booking.t.db.query<{ choice: string }>(
    `select s.choice from booking.lodging_settings s join booking.events e on e.id = s.event_id where e.reservation_id = $1`, [reservation])).rows[0]?.choice).toBe('request');
  await expect.poll(async () => (await api.booking.t.db.query<{ lodging_capability: string }>(
    'select lodging_capability from organizers.experiences where reservation_id = $1', [reservation])).rows[0]?.lodging_capability).toBe('request');

  // Vista previa: abre Guests con el huésped de muestra.
  await page.locator('#expnav-ven').click();
  const popup = context.waitForEvent('page');
  await page.locator('#expPreviewOpen').click();
  await expect.poll(async () => (await popup).url()).toMatch(/^https:\/\/guests\.ikisai\.com\/i\//);
});
