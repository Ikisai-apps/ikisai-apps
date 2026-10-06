/**
 * Escenarios sin red de Booking (docs/booking/API.md §11.2, O1–O7). Cada test arranca su propia API falsa en memoria
 * y su propio servidor de previsualización (la compilación se hace una sola vez por archivo). Viewport móvil por defecto.
 *
 * Cómo correrlo:   npx playwright test tests/booking/offline.spec.ts
 */
import { expect, test, type BrowserContext, type Page } from 'playwright/test';
import { ASSIGNMENTS, BEDS, EVENTS, GUESTS, PROPOSALS, PROPOSAL_LINES, RESERVATIONS, STAFF, buildApp, inDays, login, startHarness, type Harness } from './harness.ts';
import { startFakeApi } from './fake-api.ts';

test.use({ viewport: { width: 390, height: 844 } });
test.setTimeout(120_000);

let harness: Harness;

test.beforeAll(async () => {
  const probe = await startFakeApi();
  await buildApp(probe.url);
  await probe.close();
});

test.beforeEach(async () => {
  harness = await startHarness({ compile: false });
});

test.afterEach(async () => {
  await harness?.close();
});

const api = () => harness.api;
const nav = (page: Page, name: string) => page.locator('.nav').getByText(name, { exact: true }).click();

/** Crea una pre-reserva con la interfaz (con red, o sin ella) y la deja anotada. */
async function createReservation(page: Page, title = 'Retiro Test'): Promise<void> {
  await nav(page, 'Reservas');
  await page.getByRole('button', { name: 'Nueva reserva' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nueva reserva' });
  await dialog.getByLabel('Nombre del grupo o evento').fill(title);
  await dialog.getByLabel('Estado').selectOption('pre_reservada');
  await dialog.getByLabel('Entrada').fill(inDays(10));
  await dialog.getByLabel('Salida').fill(inDays(12));
  await dialog.getByLabel('Personas previstas').fill('20');
  await page.getByRole('button', { name: 'Guardar' }).click();
  await expect(dialog).toBeHidden();
}

async function openFicha(page: Page, title = 'Retiro Test'): Promise<void> {
  await nav(page, 'Reservas');
  await page.locator('#reservationList .row', { hasText: title }).getByText(title).first().click();
  await expect(page.locator('#statusChip')).toBeVisible();
}

async function confirmOnline(page: Page): Promise<void> {
  await page.locator('#confirmReservation').click();
  await page.getByRole('alertdialog', { name: 'Confirmar reserva' }).getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.locator('#blockOperation')).toContainText('EVT_TEST_', { timeout: 15_000 });
}

/** Reserva confirmada con un huésped sintético, todo ya sincronizado; deja la página en la ficha de huéspedes. */
async function seedGuest(page: Page): Promise<void> {
  await login(page, harness.baseURL);
  await createReservation(page);
  await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');
  await openFicha(page);
  await confirmOnline(page);
  await page.locator('#openGuests').click();
  await page.locator('#newGuest').click();
  const dialog = page.getByRole('dialog', { name: 'Nuevo huésped' });
  await dialog.getByLabel('Nombre', { exact: true }).fill('Persona');
  await dialog.getByLabel('Primer apellido').fill('Sintética');
  await dialog.getByLabel('Estado de los datos').selectOption('datos_recibidos');
  await page.locator('#saveRow').click();
  await expect(page.locator('#guestList .row', { hasText: 'Persona Sintética' })).toBeVisible();
  await expect.poll(() => api().rows(GUESTS).length).toBe(1);
  await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');
}

const offline = async (page: Page, context: BrowserContext) => {
  await context.setOffline(true);
  await expect(page.locator('#syncStatus')).toContainText('Sin conexión');
};

test('O1 crear una reserva sin red, recargar y reconectar', async ({ page, context }) => {
  await login(page, harness.baseURL);
  await offline(page, context);
  await createReservation(page);
  const row = page.locator('#reservationList .row', { hasText: 'Retiro Test' });
  await expect(row).toHaveAttribute('data-pending', 'true');
  expect(api().rows(RESERVATIONS)).toHaveLength(0);

  await page.reload();
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-pending', 'true');

  await context.setOffline(false);
  await expect.poll(() => api().rows(RESERVATIONS).map((r) => r.title), { timeout: 15_000 }).toEqual(['Retiro Test']);
  await expect(row).toHaveAttribute('data-pending', 'false');
  await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');
});

test('O3 confirmar sin red: marca de pendiente y evento al reconectar', async ({ page, context }) => {
  await login(page, harness.baseURL);
  await createReservation(page);
  await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');
  await openFicha(page);
  await offline(page, context);
  await page.locator('#confirmReservation').click();
  await page.getByRole('alertdialog', { name: 'Confirmar reserva' }).getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.locator('#confirmPendingChip')).toBeVisible();
  await expect(page.locator('#confirmReservation')).toHaveCount(0);
  expect(api().rows(EVENTS)).toHaveLength(0);

  await context.setOffline(false);
  await expect(page.locator('#blockOperation')).toContainText('EVT_TEST_', { timeout: 15_000 });
  await expect(page.locator('#confirmPendingChip')).toHaveCount(0);
  await expect(page.locator('#statusChip')).toHaveText('Confirmada');
  await expect(page.locator('#calendarChip')).toHaveCount(1); // pastilla de Calendar presente (oculta si no hay estado que enseñar)
});

test('O3 variante: otra persona cancela la reserva y el lote se rechaza', async ({ page, context }) => {
  await login(page, harness.baseURL);
  await createReservation(page);
  await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');
  await openFicha(page);
  await offline(page, context);
  await page.locator('#confirmReservation').click();
  await page.getByRole('alertdialog', { name: 'Confirmar reserva' }).getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.locator('#confirmPendingChip')).toBeVisible();
  api().serverUpdate(RESERVATIONS, api().rows(RESERVATIONS)[0]!.id, { status: 'cancelada' });

  await context.setOffline(false);
  await expect(page.locator('#confirmRejected')).toContainText('Otra persona cambió el estado de la reserva', { timeout: 15_000 });
  await expect(page.locator('#confirmPendingChip')).toHaveCount(0);
  await page.getByRole('button', { name: 'Entendido' }).click();
  await expect(page.locator('#confirmRejected')).toHaveCount(0);
  await expect(page.locator('#confirmReservation')).toHaveCount(0); // cancelada: no se puede confirmar
  expect(api().rows(EVENTS)).toHaveLength(0);
});

test('O4 conflicto disjunto: se fusiona solo', async ({ page, context }) => {
  await login(page, harness.baseURL);
  await createReservation(page);
  await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');
  await openFicha(page);
  await offline(page, context);
  await page.locator('#editReservation').click();
  await page.getByRole('dialog', { name: 'Editar reserva' }).getByLabel('Teléfono').fill('600 111 222');
  await page.locator('#saveRow').click();
  await expect(page.locator('#syncStatus')).toContainText('1 cambio pendiente');
  api().serverUpdate(RESERVATIONS, api().rows(RESERVATIONS)[0]!.id, { start_date: inDays(20), end_date: inDays(22) });

  await context.setOffline(false);
  await expect.poll(() => api().rows(RESERVATIONS)[0]).toMatchObject({ contact_phone: '600 111 222', start_date: inDays(20), end_date: inDays(22) });
  await expect(page.getByText('Se incorporaron cambios de otra persona')).toBeVisible();
  await expect(page.getByRole('button', { name: /resolver/i })).toHaveCount(0);
  await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');
});

test('O5 conflicto solapado: se resuelve con «Mantener la mía»', async ({ page, context }) => {
  await login(page, harness.baseURL);
  await createReservation(page);
  await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');
  await openFicha(page);
  await offline(page, context);
  await page.locator('#editReservation').click();
  await page.getByRole('dialog', { name: 'Editar reserva' }).getByLabel('Personas previstas').fill('33');
  await page.locator('#saveRow').click();
  await expect(page.locator('#syncStatus')).toContainText('1 cambio pendiente');
  api().serverUpdate(RESERVATIONS, api().rows(RESERVATIONS)[0]!.id, { expected_guests: 44 });

  await context.setOffline(false);
  await page.getByRole('button', { name: /resolver/i }).click();
  await expect(page.getByRole('heading', { name: 'Por resolver', level: 2 })).toBeVisible();
  await page.locator('[data-choice="mine"]').click();
  await expect.poll(() => api().rows(RESERVATIONS)[0]!.expected_guests).toBe(33);
});

test('O6 firma hecha sin red: se sube al reconectar', async ({ page, context }) => {
  await seedGuest(page);
  await offline(page, context);
  await page.getByRole('button', { name: 'Editar Persona Sintética' }).click();
  await page.locator('#signOnScreen').click();
  const box = (await page.locator('#signaturePad').boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 30, { steps: 6 });
  await page.mouse.move(box.x + 220, box.y + box.height - 30, { steps: 6 });
  await page.mouse.up();
  await page.locator('#saveSignature').click();
  const row = page.locator('#guestList .row', { hasText: 'Persona Sintética' });
  await expect(row).toContainText('Firmado');
  await expect(row).toHaveAttribute('data-pending', 'true');
  expect(api().uploads()).toHaveLength(0);

  await context.setOffline(false);
  await expect.poll(() => { const file = api().uploads()[0]; return !!file && api().rows(GUESTS)[0]!.signature_file_id === file.id; }, { timeout: 20_000 }).toBe(true);
  expect(api().uploads()[0]).toMatchObject({ mime: 'image/png' });
});

test('Inicio avisa de los huéspedes sin comunicar a SES cuando la entrada es inminente', async ({ page }) => {
  await seedGuest(page);
  await nav(page, 'Inicio');
  await expect(page.locator('#notices')).not.toContainText('sin comunicar a SES'); // la entrada es dentro de diez días
  api().serverUpdate(RESERVATIONS, api().rows(RESERVATIONS)[0]!.id, { start_date: inDays(1), end_date: inDays(3) });
  await page.getByRole('button', { name: 'Sincronizar ahora' }).click();
  await expect(page.locator('#notices li', { hasText: 'sin comunicar a SES' })).toHaveText(/^1\s*huésped sin comunicar a SES$/);
});

test('O7 cerrar sesión borra huéspedes e importes del dispositivo', async ({ page, context }) => {
  await seedGuest(page);
  const stores = () => page.evaluate(() => new Promise<Record<string, number | null>>((resolve, reject) => {
    const open = indexedDB.open('ikisai-booking-v1');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const out: Record<string, number | null> = {};
      const names = ['booking.guests', 'booking.reservation_finance', 'booking.reservations'];
      const present = names.filter((n) => db.objectStoreNames.contains(n));
      for (const n of names) if (!present.includes(n)) out[n] = null;
      if (present.length === 0) { db.close(); return resolve(out); }
      const tx = db.transaction(present, 'readonly');
      let left = present.length;
      for (const n of present) {
        const count = tx.objectStore(n).count();
        count.onsuccess = () => { out[n] = count.result; if (--left === 0) { db.close(); resolve(out); } };
      }
    };
  }));
  expect((await stores())['booking.guests']).toBeGreaterThan(0);
  expect((await stores())['booking.reservation_finance']).toBeGreaterThan(0);

  await offline(page, context);
  await openFicha(page);
  await page.locator('#editReservation').click();
  await page.getByRole('dialog', { name: 'Editar reserva' }).getByLabel('Teléfono').fill('600 333 444');
  await page.locator('#saveRow').click();
  await expect(page.locator('#syncStatus')).toContainText('1 cambio pendiente');

  await nav(page, 'Inicio');
  await page.locator('#logoutHome').click();
  const warning = page.getByRole('alertdialog', { name: 'Hay cambios sin sincronizar' });
  await expect(warning).toBeVisible();
  await warning.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page.getByLabel('Correo electrónico')).toBeVisible();

  const after = await stores();
  expect(after['booking.guests'] ?? 0).toBe(0);
  expect(after['booking.reservation_finance'] ?? 0).toBe(0);
});

/** Crea una habitación con sus camas desde «Espacios y camas». */
async function createRoom(page: Page, name: string, beds: string[]): Promise<void> {
  await page.evaluate(() => { location.hash = '#/espacios'; });
  await expect(page.getByRole('heading', { name: 'Espacios y camas', level: 2 })).toBeVisible();
  await page.locator('#newSpace').click();
  const dialog = page.getByRole('dialog', { name: 'Nuevo espacio' });
  await dialog.getByLabel('Nombre', { exact: true }).fill(name);
  await page.locator('#saveRow').click();
  await expect(dialog).toBeHidden();
  for (const bed of beds) {
    await page.getByRole('button', { name: `Añadir cama a ${name}` }).click();
    const sheet = page.getByRole('dialog', { name: `Nueva cama en ${name}` });
    await sheet.getByLabel('Etiqueta').fill(bed);
    await page.locator('#saveRow').click();
    await expect(sheet).toBeHidden();
  }
}

/** Abre la hoja de asignar y la rellena (sin guardar). */
async function fillAssignment(page: Page, room: string, group: string, bed?: string) {
  await page.locator('#addAssignment').click();
  const dialog = page.getByRole('dialog', { name: 'Asignar alojamiento' });
  await dialog.getByLabel('Espacio').selectOption({ label: room });
  if (bed) await dialog.getByLabel('Cama').selectOption({ label: bed });
  await dialog.getByLabel('Nombre del grupo').fill(group);
  return dialog;
}

test('O8 asignar alojamiento sin red: queda pendiente y llega al reconectar', async ({ page, context }) => {
  await login(page, harness.baseURL);
  await createReservation(page);
  await openFicha(page);
  await confirmOnline(page);
  await createRoom(page, 'Habitación 1', ['Cama 1']);
  await expect.poll(() => api().rows(BEDS).length).toBe(1);
  await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');
  await openFicha(page);

  await offline(page, context);
  const dialog = await fillAssignment(page, 'Habitación 1', 'Grupo sin red', 'Cama 1 · 1 plaza');
  await page.locator('#saveRow').click();
  await expect(dialog).toBeHidden();
  const row = page.locator('#blockLodging li.row', { hasText: 'Grupo sin red' });
  await expect(row).toHaveAttribute('data-pending', 'true');
  await expect(row).toContainText('cama Cama 1');
  await expect(page.locator('#syncStatus')).toContainText('1 cambio pendiente');
  expect(api().rows(ASSIGNMENTS)).toHaveLength(0);

  await context.setOffline(false);
  await expect.poll(() => api().rows(ASSIGNMENTS).map((a) => a.group_label), { timeout: 15_000 }).toEqual(['Grupo sin red']);
  expect(api().rows(ASSIGNMENTS)[0]).toMatchObject({ bed_id: api().rows(BEDS)[0]!.id, persons: 1, event_id: api().rows(EVENTS)[0]!.id });
  await expect(row).toHaveAttribute('data-pending', 'false');
  await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');
});

test('anotar un turno del personal sin red: queda pendiente y llega al reconectar', async ({ page, context }) => {
  await login(page, harness.baseURL);
  await createReservation(page);
  await openFicha(page);
  await confirmOnline(page);
  await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');

  await offline(page, context);
  await page.locator('#addShift').click();
  const dialog = page.getByRole('dialog', { name: 'Nuevo turno' });
  await dialog.locator('#f-person_name').fill('Persona Sintética Sin Red');
  await dialog.getByLabel('Función').selectOption({ label: 'Acogida del grupo' });
  await dialog.getByLabel('Horas previstas').fill('5');
  await page.locator('#saveRow').click();
  await expect(dialog).toBeHidden();
  const item = page.locator('#blockStaff .staff-item', { hasText: 'Persona Sintética Sin Red' });
  await expect(item).toHaveAttribute('data-pending', 'true');
  await expect(page.locator('#blockOperation')).toContainText('1 turno · 5 h previstas');
  await expect(page.locator('#syncStatus')).toContainText('1 cambio pendiente');
  expect(api().rows(STAFF)).toHaveLength(0);

  await context.setOffline(false);
  await expect.poll(() => api().rows(STAFF).map((a) => a.person_name), { timeout: 15_000 }).toEqual(['Persona Sintética Sin Red']);
  expect(api().rows(STAFF)[0]).toMatchObject({ function: 'acogida_grupo', planned_hours: 5, status: 'prevista', event_id: api().rows(EVENTS)[0]!.id });
  await expect(item).toHaveAttribute('data-pending', 'false');
  await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');
});

test('cama ocupada: aviso local con otra reserva y rechazo del servidor', async ({ page }) => {
  await login(page, harness.baseURL);
  await createReservation(page, 'Retiro A');
  await openFicha(page, 'Retiro A');
  await confirmOnline(page);
  await createRoom(page, 'Habitación 1', ['Cama 1']);
  await openFicha(page, 'Retiro A');
  let dialog = await fillAssignment(page, 'Habitación 1', 'Grupo A', 'Cama 1 · 1 plaza');
  await page.locator('#saveRow').click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => api().rows(ASSIGNMENTS).map((a) => a.group_label)).toEqual(['Grupo A']);

  // Otra reserva confirmada en las mismas noches: la hoja avisa con lo que hay en el espejo y no deja guardar.
  await createReservation(page, 'Retiro B');
  await openFicha(page, 'Retiro B');
  await confirmOnline(page);
  dialog = await fillAssignment(page, 'Habitación 1', 'Grupo B', 'Cama 1 · 1 plaza');
  await expect(dialog.locator('#bedConflict')).toContainText('ya está ocupada esas noches en «Retiro A»');
  await page.locator('#saveRow').click();
  await expect(dialog.locator('.formerror').first()).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(api().rows(ASSIGNMENTS)).toHaveLength(1);

  // Sin cama concreta, o con otras noches, ya no choca.
  await dialog.getByLabel('Cama').selectOption({ label: 'Sin cama concreta' });
  await expect(dialog.locator('#bedConflict')).toBeHidden();
  await dialog.getByLabel('Cama').selectOption({ label: 'Cama 1 · 1 plaza' });
  await expect(dialog.locator('#bedConflict')).toBeVisible();
  await dialog.getByLabel('Desde').fill(inDays(40));
  await dialog.getByLabel('Hasta').fill(inDays(42));
  await expect(dialog.locator('#bedConflict')).toBeHidden();

  // El servidor lo comprueba de nuevo: si rechaza, la hoja lo dice y no queda nada en la ficha.
  api().failNextCommit('BED_OVERBOOKED', 422);
  await page.locator('#saveRow').click();
  await expect(dialog).toContainText('Esa cama ya está ocupada esas noches en otra reserva.');
  await expect(dialog).toBeVisible();
  expect(api().rows(ASSIGNMENTS)).toHaveLength(1);
  page.once('dialog', (confirmation) => void confirmation.accept()); // «Hay cambios sin guardar»
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#blockLodging')).toContainText('Sin asignaciones todavía.');
  await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');
});

test('propuesta: líneas de un borrador editadas sin red llegan al reconectar; al cerrar sesión no queda nada de tarifas ni propuestas', async ({ page, context }) => {
  await login(page, harness.baseURL);
  await createReservation(page);
  await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');
  await openFicha(page);
  await page.locator('#createProposal').click();
  await expect.poll(() => api().rows(PROPOSALS).length).toBe(1);
  await page.locator('#editProposal').click();
  await expect(page.getByRole('heading', { name: 'Propuesta v1', level: 2 })).toBeVisible();

  const fillLine = async (title: string, values: Record<string, string>, unit?: string) => {
    const dialog = page.getByRole('dialog', { name: title });
    if (unit) await dialog.locator('#f-unit').selectOption(unit);
    for (const [key, value] of Object.entries(values)) await dialog.locator(`#f-${key}`).fill(value);
    await page.locator('#saveRow').click();
    await expect(dialog).toBeHidden();
  };
  await page.locator('#addLine').click();
  await fillLine('Nueva línea', { description: 'Sala grande', quantity: '3', unit_amount: '100' }, 'dia');
  await expect.poll(() => api().rows(PROPOSAL_LINES).length).toBe(1);
  await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');

  await offline(page, context);
  await page.getByRole('button', { name: 'Editar Sala grande' }).click();
  await fillLine('Línea de la propuesta', { quantity: '4' });
  await page.locator('#addLine').click();
  await fillLine('Nueva línea', { description: 'Equipo de sonido', quantity: '1', unit_amount: '50.5' }, 'unidad');
  await expect(page.locator('#proposalLines .line-item[data-pending="true"]')).toHaveCount(2);
  await expect(page.locator('#proposalTotal')).toContainText('450,50');
  expect(api().rows(PROPOSAL_LINES)).toHaveLength(1);
  expect(api().rows(PROPOSAL_LINES)[0]).toMatchObject({ quantity: 3 });

  await context.setOffline(false);
  await expect.poll(() => api().rows(PROPOSAL_LINES).map((l) => [l.description, l.quantity]).sort(), { timeout: 15_000 }).toEqual([['Equipo de sonido', 1], ['Sala grande', 4]]);
  await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');
  await expect(page.locator('#proposalLines .line-item[data-pending="true"]')).toHaveCount(0);
  await expect(page.locator('#proposalTotal')).toContainText('450,50');

  // Al cerrar sesión, tarifario, condiciones y propuestas se retiran del dispositivo como los importes.
  const tables = ['booking.rates', 'booking.conditions', 'booking.cancellation_tiers', 'booking.proposals', 'booking.proposal_lines'];
  const counts = () => page.evaluate((names) => new Promise<number[]>((resolve, reject) => {
    const open = indexedDB.open('ikisai-booking-v1');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const present = names.filter((n) => db.objectStoreNames.contains(n));
      if (present.length === 0) { db.close(); return resolve(names.map(() => 0)); }
      const tx = db.transaction(present, 'readonly');
      const out = new Map<string, number>();
      for (const n of present) {
        const count = tx.objectStore(n).count();
        count.onsuccess = () => { out.set(n, count.result); if (out.size === present.length) { db.close(); resolve(names.map((x) => out.get(x) ?? 0)); } };
      }
    };
  }), tables);
  expect((await counts())[3]).toBeGreaterThan(0);
  expect((await counts())[4]).toBeGreaterThan(0);
  await nav(page, 'Inicio');
  await page.locator('#logoutHome').click();
  await expect(page.getByLabel('Correo electrónico')).toBeVisible();
  expect(await counts()).toEqual([0, 0, 0, 0, 0]);
});
