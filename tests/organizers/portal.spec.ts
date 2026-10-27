/**
 * Organizers · recorrido de aceptación en móvil (API.md §11) contra la organizers-api y la booking-api reales sobre PGlite
 * (server.ts): entrada por enlace, retiro, asistentes con declaración, enlace de huésped, privacidad de lo que escribe el
 * huésped, cocina, recordatorio del grupo, baja, modo sin registro de viajeros y lectura sin red.
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import { freePort } from '../../packages/test-kit/src/net.ts';
import { buildOrganizersApp, ORGANIZERS_VITE_CONFIG, startOrganizersServer, type OrganizersTestServer } from './server.ts';
import { portalHelpRoundTrip } from '../../packages/ui-kit/testing/feedback-smoke.ts';

const configFile = ORGANIZERS_VITE_CONFIG;

let api: OrganizersTestServer;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
  api = await startOrganizersServer();
  process.env.VITE_API_PROXY = api.url;
  await buildOrganizersApp();
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

test('organizers · sin el enlace, entra con un código por correo (0106) @smoke', async ({ page }) => {
  const reservation = await api.reservation({ title: 'Retiro con código', confirm: true });
  await api.organizerLink([reservation], 'codigo@example.invalid', 'Clara');
  await page.goto(`${baseURL}/`);
  const form = page.locator('#emailCode');
  await expect(form).toContainText('¿No tienes el enlace a mano?');
  await page.locator('#codeEmail').fill('codigo@example.invalid');
  await page.locator('#codeSend').click();
  await expect(page.locator('#codeStep')).toBeVisible();
  await expect(page.locator('#codeSend')).toHaveText('Enviar otro código');
  const mail = api.booking.supabase.lastEmailCode();
  expect(mail?.email).toBe('codigo@example.invalid');
  // Equivocado: aviso y se sigue en la entrada.
  await page.locator('#codeInput').fill(mail!.code === '000000' ? '111111' : '000000');
  await page.locator('#codeEnter').click();
  await expect(page.locator('.toast.show')).toContainText('El código no es correcto o ha caducado');
  await page.locator('#codeInput').fill(mail!.code);
  await page.locator('#codeEnter').click();
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro con código');
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
  // Resumen paso a paso: confirmado y sin asistentes, lo siguiente es añadirlos.
  await expect(page.locator('.step-box')).toContainText('Añadir a tus asistentes');

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
  // «Lo que le falta», con el contacto como teléfono o correo; los bloques con algo que falta, abiertos.
  await expect(page.locator('#guestMissing')).toContainText('teléfono o correo');
  await expect(page.locator('#guestMissing')).toContainText('Firma del registro de viajeros');
  await expect(page.locator('details[data-group="Contacto"]')).toHaveAttribute('open', '');
  await expect(page.locator('[data-field="phone"]')).toHaveClass(/orgfield-missing/);

  // Datos que escribe quien organiza.
  await openGroup(page, 'Contacto');
  // Guardado automático: sin botón; al salir del campo se guarda y la ficha lo dice.
  await expect(page.locator('#saveGuest')).toHaveCount(0);
  await page.locator('#f-phone').fill('600 000 000');
  await page.locator('#f-email').focus();
  await expect(page.locator('#saveState')).toContainText('Guardado');
  await expect(page.locator('#guestMissing')).not.toContainText('teléfono o correo');
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
  const guestId = page.url().split('/').pop()!;

  // En la lista: Ana pasa a «No han abierto su enlace»; las plazas, una por persona y fuera de las capturas.
  await page.locator('#backToGuests').click();
  await expect(page.locator('#guestRows [data-stage="sinabrir"]')).toContainText('Ana S.');
  await expect(page.locator('#guestRows [data-group="sinabrir"] .worst-count')).toHaveText('1');
  await expect(page.locator('#guestSeats button')).toHaveCount(1);
  await expect(page.locator('#guestSeats button')).toHaveAttribute('aria-label', 'Ana S. · No han abierto su enlace');
  expect(await page.locator('#guestSeats').evaluate((node) => !!node.closest('[data-feedback-ignore]'))).toBe(true);
  await expect(page.locator('#guestSummary')).toContainText('0/1');
  await page.locator(`#guestRows [data-id="${guestId}"]`).click();
  await expect(page.locator('#guestName')).toHaveText('Ana S.');

  // Lo que escribe el propio huésped: «Rellenado», nunca el valor.
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
  // Tipo de menú, aviso sin menú compartido y el recuento sin gravedad (la gravedad, solo junto al nombre).
  await expect(page.locator('#kitchenMenuStyle')).toContainText('Menú vegetariano');
  await expect(page.locator('#kitchenMenuStyle')).toContainText('Pensión completa');
  await expect(page.locator('#kitchenCheck')).toContainText('aún no ha compartido el menú');
  await expect(page.locator('#kitchenSummary')).toHaveText('1 alergia o intolerancia en el grupo');
  await expect(page.locator('#kitchenNamed')).toContainText('grave');
  const outsideNamed = await page.locator('#kitchen').evaluate((node) => {
    const copy = node.cloneNode(true) as HTMLElement;
    copy.querySelector('#kitchenNamed')?.remove();
    return copy.textContent ?? '';
  });
  expect(outsideNamed).not.toMatch(/\bapto\b|grave/i);

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
  // «Te toca» y el recorrido de cada tarjeta, solo con lo que trae la tarjeta.
  await expect(page.locator('.orgretreat').first()).toContainText('Te toca: revisar la señal en Pagos');
  await expect(page.locator('.orgretreat').first().locator('.stage-list')).toHaveAttribute('aria-label', /etapa 2 de 5, Prerreserva/);
  await expect(page.locator('.orgretreat', { hasText: 'Encuentro de invierno' })).toContainText('Te toca: añadir a tus asistentes');

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
  // Rosa aún no tiene enlace: «Enviar su enlace» necesita red y lo dice; «Recordar» y las herramientas siguen.
  await expect(page.locator('#guestRows [data-act="sinenlace"]')).toBeDisabled();
  // Una sola línea con el motivo para toda la lista (kit 0.49), no una por fila.
  await expect(page.locator('#guestRowsOffline')).toBeVisible();
  await expect(page.locator('#guestRowsOffline')).toContainText('para enviar enlaces necesitas red');
  await expect(page.locator('#guestRows .offline-why')).toHaveCount(1);
  await expect(page.locator('#addGuest')).toBeEnabled();
  await expect(page.locator('#guestSeats button')).toHaveCount(1);
  // Mis retiros sin red: la última copia, con «Reintentar».
  await page.locator('#backToRetreats').click();
  await expect(page.locator('#staleNote')).toBeVisible();
  await expect(page.locator('#staleNote').getByRole('button', { name: 'Reintentar' })).toBeVisible();
  await expect(page.locator('.orgretreat')).toContainText('Retiro sin cobertura');
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

test('organizers · ayuda y sugerencias: enviar con doble toque llega una vez, se cierra y se ve el aviso; también con teclado @smoke', async ({ page }) => {
  const reservation = await api.reservation({ title: 'Retiro con comentario', confirm: true });
  await enter(page, await api.organizerLink([reservation], 'eva@example.invalid'));
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro con comentario');
  const reports = async (text: string) => (await api.booking.t.db.query<{ subject: string; category: string; scope: any }>(
    `select subject, category, scope from core.feedback_reports where message like $1`, [`%${text}%`])).rows;

  // Prueba común del kit (portalHelpRoundTrip): lanzador → «Ayuda y sugerencias» → respuestas → enviar con doble toque.
  await portalHelpRoundTrip(page, { choices: ['Mi retiro', 'Limpieza'], text: 'Faltan toallas en la sala grande' });
  const stored = await reports('toallas');
  expect(stored, 'un solo reporte aunque se toque dos veces').toHaveLength(1);
  expect(stored[0]).toMatchObject({ subject: 'event', category: 'cleaning' });
  expect(stored[0]!.scope.reservation_id).toBe(reservation);

  // Con el teclado del móvil abierto (686 px de alto visible): el aviso se ve igual y tampoco se duplica.
  await portalHelpRoundTrip(page, { choices: ['Mi retiro', 'Limpieza'], text: 'La ducha del baño gotea', keyboard: 686 });
  expect(await reports('ducha')).toHaveLength(1);

  // Lo enviado se ve al volver a abrir la ayuda.
  await page.locator('#appLauncher').click();
  await page.locator('.launcher-center').click();
  await expect(page.locator('#helpMine')).toContainText('Faltan toallas en la sala grande');
  await expect(page.locator('#helpMine')).toContainText('La ducha del baño gotea');
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
  await expect(page.locator('#logoutButton')).toHaveAttribute('aria-label', 'Sign out');

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
  await expect(page.locator('#goDates')).toContainText('Ikisai confirmará');
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
  // Veredicto arriba (tanda 30, MUELA-084): falta marcar una fecha, y es lo siguiente; se recalcula al marcar.
  const verdict = page.locator('#datesVerdict');
  await expect(verdict.locator('.check-verdict')).toContainText('para pedir la propuesta');
  await expect(verdict.locator('#readyNext')).toContainText('Fechas posibles');
  await page.locator('#datesIkisai .orgdateoption').first().locator('input').check();
  await expect(verdict.locator('#readyNext')).not.toContainText('Fechas posibles');
  await expect(page.locator('#datesSaveState')).toContainText('Guardado');
  await page.reload();
  await expect(page.locator('#datesIkisai .orgdateoption').first().locator('input')).toBeChecked();

  // Fecha definitiva: solo se lee.
  await page.goto(`${baseURL}/#/retiro/${fixed}/fechas`);
  await expect(page.locator('#datesFixed')).toBeVisible();
  await expect(page.locator('#datesFixed input, #datesFixed .orgweekend')).toHaveCount(0);
  // Con la fecha fijada, lo siguiente es el diseño: «Ir a Personas» abre Diseño con el campo enfocado.
  await expect(page.locator('#datesVerdict #readyNext')).toContainText('Cuántas personas venís');
  await page.locator('#datesVerdict #readyNext').click();
  await expect(page.locator('#d-expected_guests')).toBeFocused();
});

test('organizers · diseño (fase 2): datos, extras y precio orientativo; calculadora privada; propuesta con «Quiero confirmar»', async ({ page }) => {
  const { extraId } = await api.seedRates();
  const w = await api.friday(8);
  const reservation = await api.draftReservation({ title: 'Retiro a diseñar', status: 'negociacion' });
  await api.ikisaiOptions(reservation, [[w, plusDays(w, 2)]]);
  await enter(page, await api.organizerLink([reservation], 'diseno@example.invalid', 'Tere'));

  await expect(page.locator('#goDesign')).toBeVisible();
  await page.locator('#goDesign').click();
  await expect(page.locator('#designPeople')).toBeVisible();
  // Veredicto arriba con «Siguiente» (MUELA-072:47 y MUELA-084): la fecha de Ikisai aún no está marcada (lo siguiente) y
  // faltan las personas (en la lista de debajo).
  await expect(page.locator('#designReady .check-verdict')).toContainText(/Te faltan? \d+ cosas? para pedir la propuesta/);
  await expect(page.locator('#designReady #readyNext')).toContainText('Fechas posibles');
  await expect(page.locator('#designReady .check-list')).toContainText('Cuántas personas venís');
  await page.locator('#designReady .check-action', { hasText: 'Ir a Personas' }).click();
  await expect(page.locator('#d-expected_guests')).toBeFocused();
  await page.locator('#d-expected_guests').fill('20');
  await expect(page.locator('#designReady')).not.toContainText('Cuántas personas venís');
  // 20 personas × 2 noches × 60 € + 2 días de sala × 200 € = 2800 € (IVA incluido; regla de VG: tantos días como noches)
  await expect(page.locator('#quoteTotal')).toHaveText(/2\.?800,00/);
  // El extra se guarda en su propia escritura (después de la de las personas): se espera a que llegue.
  const extraSaved = page.waitForResponse((r) => r.url().includes('booking.portal_update_draft') && (r.request().postData() ?? '').includes('"extras"'));
  await page.locator(`.orgextra[data-rate="${extraId}"] input[type=checkbox]`).check();
  await expect(page.locator('#quoteTotal')).toHaveText(/2\.?950,00/);
  await expect(page.locator('#quoteDeposit')).toHaveText(/885,00/);
  await extraSaved;
  // Precio medio, nunca un «por persona» suelto: 2950 € entre 20 personas.
  await expect(page.locator('#quoteAverage')).toContainText('147,50');
  await expect(page.locator('#quoteAverage')).toContainText('el total entre 20 personas');
  await expect(page.locator('#priceBar')).toContainText(/2\.?950,00/);
  await expect(page.locator('#priceBar')).not.toContainText(/^Por persona/);
  await expect(page.locator('#designSaveState')).toContainText('Guardado');

  // «¿Cuánto ganas?»: 20 asistentes a 300 € frente a 2950 € de Ikisai.
  await page.locator('#margin-price').fill('300');
  await expect(page.locator('#marginValue')).toHaveText(/3\.?050,00/);
  // Lo de Ikisai varía con las plazas: con 9 asistentes (2700 €) ya se cubre el mínimo de 2500 €; con 8 (2400 €), no.
  await expect(page.locator('#marginBreakEven')).toHaveText('9 asistentes');
  // La raya roja: con 20 asistentes se cubren costes a 148 € (2950 / 20 = 147,50, al euro hacia arriba).
  await expect(page.locator('#marginBreakEvenLabel')).toHaveText(/^Cubres costes: 148,00\s€$/);
  await page.locator('#marginBreakEvenPrice').click();
  await expect(page.locator('#margin-price')).toHaveValue('148');
  await expect(page.locator('#margin-price')).toBeFocused();
  await expect(page.locator('#margin-pct')).toHaveValue('0');
  await expect(page.locator('#marginValue')).toHaveText(/^10,00/);
  // Quiero ganar un 20 % sobre los costes: 2950 × 1,2 / 20 = 177 €.
  await page.locator('#margin-pct').fill('20');
  await expect(page.locator('#margin-price')).toHaveValue('177');
  // Los colaboradores solo cuentan aquí: el aviso manda a «Personas» para cambiar las plazas de verdad.
  await expect(page.locator('#marginSeatsNote')).toBeHidden();
  await page.locator('#margin-collaborators').fill('2');
  await expect(page.locator('#marginSeatsNote')).toBeVisible();
  await expect(page.locator('#marginSeatsNote')).toContainText('Personas');
  await expect(page.locator('#marginSeats')).toContainText('22 plazas');

  await page.reload();
  // La calculadora no escribe en Booking: las plazas siguen en 20.
  await expect(page.locator('#d-expected_guests')).toHaveValue('20');
  await expect(page.locator(`.orgextra[data-rate="${extraId}"] input[type=checkbox]`)).toBeChecked();
  await expect(page.locator('#margin-collaborators')).toHaveValue('2');
  await expect(page.locator('#margin-price')).toHaveValue('177');

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
  // Ya pedido: el botón deja su sitio a la fecha en que se pidió; «Enviar un comentario» se queda.
  await expect(page.locator('#wantSent')).toBeVisible();
  await expect(page.locator('#wantConfirm')).toHaveCount(0);
  await expect(page.locator('#sendCommentOpen')).toBeVisible();
});

test('organizers · propuesta con versiones: la vigente con acciones, las anteriores plegadas y comparar versiones', async ({ page }) => {
  await api.seedRates();
  const w = await api.friday(9);
  const reservation = await api.draftReservation({ title: 'Retiro con dos versiones', status: 'negociacion', expected_guests: 20 });
  await api.ikisaiOptions(reservation, [[w, plusDays(w, 2)]]);
  await api.sendProposal(reservation, 20);
  // La segunda deja la primera como sustituida (Booking #610).
  await api.sendProposal(reservation, 20);
  await enter(page, await api.organizerLink([reservation], 'versiones@example.invalid', 'Vera'));

  await page.locator('#tab-propuesta').click();
  await expect(page.locator('#proposal-2')).toBeVisible();
  await expect(page.locator('#proposal-2 #wantConfirm')).toHaveCount(1);
  await expect(page.locator('#proposalPrevious')).toContainText('Versión anterior · sustituida por la 2');
  await expect(page.locator('#proposal-1 #wantConfirm')).toHaveCount(0);
  await expect(page.locator('#wantConfirm')).toHaveCount(1);
  await expect(page.locator('#proposalAverage')).toContainText('Precio medio por persona');
  await expect(page.locator('#proposalAverage')).toContainText('el total entre 20 personas');
  // Las unidades en lenguaje claro.
  await expect(page.locator('#proposal-2 .orgquote')).toContainText('por persona y noche');

  await page.locator('#propViewCompare').click();
  await expect(page.locator('#propViewCompare')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#proposalCompare')).toContainText('Versión 2 frente a versión 1');
  await expect(page.locator('#proposalCompare .orgviewhead')).toBeFocused();
  await page.locator('#propViewBudget').click();
  await expect(page.locator('#proposal-2')).toBeVisible();
  await expect(page.getByText('Por persona', { exact: true })).toHaveCount(0);
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
  // El extracto: lo contratado (Booking, 2800 €) menos lo pagado (Finance, 300 €).
  const statement = page.locator('#moneyStatement');
  await expect(statement.locator('.mb-total .mb-amount')).toHaveText(/2\.?500,00/);
  await expect(statement.locator('.mb-total')).toContainText(/de 2\.?800,00\s€ contratados/);
  // Próximamente: la señal de 840 € pagada en parte (quedan 540 €); el saldo, sin fecha (su plazo es interno de Ikisai).
  const deposit = statement.locator('li[data-move="senal"]');
  await expect(deposit).toContainText('540,00');
  await expect(deposit).toContainText('840,00');
  await expect(deposit).toContainText('hasta el');
  await expect(deposit).toContainText('Pendiente');
  await expect(statement.locator('li[data-move="saldo"]')).not.toContainText('hasta el');
  // Movimientos: las dos facturas y el pago recibido de la cobrada.
  await expect(statement.locator('li.mb-doc')).toHaveCount(2);
  await expect(statement.locator('li.mb-doc').filter({ hasText: 'Cobrada' })).toHaveCount(1);
  await expect(statement.locator('li.mb-in')).toContainText('Pago recibido');

  // Las seis cifras, con los ids de siempre.
  await expect(page.locator('#contractTotal')).toHaveText(/2\.?800,00/);
  await expect(page.locator('#contractPaid')).toHaveText(/300,00/);
  await expect(page.locator('#contractBalance')).toHaveText(/2\.?500,00/);
  await expect(page.locator('#moneyInvoiced')).toHaveText(/1\.?000,00/);
  await expect(page.locator('#moneyCollected')).toHaveText(/300,00/);
  await expect(page.locator('#moneyPending')).toHaveText(/700,00/);
  await expect(page.locator('#moneyTotals')).toContainText('Según la propuesta aceptada (versión 1)');

  // «Cómo pagar», abierto entre «Próximamente» y «Movimientos» (afterUpcoming, kit 0.49) porque queda algo por pagar.
  const how = page.locator('#paymentInstructions');
  await expect(how).toContainText('Por transferencia');
  expect(await how.evaluate((node) => node.tagName)).toBe('SECTION');
  expect(await how.evaluate((node) => [node.previousElementSibling?.getAttribute('aria-label'), node.nextElementSibling?.getAttribute('aria-label')])).toEqual(['Próximamente', 'Movimientos']);
  expect(await how.evaluate((node) => !!(node.compareDocumentPosition(document.querySelector('#moneyTotals')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);

  // Registrada de otra herramienta: aún no se abre desde el portal; se pide a Ikisai.
  await statement.locator('li.mb-doc .mb-open').first().click();
  // El correo de organizadores de Central (`contact.organizers.email`), no el de reserva.
  await expect(page.locator('#askInvoice')).toContainText('hola-organizadores@ikisai.com');
});

test('organizers · pagos todo pagado: nada por pagar y «Cómo pagar» plegado al final', async ({ page }) => {
  const reservation = await api.reservation({ title: 'Retiro ya pagado', confirm: true });
  await api.seedRates();
  const proposal = await api.sendProposal(reservation, 20);
  await api.acceptProposal(proposal);
  await api.registeredInvoice(reservation, '2026-0301', 2800, true);
  await enter(page, await api.organizerLink([reservation], 'pagado@example.invalid', 'Pilar'));

  await page.locator('#tab-pagos').click();
  await expect(page.locator('#moneyStatement .mb-total .mb-amount')).toHaveText(/^0,00/);
  await expect(page.locator('#contractBalance')).toHaveText(/^0,00/);
  const how = page.locator('#paymentInstructions');
  await expect(how).toContainText('Por transferencia');
  expect(await how.evaluate((node) => [node.tagName, (node as HTMLDetailsElement).open])).toEqual(['DETAILS', false]);
  expect(await how.evaluate((node) => !!(node.compareDocumentPosition(document.querySelector('#moneyTotals')!) & Node.DOCUMENT_POSITION_PRECEDING))).toBe(true);
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
  await expect(page.locator('#moneyStatement .orgpurpose')).toHaveText('Saldo');
  // Sin contrato, el extracto cuenta las facturas enviadas sin pagar.
  await expect(page.locator('#moneyStatement .mb-total')).toContainText('Facturas enviadas sin pagar');
  await expect(page.locator('#moneyStatement .mb-total .mb-amount')).toHaveText(/1\.?100,00/);
  await expect(page.locator('#noContract')).toBeVisible();
  await page.locator('#moneyStatement li.mb-doc .mb-open').first().click();
  await expect(page.locator('#invoiceDocumentView')).toContainText('Factura F2026-0001');
  await expect(page.locator('#docRecipient')).toContainText('Asociación Organiza');
  await expect(page.locator('#docTotal')).toHaveText(/1\.?100,00/);
  await expect(page.locator('#printPage')).toBeVisible();
});

test('organizers · factura registrada con su PDF guardado: «Abrir PDF» lo abre en otra pestaña (K2, portal-files)', async ({ page }) => {
  const reservation = await api.reservation({ title: 'Retiro con factura registrada', confirm: true });
  const invoice = crypto.randomUUID(); const file = crypto.randomUUID();
  // Lecturas de Finance simuladas; el resolutor de `portal-files` (0249) tiene su prueba en tests/invoices/sql.test.ts.
  await page.route('**/api/v1/read/invoices.portal_reservation_money', (route) => route.fulfill({ json: {
    reservation_id: reservation, currency: 'EUR', totals: { invoiced: 500, collected: 0, pending: 500 },
    invoices: [{ id: invoice, number: '2026-0011', issue_date: '2026-10-20', type: 'F2', rectifies: null, base: 500, tax: 0, withholding: 0, total: 500, status: 'registrada', collected: false, collected_at: null, has_document: true, purpose: 'senal' }],
  } }));
  await page.route('**/api/v1/read/invoices.portal_invoice_document', (route) => route.fulfill({ json: {
    id: invoice, number: '2026-0011', issue_date: '2026-10-20', status: 'registrada', document: null,
    files: [{ file_id: file, filename: 'senal.pdf', mime: 'application/pdf', size: 1234 }],
  } }));
  let asked = '';
  await page.route('**/api/v1/portal-files/*', (route) => {
    asked = new URL(route.request().url()).pathname.split('/').pop()!;
    return route.fulfill({ json: { id: file, url: 'https://storage.example.invalid/senal.pdf?token=x', mime: 'application/pdf', filename: 'senal.pdf', size: 1234, expiresAt: new Date(Date.now() + 300_000).toISOString() } });
  });
  // Chromium sin ventana descarga los PDF en lugar de mostrarlos (la pestaña se queda en about:blank): se mira la petición.
  let opened = '';
  await page.context().route('https://storage.example.invalid/**', (route) => { opened = route.request().url(); return route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.4' }); });
  await enter(page, await api.organizerLink([reservation], 'registrada@example.invalid', 'Rosa'));
  await page.locator('#tab-pagos').click();
  await page.locator('#moneyStatement li.mb-doc .mb-open').first().click();
  const sheet = page.locator('#invoiceFiles');
  await expect(sheet).toContainText('Esta factura se hizo con otra herramienta');
  await expect(page.locator('#askInvoice')).toHaveCount(0);
  const popup = page.waitForEvent('popup');
  await sheet.getByRole('button', { name: 'Abrir PDF' }).click();
  await popup;
  await expect.poll(() => opened).toBe('https://storage.example.invalid/senal.pdf?token=x');
  expect(asked).toBe(file);
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

  // Material: enlace al grupo, publicado antes del retiro. Cada apartado tiene su dirección.
  await page.locator('#expnav-materiales').click();
  await expect(page).toHaveURL(/\/experiencia\/materiales$/);
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
  // En la portada, el apartado lo dice con texto: lo ven antes del retiro.
  await page.locator('#expnav-ven').click();
  await expect(page.locator('[data-section="materiales"]')).toContainText('Antes del retiro');
  await expect(page.locator('[data-section="materiales"]')).toContainText('1 publicado');

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
  await expect(page.locator('#offersLine')).toContainText('Cubres gastos a partir de 7 asistentes; esperas 10.');

  // Tres toques rápidos en «+»: la cuenta cambia al momento y se guarda una sola vez (revisión 2).
  const rows = async () => (await api.booking.t.db.query<Record<string, any>>('select * from organizers.offers where reservation_id = $1 and deleted_at is null', [reservation])).rows;
  const more = page.locator('#offersList [data-step="+"]');
  await more.click();
  await more.click();
  await more.click();
  await expect(page.locator('#offersList .orgoffer-count')).toHaveText('Esperas vender 13');
  await expect(page.locator('#offersRevenue')).toHaveText(/5\.?850,00/);
  await expect.poll(async () => { const [o] = await rows(); return [o?.expected, o?.revision]; }, { timeout: 15_000 }).toEqual([13, 2]);

  // Cartel al momento: «Guardar JPG» y, en «Más opciones», la hoja de siempre en el formato elegido.
  await expect(page.locator('#posterPreview')).toBeVisible();
  const quick = page.waitForEvent('download');
  await page.locator('#posterQuickJpg').click();
  expect((await quick).suggestedFilename()).toBe('cartel-retiro-con-cartel.jpg');
  await page.locator('#posterFormats [data-format="a4"]').click();
  await expect(page.locator('#posterFormats [data-format="a4"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#posterOpen').click();
  await expect(page.locator('#posterCanvas')).toBeVisible();
  await expect.poll(() => page.locator('#posterCanvas').evaluate((c: HTMLCanvasElement) => [c.width, c.height])).toEqual([1240, 1754]);
  await page.locator('#poster-format').selectOption('cuadrado');
  await expect.poll(() => page.locator('#posterCanvas').evaluate((c: HTMLCanvasElement) => c.width === c.height)).toBe(true);
  const download = page.waitForEvent('download');
  await page.locator('#posterJpg').click();
  expect((await download).suggestedFilename()).toBe('cartel-retiro-con-cartel.jpg');
});

test('organizers · programa «para quién» (MUELA-065): todos por defecto, algunas personas con sus nombres y solo adultos', async ({ page }) => {
  const reservation = await api.reservation({ title: 'Retiro en familia', confirm: true, start: '2027-05-14', end: '2027-05-16' });
  await enter(page, await api.organizerLink([reservation], 'familia@example.invalid', 'Fina'));
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro en familia');
  for (const name of ['Ana', 'Leo']) {
    await page.goto(`${baseURL}/#/retiro/${reservation}/asistentes/nuevo`);
    await page.locator('#f-first_name').fill(name);
    // La declaración se pide una vez por retiro.
    if (name === 'Ana') await page.locator('#declaration').check();
    await page.locator('#saveNewGuest').click();
    await expect(page.locator('#guestName')).toHaveText(name);
  }

  await page.goto(`${baseURL}/#/retiro/${reservation}/experiencia/programa`);
  await page.locator('[data-add-day="2027-05-15"]').click();
  await expect(page.locator('#pr-audience')).toHaveValue('todos');
  await expect(page.locator('#pr-people')).toBeHidden();
  await page.locator('#pr-title').fill('Taller de barro');
  // Con «Algunas personas» hay que elegir al menos a una.
  await page.locator('#pr-audience').selectOption('personas');
  await expect(page.locator('#pr-people')).toBeVisible();
  await page.locator('#pr-save').click();
  await expect(page.locator('#pr-error')).toContainText('al menos a una persona');
  await page.locator('#pr-people label', { hasText: 'Leo' }).locator('input').check();
  await page.locator('#pr-save').click();
  const row = page.locator('[data-day="2027-05-15"] .orgitem', { hasText: 'Taller de barro' });
  await expect(row.locator('.orgaudience')).toHaveText('Solo: Leo');

  // Se relee de Booking con el mismo público; a «Solo adultos», y la lista de personas se vacía.
  await page.reload();
  await expect(row.locator('.orgaudience')).toHaveText('Solo: Leo');
  await row.locator('.orgitem-main').click();
  await expect(page.locator('#pr-audience')).toHaveValue('personas');
  await expect(page.locator('#pr-people label', { hasText: 'Leo' }).locator('input')).toBeChecked();
  await page.locator('#pr-audience').selectOption('adultos');
  await page.locator('#pr-save').click();
  await expect(row.locator('.orgaudience')).toHaveText('Solo adultos');

  // Lo de siempre, para todos, no lleva etiqueta.
  await page.locator('[data-add-day="2027-05-15"]').click();
  await page.locator('#pr-title').fill('Comida');
  await page.locator('#pr-save').click();
  await expect(page.locator('[data-day="2027-05-15"] .orgitem', { hasText: 'Comida' }).locator('.orgaudience')).toHaveCount(0);
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
  // Guests ya está publicado: la prueba no debe salir a producción (ni mandarle un token de prueba). Se sirve una página vacía.
  await context.route('https://guests.ikisai.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Guests</title>' }));
  const popup = context.waitForEvent('page');
  await page.locator('#expPreviewOpen').click();
  await expect.poll(async () => (await popup).url()).toMatch(/^https:\/\/guests\.ikisai\.com\/i\//);

  // Atrás vuelve al apartado anterior sin salir de la Experiencia.
  await page.bringToFront();
  await page.goBack();
  await expect(page).toHaveURL(/\/experiencia\/alojamiento$/);
  await expect(page.locator('#lodging')).toBeVisible();
});

test('organizers · menú compartido (tanda 26): alérgenos con su nombre y «sin revisar por cocina»', async ({ page }) => {
  const reservation = await api.reservation({ title: 'Retiro con menú', confirm: true, start: '2027-05-14', end: '2027-05-16' });
  await api.menu(reservation, [{ date: '2027-05-15', type: 'comida', time: '14:00', dishes: [
    { name: 'Lasaña de verduras', allergens: ['gluten', 'lacteos'], checked: true },
    { name: 'Tarta de queso', allergens: ['lacteos', 'huevos'], checked: false },
    { name: 'Ensalada de temporada', allergens: [], checked: false },
    { name: 'Arroz blanco', allergens: [], checked: true },
  ] }]);
  await enter(page, await api.organizerLink([reservation], 'menu-alergenos@example.invalid', 'Pablo'));
  await page.locator('#tab-experiencia').click();
  await page.locator('#expnav-menu').click();
  const allergens = (name: string) => page.locator('.orgdish', { hasText: name }).locator('.orgdish-allergens');

  // Revisada: solo los nombres, nunca el código interno.
  await expect(allergens('Lasaña de verduras')).toHaveText('Alérgenos: gluten, lácteos');
  await expect(allergens('Lasaña de verduras').locator('.orgdish-unchecked')).toHaveCount(0);
  // Sin revisar: los declarados y el aviso.
  await expect(allergens('Tarta de queso')).toHaveText('Alérgenos: lácteos, huevo · sin revisar por cocina');
  // Sin revisar y sin ninguno declarado: no se puede leer como «no tiene».
  await expect(allergens('Ensalada de temporada')).toHaveText('Alérgenos: sin revisar por cocina');
  // Revisada y sin alérgenos: nada que avisar.
  await expect(allergens('Arroz blanco')).toHaveCount(0);
  await expect(page.locator('#menu')).not.toContainText('lacteos');
});

test('organizers · cocina contra el menú: platos que declaran un alérgeno del grupo y lo que no se puede comprobar, nunca «apto»', async ({ page }) => {
  const reservation = await api.reservation({ title: 'Retiro con cocina', confirm: true, start: '2027-05-14', end: '2027-05-16' });
  await api.menu(reservation, [{ date: '2027-05-15', type: 'comida', time: '14:00', dishes: [
    { name: 'Tarta de queso', allergens: ['lacteos', 'huevos'], checked: false },
    { name: 'Macedonia con kiwi', allergens: [], checked: true },
    { name: 'Arroz blanco', allergens: [], checked: true },
  ] }]);
  await enter(page, await api.organizerLink([reservation], 'cocina-menu@example.invalid', 'Clara'));
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro con cocina');

  // Dos asistentes con su alergia, por la interfaz: una de la lista europea (lácteos) y otra que no (kiwi).
  for (const [name, subject, severity] of [['Marcos', 'lácteos', 'grave'], ['Eva', 'kiwi', 'moderada']] as const) {
    await page.locator('#tab-asistentes').click();
    await page.locator('#addGuest').click();
    await page.locator('#f-first_name').fill(name);
    if (await page.locator('#declaration').count()) await page.locator('#declaration').check();
    await page.locator('#saveNewGuest').click();
    await expect(page.locator('#guestName')).toHaveText(name);
    await page.locator('#addRestriction').click();
    await page.locator('.orgrestriction .r-subject').fill(subject);
    await page.locator('.orgrestriction .r-severity').selectOption(severity);
    await expect(page.locator('#saveState')).toContainText('Guardado');
    await page.locator('#backToGuests').click();
  }

  await page.locator('#tab-cocina').click();
  const tarta = page.locator('#kitchenMenu [data-dish]', { hasText: 'Tarta de queso' });
  await expect(tarta).toContainText('Declara lácteos');
  // La gravedad, solo junto al nombre compartido; en el recuento, nunca.
  await expect(tarta).toContainText('Marcos (Alergia a lácteos · grave)');
  await expect(page.locator('#kitchenSummary')).toHaveText('2 alergias o intolerancias en el grupo');
  await expect(page.locator('#kitchenCheck')).toContainText('1 plato del menú declara un alérgeno de tu grupo');
  await expect(page.locator('#kitchenCheck')).toContainText('1 plato aún sin revisar por cocina.');
  // Lo que no es de la lista europea: «no se puede comprobar», y el nombre del plato solo como pista.
  await expect(page.locator('#kitchenUnverifiable')).toContainText('kiwi');
  await expect(page.locator('#kitchenUnverifiable')).toContainText('no se puede comprobar: lo revisa cocina');
  await expect(page.locator('#kitchenMenu [data-dish]', { hasText: 'Macedonia con kiwi' })).toContainText('Pista: el plato menciona «kiwi» · no se puede comprobar: lo revisa cocina.');
  await expect(page.locator('#kitchenMenu [data-dish]', { hasText: 'Arroz blanco' }).locator('.orgkdish-hit, .orgkdish-hint')).toHaveCount(0);
  expect(await page.locator('#kitchen').textContent()).not.toMatch(/\bapto\b|✓/i);
});

test('organizers · asistentes por grupos: enviar el enlace desde la fila, recuento por grupo y «Recordar» con el enlace de la sesión', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const reservation = await api.reservation({ title: 'Retiro por grupos', confirm: true });
  const link = await api.organizerLink([reservation], 'grupos@example.invalid', 'Gala');
  const post = async (path: string, body: unknown, bearer?: string) => (await fetch(`${api.url}/api/v1${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) })).json();
  const session = await post('/auth/link', { token: link });
  const ana = crypto.randomUUID();
  const bea = crypto.randomUUID();
  for (const [id, name] of [[ana, 'Ana'], [bea, 'Bea']]) {
    await post('/invoke/booking.portal_add_guest', { reservation_id: reservation, guest_id: id, fields: { first_name: name }, declaration: true, declaration_version: 'org-v1' }, session.token);
  }
  await enter(page, link);
  await page.locator('#tab-asistentes').click();
  await expect(page.locator('#guestRows [data-group="sinenlace"] .worst-count')).toHaveText('2');
  await expect(page.locator('#guestSeats button')).toHaveCount(2);

  // «Enviar su enlace» desde la fila: el enlace se ve una vez y Ana pasa a «No han abierto su enlace».
  await page.locator(`#guestRows [data-id="${ana}"] [data-act="sinenlace"]`).click();
  await expect(page.locator('#shareText')).toContainText('https://guests.ikisai.com/i/');
  const url = (await page.locator('#shareText').inputValue()).match(/https:\/\/\S+/)![0];
  await page.keyboard.press('Escape');
  await expect(page.locator('#guestRows [data-stage="sinabrir"]')).toContainText('Ana');
  await expect(page.locator('#guestRows [data-group="sinenlace"] .worst-count')).toHaveText('1');
  await expect(page.locator('#guestRows [data-group="sinabrir"] .worst-count')).toHaveText('1');

  // «Recordar» copia el recordatorio con el enlace de esta sesión.
  await page.locator(`#guestRows [data-id="${ana}"] [data-act="recordar"]`).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(url);

  // Intro sobre la acción no abre la ficha (la acción va primero).
  await page.locator(`#guestRows [data-id="${ana}"] [data-act="recordar"]`).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/asistentes$/);

  // Fila desfasada: otra sesión le envió un enlace a Bea; al enviar, se pide «Crear enlace nuevo».
  await post('/portal-links', { app: 'guests', scope: { reservation_id: reservation, guest_id: bea }, person: { name: 'Bea' }, label: 'Bea', replace: true }, session.token);
  await page.locator(`#guestRows [data-id="${bea}"] [data-act="sinenlace"]`).click();
  await page.getByRole('button', { name: 'Crear enlace nuevo' }).click();
  await expect(page.locator('#shareText')).toContainText('https://guests.ikisai.com/i/');
  await page.keyboard.press('Escape');
  await expect(page.locator('#guestRows [data-group="sinabrir"] .worst-count')).toHaveText('2');

  // La hoja rápida de una plaza: su etapa escrita y «Abrir la ficha».
  await page.locator(`#guestSeats [data-guest="${bea}"]`).click();
  await expect(page.locator('#guestQuick')).toContainText('No han abierto su enlace');
  await page.locator('#guestQuick').getByRole('button', { name: 'Abrir la ficha' }).click();
  await expect(page.locator('#guestName')).toHaveText('Bea');
});

test('organizers · experiencia por ruta: cada apartado tiene su dirección, con el foco en su título; Atrás vuelve', async ({ page }) => {
  const reservation = await api.reservation({ title: 'Retiro con rutas', confirm: true });
  await enter(page, await api.organizerLink([reservation], 'rutas@example.invalid', 'Rita'));
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro con rutas');

  await page.goto(`${baseURL}/#/retiro/${reservation}/experiencia/preguntas`);
  await expect(page.locator('#expQuestions')).toBeVisible();
  await expect(page.locator('#expQuestions h3')).toBeFocused();
  await expect(page.locator('#expnav-preguntas')).toHaveAttribute('aria-current', 'page');

  // La portada: lo siguiente (el programa está por hacer) y los tres momentos.
  await page.locator('#expnav-ven').click();
  await expect(page).toHaveURL(/\/experiencia\/ven$/);
  await expect(page.locator('#expNext')).toContainText('Añade la primera actividad');
  await expect(page.locator('.orgexp-moment > h3')).toHaveText(['Antes del retiro', 'Durante el retiro', 'Después del retiro']);
  await expect(page.locator('[data-section="preguntas"]')).toContainText('Vacío');

  // «Abrir» de lo siguiente lleva al programa por su dirección; Atrás vuelve a la portada.
  await page.locator('#expNext .step-next').click();
  await expect(page).toHaveURL(/\/experiencia\/programa$/);
  await expect(page.locator('#program')).toBeVisible();
  await page.goBack();
  await expect(page.locator('#expNext')).toBeVisible();

  // Un apartado solo vale tras «experiencia»: lo demás va a Mis retiros.
  await page.goto(`${baseURL}/#/retiro/${reservation}/asistentes/programa`);
  await expect(page.locator('.orgretreat')).toContainText('Retiro con rutas');
});

test('organizers · supletorias (Booking §25): «N de M» con − / + y su precio, reparto en una supletoria y pendiente con la propuesta aceptada', async ({ page }) => {
  const reservation = await api.reservation({ title: 'Retiro con supletorias', confirm: true });
  const room = await api.room(reservation, { name: 'Hab 1', beds: 2, extra: 2, enSuite: true });
  await api.seedRates();
  const proposal = await api.sendProposal(reservation, 20);
  const link = await api.organizerLink([reservation], 'supletorias-ui@example.invalid', 'Sara');

  // Una asistente para repartir, dada de alta con una sesión propia del mismo enlace.
  const post = async (path: string, body: unknown, bearer?: string) => (await fetch(`${api.url}/api/v1${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) })).json();
  const session = await post('/auth/link', { token: link });
  const guest = crypto.randomUUID();
  await post('/invoke/booking.portal_add_guest', { reservation_id: reservation, guest_id: guest, fields: { first_name: 'Marta' }, declaration: true, declaration_version: 'org-v1' }, session.token);
  await enter(page, link);

  await page.locator('#tab-experiencia').click();
  await page.locator('#expnav-alojamiento').click();
  const hab = page.locator(`.orgroom[data-space="${room.spaceId}"]`);
  const counter = hab.locator('.orgextra-count');
  await expect(counter).toHaveText('0 de 2');
  await expect(hab.locator('.orgextra-beds')).toContainText('por noche · Se añade a tu presupuesto');
  await expect(hab.locator('.orgbed')).toHaveCount(2);

  // Activa las dos: salen en el reparto marcadas «supletoria», y «+» se apaga.
  await hab.locator('[data-action="extra-plus"]').click();
  await expect(counter).toHaveText('1 de 2');
  await hab.locator('[data-action="extra-plus"]').click();
  await expect(counter).toHaveText('2 de 2');
  await expect(hab.locator('[data-action="extra-plus"]')).toBeDisabled();
  await expect(hab.locator('.orgbed')).toHaveCount(4);
  await expect(hab.locator(`.orgbed[data-bed="${room.extra[0]}"]`)).toContainText('supletoria');

  // Reparto: Marta en la supletoria 1; ocupada, no se puede quitar.
  await hab.locator(`.orgbed[data-bed="${room.extra[0]}"]`).click();
  await page.locator('#bed-guest').selectOption(guest);
  await page.locator('#bed-save').click();
  await expect(hab.locator(`.orgbed[data-bed="${room.extra[0]}"]`)).toContainText('Marta');
  await hab.locator('[data-action="extra-minus"]').click();
  await hab.locator('[data-action="extra-minus"]').click();
  await expect(page.locator('.toast.show')).toContainText('ocupadas');
  await expect(counter).toHaveText('1 de 2');

  // Con la propuesta aceptada, lo nuevo queda pendiente de Ikisai.
  await api.acceptProposal(proposal);
  await page.reload();
  await page.locator('#expnav-alojamiento').click();
  await expect(page.locator('#lodgingExtraPending')).toContainText('quedarán pendientes de Ikisai');
  await expect(hab.locator('.orgextra-pending')).toHaveCount(0);
  await hab.locator('[data-action="extra-plus"]').click();
  await expect(counter).toHaveText('2 de 2');
  await expect(hab.locator('.orgextra-pending')).toContainText('Pendiente de Ikisai: 1 supletoria más.');
});

test('organizers · solicitudes para apuntarse (Booking §26.3): aviso en Resumen, aceptar con mensaje y descartar', async ({ page }) => {
  const reservation = await api.reservation({ title: 'Retiro abierto a huéspedes', confirm: true, guests: 12 });
  await api.joinRequest(reservation, ['Marta', 'Nico'], '¿Queda sitio para dos?');
  await api.joinRequest(reservation, ['Iker']);
  const link = await api.organizerLink([reservation], 'apuntarme-ui@example.invalid', 'Sara');
  await enter(page, link);

  // Resumen: el paso con cuántas solicitudes y personas, y el número en la pestaña.
  await expect(page.locator('#goJoins')).toContainText('3 personas piden apuntarse a tu retiro.');
  await expect(page.locator('#goJoins')).toContainText('Decidir 2 solicitudes para apuntarse');
  await expect(page.locator('#tab-asistentes .orgtab-count')).toHaveText('2');
  await page.locator('#goJoins').click();
  const joins = page.locator('#joinRequests');
  await expect(joins.locator('.orgjoin')).toHaveCount(2);
  const pair = joins.locator('.orgjoin', { hasText: 'Marta y Nico' });
  await expect(pair).toContainText('2 personas');
  await expect(pair.locator('.orgjoin-message')).toHaveText('¿Queda sitio para dos?');

  // Aceptar con mensaje: el aviso de plazas, y las dos personas pasan a la lista.
  await pair.locator('[data-action="join-accept"]').click();
  await expect(page.locator('#joinSheet')).toContainText('¿Aceptar a Marta y Nico?');
  await expect(page.locator('#join-seats')).toContainText('Ahora tienes 0 asistentes de 12 plazas; con esta solicitud serían 2.');
  await page.locator('#join-comment').fill('¡Bienvenidos!');
  await page.locator('#join-confirm').click();
  await expect(page.locator('.toast.show')).toContainText('ya están en tus asistentes');
  await expect(page.locator('#guestRows')).toContainText('Marta');
  await expect(page.locator('#guestRows')).toContainText('Nico');
  // Aún sin enlace: caen en «Sin enlace», con su recuento; y la línea de quien espera plaza.
  await expect(page.locator('#guestRows [data-group="sinenlace"] .worst-count')).toHaveText('2');
  await expect(page.locator('.orgseat-waiting')).toContainText('1 persona espera plaza');
  await expect(page.locator('#tab-asistentes .orgtab-count')).toHaveText('1');

  // Descartar: nadie entra, y queda en «Ya decididas» con su estado.
  await joins.locator('.orgjoin', { hasText: 'Iker' }).locator('[data-action="join-discard"]').click();
  await expect(page.locator('#joinSheet')).toContainText('¿Descartar la solicitud de Iker?');
  await page.locator('#join-confirm').click();
  await expect(joins.locator('#joinNone')).toBeVisible();
  await expect(page.locator('#tab-asistentes .orgtab-count')).toHaveCount(0);
  await expect(page.locator('#guestRows')).not.toContainText('Iker');
  await joins.locator('#joinHistory summary').click();
  await expect(joins.locator('#joinHistory')).toContainText('Ya decididas (2)');
  await expect(joins.locator('#joinHistory li', { hasText: 'Marta y Nico' })).toContainText('Aceptada · ¡Bienvenidos!');
  await expect(joins.locator('#joinHistory li', { hasText: 'Iker' })).toContainText('Descartada');

  // En Resumen ya no hay paso de solicitudes.
  await page.locator('#tab-resumen').click();
  await expect(page.locator('#summaryGuests')).toBeVisible();
  await expect(page.locator('#goJoins')).toHaveCount(0);
});

test('organizers · mis retiros: pasados y cancelados plegados aparte; el cancelado lo dice con texto', async ({ page }) => {
  const next = await api.reservation({ title: 'Retiro que viene', confirm: false, start: '2027-05-07', end: '2027-05-09' });
  const past = await api.draftReservation({ title: 'Retiro del año pasado', status: 'en_estudio', start_date: '2025-05-02', end_date: '2025-05-04' });
  const lost = await api.draftReservation({ title: 'Retiro perdido', status: 'perdida' });
  // Se entra con el enlace del último retiro (el que viene): los de un retiro pasado o perdido ya han caducado.
  await enter(page, await api.organizerLink([past, lost, next], 'pasados@example.invalid', 'Olga'));

  // Dos no cancelados: no se abre ninguna ficha sola.
  await expect(page.locator('#retreats')).toBeVisible();
  const list = page.locator('#retreats > .orgcards > .orgretreat');
  await expect(list).toHaveCount(1);
  await expect(page.locator('#retreatTitle')).toHaveCount(0);
  await expect(list).toContainText('Retiro que viene');
  const folds = page.locator('#retreats details.orgfold');
  await expect(folds).toHaveCount(2);
  await expect(folds.nth(0).locator('summary')).toHaveText('Pasados · 1');
  await expect(folds.nth(1).locator('summary')).toHaveText('Cancelados · 1');
  expect(await folds.evaluateAll((nodes) => nodes.map((n) => (n as HTMLDetailsElement).open))).toEqual([false, false]);
  await expect(folds.nth(0)).toContainText('Retiro del año pasado');
  const cancelled = folds.nth(1).locator('.orgretreat');
  await expect(cancelled).toBeHidden();
  await expect(cancelled).toContainText('Retiro perdido');
  await expect(cancelled).toContainText('Cancelada');
  await expect(cancelled).toContainText('Cancelado: ya no sigue adelante.');
  await folds.nth(1).locator('summary').click();
  await expect(cancelled).toBeVisible();
  // El resumen de cada pliegue se toca con comodidad (46 px).
  expect((await folds.nth(1).locator('summary').boundingBox())!.height).toBeGreaterThanOrEqual(46);
});

/** Número de portadas guardadas en el dispositivo (IndexedDB de Organizers). */
const storedCovers = (page: Page) => page.evaluate(() => new Promise<number>((resolve) => {
  const open = indexedDB.open('ikisai-organizers');
  open.onerror = () => resolve(-1);
  open.onsuccess = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains('images')) { db.close(); resolve(-1); return; }
    const count = db.transaction('images').objectStore('images').count();
    count.onsuccess = () => { db.close(); resolve(count.result); };
  };
}));

test('organizers · cerrar sesión en el móvil: botón visible de 46 px; al salir se borran las portadas guardadas', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'es-ES' });
  await context.addInitScript(() => { try { localStorage.setItem('ikisai-install-dismissed:organizers', String(Date.now())); } catch { /* */ } });
  const page = await context.newPage();
  const reservation = await api.reservation({ title: 'Retiro para salir', confirm: true });
  await enter(page, await api.organizerLink([reservation], 'salir@example.invalid', 'Rita'));
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro para salir');

  const button = page.locator('#logoutButton');
  await expect(button).toBeVisible();
  const box = (await button.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(46);
  expect(box.height).toBeGreaterThanOrEqual(46);

  // Una portada guardada de esta persona (la clave lleva su id, que sale de sus lecturas guardadas).
  const stored = await page.evaluate(() => new Promise<boolean>((resolve) => {
    const open = indexedDB.open('ikisai-organizers');
    open.onerror = () => resolve(false);
    open.onsuccess = () => {
      const db = open.result;
      const read = db.transaction('reads').objectStore('reads').getAll();
      read.onsuccess = () => {
        const userId = (read.result as Array<{ userId: string }>)[0]?.userId;
        if (!userId) { db.close(); resolve(false); return; }
        const put = db.transaction('images', 'readwrite').objectStore('images')
          .put({ key: `${userId}|cover|prueba`, userId, at: new Date().toISOString(), value: { fileId: 'f', blob: new Blob(['x'], { type: 'image/png' }), mime: 'image/png' } });
        put.onsuccess = () => { db.close(); resolve(true); };
        put.onerror = () => { db.close(); resolve(false); };
      };
    };
  }));
  expect(stored).toBe(true);
  await expect.poll(() => storedCovers(page)).toBe(1);

  await button.click();
  await page.getByRole('button', { name: 'Salir' }).click();
  await expect(page.locator('#entryTitle')).toHaveText('Entra con tu enlace');
  await expect.poll(() => storedCovers(page)).toBe(0);
  await context.close();
});

test('organizers · menú lateral: la marca abre el cajón con «Este retiro», tus retiros, ayuda y «Cerrar sesión»; «‹ Volver a…» desde otra app', async ({ page }) => {
  const reservation = await api.reservation({ title: 'Retiro del menú', confirm: true });
  const other = await api.reservation({ title: 'Otro retiro del menú', confirm: true });
  await enter(page, await api.organizerLink([reservation, other], 'menu-lateral@example.invalid', 'Lola'));
  await page.locator('.orgretreat', { hasText: 'Retiro del menú' }).first().click();
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro del menú');

  // «Este retiro»: las mismas pestañas de la ficha; una fila lleva a la pestaña y cierra el cajón.
  await page.locator('#appLauncher').click();
  const drawer = page.locator('.appmenu-drawer');
  await expect(drawer).toBeVisible();
  await expect(page.locator('#appLauncher')).toHaveAttribute('aria-expanded', 'true');
  await drawer.locator('.appmenu-tile', { hasText: 'Retiro del menú' }).click();
  await drawer.getByRole('link', { name: 'Asistentes' }).click();
  await expect(page).toHaveURL(new RegExp(`#/retiro/${reservation}/asistentes$`));
  await expect(drawer).toBeHidden();

  // Tus retiros, «Ayuda y sugerencias» del lanzador y «Cerrar sesión» del kit; Escape cierra.
  await page.locator('#appLauncher').click();
  await drawer.locator('.appmenu-tile', { hasText: 'Mis retiros' }).click();
  await expect(drawer.getByRole('link', { name: /Otro retiro del menú/ })).toBeVisible();
  await expect(drawer.locator('.launcher-center')).toBeVisible();
  await expect(drawer.locator('.appmenu-logout button')).toContainText('Cerrar sesión');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  // En la cabecera sigue un solo «Cerrar sesión», el del kit (0.49), con el id de feedback de Organizers.
  await expect(page.locator('#logoutButton')).toHaveCount(1);
  await expect(page.locator('#logoutButton')).toHaveAttribute('data-feedback-id', 'organizers.cabecera.cerrar_sesion');

  // Llegar desde otra app con «volver»: «‹ Volver a Booking» arriba, y la URL queda limpia.
  const base = page.url().split('#')[0]!.split('?')[0]!;
  await page.goto(`${base}?volver=${encodeURIComponent('https://booking.ikisai.com/#/reservas')}&titulo=Booking#/`);
  const back = page.locator('.return-link');
  await expect(back).toContainText('Booking');
  await expect(back).toHaveAttribute('href', 'https://booking.ikisai.com/#/reservas');
  expect(page.url()).not.toContain('volver=');
});

test('organizers · guarda tu acceso: botón compacto en Mis retiros y en la ficha, oculto en Diseño; sin desplazamiento lateral', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'es-ES' });
  await context.addInitScript(() => { try { localStorage.setItem('ikisai-install-dismissed:organizers', String(Date.now())); } catch { /* */ } });
  const page = await context.newPage();
  const reservation = await api.draftReservation({ title: 'Retiro con acceso guardado' });
  await enter(page, await api.organizerLink([reservation], 'acceso@example.invalid', 'Alba'));
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro con acceso guardado');
  const access = page.locator('#saveAccess');
  await expect(access).toBeVisible();
  const box = (await access.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(46);
  expect(box.height).toBeGreaterThanOrEqual(46);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.locator('#tab-diseno').click();
  await expect(page.locator('#designPeople')).toBeVisible();
  await expect(access).toBeHidden();

  await page.locator('#backToRetreats').click();
  await expect(page.locator('.orgretreat')).toContainText('Retiro con acceso guardado');
  await expect(access).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await access.click();
  await expect(page.locator('#accessSheet')).toBeVisible();
  await context.close();
});
