import { expect, test, type Page } from 'playwright/test';

async function draw(page: Page, points: [number, number][]): Promise<void> {
  const box = (await page.locator('#sigPad .signature-canvas').boundingBox())!;
  await page.mouse.move(box.x + points[0]![0], box.y + points[0]![1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) await page.mouse.move(box.x + x, box.y + y, { steps: 4 });
  await page.mouse.up();
}

test.describe('ui-kit v0.20 · piezas de portal', () => {
  test('estado de guardado @smoke: guardando → guardado; sin red → pendiente; error → reintentar', async ({ page }) => {
    await page.goto('/#portal');
    const field = page.locator('.save-state[data-field="nombre"]');
    await page.locator('#save-nombre').fill('Retiro de otoño');
    await page.locator('#save-nombre').press('Tab');
    await expect(field).toHaveAttribute('data-status', 'saved');
    await expect(field).toHaveText('Guardado');
    await page.locator('#saveMode-offline').check();
    await page.locator('#save-plazas').fill('24');
    await page.locator('#save-plazas').press('Tab');
    const plazas = page.locator('.save-state[data-field="plazas"]');
    await expect(plazas).toHaveAttribute('data-status', 'pending');
    await expect(page.locator('#saveGlobal')).toHaveAttribute('data-status', 'pending');
    await page.locator('#saveMode-fail').check();
    await page.locator('#save-nombre').fill('Retiro de invierno');
    await page.locator('#save-nombre').press('Tab');
    await expect(field).toHaveAttribute('data-status', 'error');
    await expect(page.locator('#saveGlobal')).toContainText('Hay cambios sin guardar');
    await page.locator('#saveMode-ok').check();
    await field.locator('.save-retry').click();
    await expect(field).toHaveAttribute('data-status', 'saved');
  });

  test('firma: trazar, deshacer, borrar y exportar un PNG recortado', async ({ page }) => {
    await page.goto('/#portal');
    const pad = page.locator('#sigPad');
    await pad.scrollIntoViewIfNeeded();
    await expect(pad).toHaveAttribute('data-empty', 'true');
    await expect(pad.locator('.signature-clear')).toBeDisabled();
    await draw(page, [[40, 60], [80, 90], [120, 70], [160, 100]]);
    await draw(page, [[60, 120], [140, 125]]);
    await expect(pad).toHaveAttribute('data-empty', 'false');
    await expect(pad.locator('.signature-canvas')).toHaveAttribute('aria-label', 'Firma del organizador: firmado');
    await page.locator('#sigExport').click();
    // Recortado a la firma (≈120×65 px CSS más margen), no al recuadro entero.
    await expect.poll(async () => (await page.locator('#sigOut').textContent()) ?? '').toMatch(/^image\/png \d+x\d+$/);
    const [w, h] = (await page.locator('#sigOut').textContent())!.split(' ')[1]!.split('x').map(Number);
    const ratio = await page.evaluate(() => window.devicePixelRatio || 1);
    expect(w! / ratio).toBeGreaterThan(110);
    expect(w! / ratio).toBeLessThan(160);
    expect(h! / ratio).toBeLessThan(110);
    await pad.locator('.signature-undo').click();
    await expect(pad).toHaveAttribute('data-empty', 'false');
    await pad.locator('.signature-clear').click();
    await expect(pad).toHaveAttribute('data-empty', 'true');
    await page.locator('#sigExport').click();
    await expect(page.locator('#sigOut')).toHaveText('vacía');
  });

  test('firma accesible: escribir el nombre en lugar de trazar', async ({ page }) => {
    await page.goto('/#portal');
    const pad = page.locator('#sigPad');
    await pad.locator('.signature-type-toggle').click();
    await pad.locator('.signature-typed').fill('Ana Martín');
    await expect(pad).toHaveAttribute('data-empty', 'false');
    await page.locator('#sigExport').click();
    await expect(page.locator('#sigOut')).toHaveText(/^image\/png /);
    await pad.locator('.signature-type-toggle').click();
    await expect(pad).toHaveAttribute('data-empty', 'true');
  });

  test('«Instala la app» @smoke: sin instalador del navegador explica cómo y ofrece seguir en la web', async ({ page }) => {
    await page.goto('/#portal');
    await expect(page.locator('.install-card')).toContainText('Instala Ikisai Guests');
    await page.locator('#installSheet').click();
    const sheet = page.locator('.install-sheet');
    await expect(sheet).toContainText('funciona aunque no haya cobertura');
    await expect(page.locator('.install-steps li').first()).toBeVisible();
    await page.locator('.install-web').click();
    await expect(sheet).toHaveCount(0);
    expect(await page.evaluate(() => Number(localStorage.getItem('ikisai-install-dismissed:demo-guests')) > 0)).toBe(true);
  });

  test('cáscara con nav: [] @smoke: sin barra inferior ni hueco; iconos de Guests y Organizers', async ({ page }) => {
    await page.goto('/#portal');
    const shell = page.locator('#portalShellHost .shell');
    await expect(shell).toHaveClass(/nonav/);
    await expect(shell.locator('nav.nav')).toBeHidden();
    await expect(page.locator('#portalShellHost .mark svg')).toHaveCount(1);
    const guestIcon = await page.evaluate(() => document.querySelector('#portalShellHost .mark svg')!.innerHTML);
    expect(guestIcon).toContain('circle');
  });
});
