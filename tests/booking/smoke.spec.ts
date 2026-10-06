/**
 * Humo de Ikisai Booking (esqueleto): login → bootstrap → espejo local → crear y editar reservas sin red → sincronizar.
 *
 * Cómo correrlo:   npx playwright test tests/booking            (desde la raíz del repo)
 * Compila la app con la API de Vite, la sirve con `vite preview` y reenvía /api a una API falsa en memoria (fake-api.ts).
 */
import { expect, test } from 'playwright/test';
import { EVENTS, FINANCE, GUESTS, RESERVATIONS, RESTRICTIONS, CHECKLIST, USER, inDays, login as loginTo, startHarness, type Harness } from './harness.ts';

let harness: Harness;
let api: Harness['api'];
let baseURL: string;
const login = (page: Parameters<typeof loginTo>[0]) => loginTo(page, baseURL);

test.beforeAll(async () => {
  harness = await startHarness();
  api = harness.api;
  baseURL = harness.baseURL;
});

test.afterAll(async () => {
  await harness?.close();
});

test('login → Inicio → reservas sin red → sincronizar', async ({ page, context }) => {
  test.setTimeout(120_000);

  await test.step('login contra la API, bootstrap y las cuatro entradas de navegación', async () => {
    await login(page);
    await expect(page.locator('#syncStatus')).toContainText('En línea');
    expect(api.requests.some((r) => r.path.startsWith('/api/v1/bootstrap'))).toBeTruthy();
    expect(api.requests.some((r) => r.path.startsWith('/api/v1/snapshot'))).toBeTruthy();
    for (const label of ['Inicio', 'Reservas', 'Calendario', 'Huéspedes']) await expect(page.locator('.nav').getByText(label, { exact: true })).toBeVisible();
    await expect(page.getByText('No hay pre-reservas ni reservas confirmadas próximas.')).toBeVisible();
  });

  await test.step('lista vacía de reservas', async () => {
    await page.locator('.nav').getByText('Reservas', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Reservas', level: 2 })).toBeVisible();
    await expect(page.getByText('Todavía no hay reservas')).toBeVisible();
  });

  await test.step('la app explica qué falta para pre-reservar', async () => {
    await page.getByRole('button', { name: 'Nueva reserva' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nueva reserva' });
    await expect(dialog).toBeVisible();
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.locator('#reservationError')).toContainText('«title»');
    await dialog.getByLabel('Nombre del grupo o evento').fill('Retiro Test');
    await dialog.getByLabel('Estado').selectOption('pre_reservada');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.locator('#reservationError')).toContainText('falta la fecha de entrada');
    expect(api.rows(RESERVATIONS)).toHaveLength(0);
  });

  await test.step('crear la pre-reserva y verla confirmada por el servidor, con su fila de importes', async () => {
    const dialog = page.getByRole('dialog', { name: 'Nueva reserva' });
    await dialog.getByLabel('Entrada').fill(inDays(10));
    await dialog.getByLabel('Salida').fill(inDays(12));
    await dialog.getByLabel('Personas previstas').fill('20');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(dialog).toBeHidden();

    const row = page.locator('#reservationList .row', { hasText: 'Retiro Test' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('20 personas');
    await expect(row).toContainText('2 noches');
    await expect(row).toContainText('Pre-reserva');
    await expect(row).toHaveAttribute('data-pending', 'false');
    await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');

    const rows = api.rows(RESERVATIONS);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Retiro Test', status: 'pre_reservada', expected_guests: 20, start_date: inDays(10), revision: 1 });
    expect(api.rows(FINANCE).map((r) => r.id)).toEqual([rows[0]!.id]);
  });

  await test.step('recargar: sigue en el espejo local; Inicio la lista como próxima; filtros y búsqueda', async () => {
    await page.reload();
    await expect(page.locator('#reservationList .row', { hasText: 'Retiro Test' })).toBeVisible();
    await page.locator('.nav').getByText('Inicio', { exact: true }).click();
    await expect(page.locator('#upcomingList .row', { hasText: 'Retiro Test' })).toBeVisible();
    await expect(page.locator('#notices')).toContainText('pre-reserva pendiente de confirmar');
    await page.locator('.nav').getByText('Reservas', { exact: true }).click();
    await page.locator('.filters').getByRole('button', { name: 'Canceladas' }).click();
    await expect(page.getByText('Ninguna reserva coincide')).toBeVisible();
    await page.locator('.filters').getByRole('button', { name: 'Pre-reservas' }).click();
    await page.getByLabel('Buscar reservas').fill('yoga');
    await expect(page.getByText('Ninguna reserva coincide')).toBeVisible();
    await page.getByLabel('Buscar reservas').fill('retiro');
    await expect(page.locator('#reservationList .row')).toHaveCount(1);
  });

  await test.step('ficha sin red: editar y ver «pendiente»; al volver la red solo viaja el campo cambiado', async () => {
    await page.getByRole('button', { name: 'Abrir Retiro Test' }).click();
    await expect(page.getByRole('heading', { name: 'Retiro Test', level: 2 })).toBeVisible();
    await expect(page.locator('#blockOperation')).toContainText('se crea al confirmar');
    await context.setOffline(true);
    await expect(page.locator('#syncStatus')).toContainText('Sin conexión');

    await page.locator('#editReservation').click();
    const dialog = page.getByRole('dialog', { name: 'Editar reserva' });
    await expect(dialog).toContainText('Revisión 1');
    await expect(page.locator('#saveRow')).toBeHidden(); // «Guardar» solo aparece con cambios
    await dialog.getByLabel('Personas previstas').fill('22');
    await dialog.getByLabel('Teléfono').fill('600 000 000');
    await page.locator('#saveRow').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#blockSummary')).toContainText('22 previstas');
    await expect(page.locator('.ficha .chip.pending')).toBeVisible();
    await expect(page.locator('#syncStatus')).toContainText('1 cambio pendiente');
    expect(api.rows(RESERVATIONS)[0]!.expected_guests).toBe(20);

    await context.setOffline(false);
    await page.waitForFunction(() => navigator.onLine);
    await page.getByRole('button', { name: 'Sincronizar ahora' }).click();
    await expect(page.locator('.ficha .chip.pending')).toHaveCount(0, { timeout: 15_000 });
    expect(api.rows(RESERVATIONS)[0]).toMatchObject({ expected_guests: 22, contact_phone: '600 000 000', revision: 2, status: 'pre_reservada', title: 'Retiro Test' });
  });

  await test.step('confirmar crea el evento operativo; editar la operación', async () => {
    await page.locator('#confirmReservation').click();
    await page.locator('.dialog').getByRole('button', { name: 'Confirmar', exact: true }).click();
    await expect(page.locator('#statusChip')).toHaveText('Confirmada', { timeout: 15_000 });
    await expect(page.locator('#blockOperation')).toContainText('EVT_TEST_001');
    await expect(page.locator('#confirmReservation')).toHaveCount(0);

    await page.locator('#editOperation').click();
    const dialog = page.getByRole('dialog', { name: 'Operación' });
    await dialog.getByLabel('Hora de llegada').fill('17:00');
    await dialog.getByLabel('Hora de salida').fill('12:00');
    await dialog.getByLabel('Personas finales').fill('23');
    await page.locator('#saveRow').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#blockOperation')).toContainText('17:00');
    await expect(page.locator('#blockSummary')).toContainText('23 finales');
    await expect.poll(() => api.rows(EVENTS)[0]).toMatchObject({ arrival_time: '17:00', departure_time: '12:00', final_guests: 23, revision: 2 });
  });

  await test.step('checklist base, una restricción y el cobro', async () => {
    await page.locator('#seedChecklist').click();
    await expect(page.locator('#blockChecklist .checklist li')).toHaveCount(20);
    await page.locator('#blockChecklist').getByRole('checkbox', { name: 'Wifi operativo' }).check();
    await expect.poll(() => api.rows(CHECKLIST).filter((item) => item.status === 'hecho').map((item) => item.label)).toEqual(['Wifi operativo']);
    await page.locator('#seedChecklist').click();
    await expect.poll(() => api.rows(CHECKLIST).length).toBe(20); // no duplica

    await page.locator('#addRestriction').click();
    let dialog = page.getByRole('dialog', { name: 'Nueva restricción' });
    await dialog.getByLabel('Tipo').selectOption('alergia');
    await page.locator('#saveRow').click();
    await expect(dialog.locator('.formerror')).toContainText('«subject»'); // una alergia exige el alérgeno
    await dialog.getByLabel('Alérgeno o producto').fill('pistacho');
    await dialog.getByLabel('Gravedad').selectOption('grave');
    await page.locator('#saveRow').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#restrictionSummary')).toHaveText('1 alergia a pistacho');
    await expect.poll(() => api.rows(RESTRICTIONS)[0]).toMatchObject({ restriction_type: 'alergia', subject: 'pistacho', severity: 'grave', servings: 1, active: true });

    await page.locator('#editFinance').click();
    dialog = page.getByRole('dialog', { name: 'Cobro' });
    await dialog.getByLabel('Señal requerida (€)').fill('300');
    await dialog.getByLabel('Señal pagada (€)').fill('100.50');
    await page.locator('#saveRow').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#blockFinance')).toContainText('Parcial');
    await expect.poll(() => api.rows(FINANCE)[0]).toMatchObject({ deposit_required: 300, deposit_paid: 100.5 });
  });

  await test.step('huéspedes: alta, qué falta para SES y firma en pantalla con adjunto', async () => {
    await page.locator('#openGuests').click();
    await expect(page.getByRole('heading', { name: 'Huéspedes', level: 2 })).toBeVisible();
    await expect(page.getByText('Nadie registrado todavía')).toBeVisible();
    await page.locator('#newGuest').click();
    let dialog = page.getByRole('dialog', { name: 'Nuevo huésped' });
    await dialog.getByLabel('Nombre', { exact: true }).fill('Persona');
    await dialog.getByLabel('Primer apellido').fill('Sintética');
    await dialog.getByLabel('Tipo de documento').selectOption('DNI');
    await dialog.getByLabel('Número de documento').fill('00000000t');
    await expect(page.locator('#sesMissing')).toContainText('segundo apellido');
    await expect(page.locator('#sesMissing')).toContainText('número de soporte');
    await dialog.getByLabel('Estado de los datos').selectOption('datos_revisados');
    await page.locator('#saveRow').click();
    await expect(dialog.locator('.formerror')).toContainText('Para dar los datos por revisados falta');
    await dialog.getByLabel('Estado de los datos').selectOption('datos_recibidos');
    await page.locator('#saveRow').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#guestList .row', { hasText: 'Persona Sintética' })).toContainText('faltan datos para SES');
    await expect.poll(() => api.rows(GUESTS)[0]).toMatchObject({ first_name: 'Persona', document_number: '00000000T', data_status: 'datos_recibidos', nationality: 'ESP' });

    await page.getByRole('button', { name: 'Editar Persona Sintética' }).click();
    await page.locator('#signOnScreen').click();
    dialog = page.getByRole('dialog', { name: 'Firma del parte de entrada' });
    await expect(dialog).toContainText('No se guarda copia de tu documento');
    await page.locator('#saveSignature').click();
    await expect(dialog.locator('.formerror')).toHaveText('Falta la firma en el recuadro.');
    const box = (await page.locator('#signaturePad').boundingBox())!;
    await page.mouse.move(box.x + 30, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 30, { steps: 6 });
    await page.mouse.move(box.x + 220, box.y + box.height - 30, { steps: 6 });
    await page.mouse.up();
    await page.locator('#saveSignature').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#guestList .row', { hasText: 'Persona Sintética' })).toContainText('Firmado');
    // el marcador {"$blob": …} se sustituyó por el id del archivo subido y verificado
    await expect.poll(() => { const file = api.uploads()[0]; return !!file && api.rows(GUESTS)[0]!.signature_file_id === file.id; }, { timeout: 15_000 }).toBe(true);
    expect(api.uploads()[0]).toMatchObject({ mime: 'image/png' });
    expect(api.uploads()[0]!.size).toBeGreaterThan(200);
    expect(api.rows(GUESTS)[0]).toMatchObject({ signed_by_name: 'Persona Sintética', revision: 2 });
  });

  await test.step('restricción de un huésped desde su ficha: guest_id y sin servings', async () => {
    await page.getByRole('button', { name: 'Editar Persona Sintética' }).click();
    const dialog = page.getByRole('dialog', { name: 'Persona Sintética' });
    await expect(dialog.locator('#guestRestrictions')).toContainText('Ninguna registrada.');
    await dialog.locator('#addGuestRestriction').click();
    const sheet = page.getByRole('dialog', { name: 'Nueva restricción' });
    await expect(sheet.getByLabel('Número de personas')).toHaveCount(0);
    await sheet.getByLabel('Tipo').selectOption('sin_gluten');
    await page.locator('#saveRow').click();
    await expect(sheet).toBeHidden();
    await expect.poll(() => api.rows(RESTRICTIONS).find((r) => r.guest_id !== null && r.guest_id !== undefined)).toMatchObject({ guest_id: api.rows(GUESTS)[0]!.id, servings: null, restriction_type: 'sin_gluten' });
  });

  await test.step('justificante de SES como archivo: el marcador se sustituye por el id', async () => {
    await page.getByRole('button', { name: 'Editar Persona Sintética' }).click();
    await page.getByRole('dialog', { name: 'Persona Sintética' }).getByLabel('Número de soporte').fill('ABC123456');
    await page.getByRole('dialog', { name: 'Persona Sintética' }).getByLabel('Segundo apellido').fill('Ficticia');
    for (const [name, value] of [['Fecha de nacimiento', '1990-01-01'], ['Dirección', 'Calle Ficticia 1'], ['Código postal', '00000'], ['Municipio', 'Lugar Ficticio'], ['Teléfono', '600000000']] as const) {
      await page.getByRole('dialog', { name: 'Persona Sintética' }).getByLabel(name, { exact: true }).fill(value);
    }
    await page.getByRole('dialog', { name: 'Persona Sintética' }).getByLabel('Estado de los datos').selectOption('datos_revisados');
    await page.locator('#saveRow').click();
    await expect.poll(() => api.rows(GUESTS)[0]!.data_status).toBe('datos_revisados');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.locator('#sesQueue')).toBeVisible();
    await page.getByRole('button', { name: /Marcar listo para envío/ }).click();
    await expect.poll(() => api.rows(GUESTS)[0]!.ses_status).toBe('listo_para_envio');
    // hoja «Datos para SES»: los datos del viajero y de la transacción, cada uno con su botón de copiar
    await page.getByRole('button', { name: /Datos para SES de Persona/ }).click();
    const sesData = page.getByRole('dialog', { name: /Datos para SES/ });
    for (const text of ['00000000T', 'ABC123456', 'Ficticia', 'Calle Ficticia 1', '17:00', '12:00']) await expect(sesData).toContainText(text);
    expect(await sesData.getByRole('button', { name: /Copiar/ }).count()).toBeGreaterThan(10);
    await page.keyboard.press('Escape');
    await expect(sesData).toBeHidden();
    await page.getByRole('button', { name: /Registrar envío de Persona/ }).click();
    const dialog = page.getByRole('dialog', { name: /Envío a SES/ });
    await dialog.locator('#receiptFile').setInputFiles({ name: 'justificante.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 justificante sintético, contenido de prueba para el humo '.repeat(8)) });
    await page.locator('#saveRow').click();
    await expect(dialog).toBeHidden();
    const receipt = () => api.uploads().find((u) => u.filename === 'justificante.pdf');
    // se compara dentro del sondeo: el id del archivo no existe hasta que termina la subida
    await expect.poll(() => { const file = receipt(); return !!file && api.rows(GUESTS)[0]!.ses_receipt_file_id === file.id; }, { timeout: 15_000 }).toBe(true);
    expect(receipt()).toMatchObject({ mime: 'application/pdf' });
    expect(api.rows(GUESTS)[0]).toMatchObject({ ses_status: 'enviado_SES' });
  });

  await test.step('Calendario: la reserva aparece y el panel refleja el estado de Google Calendar', async () => {
    const reservationId = api.rows(RESERVATIONS)[0]!.id;
    api.setCalendarStatus({ configured: true, calendarId: 'prueba@group.calendar.example', health: 'calendar_not_shared',
      items: [{ reservationId, syncStatus: 'error', lastSyncedAt: null, lastError: 'sin permiso', htmlLink: null, pendingJob: true, attempts: 2, nextAttemptAt: null }] });
    await page.locator('.nav').getByText('Calendario', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Calendario', level: 2 })).toBeVisible();
    await expect(page.locator('#calendarHost')).toContainText('Retiro Test');
    await expect(page.locator('#calendarHealth')).toContainText('no está compartido con la cuenta de servicio');
    await expect(page.locator('#calendarCounts')).toContainText('1 pendiente · 1 con error');
    await expect(page.locator('#calendarFailing')).toContainText('Retiro Test');
    await page.locator('#calendarFailing').getByRole('button', { name: /Reintentar/ }).click();
    await expect.poll(() => api.calendarRetries()).toEqual([reservationId]);
    await page.locator('#calendarHost [data-event-id]').first().click();
    await expect(page.locator('#statusChip')).toBeVisible();
    await expect(page.locator('#calendarChip')).toHaveText('Calendar: error'); // el mismo estado, en la cabecera de la ficha
  });

  await test.step('papelera: se va la reserva con todo lo suyo y se restaura entera', async () => {
    await page.locator('.nav').getByText('Reservas', { exact: true }).click();
    await page.locator('.filters').getByRole('button', { name: 'Confirmadas' }).click();
    await page.getByRole('button', { name: 'Abrir Retiro Test' }).click();
    // A 390 px «Papelera» está dentro del menú «Más».
    await expect(page.locator('#trashReservation')).toBeHidden();
    await page.locator('#moreActions summary').click();
    await page.locator('#trashReservation').click();
    await expect(page.locator('.dialog')).toContainText('23 elementos asociados'); // 20 tareas, 2 restricciones, 1 huésped
    await page.locator('.dialog').getByRole('button', { name: 'Enviar a la papelera' }).click();
    await expect(page.getByRole('heading', { name: 'Reservas', level: 2 })).toBeVisible();
    await expect(page.locator('#trashCount')).toHaveText('1');
    await expect.poll(() => [RESERVATIONS, FINANCE, EVENTS, GUESTS, RESTRICTIONS, CHECKLIST].every((table) => api.rows(table).every((row) => row.deleted_at !== null))).toBe(true);

    await page.locator('#trash summary').click();
    await page.getByRole('button', { name: 'Abrir Retiro Test en la papelera' }).click();
    await expect(page.locator('.ficha .chip.trash')).toBeVisible();
    await page.locator('#restoreReservation').click();
    await expect(page.locator('#editReservation')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#blockChecklist .checklist li')).toHaveCount(20);
    await expect(page.locator('#restrictionSummary')).toHaveText('1 alergia a pistacho · 1 sin gluten'); // la del evento y la del huésped
    await expect.poll(() => [RESERVATIONS, FINANCE, EVENTS, GUESTS, RESTRICTIONS, CHECKLIST].every((table) => api.rows(table).every((row) => row.deleted_at === null))).toBe(true);
    await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');
  });
});

test('PWA: manifest, service worker y shell en caché', async ({ page }) => {
  await login(page);
  const manifest = await page.request.get(`${baseURL}/manifest.webmanifest`);
  expect(manifest.ok()).toBeTruthy();
  expect(await manifest.json()).toMatchObject({ name: 'Ikisai Booking', short_name: 'Booking', display: 'standalone' });
  const sw = await page.request.get(`${baseURL}/sw.js`);
  expect(sw.ok()).toBeTruthy();
  expect(await sw.text()).toContain('ikisai-booking-shell-');
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return Boolean(registration?.active);
  }, null, { timeout: 15_000 });
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const cache = await caches.open(keys.find((k) => k.startsWith('ikisai-booking-shell-')) ?? '');
    return (await cache.keys()).map((r) => new URL(r.url).pathname);
  });
  expect(cached).toEqual(expect.arrayContaining(['/', '/manifest.webmanifest', '/fonts/inter.woff2']));
  expect(cached.some((p) => p.startsWith('/api/'))).toBeFalsy();
});
