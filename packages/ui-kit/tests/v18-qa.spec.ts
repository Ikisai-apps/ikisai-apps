import { expect, test, type Page } from 'playwright/test';

async function fresh(page: Page, mode = false): Promise<void> {
  await page.goto('/#feedback');
  await page.evaluate(async (on) => {
    const w = window as any;
    w.ikisaiFeedback.fbSave({ reports: [], posts: 0, offline: false, fail: null });
    await w.ikisaiFeedback.feedback.clear('demo-user');
    w.ikisaiFeedback.feedback.mode.set(on);
  }, mode);
  await page.reload();
  await page.locator('#fbOpen').waitFor();
}
const server = (page: Page) => page.evaluate(() => (window as any).ikisaiFeedback.fbState());
const composer = (page: Page) => page.locator('.fb-composer');

/** Pulsación mantenida con el ratón en el centro del elemento (opcionalmente moviéndose `drift` px a mitad). */
async function longPress(page: Page, selector: string, ms = 750, drift = 0): Promise<void> {
  // `hover` coloca el ratón con el mismo cálculo que un clic de Playwright (en la emulación móvil, tras recargar, la vista
  // visual queda desplazada respecto a la de diseño y `boundingBox` + `mouse.move` caería en otro elemento).
  const target = page.locator(selector).first();
  const box = (await target.boundingBox())!;
  await target.hover({ position: { x: Math.min(box.width / 2, 20), y: box.height / 2 } });
  await page.mouse.down();
  if (drift) {
    await page.waitForTimeout(200);
    await target.hover({ position: { x: Math.min(box.width / 2, 20) + drift, y: box.height / 2 }, force: true });
  }
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

async function sendOne(page: Page, text: string, blocking = false): Promise<void> {
  await page.locator('#fbOpen').click();
  await composer(page).locator('.fb-message').fill(text);
  if (blocking) await composer(page).locator('.fb-blocking input').check();
  await composer(page).locator('.fb-send').click();
  await expect(composer(page)).toHaveCount(0);
}

test.describe('ui-kit v0.15 · feedback: modo «Señalar para comentar» y gesto', () => {
  test('apagado (por defecto): ni gesto ni pines ni marca; el clic largo es un clic normal', async ({ page }) => {
    await fresh(page);
    expect(await page.evaluate(() => document.documentElement.classList.contains('fb-mode'))).toBe(false);
    await longPress(page, '#fbAction');
    await expect(composer(page)).toHaveCount(0);
    await expect(page.locator('#fbClicks')).toHaveText('1');
    await page.locator('#fbAction').focus();
    await page.keyboard.press('Shift+F10');
    await expect(composer(page)).toHaveCount(0);
    // Un borrador existe pero no se ve su pin con el modo apagado.
    await page.locator('#fbOpen').click();
    await composer(page).locator('.fb-message').fill('Borrador oculto');
    await page.keyboard.press('Escape');
    await expect(page.locator('.fb-pin')).toHaveCount(0);
    await page.locator('#fbMode').check();
    await expect(page.locator('.fb-pin[data-node="demo.reservation.guests.add"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.classList.contains('fb-mode'))).toBe(true);
  });

  test('encendido: clic corto ejecuta la acción; pulsación larga abre el composer y no ejecuta el clic', async ({ page }) => {
    await fresh(page, true);
    await page.locator('#fbAction').click();
    await expect(page.locator('#fbClicks')).toHaveText('1');
    await expect(composer(page)).toHaveCount(0);
    await longPress(page, '#fbAction');
    await expect(composer(page).locator('.fb-where strong')).toHaveText('Reserva › Huéspedes › Añadir huésped');
    await expect(page.locator('#fbClicks')).toHaveText('1');
    await expect(composer(page)).toHaveCount(1);
  });

  test('moverse más de 8 px cancela; un hijo sin id sube al ancestro; sin ninguno, el nodo de reserva', async ({ page }) => {
    await fresh(page, true);
    await longPress(page, '#fbAction', 750, 30);
    await expect(composer(page)).toHaveCount(0);
    await longPress(page, '#fbScreen h3');
    await expect(composer(page).locator('.fb-where strong')).toHaveText('Reserva');
    await page.keyboard.press('Escape');
    await longPress(page, '#fbServer');
    await expect(composer(page).locator('.fb-where strong')).toHaveText('Banco de feedback');
  });

  test('zonas ignoradas y campos editables no disparan; Mayúsculas+F10 sobre el foco sí', async ({ page }) => {
    await fresh(page, true);
    await longPress(page, '[data-feedback-ignore]');
    await expect(composer(page)).toHaveCount(0);
    await longPress(page, '#fbPrivate');
    await expect(composer(page)).toHaveCount(0);
    await page.locator('#fbAction').focus();
    await page.keyboard.press('Shift+F10');
    await expect(composer(page).locator('.fb-where strong')).toHaveText('Reserva › Huéspedes › Añadir huésped');
  });

  test('el interruptor del lanzador enciende y apaga el modo, y se recuerda al recargar', async ({ page }) => {
    await fresh(page);
    await page.locator('#demoLauncher').click();
    const sw = page.locator('.launcher-signal input');
    await expect(sw).not.toBeChecked();
    await page.locator('.launcher-signal').click();
    await expect(sw).toBeChecked();
    await expect(page.locator('#fbMode')).toBeChecked();
    await page.reload();
    await page.locator('#fbOpen').waitFor();
    expect(await page.evaluate(() => document.documentElement.classList.contains('fb-mode'))).toBe(true);
    await page.locator('#demoLauncher').click();
    await page.locator('.launcher-signal').click();
    await expect(page.locator('.launcher-signal input')).not.toBeChecked();
    expect(await page.evaluate(() => document.documentElement.classList.contains('fb-mode'))).toBe(false);
  });
});

test.describe('ui-kit v0.15 · feedback: verificación, pasos, «Me bloquea» y QA', () => {
  test('«Me bloquea» y los pasos para reproducir llegan al servidor, sin valores', async ({ page }) => {
    await fresh(page);
    await page.locator('#fbAction').click();
    await sendOne(page, 'No deja añadir', true);
    const report = (await server(page)).reports[0];
    expect(report.blocking).toBe(true);
    const steps = report.context.steps as { action: string; node?: string; route?: string }[];
    expect(steps.some((s) => s.action === 'tocó' && s.node === 'demo.reservation.guests.add' && s.route === '/feedback')).toBe(true);
    expect(steps.some((s) => s.action === 'abrió' && s.route === '/feedback')).toBe(true);
    expect(JSON.stringify(steps)).not.toContain('Alergia');
    expect(steps.length).toBeLessThanOrEqual(10);
  });

  test('pin verde: «Funciona» verifica con la versión y desaparece; «Sigue fallando» reabre', async ({ page }) => {
    await fresh(page, true);
    await sendOne(page, 'Primero');
    await page.locator('#fbFix').click();
    const pin = page.locator('.fb-pin.verify[data-node="demo.reservation.guests.add"]');
    await expect(pin).toBeVisible();
    await pin.click();
    await expect(page.locator('.fb-verify')).toContainText('Esto ya está corregido. ¿Lo compruebas?');
    await page.locator('.fb-works').click();
    await expect(pin).toHaveCount(0);
    expect((await server(page)).reports[0].display).toBe('verified');

    await sendOne(page, 'Segundo');
    await page.locator('#fbFix').click();
    await page.locator('.fb-pin.verify').click();
    await page.locator('.fb-fails').click();
    await page.locator('.fb-verify .fb-message').fill('Al recargar vuelve a pasar');
    await page.locator('.fb-fails').click();
    await expect(page.locator('.fb-pin.verify')).toHaveCount(0);
    const second = (await server(page)).reports[1];
    expect(second.display).toBe('open');
    expect(second.message).toContain('Al recargar vuelve a pasar');
  });

  test('centro: árbol plegado con recuentos, tarjetas, detalle con «Copiar para Claude», «.md» y descarte', async ({ page, context, browserName }) => {
    if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await fresh(page);
    await sendOne(page, 'Falla al guardar', true);
    await page.locator('#fbCenter').click();
    const tree = page.locator('.fb-center .fb-tree');
    await expect(tree.locator('.fb-branch-label', { hasText: 'Reserva' })).toBeVisible();
    await expect(tree.locator('.fb-branch-label', { hasText: 'Añadir huésped' })).toHaveCount(0);
    await tree.locator('.fb-toggle').first().click();
    await tree.locator('.fb-toggle').nth(1).click();
    await tree.locator('.fb-branch-label', { hasText: 'Añadir huésped' }).click();
    const card = page.locator('.fb-card[data-code="FB_2026_0001"]');
    await expect(card).toContainText('Me bloquea');
    await card.click();
    await expect(page.locator('.fb-detail-msg')).toHaveText('Falla al guardar');
    await page.locator('.fb-copy').click();
    await expect(page.locator('.toast.show')).toContainText('Copiado');
    if (browserName === 'chromium') expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('FB_2026_0001');
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.fb-download').click()]);
    expect(download.suggestedFilename()).toBe('FB_2026_0001.md');
    await page.locator('.fb-dismiss').click();
    await page.locator('.fb-detail .fb-message').fill('Duplicado de otro');
    await page.locator('.fb-dismiss').click();
    await expect(page.locator('.fb-detail [data-display="dismissed"]')).toBeVisible();
    expect((await server(page)).reports[0].dismissReason).toBe('Duplicado de otro');
    // Búsqueda en el mapa.
    await page.locator('.fb-tabs [data-fb-tab="map"]').click();
    await page.locator('.fb-tree-search').fill('huésped');
    await expect(page.locator('.fb-tree .fb-branch-label')).toHaveText(['Reserva › Huéspedes › Añadir huésped']);
  });

  test('«Mis borradores» del centro reabre el borrador en el composer', async ({ page }) => {
    await fresh(page);
    await page.locator('#fbOpen').click();
    await composer(page).locator('.fb-message').fill('A medias');
    await page.keyboard.press('Escape');
    await page.locator('#fbCenter').click();
    await page.locator('.fb-tabs [data-fb-tab="drafts"]').click();
    await page.locator('.fb-card.draft').click();
    await expect(composer(page).locator('.fb-message')).toHaveValue('A medias');
  });
});

test.describe('ui-kit v0.15 · feedback: formulario progresivo de portales', () => {
  test('crece pregunta a pregunta, sugiere por contexto y cambiar una respuesta borra las de después', async ({ page }) => {
    await fresh(page);
    const form = page.locator('#fbPortal');
    await expect(form.locator('.fb-step')).toHaveCount(1);
    await form.locator('.fb-choice', { hasText: 'Espacio' }).click();
    await expect(form.locator('.fb-step[data-step="place"] .fb-step-q')).toHaveText('¿Es sobre Habitación 3?');
    await form.locator('.fb-step[data-step="place"] .fb-choice', { hasText: 'Otro sitio' }).click();
    await form.locator('.fb-choice', { hasText: 'Piscina' }).click();
    await form.locator('.fb-choice', { hasText: 'Limpieza' }).click();
    await expect(form.locator('.fb-step')).toHaveCount(4);
    // Cambiar la primera respuesta olvida lugar y tipo.
    await form.locator('.fb-step[data-step="about"] .fb-change').click();
    await form.locator('.fb-choice', { hasText: 'Retiro / evento' }).click();
    await expect(form.locator('.fb-step[data-step="place"]')).toHaveCount(0);
    await form.locator('.fb-choice', { hasText: 'Comida' }).click();
    await form.locator('textarea').fill('La cena llegó fría');
    await form.locator('.fb-send').click();
    await expect(page.locator('#fbPortalOut')).toHaveText(JSON.stringify({ answers: { about: 'event', eventCat: 'comida' }, message: 'La cena llegó fría', images: 0 }));
  });

  test('rama Aplicación: señala una vez sin el interruptor y sigue con el comentario (C4 de Organizers)', async ({ page }) => {
    await fresh(page);
    expect(await page.evaluate(() => document.documentElement.classList.contains('fb-mode'))).toBe(false);
    const form = page.locator('#fbPortal');
    await form.locator('.fb-choice', { hasText: 'Aplicación' }).click();
    await form.locator('.fb-choice', { hasText: 'Algo no funciona' }).click();
    await form.locator('.fb-signal').click();
    await expect(page.locator('.fb-capture-bar')).toContainText('Mantén pulsado sobre el lugar');
    // Cancelar no responde el paso.
    await page.locator('.fb-capture-cancel').click();
    await expect(page.locator('.fb-capture-bar')).toHaveCount(0);
    await expect(form.locator('.fb-signal')).toBeVisible();
    await form.locator('.fb-signal').click();
    await longPress(page, '#fbAction');
    await expect(page.locator('.fb-capture-bar')).toHaveCount(0);
    await expect(page.locator('.fb-composer')).toHaveCount(0);
    await expect(page.locator('#fbClicks')).toHaveText('0');
    await expect(form.locator('.fb-step[data-step="appWhere"] .fb-step-answer')).toContainText('Reserva › Huéspedes › Añadir huésped');
    await form.locator('textarea').fill('No deja añadir');
    await form.locator('.fb-send').click();
    const out = JSON.parse(await page.locator('#fbPortalOut').textContent() ?? '{}');
    expect(out.node).toEqual({ id: 'demo.reservation.guests.add', path: ['Reserva', 'Huéspedes', 'Añadir huésped'] });
    expect(out.answers.appWhere).toBe('demo.reservation.guests.add');
    // Cambiar el elemento vuelve a pedir que se señale.
    // Con teclado: en la emulación móvil, tras desplazar, el clic por coordenadas cae en otra sección.
    await form.locator('.fb-step[data-step="appWhere"] .fb-change').focus();
    await page.keyboard.press('Enter');
    await expect(form.locator('.fb-signal')).toBeVisible();
  });
});
