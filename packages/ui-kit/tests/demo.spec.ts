import { expect, test } from 'playwright/test';

test.describe('Muestra del ui-kit', () => {
  test('carga sin errores, con las fuentes y sin desborde horizontal', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto('/');
    await expect(page.locator('.demo-head h1')).toContainText('Ikisai UI kit');
    const fonts = await page.evaluate(async () => { await document.fonts.ready; return [document.fonts.check('16px Fraunces'), document.fonts.check('16px Inter')]; });
    expect(fonts).toEqual([true, true]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > (visualViewport?.width ?? innerWidth) + 1);
    expect(overflow).toBe(false);
    expect(errors).toEqual([]);
  });

  test('la barra de estado refleja red, pendientes y conflictos', async ({ page }) => {
    await page.goto('/');
    const states = page.locator('#statusStates .statuschip');
    await expect(states).toHaveCount(5);
    await expect(states.nth(0)).toHaveAttribute('data-network', 'online');
    await expect(states.nth(0)).toHaveAttribute('aria-label', 'En línea · Todo guardado');
    await expect(states.nth(2)).toHaveAttribute('data-pending', 'true');
    await expect(states.nth(2)).toHaveAttribute('aria-label', 'Sin conexión · 4 cambios pendientes');
    await expect(states.nth(3)).toHaveAttribute('data-conflicts', 'true');
    await expect(states.nth(4)).toHaveAttribute('data-network', 'error');
    await expect(states.nth(4)).toHaveAttribute('title', 'El servidor no responde.');
    // El texto visible depende del ancho: corto en móvil, largo en escritorio.
    const visible = await states.nth(2).locator('span:visible').innerText();
    expect(['4 pendientes', 'Sin conexión · 4 cambios pendientes']).toContain(visible);
    await page.locator('[data-state="online-conflicts"]').click();
    await expect(page.locator('#bannerStates .banner.alert')).toContainText('2 conflictos');
    await page.locator('[data-state="error"]').click();
    await expect(page.locator('#bannerStates .banner.warn')).toContainText('El servidor no responde.');
  });

  test('el login valida, muestra errores y entra', async ({ page }) => {
    await page.goto('/');
    const frame = page.locator('#loginFrame');
    await expect(frame.locator('#loginTitle')).toContainText('Ikisai Invoices');
    await frame.locator('#loginSubmit').click();
    await expect(frame.locator('#loginError')).toHaveText('Escribe tu correo y tu contraseña.');
    await frame.locator('#email').fill('alguien@otro.com');
    await frame.locator('#password').fill('x');
    await frame.locator('#loginSubmit').click();
    await expect(frame.locator('#loginError')).toHaveText('Correo o contraseña incorrectos.');
    await frame.locator('#email').fill('victor@ikisai.com');
    await frame.locator('#loginSubmit').click();
    await expect(page.locator('.toast.show')).toContainText('Bienvenida, victor@ikisai.com');
  });

  test('el shell marca la ruta activa y la cabecera lleva estado y herramientas', async ({ page }, testInfo) => {
    await page.goto('/');
    const shell = page.locator('#shellFrame .shell');
    await expect(shell.locator('.topbar h1')).toContainText('Ikisai Invoices');
    await expect(shell.locator('.topbar .statuschip')).toHaveAttribute('data-pending', 'true');
    await expect(shell.locator('.navbtn[aria-current="page"]')).toContainText('Inicio');
    await shell.locator('.navbtn', { hasText: 'Facturas' }).click();
    await expect(shell.locator('.navbtn[aria-current="page"]')).toContainText('Facturas');
    await expect(shell.locator('.navbtn .badge')).toHaveText('2');
    await expect(shell.locator('.banners .banner.warn')).toBeVisible();
    const logoutVisible = await shell.locator('#logoutButton').isVisible();
    expect(logoutVisible).toBe(testInfo.project.name === 'escritorio');
  });

  test('tema y acento: el acento elegido manda y el modo oscuro se guarda', async ({ page }) => {
    await page.goto('/');
    await page.locator('#accentPicker').fill('#3f6d8e');
    await page.locator('#accentPicker').dispatchEvent('input');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe('#3f6d8e');
    await page.locator('#accentReset').click();
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--accent'))).toBe('');
    await page.locator('#themeToggle').click();
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(['light', 'dark']).toContain(theme);
    await page.reload();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
  });
});
