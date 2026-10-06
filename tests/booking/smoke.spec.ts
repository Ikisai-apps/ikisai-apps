/**
 * Humo de Ikisai Booking (esqueleto): login → bootstrap → espejo local → crear y editar reservas sin red → sincronizar.
 *
 * Cómo correrlo:   npx playwright test tests/booking            (desde la raíz del repo)
 * Compila la app con la API de Vite, la sirve con `vite preview` y reenvía /api a una API falsa en memoria (fake-api.ts).
 */
import { expect, test } from 'playwright/test';
import { proposalTotals } from '../../supabase/functions/_domain/booking/mod.ts';
import { ASSIGNMENTS, BEDS, NEEDS, SPACES, STAFF, EVENTS, FINANCE, GUESTS, RESERVATIONS, RESTRICTIONS, CHECKLIST, USER, inDays, login as loginTo, startHarness, type Harness } from './harness.ts';

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
    // Incidencia del usuario en Android (V1): tras confirmar y volver a la app, el lote del `call` quedaba atascado en
    // IndexedDB («Evaluating the object store's key path…») con «2 pendientes». Tras recargar no debe quedar nada.
    await page.reload();
    await expect(page.locator('#statusChip')).toHaveText('Confirmada');
    await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado', { timeout: 15_000 });
    await expect(page.locator('#localErrorBanner')).toHaveCount(0);
    await expect(page.getByText('IDBObjectStore')).toHaveCount(0);

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

  await test.step('espacios y camas: habitación con dos camas, reordenar y asignar un grupo con aviso de sobreocupación', async () => {
    await page.locator('#openSpaces').click();
    await expect(page.getByRole('heading', { name: 'Espacios y camas', level: 2 })).toBeVisible();
    await expect(page.getByText('Todavía no hay espacios')).toBeVisible();

    await page.locator('#newSpace').click();
    let dialog = page.getByRole('dialog', { name: 'Nuevo espacio' });
    await dialog.getByLabel('Nombre', { exact: true }).fill('Habitación 1');
    await dialog.locator('#f-zone').fill('Planta baja');
    await dialog.locator('#f-capacity').fill('4');
    await page.locator('#saveRow').click();
    await expect(dialog.locator('.formerror')).toContainText('solo se indica en salas y zonas'); // en una habitación se suman las camas
    await dialog.locator('#f-capacity').fill('');
    await page.locator('#saveRow').click();
    await expect(dialog).toBeHidden();

    await page.locator('#newSpace').click();
    dialog = page.getByRole('dialog', { name: 'Nuevo espacio' });
    await dialog.getByLabel('Nombre', { exact: true }).fill('Sala común');
    await dialog.locator('#f-kind').selectOption('sala');
    await dialog.locator('#f-zone').fill('Planta baja');
    await dialog.locator('#f-capacity').fill('30');
    await page.locator('#saveRow').click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => api.rows(SPACES).map((r) => r.name).sort()).toEqual(['Habitación 1', 'Sala común']);
    expect(api.rows(SPACES).find((r) => r.name === 'Habitación 1')).toMatchObject({ kind: 'habitacion', zone: 'Planta baja', active: true, capacity: null });
    expect(api.rows(SPACES).find((r) => r.name === 'Sala común')).toMatchObject({ kind: 'sala', capacity: 30 });

    for (const bed of ['Cama 1', 'Cama 2']) {
      await page.getByRole('button', { name: 'Añadir cama a Habitación 1' }).click();
      dialog = page.getByRole('dialog', { name: 'Nueva cama en Habitación 1' });
      await dialog.getByLabel('Etiqueta').fill(bed);
      await page.locator('#saveRow').click();
      await expect(dialog).toBeHidden();
    }
    await expect.poll(() => api.rows(BEDS).map((r) => r.label).sort()).toEqual(['Cama 1', 'Cama 2']);
    await expect(page.locator('.space-item[data-kind="habitacion"] > .space-main [data-role="places"]')).toContainText('2 plazas');
    await expect(page.locator('.space-item[data-kind="sala"] [data-role="places"]')).toContainText('30 plazas');

    // Reordenar con «Bajar»: solo cambia el espacio movido (un `update`).
    const before = new Map(api.rows(SPACES).map((r) => [r.id, { position: r.position, revision: r.revision, name: r.name as string }]));
    await page.getByRole('button', { name: 'Bajar Habitación 1', exact: true }).click();
    await expect.poll(() => api.rows(SPACES).filter((r) => r.position !== before.get(r.id)!.position || r.revision !== before.get(r.id)!.revision).map((r) => r.name)).toEqual(['Habitación 1']);
    const moved = api.rows(SPACES).find((r) => r.name === 'Habitación 1')!;
    expect(moved.revision).toBe(before.get(moved.id)!.revision + 1);
    expect(Number(moved.position)).toBeGreaterThan(Number(api.rows(SPACES).find((r) => r.name === 'Sala común')!.position));
    await expect(page.locator('.zone[data-zone="Planta baja"] > .sortable-wrap > ul > .sortable-row .name').first()).toHaveText('Sala común');

    // De vuelta en la ficha: asignar un grupo de 3 personas a la habitación (2 plazas) sin cama.
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Retiro Test', level: 2 })).toBeVisible();
    await expect(page.locator('#blockLodging')).toContainText('Sin asignaciones todavía.');
    await page.locator('#addAssignment').click();
    dialog = page.getByRole('dialog', { name: 'Asignar alojamiento' });
    await dialog.getByLabel('Espacio').selectOption({ label: 'Habitación 1 · Planta baja' });
    await expect(dialog.getByLabel('Cama')).toContainText('Cama 2');
    await dialog.getByLabel('Nombre del grupo').fill('Grupo de prueba');
    await dialog.getByLabel('Personas').fill('3');
    await page.locator('#saveRow').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#blockLodging [data-role="occupancy"]')).toHaveText('3 / 2 plazas');
    await expect(page.locator('#blockLodging .lodging-space[data-over="true"]')).toContainText('Sobreocupada');
    await expect(page.locator('#blockLodging')).toContainText('Grupo de prueba');
    await expect(page.locator('#blockOperation')).toContainText('3 personas en 1 espacio');
    await expect.poll(() => api.rows(ASSIGNMENTS)[0]).toMatchObject({ event_id: api.rows(EVENTS)[0]!.id, space_id: moved.id, bed_id: null, guest_id: null, group_label: 'Grupo de prueba', persons: 3 });
    expect(api.rows(ASSIGNMENTS)).toHaveLength(1);

    // No se puede quitar un espacio con asignaciones vivas.
    await page.locator('#openSpaces').click();
    await page.getByRole('button', { name: 'Editar Habitación 1', exact: true }).click();
    await expect(page.locator('#removeBlocked')).toContainText('1 asignación viva');
    await expect(page.locator('#removeRow')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.goBack();
    await expect(page.locator('#blockLodging')).toContainText('3 / 2 plazas');
  });

  await test.step('espacios: alta rápida en un lote, duplicar, no reservable y supletorias en Alojamiento', async () => {
    const sameBatch = (ids: string[]) => {
      const entries = api.changeLog().filter((c) => ids.includes(c.id));
      return { size: new Set(entries.map((c) => c.requestId)).size, count: entries.length, tables: entries.map((c) => c.table).sort() };
    };
    await page.locator('#openSpaces').click();
    await page.locator('#newSpace').click();
    let dialog = page.getByRole('dialog', { name: 'Nuevo espacio' });
    await expect(dialog.locator('#f-quick_beds')).toBeVisible();
    await dialog.locator('#f-kind').selectOption('sala');
    await expect(dialog.locator('#f-quick_beds')).toBeHidden(); // solo en habitaciones
    await dialog.locator('#f-kind').selectOption('habitacion');
    await dialog.getByLabel('Nombre', { exact: true }).fill('Habitación 2');
    await dialog.locator('#f-quick_beds').fill('2');
    await dialog.locator('#f-quick_extras').fill('1');
    await page.locator('#saveRow').click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => api.rows(SPACES).some((r) => r.name === 'Habitación 2')).toBe(true);
    const room2 = api.rows(SPACES).find((r) => r.name === 'Habitación 2')!;
    await expect.poll(() => api.rows(BEDS).filter((b) => b.space_id === room2.id).length).toBe(3);
    const beds2 = api.rows(BEDS).filter((b) => b.space_id === room2.id).sort((a, b) => Number(a.position) - Number(b.position));
    expect(beds2.map((b) => [b.label, b.kind, b.capacity])).toEqual([['Cama 1', 'individual', 1], ['Cama 2', 'individual', 1], ['Supletoria 1', 'supletoria', 1]]);
    expect(room2).toMatchObject({ kind: 'habitacion', bookable: true });
    // Las cuatro filas (espacio y tres camas) llegaron en el mismo `commit`.
    expect(sameBatch([room2.id, ...beds2.map((b) => b.id)])).toEqual({ size: 1, count: 4, tables: [BEDS, BEDS, BEDS, SPACES] });
    const card2 = page.locator('.space-item[data-kind="habitacion"]').filter({ has: page.getByRole('button', { name: 'Editar Habitación 2', exact: true }) });
    await expect(card2.locator('[data-role="places"]').first()).toHaveText('2 plazas + 1 supletoria');
    await expect(card2.locator('.bed-item', { hasText: 'Supletoria 1' }).locator('.chip').first()).toHaveText('Supletoria');

    // Duplicar: «<nombre> (copia)» con las mismas camas, en otro lote.
    await page.getByRole('button', { name: 'Duplicar Habitación 2', exact: true }).click();
    await expect.poll(() => api.rows(SPACES).some((r) => r.name === 'Habitación 2 (copia)')).toBe(true);
    const copy = api.rows(SPACES).find((r) => r.name === 'Habitación 2 (copia)')!;
    await expect.poll(() => api.rows(BEDS).filter((b) => b.space_id === copy.id).length).toBe(3);
    const copyBeds = api.rows(BEDS).filter((b) => b.space_id === copy.id);
    expect(copyBeds.map((b) => b.label).sort()).toEqual(['Cama 1', 'Cama 2', 'Supletoria 1']);
    const batch = sameBatch([copy.id, ...copyBeds.map((b) => b.id)]);
    expect(batch).toEqual({ size: 1, count: 4, tables: [BEDS, BEDS, BEDS, SPACES] });
    expect(api.changeLog().find((c) => c.id === copy.id)!.requestId).not.toBe(api.changeLog().find((c) => c.id === room2.id)!.requestId);
    expect(Number(copy.position)).toBeGreaterThan(Number(room2.position));

    // Marcar la copia como no reservable.
    await page.getByRole('button', { name: 'Editar Habitación 2 (copia)', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Espacio' });
    await expect(dialog.getByLabel('Reservable')).toBeChecked();
    await expect(dialog.locator('#f-quick_beds')).toHaveCount(0); // el alta rápida solo está en «Nuevo espacio»
    await dialog.getByLabel('Reservable').uncheck();
    await page.locator('#saveRow').click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => api.rows(SPACES).find((r) => r.id === copy.id)!.bookable).toBe(false);
    await expect(page.locator('.space-item[data-kind="habitacion"]').filter({ hasText: 'Habitación 2 (copia)' }).first().locator('.chip', { hasText: 'No reservable' })).toBeVisible();

    // En Alojamiento solo se ofrece la reservable, y su cama supletoria va marcada.
    await page.goBack();
    await page.locator('#addAssignment').click();
    dialog = page.getByRole('dialog', { name: 'Asignar alojamiento' });
    await expect(dialog.locator('#f-space_id')).toContainText('Habitación 2');
    const options = await dialog.locator('#f-space_id option').allTextContents();
    expect(options).toContain('Habitación 2');
    expect(options.some((o) => o.includes('(copia)'))).toBe(false);
    await dialog.getByLabel('Espacio').selectOption({ label: 'Habitación 2' });
    await expect(dialog.getByLabel('Cama')).toContainText('Supletoria 1 (supletoria)');
    await dialog.getByLabel('Cama').selectOption({ label: 'Supletoria 1 (supletoria) · 1 plaza' });
    await dialog.getByLabel('Nombre del grupo').fill('Grupo extra');
    await dialog.getByLabel('Personas').fill('1');
    await page.locator('#saveRow').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#extraBeds')).toHaveText('1 supletoria activada');
    await expect(page.locator('#blockLodging .lodging-space[data-space="Habitación 2"] [data-role="occupancy"]')).toHaveText('1 / 3 plazas');
  });

  await test.step('checklist base, una restricción y el cobro', async () => {
    await page.locator('#seedChecklist').click();
    await expect(page.locator('#blockChecklist .checklist li')).toHaveCount(20);
    await page.locator('#blockChecklist').getByRole('checkbox', { name: 'Wifi operativo' }).check();
    await expect.poll(() => api.rows(CHECKLIST).filter((item) => item.status === 'hecho').map((item) => item.label)).toEqual(['Wifi operativo']);
    await page.locator('#seedChecklist').click();
    await expect.poll(() => api.rows(CHECKLIST).length).toBe(20); // no duplica

    // Reordenar con el botón «Bajar» del componente: solo cambia el ítem movido (un `update`), no la lista entera.
    const firstList = page.locator('#blockChecklist ul.checklist').first();
    const labels: string[] = await firstList.locator('.checklist-item label span').allTextContents();
    expect(labels.length).toBeGreaterThan(2);
    const before = new Map(api.rows(CHECKLIST).map((item) => [item.id, { position: item.position, revision: item.revision, label: item.label as string }]));
    await page.locator('#blockChecklist').getByRole('button', { name: `Bajar ${labels[0]}`, exact: true }).click();
    const expectedOrder: string[] = [labels[1]!, labels[0]!, ...labels.slice(2)];
    await expect.poll(() => api.rows(CHECKLIST).filter((item) => item.position !== before.get(item.id)!.position || item.revision !== before.get(item.id)!.revision).map((item) => item.label)).toEqual([labels[0]]);
    const moved = api.rows(CHECKLIST).find((item) => item.label === labels[0])!;
    expect(moved.revision).toBe(before.get(moved.id)!.revision + 1);
    await expect(firstList.locator('.checklist-item label span')).toHaveText(expectedOrder);
    await page.reload();
    await expect(page.locator('#blockChecklist ul.checklist').first().locator('.checklist-item label span')).toHaveText(expectedOrder);
    await expect(page.locator('#blockChecklist .checklist li')).toHaveCount(20);

    // Teclado: flecha abajo dos veces sobre el asa; el foco sigue en el asa del mismo ítem tras cada guardado.
    const list = () => page.locator('#blockChecklist ul.checklist').first();
    const order = () => list().locator('.checklist-item label span').allTextContents();
    const top = (await order())[0]!;
    const handleOf = (label: string) => list().getByRole('button', { name: new RegExp(`^Mover ${label}\.`) });
    await handleOf(top).focus();
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await order()).indexOf(top)).toBe(1);
    await expect(handleOf(top)).toBeFocused();
    await expect(page.locator('.ficha .chip.pending')).toHaveCount(0);
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await order()).indexOf(top)).toBe(2);
    await expect(handleOf(top)).toBeFocused();
    await expect.poll(() => {
      const rows = api.rows(CHECKLIST).filter((item) => item.checklist_type === 'preparacion_general').sort((a, b) => Number(a.position) - Number(b.position));
      return rows.map((item) => item.label).indexOf(top);
    }).toBe(2);

    // Ratón: arrastrar el asa del último ítem por encima del primero.
    const now = await order();
    const last = now[now.length - 1]!;
    const from = (await handleOf(last).boundingBox())!;
    const to = (await list().locator('.sortable-row').first().boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 12, { steps: 3 });
    await page.mouse.move(to.x + 20, to.y + 4, { steps: 12 });
    await page.mouse.up();
    await expect.poll(async () => (await order())[0]).toBe(last);
    await expect.poll(() => {
      const rows = api.rows(CHECKLIST).filter((item) => item.checklist_type === 'preparacion_general').sort((a, b) => Number(a.position) - Number(b.position));
      return rows[0]?.label;
    }).toBe(last);

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
    await dialog.getByLabel('Importe presupuestado (€)').fill('300');
    await dialog.getByLabel('Señal requerida (€)').fill('300');
    await dialog.getByLabel('Señal pagada (€)').fill('100.50');
    await page.locator('#saveRow').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#blockFinance')).toContainText('Parcial');
    await expect.poll(() => api.rows(FINANCE)[0]).toMatchObject({ deposit_required: 300, deposit_paid: 100.5 });

    // Coste real: dos asignaciones a la reserva y una al evento (importe como texto y como número), dos categorías.
    const reservationId = api.rows(RESERVATIONS)[0]!.id;
    const eventId = api.rows(EVENTS)[0]!.id;
    const costRow = (n: number, target: 'reservation' | 'event', targetId: string, category: string, amount: number | string, date: string) => ({
      allocation_id: `00000000-0000-4000-8000-00000000000${n}`, target_kind: target, target_id: targetId, invoice_code: `FAC_TEST_00${n}`, invoice_date: date,
      supplier_name: `Proveedor ${n}`, expense_category: category, is_investment: false, allocated_amount: amount, allocation_revision: 1,
    });
    api.setCostRows([
      costRow(1, 'reservation', reservationId, 'Alimentación', '100.50', '2026-10-01'),
      costRow(2, 'reservation', reservationId, 'Mantenimiento', '49.50', '2026-10-02'),
      costRow(3, 'event', eventId, 'Alimentación', 2400.25, '2026-10-03'),
    ]);
    await page.reload();
    await expect(page.locator('#costTotal')).toHaveText(/^2\.?550,25\s€$/);
    await expect(page.locator('#costByCategory .mb-line')).toHaveCount(2);
    await expect(page.locator('#costByCategory .mb-line').first()).toContainText('Alimentación');
    await expect(page.locator('#costByCategory .mb-line').first()).toContainText('2 facturas');
    await expect(page.locator('#costByCategory a').first()).toHaveAttribute('href', `https://invoices.ikisai.com/#/compras?destino=booking:reservation:${reservationId}`);
    await expect(page.locator('#costByCategory .mb-compare')).toContainText('excede'); // 2.550,25 € frente a 300 € presupuestados
    await expect(page.locator('#costByCategory')).toContainText('Mantenimiento');
    await expect(page.locator('#costList li')).toHaveCount(3);
    for (const code of ['FAC_TEST_001', 'FAC_TEST_002', 'FAC_TEST_003']) {
      await expect(page.locator('#costList').getByRole('link', { name: code })).toHaveAttribute('rel', 'noopener');
    }

    // Si la lectura falla (422 o 403), el bloque lo dice y la ficha sigue entera; sin caché tampoco se rompe.
    api.failCosts(422);
    await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('booking.costs.')).forEach((key) => localStorage.removeItem(key)));
    await page.reload();
    await expect(page.locator('#blockCosts')).toContainText('Coste real no disponible.');
    await expect(page.locator('#costTotal')).toBeHidden();
    await expect(page.locator('#blockFinance')).toContainText('Parcial');
    await expect(page.locator('#blockChecklist .checklist li')).toHaveCount(20);
    api.failCosts(null);
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
    await expect(page.locator('.dialog')).toContainText('25 elementos asociados'); // 20 tareas, 2 restricciones, 1 huésped, 2 asignaciones
    await page.locator('.dialog').getByRole('button', { name: 'Enviar a la papelera' }).click();
    await expect(page.getByRole('heading', { name: 'Reservas', level: 2 })).toBeVisible();
    await expect(page.locator('#trashCount')).toHaveText('1');
    await expect.poll(() => [RESERVATIONS, FINANCE, EVENTS, GUESTS, RESTRICTIONS, CHECKLIST, ASSIGNMENTS].every((table) => api.rows(table).every((row) => row.deleted_at !== null))).toBe(true);

    await page.locator('#trash summary').click();
    await page.getByRole('button', { name: 'Abrir Retiro Test en la papelera' }).click();
    await expect(page.locator('.ficha .chip.trash')).toBeVisible();
    await page.locator('#restoreReservation').click();
    await expect(page.locator('#editReservation')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#blockChecklist .checklist li')).toHaveCount(20);
    await expect(page.locator('#restrictionSummary')).toHaveText('1 alergia a pistacho · 1 sin gluten'); // la del evento y la del huésped
    await expect.poll(() => [RESERVATIONS, FINANCE, EVENTS, GUESTS, RESTRICTIONS, CHECKLIST, ASSIGNMENTS].every((table) => api.rows(table).every((row) => row.deleted_at === null))).toBe(true);
    await expect(page.locator('#syncStatus')).toContainText('Todo sincronizado');
  });

  await test.step('vaciar papelera: borra para siempre solo lo que está en la papelera, de hijos a padres', async () => {
    await page.locator('.nav').getByText('Reservas', { exact: true }).click();
    await page.getByRole('button', { name: 'Nueva reserva' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nueva reserva' });
    await dialog.getByLabel('Nombre del grupo o evento').fill('Borrador para purgar');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(dialog).toBeHidden();
    await page.locator('.filters').getByRole('button', { name: 'Activas' }).click();
    await page.getByRole('button', { name: 'Abrir Borrador para purgar' }).click();
    await page.locator('details.more summary').click();
    await page.locator('#trashReservation').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Enviar a la papelera' }).click();
    await expect(page.locator('#trashCount')).toHaveText('1');

    await page.locator('#trash summary').click();
    await page.locator('#emptyTrash').click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('1 reserva y 1 elemento asociado'); // la reserva y su fila de importes
    await confirm.getByRole('button', { name: 'Vaciar papelera' }).click();
    await expect(page.locator('#trash')).toBeHidden();
    await expect.poll(() => api.rows(RESERVATIONS).map((r) => r.title)).toEqual(['Retiro Test']);
    expect(api.rows(FINANCE)).toHaveLength(1);
    expect(api.rows(CHECKLIST)).toHaveLength(20); // lo vivo no se toca
    expect(api.purgeRequests()).toEqual([[CHECKLIST, RESTRICTIONS, ASSIGNMENTS, STAFF, NEEDS, GUESTS, EVENTS, FINANCE, RESERVATIONS, BEDS, SPACES]]);
    await page.reload();
    await expect(page.locator('#reservationList')).toBeVisible();
    await expect(page.locator('#trash')).toBeHidden(); // tampoco queda en el espejo local
  });

  await test.step('personal: turnos por día, horas reales, reorden con un solo update, refuerzo urgente en Inicio y aviso al cerrar', async () => {
    await page.locator('.nav').getByText('Reservas', { exact: true }).click();
    await page.locator('.filters').getByRole('button', { name: 'Activas' }).click();
    await page.getByRole('button', { name: 'Abrir Retiro Test' }).click();
    await expect(page.locator('#blockStaff')).toContainText('Sin turnos todavía.');
    await expect(page.locator('#blockOperation')).toContainText('Personal—');
    const eventId = api.rows(EVENTS)[0]!.id;

    const addShift = async (name: string, fn: string, planned: string, day?: string) => {
      await page.locator('#addShift').click();
      const dialog = page.getByRole('dialog', { name: 'Nuevo turno' });
      await expect(dialog).toContainText('Solo el nombre: sin teléfono ni documento');
      await dialog.locator('#f-person_name').fill(name);
      await dialog.getByLabel('Función').selectOption({ label: fn });
      await dialog.getByLabel('Horas previstas').fill(planned);
      if (day) await dialog.locator('#f-work_date').fill(day);
      return dialog;
    };

    // El día tiene que caer dentro de las fechas de la reserva.
    let dialog = await addShift('Persona Sintética Dos', 'Soporte técnico', '6', inDays(40));
    await page.locator('#saveRow').click();
    await expect(dialog.locator('.formerror')).toContainText('dentro de las fechas de la reserva');
    await dialog.locator('#f-work_date').fill(inDays(11));
    await page.locator('#saveRow').click();
    await expect(dialog).toBeHidden();
    for (const [name, fn, hours] of [['Persona Sintética Uno', 'Cocina', '8'], ['Persona Sintética Tres', 'Mantenimiento de guardia', '4']] as const) {
      dialog = await addShift(name, fn, hours);
      await page.locator('#saveRow').click();
      await expect(dialog).toBeHidden();
    }
    await expect.poll(() => api.rows(STAFF).map((r) => r.person_name).sort()).toEqual(['Persona Sintética Dos', 'Persona Sintética Tres', 'Persona Sintética Uno']);
    expect(api.rows(STAFF).find((r) => r.person_name === 'Persona Sintética Dos')).toMatchObject({ event_id: eventId, function: 'soporte_tecnico', work_date: inDays(11), planned_hours: 6, status: 'prevista' });
    expect(api.rows(STAFF).find((r) => r.person_name === 'Persona Sintética Uno')).toMatchObject({ function: 'cocina', work_date: null, planned_hours: 8 });
    await expect(page.locator('#blockStaff .staff-day')).toHaveCount(2);
    await expect(page.locator('#blockStaff .staff-day').first()).toContainText('Todo el evento');
    await expect(page.locator('#blockStaff .staff-day[data-day="all"] .staff-item .name')).toHaveText(['Persona Sintética Uno', 'Persona Sintética Tres']);
    await expect(page.locator(`#blockStaff .staff-day[data-day="${inDays(11)}"]`)).toContainText('Persona Sintética Dos');
    await expect(page.locator('#staffTotals')).toHaveText('3 turnos · 18 h previstas · 0 h reales');

    // Horas reales de un turno.
    await page.getByRole('button', { name: 'Editar turno de Persona Sintética Uno' }).click();
    dialog = page.getByRole('dialog', { name: 'Editar turno' });
    await dialog.getByLabel('Horas reales').fill('7.5');
    await dialog.getByLabel('Estado').selectOption({ label: 'Realizada' });
    await page.locator('#saveRow').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#staffTotals')).toHaveText('3 turnos · 18 h previstas · 7,5 h reales');
    await expect(page.locator('#blockOperation')).toContainText('3 turnos · 18 h previstas · 7,5 h reales');
    await expect.poll(() => api.rows(STAFF).find((r) => r.person_name === 'Persona Sintética Uno')).toMatchObject({ actual_hours: 7.5, status: 'realizada' });

    // Reordenar: solo cambia el turno movido (un `update`).
    const before = new Map(api.rows(STAFF).map((r) => [r.id, { position: r.position, revision: r.revision }]));
    await page.locator('#blockStaff').getByRole('button', { name: 'Bajar Persona Sintética Uno', exact: true }).click();
    await expect.poll(() => api.rows(STAFF).filter((r) => r.position !== before.get(r.id)!.position || r.revision !== before.get(r.id)!.revision).map((r) => r.person_name)).toEqual(['Persona Sintética Uno']);
    await expect(page.locator('#blockStaff .staff-day[data-day="all"] .staff-item .name')).toHaveText(['Persona Sintética Tres', 'Persona Sintética Uno']);

    // Refuerzo urgente: aviso en Inicio hasta que se marca cubierto.
    await page.locator('#addNeed').click();
    dialog = page.getByRole('dialog', { name: 'Nuevo refuerzo' });
    await dialog.getByLabel('Tipo').selectOption({ label: 'Cocina' });
    await dialog.getByLabel('Personas').fill('2');
    await dialog.getByLabel('Prioridad').selectOption({ label: 'Urgente' });
    await page.locator('#saveRow').click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => api.rows(NEEDS)[0]).toMatchObject({ event_id: eventId, need_type: 'cocina', persons: 2, priority: 'urgente', status: 'detectado' });
    await expect(page.locator('#needList .row [data-role="priority"]')).toHaveClass(/alert/);

    await page.locator('.nav').getByText('Inicio', { exact: true }).click();
    await expect(page.locator('#upcomingList')).toBeVisible();
    await expect(page.locator('[data-notice="needs"]')).toHaveCount(0); // la entrada es dentro de diez días
    api.serverUpdate(RESERVATIONS, api.rows(RESERVATIONS)[0]!.id, { start_date: inDays(3), end_date: inDays(12) });
    await page.getByRole('button', { name: 'Sincronizar ahora' }).click();
    await expect(page.locator('[data-notice="needs"]')).toHaveText(/^1\s*refuerzo sin cubrir en los próximos 7 días$/);
    await page.locator('[data-notice="needs"] a').click(); // una sola reserva: va a su ficha
    await expect(page.getByRole('heading', { name: 'Retiro Test', level: 2 })).toBeVisible();
    await page.getByRole('button', { name: 'Marcar cubierto el refuerzo de Cocina' }).click();
    await expect.poll(() => api.rows(NEEDS)[0]!.status).toBe('cubierto');
    await expect(page.locator('#needList [data-action="cover"]')).toHaveCount(0);
    await page.locator('.nav').getByText('Inicio', { exact: true }).click();
    await expect(page.locator('#upcomingList')).toBeVisible();
    await expect(page.locator('[data-notice="needs"]')).toHaveCount(0);

    // Cierre operativo: avisa de los turnos sin horas reales, pero no bloquea.
    await page.locator('.nav').getByText('Reservas', { exact: true }).click();
    await page.getByRole('button', { name: 'Abrir Retiro Test' }).click();
    await page.locator('#closeEvent').click();
    const warning = page.getByRole('alertdialog', { name: 'Anotar cierre operativo' });
    await expect(warning).toContainText('2 turnos sin horas reales');
    await warning.getByRole('button', { name: 'Anotar cierre' }).click();
    await expect.poll(() => api.rows(EVENTS)[0]!.closed_at).not.toBeNull();
    await expect(page.locator('#blockOperation')).toContainText('Reabrir evento');
  });

  await test.step('tarifas y propuesta: tarifario, condiciones, borrador con sugerencia y extra, enviar, bloqueo, nueva versión, aceptar y documento', async () => {
    const euros = (n: number) => `${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`.replace(/\./g, '');
    const plain = (text: string | null) => (text ?? '').replace(/\./g, '').replace(/ /g, ' ');
    const shows = (locator: ReturnType<typeof page.locator>, amount: number) => expect.poll(async () => plain(await locator.textContent())).toContain(euros(amount));
    const goto = (hash: string) => page.evaluate((h) => { location.hash = h; }, hash);

    // Tarifario: dos tarifas con importes legibles, y un extra del catálogo.
    await page.locator('.nav').getByText('Inicio', { exact: true }).click();
    await page.locator('#openRatesHome').click();
    await expect(page.getByRole('heading', { name: 'Tarifas y condiciones', level: 2 })).toBeVisible();
    await expect(page.getByText('Todavía no hay tarifas')).toBeVisible();
    const newRate = async (name: string, layer: string, unit: string, amount: string, extra?: (dialog: ReturnType<typeof page.getByRole>) => Promise<void>) => {
      await page.locator('#newRate').click();
      const dialog = page.getByRole('dialog', { name: 'Nueva tarifa' });
      await dialog.locator('#f-name').fill(name);
      await dialog.locator('#f-layer').selectOption(layer);
      await dialog.locator('#f-unit').selectOption(unit);
      await dialog.locator('#f-amount').fill(amount);
      await extra?.(dialog);
      await page.locator('#saveRow').click();
      await expect(dialog).toBeHidden();
    };
    await newRate('Alojamiento en grupo', 'por_persona', 'persona_noche', '40', async (dialog) => {
      await dialog.locator('#f-service').selectOption('alojamiento');
      await dialog.getByLabel('Retiro', { exact: true }).check();
    });
    await newRate('Sala grande', 'recinto', 'dia', '500');
    await newRate('Equipo de sonido', 'extra', 'unidad', '60');
    await expect.poll(() => api.rows('booking.rates').length).toBe(3);
    expect(api.rows('booking.rates').find((r) => r.name === 'Alojamiento en grupo')).toMatchObject({ amount: 40, service: 'alojamiento', event_types: ['retiro'], layer: 'por_persona' });
    await expect(page.locator('section.zone[data-layer="por_persona"] [data-role="amount"]')).toHaveText('40,00 € / persona y noche');
    await expect(page.locator('section.zone[data-layer="extra"] .sectionlabel')).toContainText('Extras');
    await expect(page.locator('section.zone .sectionlabel').first()).toContainText('Recinto');

    // Condiciones por defecto con un tramo de cancelación.
    await page.locator('#newConditions').click();
    const conditionsDialog = page.getByRole('dialog', { name: 'Nuevas condiciones' });
    await conditionsDialog.locator('#f-name').fill('Condiciones estándar');
    await conditionsDialog.locator('#f-deposit_minimum').fill('300');
    await conditionsDialog.locator('#f-text').fill('La señal confirma la reserva.');
    await page.locator('#saveRow').click();
    await expect(conditionsDialog).toBeHidden();
    await expect.poll(() => api.rows('booking.conditions')[0]).toMatchObject({ name: 'Condiciones estándar', is_default: true, deposit_percent: 30, deposit_minimum: 300, prices_include_vat: true, vat_rate: 10 });
    const conditionsId = api.rows('booking.conditions')[0]!.id;
    await page.locator('[data-conditions="Condiciones estándar"] [data-action="addTier"]').click();
    const tierDialog = page.getByRole('dialog', { name: 'Nuevo tramo de cancelación' });
    await tierDialog.locator('#f-min_days_before').fill('60');
    await tierDialog.locator('#f-deposit_refund_pct').fill('100');
    await page.locator('#saveRow').click();
    await expect(tierDialog).toBeHidden();
    await expect(page.locator('[data-conditions="Condiciones estándar"] .tier-text')).toHaveText('Con 60 días o más de antelación: se devuelve toda la señal.');
    await expect(page.locator('[data-conditions="Condiciones estándar"] [data-role="default"]')).toBeVisible();

    // Ficha: crear la propuesta (usa las condiciones por defecto), sugerir líneas, añadir un extra y ver el total en vivo.
    await page.locator('.nav').getByText('Reservas', { exact: true }).click();
    await page.getByRole('button', { name: 'Abrir Retiro Test' }).click();
    await expect(page.locator('#blockProposal')).toContainText('Todavía no hay propuesta');
    await page.locator('#createProposal').click();
    await expect.poll(() => api.rows('booking.proposals').length).toBe(1);
    expect(api.rows('booking.proposals')[0]).toMatchObject({ version: 1, status: 'borrador', conditions_id: conditionsId, nature: 'orientativa' });
    const v1 = api.rows('booking.proposals')[0]!.id;
    await expect(page.locator('#proposalStatus')).toHaveText('v1 · Borrador');
    await page.locator('#editProposal').click();
    await expect(page.getByRole('heading', { name: 'Propuesta v1', level: 2 })).toBeVisible();
    await page.locator('#suggestLines').click();
    await expect.poll(() => api.rows('booking.proposal_lines').length).toBe(2);
    expect(api.rows('booking.proposal_lines').map((l) => l.description).sort()).toEqual(['Alojamiento en grupo', 'Sala grande']);
    await page.locator('#addExtra').click();
    await page.locator('#extraChoices [data-extra="Equipo de sonido"]').click();
    await expect(page.locator('#lineAmountPreview')).toContainText('60,00 €');
    await page.locator('#saveRow').click();
    await expect.poll(() => api.rows('booking.proposal_lines').length).toBe(3);

    const totalOf = (proposalId: string) => {
      const lines = api.rows('booking.proposal_lines').filter((l) => l.proposal_id === proposalId && l.deleted_at === null);
      const conditions = api.rows('booking.conditions')[0]!;
      return proposalTotals(lines as any, conditions as any);
    };
    const t1 = totalOf(v1);
    expect(t1.total).toBeGreaterThan(5000);
    await shows(page.locator('#proposalTotal'), t1.total);
    await shows(page.locator('#proposalDeposit'), t1.deposit_amount);
    await expect(page.locator('#totalVat')).toContainText('Incluido (10 %)');

    // Marcar enviada: ya no se edita.
    await page.locator('#backToReservation').click();
    await page.locator('#sendProposal').click();
    await expect.poll(() => api.rows('booking.proposals')[0]!.status).toBe('enviada');
    expect(Number(api.rows('booking.proposals')[0]!.total)).toBe(t1.total);
    await expect(page.locator('#proposalStatus')).toHaveText('v1 · Enviada');
    await expect(page.locator('#editProposal')).toHaveCount(0);
    await goto(`#/propuesta/${v1}`);
    await expect(page.locator('#proposalReadonly')).toBeVisible();
    await expect(page.locator('#addLine')).toHaveCount(0);
    await expect(page.locator('#suggestLines')).toHaveCount(0);

    // Condiciones ya usadas: el servidor las rechaza y la hoja lo explica.
    await goto('#/tarifas');
    await page.getByRole('button', { name: 'Editar condiciones Condiciones estándar' }).click();
    const inUse = page.getByRole('dialog', { name: 'Condiciones' });
    await expect(inUse.locator('#conditionsInUse')).toBeVisible();
    await inUse.locator('#f-deposit_percent').fill('40');
    await page.locator('#saveRow').click();
    await expect(inUse).toContainText('Estas condiciones ya se usaron en una propuesta enviada: crea unas nuevas.');
    page.once('dialog', (confirmation) => void confirmation.accept()); // «Hay cambios sin guardar»
    await inUse.getByRole('button', { name: 'Cancelar' }).click();
    await expect(inUse).toBeHidden();
    expect(api.rows('booking.conditions')[0]!.deposit_percent).toBe(30);

    // Nueva versión (copia las líneas), un descuento en una línea y envío: la anterior queda sustituida.
    await page.locator('.nav').getByText('Reservas', { exact: true }).click();
    await page.getByRole('button', { name: 'Abrir Retiro Test' }).click();
    await page.locator('#newVersion').click();
    await expect.poll(() => api.rows('booking.proposals').length).toBe(2);
    const v2 = api.rows('booking.proposals').find((p) => p.version === 2)!.id;
    expect(api.rows('booking.proposal_lines').filter((l) => l.proposal_id === v2)).toHaveLength(3);
    await expect(page.locator('#proposalDraft')).toContainText('La versión 2 está en borrador');
    await expect(page.locator('#proposalStatus')).toHaveText('v1 · Enviada');
    await page.locator('#editProposal').click();
    await page.getByRole('button', { name: 'Editar Sala grande' }).click();
    await page.locator('#f-discount_pct').fill('10');
    await expect(page.locator('#lineAmountPreview')).toContainText('4500');
    await page.locator('#saveRow').click();
    await expect.poll(() => api.rows('booking.proposal_lines').filter((l) => l.proposal_id === v2 && l.discount_pct === 10).length).toBe(1);
    const t2 = totalOf(v2);
    expect(t2.total).toBeLessThan(t1.total);
    await shows(page.locator('#proposalTotal'), t2.total);
    await page.locator('#backToReservation').click();
    await page.locator('#sendProposal').click();
    await expect.poll(() => api.rows('booking.proposals').find((p) => p.id === v1)!.status).toBe('sustituida');
    await expect(page.locator('#proposalStatus')).toHaveText('v2 · Enviada');

    // Aceptar fija el importe final y la señal en el bloque de cobro.
    await page.locator('#acceptProposal').click();
    const accept = page.getByRole('alertdialog', { name: 'Aceptar propuesta' });
    await expect(accept).toContainText('importe final');
    await accept.getByRole('button', { name: 'Aceptar propuesta' }).click();
    await expect.poll(() => api.rows('booking.proposals').find((p) => p.id === v2)!.status).toBe('aceptada');
    const reservationId = api.rows(RESERVATIONS)[0]!.id;
    expect(api.rows(FINANCE).find((f) => f.id === reservationId)).toMatchObject({ final_amount: t2.total, deposit_required: t2.deposit_amount });
    await shows(page.locator('#blockFinance'), t2.total);
    await expect(page.locator('#proposalStatus')).toHaveText('v2 · Aceptada');
    await page.locator('#proposalHistory summary').click();
    await expect(page.locator('#proposalHistory [data-version="1"]')).toContainText('Sustituida');

    // Documento para el organizador: sin datos de huéspedes.
    await page.locator('#viewDocument').click();
    await expect(page.getByRole('heading', { name: 'Retiro Test', level: 1 })).toBeVisible();
    await expect(page.locator('#documentNature')).toHaveText('Propuesta orientativa');
    await shows(page.locator('#documentTotal'), t2.total);
    await expect(page.locator('#proposalDocument')).toContainText('IVA incluido (10 %)');
    await expect(page.locator('#proposalDocument')).toContainText('Con 60 días o más de antelación: se devuelve toda la señal.');
    await expect(page.locator('#proposalDocument')).toContainText('La señal confirma la reserva.');
    await expect(page.locator('#documentDeposit')).toContainText('señal');
    await expect(page.locator('#proposalDocument')).toContainText('descuento −10 %');
    await expect(page.locator('#proposalDocument')).not.toContainText('Persona Sintética');
    await expect(page.locator('#printDocument')).toBeVisible();
  });
});

test('lanzador: la marca de la cabecera abre las apps de la cuenta con Booking marcada', async ({ page }) => {
  await login(page);
  await page.locator('#appLauncher').click();
  const sheet = page.getByRole('dialog', { name: 'Apps de Ikisai' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('link', { name: /Tasks/ })).toHaveAttribute('href', 'https://tasks.example.test/');
  await expect(sheet.getByRole('link', { name: /Organizadores/ })).toBeVisible();
  await expect(sheet.locator('[aria-current]')).toContainText('Booking');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});

test('PWA: manifest, service worker y shell en caché', async ({ page }) => {
  await login(page);
  const manifest = await page.request.get(`${baseURL}/manifest.webmanifest`);
  expect(manifest.ok()).toBeTruthy();
  expect(await manifest.json()).toMatchObject({ id: '/', name: 'Ikisai Booking', short_name: 'Booking', start_url: '/', display: 'standalone' });
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
