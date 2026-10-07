/**
 * «Sugerencias y QA» en Booking (FEEDBACK_ESPECIFICACION §27, recorrido de prueba en PC): el interruptor «Señalar para comentar»
 * del lanzador, la pulsación larga sobre un control marcado, el formulario con la ruta de etiquetas, el envío con el nodo
 * estable y sin datos de los campos ignorados, y el centro «Sugerencias y QA» listando el reporte.
 *
 * Cómo correrlo:   npx playwright test tests/booking/feedback.spec.ts
 * Solo contra la API falsa en memoria (fake-api.ts, rutas /feedback*); nunca contra Supabase.
 */
import { expect, test, type Page } from 'playwright/test';
import { inDays, login as loginTo, startHarness, type Harness } from './harness.ts';

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(120_000);

const PHONE = '600123456';
const CONTACT = 'Ana Ficticia';
const PATTERN = /^booking(\.[a-z0-9_]+){1,4}$/;

let harness: Harness;
test.beforeAll(async () => { harness = await startHarness(); });
test.afterAll(async () => { await harness?.close(); });

/** Pulsación larga con el ratón sobre el centro del elemento (el gesto del kit son 600 ms). */
async function hold(page: Page, selector: string, ms = 900): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`Sin caja para ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

/** Abre el lanzador de la cabecera y cambia el interruptor «Señalar para comentar». */
async function setSignal(page: Page, on: boolean): Promise<void> {
  await page.locator('#appLauncher').click();
  const dialog = page.getByRole('dialog');
  const toggle = dialog.getByRole('switch', { name: /Señalar para comentar/ });
  await expect(toggle).toBeVisible();
  if ((await toggle.isChecked()) !== on) await toggle.setChecked(on);
  await expect(toggle).toBeChecked({ checked: on });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

const domIds = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll('[data-feedback-id]')).map((n) => n.getAttribute('data-feedback-id') ?? ''));

test('recorrido de feedback en PC: interruptor, pulsación larga, formulario, envío y «Sugerencias y QA»', async ({ page }) => {
  const api = harness.api;
  await loginTo(page, harness.baseURL);

  await test.step('una reserva con contacto (datos personales que no deben viajar)', async () => {
    await page.locator('.nav').getByText('Reservas', { exact: true }).click();
    await page.getByRole('button', { name: 'Nueva reserva' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nueva reserva' });
    await dialog.getByLabel('Nombre del grupo o evento').fill('Retiro Feedback');
    await dialog.getByLabel('Estado').selectOption('pre_reservada');
    await dialog.getByLabel('Entrada').fill(inDays(10));
    await dialog.getByLabel('Salida').fill(inDays(12));
    await dialog.getByLabel('Personas previstas').fill('12');
    await dialog.getByLabel('Contacto').fill(CONTACT);
    await dialog.getByLabel('Teléfono').fill(PHONE);
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Abrir Retiro Feedback' }).click();
    await expect(page.getByRole('heading', { name: 'Retiro Feedback', level: 2 })).toBeVisible();
  });

  await test.step('el lanzador ofrece «Señalar para comentar», apagado por defecto', async () => {
    await page.locator('#appLauncher').click();
    const toggle = page.getByRole('dialog').getByRole('switch', { name: /Señalar para comentar/ });
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await page.keyboard.press('Escape');
  });

  await test.step('con el modo apagado la pulsación larga no cambia nada', async () => {
    await hold(page, '#blockSummary h3');
    await expect(page.locator('.fb-composer')).toHaveCount(0);
    await expect(page.locator('html.fb-mode')).toHaveCount(0);
    await expect(page.locator('.fb-pin')).toHaveCount(0);
    // El clic normal sigue funcionando igual que siempre.
    await page.locator('#editReservation').click();
    await expect(page.getByRole('dialog', { name: 'Editar reserva' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Editar reserva' })).toBeHidden();
  });

  await test.step('con el modo encendido, la pulsación larga sobre un dato personal no abre nada', async () => {
    await setSignal(page, true);
    await expect(page.locator('html.fb-mode')).toHaveCount(1);
    await hold(page, '#blockSummary [data-feedback-ignore]');
    await expect(page.locator('.fb-composer')).toHaveCount(0);
  });

  await test.step('la pulsación larga sobre «Editar» abre el formulario con la ruta de etiquetas', async () => {
    await hold(page, '[data-feedback-id="booking.reserva.acciones.editar"]');
    const composer = page.locator('.fb-composer');
    await expect(composer).toBeVisible();
    await expect(composer.locator('.fb-where strong')).toHaveText('Reserva › Acciones › Editar');
    // El clic que llegaría al soltar se anula: no se abre la hoja de edición.
    await expect(page.getByRole('dialog', { name: 'Editar reserva' })).toHaveCount(0);
  });

  await test.step('enviar el comentario: nodo estable y contexto sin los campos ignorados', async () => {
    const composer = page.locator('.fb-composer');
    await composer.getByRole('textbox', { name: 'Comentario' }).fill('El botón Editar debería decir «Editar reserva».');
    await composer.getByRole('button', { name: 'Enviar' }).click();
    await expect.poll(() => api.feedbackReports().length).toBe(1);
    const report = api.feedbackReports()[0]!;
    expect(report.node?.id).toBe('booking.reserva.acciones.editar');
    expect(report.node?.path).toEqual(['Reserva', 'Acciones', 'Editar']);
    expect(report.message).toContain('Editar reserva');
    expect(report.originApp).toBe('booking');
    const serialized = JSON.stringify(report.context);
    expect(serialized).not.toContain(PHONE);
    expect(serialized).not.toContain(CONTACT);
    expect(serialized).not.toContain('Retiro Feedback');
    // La ruta sin ids de negocio: el uuid de la reserva no viaja en la ruta saneada.
    expect(String((report.context as { route?: string }).route)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    await expect(page.locator('.fb-composer')).toHaveCount(0, { timeout: 5_000 });
  });

  await test.step('«Sugerencias y QA» lista el reporte (Abiertos y Mapa)', async () => {
    await page.locator('#appLauncher').click();
    await page.locator('.launcher-center').click();
    const sheet = page.getByRole('dialog', { name: 'Sugerencias y QA' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('tab', { name: 'Abiertos' }).click();
    const card = sheet.locator('.fb-card');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('FB-0001');
    await expect(card).toContainText('El botón Editar debería decir');
    await expect(card).toContainText('Reserva › Acciones › Editar');
    await sheet.getByRole('tab', { name: 'Mapa' }).click();
    await expect(sheet).toContainText('Reserva');
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  await test.step('apagar el modo devuelve la app a su estado normal', async () => {
    await setSignal(page, false);
    await expect(page.locator('html.fb-mode')).toHaveCount(0);
    await hold(page, '[data-feedback-id="booking.reserva.acciones.editar"]');
    await expect(page.locator('.fb-composer')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });
});

test('todas las pantallas llevan ids con la forma estable y sin ids de negocio', async ({ page }) => {
  await loginTo(page, harness.baseURL);
  const screens: Array<[string, string]> = [
    ['#/', 'booking.inicio'], ['#/reservas', 'booking.reservas'], ['#/calendario', 'booking.calendario'], ['#/huespedes', 'booking.huespedes'],
    ['#/espacios', 'booking.espacios'], ['#/tarifas', 'booking.tarifas'], ['#/ses', 'booking.ses'], ['#/pendientes', 'booking.pendientes'],
  ];
  for (const [hash, root] of screens) {
    await page.goto(`${harness.baseURL}/${hash}`);
    await expect(page.locator(`main[data-feedback-id="${root}"]`)).toBeVisible();
    const ids = await domIds(page);
    expect(ids.length).toBeGreaterThan(8); // cabecera, navegación y la propia pantalla
    for (const id of ids) {
      expect(id, id).toMatch(PATTERN);
      expect(id, id).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }
    // Las etiquetas existen en cada nivel (la ruta se forma subiendo por los ancestros).
    const unlabeled = await page.evaluate(() => Array.from(document.querySelectorAll('[data-feedback-id]:not([data-feedback-label])')).map((n) => n.getAttribute('data-feedback-id')));
    expect(unlabeled).toEqual([]);
  }
});
