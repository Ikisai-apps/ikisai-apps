import { expect, test, type Page } from 'playwright/test';

/** PNG de 2×2 px para adjuntar. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEJMDKgCcAEAANKBQH6PbUeAAAAAElFTkSuQmCC', 'base64');

async function fresh(page: Page): Promise<void> {
  await page.goto('/#feedback');
  await page.evaluate(async () => {
    const w = window as any;
    w.ikisaiFeedback.fbSave({ reports: [], posts: 0, offline: false, fail: null });
    await w.ikisaiFeedback.feedback.clear('demo-user');
  });
  await page.reload();
  await page.locator('#fbOpen').waitFor();
}
const server = (page: Page) => page.evaluate(() => (window as any).ikisaiFeedback.fbState());
const composer = (page: Page) => page.locator('.fb-composer');

test.describe('ui-kit v0.15 · feedback: composer, borradores y bandeja', () => {
  test('salir vacío descarta; con texto queda borrador con pin; el pin lo reabre con el texto', async ({ page }) => {
    await fresh(page);
    await page.locator('#fbMode').check();
    await page.locator('#fbOpen').click();
    await expect(composer(page).locator('.fb-where strong')).toHaveText('Reserva › Huéspedes › Añadir huésped');
    await page.keyboard.press('Escape');
    await expect(composer(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).ikisaiFeedback.feedback.drafts())).toHaveLength(0);
    await expect(page.locator('.fb-pin')).toHaveCount(0);
    await page.locator('#fbOpen').click();
    await composer(page).locator('.fb-message').fill('Al volver atrás se pierde el cambio');
    await composer(page).locator('[data-intent="improvement"]').click();
    await page.locator('.fb-catcher').click({ position: { x: 5, y: 5 } });
    await expect(composer(page)).toHaveCount(0);
    const pin = page.locator('.fb-pin[data-node="demo.reservation.guests.add"]');
    await expect(pin).toBeVisible();
    await expect(pin).toContainText('1');
    await pin.click();
    await expect(composer(page).locator('.fb-message')).toHaveValue('Al volver atrás se pierde el cambio');
    await expect(composer(page).locator('[data-intent="improvement"]')).toHaveAttribute('aria-checked', 'true');
    // El composer no ejecutó el botón señalado ni ningún clic de debajo.
    await expect(page.locator('#fbClicks')).toHaveText('0');
  });

  test('adjuntar y quitar imagen; enviar con red: el servidor confirma, el borrador desaparece y llega una vez', async ({ page }) => {
    await fresh(page);
    await page.locator('#fbOpen').click();
    await composer(page).locator('.fb-file').setInputFiles([{ name: 'a.png', mimeType: 'image/png', buffer: PNG }, { name: 'b.png', mimeType: 'image/png', buffer: PNG }]);
    await expect(composer(page).locator('.fb-thumb')).toHaveCount(2);
    await composer(page).locator('.fb-thumb .fb-remove').first().click();
    await expect(composer(page).locator('.fb-thumb')).toHaveCount(1);
    await composer(page).locator('.fb-message').fill('El botón no responde');
    await composer(page).locator('.fb-send').click();
    await expect(page.locator('.toast.show')).toContainText('Enviado · FB_2026_0001');
    await expect(composer(page)).toHaveCount(0);
    const st = await server(page);
    expect(st.reports).toHaveLength(1);
    expect(st.reports[0].attachments).toHaveLength(1);
    expect(st.reports[0].node).toEqual({ id: 'demo.reservation.guests.add', path: ['Reserva', 'Huéspedes', 'Añadir huésped'] });
    expect(await page.evaluate(() => (window as any).ikisaiFeedback.feedback.drafts())).toHaveLength(0);
    // El contexto no lleva valores de campos ni texto de la página.
    const context = JSON.stringify(st.reports[0].context);
    expect(context).not.toContain('Alergia');
    expect(context).not.toContain('Juan');
    expect(st.reports[0].context.route).toBe('/feedback');
    expect(st.reports[0].context.steps.length).toBeGreaterThan(0);
  });

  test('sin red queda «Pendiente de enviar», sobrevive a recargar y al volver la red se envía una sola vez', async ({ page }) => {
    await fresh(page);
    await page.locator('#fbOffline').check();
    await page.locator('#fbOpen').click();
    await composer(page).locator('.fb-message').fill('Sin red no guarda');
    await composer(page).locator('.fb-send').click();
    await expect(composer(page).locator('.fb-status')).toContainText('Pendiente de enviar');
    await expect(composer(page)).toHaveCount(0, { timeout: 4000 });
    expect(await page.evaluate(() => (window as any).ikisaiFeedback.feedback.pending())).toHaveLength(1);
    await page.reload();
    await page.locator('#fbOpen').waitFor();
    expect(await page.evaluate(() => (window as any).ikisaiFeedback.feedback.pending())).toHaveLength(1);
    expect((await server(page)).reports).toHaveLength(0);
    await page.locator('#fbOffline').uncheck();
    await expect.poll(async () => (await server(page)).reports.length).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as any).ikisaiFeedback.feedback.pending().then((p: unknown[]) => p.length))).toBe(0);
    // Reintentos posteriores no duplican.
    await page.evaluate(() => (window as any).ikisaiFeedback.feedback.flush());
    expect((await server(page)).reports).toHaveLength(1);
  });

  test('un rechazo definitivo devuelve el comentario a borrador con el motivo', async ({ page }) => {
    await fresh(page);
    await page.evaluate(() => { const w = window as any; const st = w.ikisaiFeedback.fbState(); st.fail = 'FEEDBACK_RATE_LIMITED'; w.ikisaiFeedback.fbSave(st); });
    await page.locator('#fbOpen').click();
    await composer(page).locator('.fb-message').fill('Otro más');
    // Tras recargar, la emulación móvil deja la vista visual desplazada respecto a la de diseño (innerHeight 948 frente a
    // visualViewport 844) y el clic por coordenadas cae unos píxeles más arriba: se activa con el teclado.
    await composer(page).locator('.fb-send').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.toast.show')).toContainText('máximo de comentarios de hoy');
    await expect.poll(() => page.evaluate(() => (window as any).ikisaiFeedback.feedback.drafts().then((d: unknown[]) => d.length))).toBe(1);
    expect(await page.evaluate(() => (window as any).ikisaiFeedback.feedback.pending())).toHaveLength(0);
  });

  test('si ya hay reportes abiertos en el nodo, avisa y «También me pasa» suma sin crear otro', async ({ page }) => {
    await fresh(page);
    await page.locator('#fbOpen').click();
    await composer(page).locator('.fb-message').fill('Primero');
    await composer(page).locator('.fb-send').click();
    await expect(page.locator('.toast.show')).toContainText('FB_2026_0001');
    await expect(composer(page)).toHaveCount(0);
    await page.locator('#fbOpen').click();
    await expect(composer(page).locator('.fb-dupes')).toContainText('Ya hay 1 reporte abierto aquí');
    await composer(page).locator('.fb-support').click();
    await expect(composer(page)).toHaveCount(0);
    const st = await server(page);
    expect(st.reports).toHaveLength(1);
    expect(st.reports[0].supporters).toEqual(['demo-user']);
  });

  test('al cerrar sesión se borran borradores y bandeja de la cuenta', async ({ page }) => {
    await fresh(page);
    await page.locator('#fbOffline').check();
    await page.locator('#fbOpen').click();
    await composer(page).locator('.fb-message').fill('Pendiente');
    await composer(page).locator('.fb-send').click();
    await expect(composer(page)).toHaveCount(0, { timeout: 4000 });
    await page.locator('#fbOpen').click();
    await composer(page).locator('.fb-message').fill('Borrador');
    await page.keyboard.press('Escape');
    const before = await page.evaluate(async () => { const f = (window as any).ikisaiFeedback.feedback; return [(await f.drafts()).length, (await f.pending()).length]; });
    expect(before).toEqual([1, 1]);
    const after = await page.evaluate(async () => { const f = (window as any).ikisaiFeedback.feedback; await f.clear('demo-user'); return [(await f.drafts()).length, (await f.pending()).length]; });
    expect(after).toEqual([0, 0]);
    await expect(page.locator('.fb-pin')).toHaveCount(0);
  });

  test('el contexto sanea rutas y recoge fallos HTTP sin consulta ni cuerpo', async ({ page }) => {
    await fresh(page);
    const context = await page.evaluate(async () => {
      // Un puerto cerrado: fallo de red (estado 0). El servidor de la demo responde 200 a cualquier ruta.
      await fetch('http://127.0.0.1:9/no-existe/3f0c1e2a-1111-4222-8333-444455556666/x?token=secreto').catch(() => null);
      const kit = (window as any).ikisaiKit;
      return kit ? null : null;
    });
    expect(context).toBeNull();
    await page.locator('#fbOpen').click();
    await composer(page).locator('.fb-message').fill('Con fallo HTTP previo');
    await composer(page).locator('.fb-send').click();
    await expect(page.locator('.toast.show')).toContainText('Enviado');
    const sent = (await server(page)).reports[0].context;
    expect(sent.http.some((f: { path: string }) => f.path === '/no-existe/:id/x')).toBe(true);
    expect(JSON.stringify(sent)).not.toContain('secreto');
    expect(new TextEncoder().encode(JSON.stringify(sent)).length).toBeLessThanOrEqual(8192);
  });
});
