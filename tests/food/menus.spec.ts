/**
 * Recorrido G–H de Ikisai Food en el navegador: evento de Booking → menú con propuesta de servicios → platos desde el
 * recetario visual → avisos de restricciones → validar → Booking cambia las personas → aviso, reabrir, revisar y validar.
 *
 * Cómo correrlo:   npx playwright test tests/food/menus.spec.ts      (desde la raíz del repo)
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, day, TIME_ZONE, buildFoodApp } from './helpers.ts';
import { startFakeApi, type FakeApi } from './fake-api.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/food/vite.config.ts');
const USER = { email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' };
const EVENT_ID = randomUUID();
const NO_MEALS_ID = randomUUID();
const RESERVATION_ID = randomUUID();

// La app calcula «hoy» con la fecha local del navegador: la misma zona que `day()` y el servidor.
test.use({ timezoneId: TIME_ZONE });

let api: FakeApi;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
  api = await startFakeApi({
    users: [USER],
    events: [{
      event_id: EVENT_ID, event_code: 'EVT_2026_001', reservation_code: 'RSV_2026_001', title: 'Retiro Test', event_type: 'retiro',
      start_date: day(10), end_date: day(12), arrival_time: '17:00:00', departure_time: '12:00:00', guest_count: 22, guest_count_is_final: true, minors_count: 0,
      meal_plan: 'pension_completa', menu_style: 'vegetariano', reservation_status: 'confirmada', requires_meals: true, meal_notes: null, event_revision: 3,
      dietary_restrictions: [
        { type: 'alergia', subject: 'pistacho', severity: 'grave', servings: 1, kitchen_notes: null },
        { type: 'vegano', subject: null, severity: null, servings: 2, kitchen_notes: null },
      ],
    }, {
      // Como «Test1» en la prueba del usuario: confirmado en Booking pero sin comidas ni régimen.
      event_id: NO_MEALS_ID, event_code: 'EVT_2026_002', reservation_code: 'RSV_2026_002', title: 'Test1', event_type: 'retiro',
      start_date: day(20), end_date: day(22), arrival_time: null, departure_time: null, guest_count: 20, guest_count_is_final: false, minors_count: 0,
      meal_plan: null, menu_style: null, reservation_status: 'confirmada', requires_meals: false, meal_notes: null, event_revision: 1, dietary_restrictions: [],
      reservation_id: RESERVATION_ID,
    }],
  });
  api.seed('food.recipes', { name: 'Curry de verduras', public_name: 'Curry suave de temporada', public_description: 'Verduras de temporada con leche de coco y arroz especiado.', category: 'principal', base_servings: 20, status: 'validada', diet_tags: ['vegano', 'vegetariano'], allergens: [], allergens_checked: true });
  api.seed('food.recipes', { name: 'Pasta al pesto', category: 'principal', base_servings: 20, status: 'validada', diet_tags: ['vegetariano'], allergens: ['gluten', 'frutos_de_cascara', 'lacteos'], allergens_checked: true });
  process.env.VITE_API_PROXY = api.url;
  await buildFoodApp();
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

async function login(page: Page): Promise<void> {
  await page.goto(`${baseURL}/`);
  await page.getByLabel('Correo electrónico').fill(USER.email);
  await page.getByLabel('Contraseña').fill(USER.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: `Hola, ${USER.displayName}` })).toBeVisible();
}

const menu = () => api.rows('food.menus')[0]!;

async function addDish(page: Page, recipe: string): Promise<void> {
  await page.locator('.service').first().getByRole('button', { name: 'Añadir plato' }).click();
  await page.getByRole('dialog').getByRole('button', { name: `Añadir ${recipe}` }).click();
  await expect(page.locator('.service').first().locator('.dish', { hasText: recipe })).toBeVisible();
}

async function validate(page: Page, acknowledgements: number): Promise<void> {
  await page.locator('#validateMenu').click();
  const dialog = page.getByRole('dialog', { name: 'Antes de validar' });
  await expect(dialog.locator('#ackList input')).toHaveCount(acknowledgements);
  await expect(page.locator('#confirmValidate')).toBeDisabled();
  for (const box of await dialog.locator('#ackList input').all()) await box.check();
  await page.locator('#confirmValidate').click();
  await expect(page.locator('#menuStatus')).toHaveText('Validado');
}

test('evento → menú → avisos → validar → el evento cambia → revisar y validar de nuevo @smoke', async ({ page, context }) => {
  test.setTimeout(120_000);

  await test.step('Inicio y Eventos enseñan el retiro tal como lo publica Booking', async () => {
    await login(page);
    // Sin menús todavía: el texto de Menús lleva a la ficha del evento.
    await page.goto(`${baseURL}/#/menus`);
    await expect(page.locator('.empty')).toContainText('Abre un evento en Eventos y pulsa «Crear menú» en su ficha.');
    await page.goto(`${baseURL}/#/`);
    const card = page.locator('#upcoming .eventcard', { hasText: 'Retiro Test' });
    await expect(card).toContainText('22 personas · Pensión completa');
    await expect(card).toContainText('pendiente');
    await page.goto(`${baseURL}/#/eventos`);
    const row = page.locator('#eventList .row', { hasText: 'Retiro Test' });
    await expect(row).toContainText('Sin menú');
    await expect(row).toContainText('2 restricciones');
    await expect(page.locator('#eventsStamp')).toContainText('Datos de los eventos a fecha de');
  });

  await test.step('crear el menú con la propuesta de servicios del régimen', async () => {
    await page.locator('#eventList .row', { hasText: 'Retiro Test' }).click();
    const sheet = page.getByRole('dialog', { name: 'Retiro Test' });
    await expect(sheet).toContainText('1 alergia a pistacho (grave)');
    await expect(sheet).toContainText('2 veganos');
    await expect(sheet.locator('input[type=checkbox]')).toHaveCount(5); // cena · desayuno, comida, cena · desayuno
    await page.locator('#createMenu').click();
    await expect(page).toHaveURL(/#\/menus\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: 'Retiro Test', level: 2 })).toBeVisible();
    await expect(page.locator('#menuStatus')).toHaveText('Borrador');
    await expect(page.locator('.service')).toHaveCount(5);
    await expect(page.locator('.menuday')).toHaveCount(3);
    await expect(page.locator('#menuRestrictions')).toContainText('1 alergia a pistacho');
    await expect.poll(() => api.rows('food.menu_services').length).toBe(5);
    expect(menu()).toMatchObject({ event_id: EVENT_ID, source_event_revision: 3, status: 'borrador' });
    expect((menu().source_event_snapshot as { guest_count: number }).guest_count).toBe(22);
  });

  await test.step('platos desde el recetario visual, con las raciones del evento; el aviso de alergia aparece', async () => {
    await addDish(page, 'Curry de verduras');
    await expect(page.locator('.dish', { hasText: 'Curry de verduras' }).locator('.servings')).toHaveValue('22');
    await expect(page.locator('#menuWarnings')).toHaveCount(0);
    await addDish(page, 'Pasta al pesto');
    await expect(page.locator('#menuWarnings')).toContainText('«Pasta al pesto» declara frutos de cáscara: 1 alergia a pistacho.');
    // El pesto es para dos: se cambian las raciones en línea.
    const pesto = page.locator('.dish', { hasText: 'Pasta al pesto' }).locator('.servings');
    await pesto.fill('2');
    await pesto.blur();
    await expect.poll(() => api.rows('food.menu_items').find((i) => i.servings === 2)).toBeTruthy();
  });

  await test.step('orden a mano de platos y servicios, persistente', async () => {
    const first = page.locator('.service').first();
    await expect(first.locator('.dish strong')).toHaveText(['Curry de verduras', 'Pasta al pesto']);
    const position = (servings: number) => Number(api.rows('food.menu_items').find((i) => i.servings === servings)!.position);
    await first.getByRole('button', { name: 'Subir Pasta al pesto' }).click();
    await expect(first.locator('.dish strong')).toHaveText(['Pasta al pesto', 'Curry de verduras']);
    await expect(first.getByRole('button', { name: 'Subir Pasta al pesto' })).toBeDisabled();
    // El asa del kit también se mueve con el teclado (y con arrastre): el curry sube y vuelve a bajar.
    // Con el teclado sobre el asa: la lista se conserva entre guardados, así que el segundo movimiento lleva revisiones al día.
    const handle = first.getByRole('button', { name: /^Mover Curry de verduras/ });
    await handle.press('ArrowUp');
    await expect(first.locator('.dish strong')).toHaveText(['Curry de verduras', 'Pasta al pesto']);
    await expect.poll(() => position(22) < position(2)).toBe(true);
    await first.getByRole('button', { name: /^Mover Curry de verduras/ }).press('ArrowDown');
    await expect(first.locator('.dish strong')).toHaveText(['Pasta al pesto', 'Curry de verduras']);
    await expect.poll(() => position(2) < position(22)).toBe(true);
    await expect.poll(() => position(2) < position(22)).toBe(true);
    // El sábado: la cena sube por delante de la comida.
    const saturday = page.locator('.menuday').nth(1);
    await expect(saturday.locator('.service h4')).toHaveText(['Desayuno', 'Comida', 'Cena']);
    await saturday.getByRole('button', { name: 'Subir Cena' }).click();
    await expect(saturday.locator('.service h4')).toHaveText(['Desayuno', 'Cena', 'Comida']);
    await page.reload();
    await expect(page.locator('.menuday').nth(1).locator('.service h4')).toHaveText(['Desayuno', 'Cena', 'Comida']);
    await expect(page.locator('.service').first().locator('.dish strong')).toHaveText(['Pasta al pesto', 'Curry de verduras']);
    // Se deja como estaba para el resto del recorrido.
    await page.locator('.menuday').nth(1).getByRole('button', { name: 'Bajar Cena' }).click();
    await expect(page.locator('.menuday').nth(1).locator('.service h4')).toHaveText(['Desayuno', 'Comida', 'Cena']);
  });

  await test.step('validar exige aceptar el aviso; después el menú queda bloqueado', async () => {
    await validate(page, 1);
    expect(menu()).toMatchObject({ status: 'validado', source_event_revision: 3 });
    expect(menu().validated_warnings).toHaveLength(1);
    await expect(page.locator('.dish .servings').first()).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Añadir plato' })).toHaveCount(0);
  });

  await test.step('hoja del organizador: solo lo público, en el orden fijado, y se imprime en A4', async () => {
    await page.locator('.menutabs').getByRole('link', { name: 'Organizador', exact: true }).click();
    const sheet = page.locator('.print-page');
    await expect(sheet).toContainText('Retiro Test');
    await expect(sheet).toHaveAttribute('data-draft', 'false'); // el menú está validado
    // Nombre y descripción públicos de la receta; el pesto va primero porque así se ordenó a mano.
    await expect(sheet).toContainText('Curry suave de temporada');
    await expect(sheet).toContainText('Verduras de temporada con leche de coco y arroz especiado.');
    const text = (await sheet.innerText()).replace(/\s+/g, ' ');
    expect(text.indexOf('Pasta al pesto')).toBeLessThan(text.indexOf('Curry suave de temporada'));
    expect(text).toContain('Vegano');
    expect(text).toContain('Frutos de cáscara');
    // Nada interno: ni raciones, ni nombre interno, ni restricciones del grupo, ni avisos.
    expect(text).not.toContain('Curry de verduras');
    expect(text).not.toMatch(/\brac\./);
    expect(text).not.toContain('alergia a pistacho');
    expect(text).not.toContain('personas');
    // Como al pulsar «Imprimir»: el kit marca el documento y solo queda la hoja.
    await page.evaluate(() => document.documentElement.classList.add('printing'));
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('.nav')).toBeHidden();
    await expect(page.locator('#printPage')).toBeHidden();
    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.byteLength).toBeGreaterThan(5_000);
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => document.documentElement.classList.remove('printing'));
    await page.locator('.menutabs').getByRole('link', { name: 'Menú', exact: true }).click();
  });

  await test.step('Booking pasa de 22 a 25 personas: aviso con lo que cambió, sin tocar el menú validado', async () => {
    api.updateEvent(EVENT_ID, { guest_count: 25 });
    await page.reload();
    const banner = page.locator('#menuStale');
    await expect(banner).toContainText('La información del evento ha cambiado.');
    await expect(banner).toContainText('Personas: 22 → 25');
    await expect(page.locator('#menuStatus')).toHaveText('Validado');
    expect(menu().source_event_revision).toBe(3);
    await page.goto(`${baseURL}/#/`);
    await expect(page.locator('#upcoming .eventcard', { hasText: 'Retiro Test' })).toContainText('desactualizado');
    await page.goBack();
  });

  await test.step('reabrir, ajustar raciones, dar por revisado el cambio y validar de nuevo', async () => {
    await page.locator('#reopenStale').click();
    await expect(page.locator('#menuStatus')).toHaveText('Por revisar');
    const curry = page.locator('.dish', { hasText: 'Curry de verduras' }).locator('.servings');
    await expect(curry).toBeEnabled();
    await curry.fill('25');
    await curry.blur();
    await expect.poll(() => api.rows('food.menu_items').find((i) => i.servings === 25)).toBeTruthy();
    await page.locator('#acknowledgeEvent').click();
    await expect(page.locator('#menuStale')).toBeEmpty();
    await expect.poll(() => menu().source_event_revision).toBe(4);
    await validate(page, 1);
    expect(menu()).toMatchObject({ status: 'validado', source_event_revision: 4 });
    expect((menu().source_event_snapshot as { guest_count: number }).guest_count).toBe(25);
  });

  await test.step('sin red: el menú se consulta, pero cambiar de estado pide conexión', async () => {
    await page.reload();
    await expect(page.locator('.dish')).toHaveCount(2);
    await context.setOffline(true);
    await expect(page.locator('#syncStatus')).toContainText('Sin conexión');
    await page.locator('#reopenMenu').click();
    await expect(page.getByText('Esta acción necesita conexión.')).toBeVisible();
    await expect(page.locator('#menuStatus')).toHaveText('Validado');
    await page.goto(`${baseURL}/#/eventos`);
    await expect(page.locator('#eventList .row', { hasText: 'Retiro Test' })).toContainText('Menú: validado');
    await context.setOffline(false);
  });
  await test.step('evento sin comidas en Booking: la ficha explica por qué y deja crear el menú (incidencia de la aceptación)', async () => {
    await page.goto(`${baseURL}/#/eventos`);
    const row = page.locator('#eventList .row', { hasText: 'Test1' });
    await expect(row).toContainText('Sin comidas en Booking');
    await page.locator('.segmented button', { hasText: 'Sin menú' }).click();
    await expect(page.locator('#eventList .row', { hasText: 'Test1' })).toBeVisible();
    await page.locator('#eventList .row', { hasText: 'Test1' }).click();
    const sheet = page.getByRole('dialog', { name: 'Test1' });
    await expect(sheet.locator('#mealsGap')).toContainText('En Booking esta reserva figura sin comidas.');
    await expect(sheet.locator('#mealsGap')).toContainText('RSV_2026_002');
    await expect(sheet.locator('#openBooking')).toHaveAttribute('href', `https://booking.ikisai.com/#/reservas/${RESERVATION_ID}`);
    await expect(sheet.locator('#openBooking')).toHaveText('Abrir la reserva en Booking');
    await expect(sheet.locator('#proposedServices')).toContainText('el menú se crea vacío');
    // La cocina elige proponer como media pensión: viernes cena, sábado desayuno y cena, domingo desayuno.
    await sheet.locator('#proposalPlan').selectOption('media_pension');
    await expect(sheet.locator('#proposedServices input[type=checkbox]')).toHaveCount(4);
    await page.locator('#createMenu').click();
    await expect(page).toHaveURL(/#\/menus\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: 'Test1', level: 2 })).toBeVisible();
    await expect(page.locator('.service')).toHaveCount(4);
    await expect.poll(() => api.rows('food.menus').some((m) => m.event_id === NO_MEALS_ID)).toBe(true);
    await page.goto(`${baseURL}/#/eventos`);
    await expect(page.locator('#eventList .row', { hasText: 'Test1' })).toContainText('Menú: borrador');
  });

  await test.step('compartir el menú validado con el organizador y atender sus comentarios del portal', async () => {
    const retiro = menu();
    await page.goto(`${baseURL}/#/menus/${retiro.id}`);
    await expect(page.locator('#menuStatus')).toHaveText('Validado');
    // Sin compartir y sin comentarios: no hay sección de comentarios.
    await expect(page.locator('#menuComments')).toBeHidden();
    await expect(page.locator('#menuShare')).toContainText('El organizador lo verá en su portal como propuesta hasta que esté validado.');
    await page.locator('#shareMenu').click();
    await expect(page.locator('#menuShared')).toHaveText('Compartido con el organizador');
    await expect(page.locator('#unshareMenu')).toBeVisible();
    await expect.poll(() => menu().organizer_shared).toBe(true);
    expect(api.rows('food.menus').find((m) => m.id === retiro.id)).toMatchObject({ organizer_shared: true, status: 'validado' });
    await expect(page.locator('#menuComments')).toContainText('Sin comentarios del organizador.');

    // El organizador comenta desde su portal (la acción de servidor crea las filas; aquí se siembran y se publican como cambios).
    const serviceIds = api.rows('food.menu_services').filter((s) => s.menu_id === retiro.id).map((s) => s.id);
    const pesto = api.rows('food.menu_items').find((i) => i.servings === 2 && serviceIds.includes(i.service_id as string))!;
    const dish = api.seed('food.menu_comments', { menu_id: retiro.id, service_id: pesto.service_id, menu_item_id: pesto.id, kind: 'prefiero_que_no', message: 'Mejor sin frutos secos, por favor.' });
    const general = api.seed('food.menu_comments', { menu_id: retiro.id, kind: 'comentario', message: '¿Puede haber más fruta en el desayuno?' });
    api.serverUpdate('food.menu_comments', dish.id, { created_at: new Date(Date.now() - 60_000).toISOString() });
    api.serverUpdate('food.menu_comments', general.id, { created_at: new Date().toISOString() });
    await page.reload();

    const notice = page.locator('#menuCommentsNotice');
    await expect(notice).toContainText('2 comentarios nuevos del organizador');
    await notice.locator('#goComments').click();
    const items = page.locator('#menuComments .menucomment');
    await expect(items).toHaveCount(2);
    // Del más nuevo al más antiguo.
    await expect(items.nth(0)).toContainText('Menú en general');
    await expect(items.nth(0)).toContainText('Comentario');
    await expect(items.nth(0)).toContainText('¿Puede haber más fruta en el desayuno?');
    await expect(items.nth(1)).toContainText('Pasta al pesto');
    await expect(items.nth(1)).toContainText('Prefiere que no');
    await expect(items.nth(1).locator('.commentstatus')).toHaveText('Nuevo');

    // En la lista de Menús, el chip de comentarios nuevos.
    await page.goto(`${baseURL}/#/menus`);
    await expect(page.locator('#menuList li', { hasText: 'Retiro Test' })).toContainText('2 comentarios nuevos');
    await page.goBack();

    // Cocina responde al del plato y lo da por resuelto.
    const pestoComment = page.locator('#menuComments .menucomment', { hasText: 'Pasta al pesto' });
    await pestoComment.getByLabel('Respuesta al organizador').fill('Lo cambiamos por pasta al pomodoro.');
    await pestoComment.getByRole('button', { name: 'Responder' }).click();
    await expect.poll(() => api.rows('food.menu_comments').find((c) => c.id === dish.id)?.reply).toBe('Lo cambiamos por pasta al pomodoro.');
    await expect(pestoComment.locator('.commentstatus')).toHaveText('Visto');
    await expect(notice).toContainText('1 comentario nuevo del organizador');
    await pestoComment.getByRole('button', { name: 'Resuelto' }).click();
    await expect(pestoComment.locator('.commentstatus')).toHaveText('Resuelto');
    await expect.poll(() => api.rows('food.menu_comments').find((c) => c.id === dish.id)).toMatchObject({ status: 'resuelto', reply: 'Lo cambiamos por pasta al pomodoro.' });
    await expect(pestoComment.getByRole('button', { name: 'Resuelto' })).toHaveCount(0);
    expect(api.rows('food.menu_comments').find((c) => c.id === general.id)).toMatchObject({ status: 'nuevo', reply: null });
  });

});
