import { expect, test } from 'playwright/test';

test.describe('ui-kit v0.10', () => {
  test('la barra de espacio de trabajo pinta marca, áreas, vistas, menú agrupado y barra inferior', async ({ page }) => {
    await page.goto('/#workspace');
    const host = page.locator('#workspaceHost');
    const bar = host.locator('header.topbar.workspace');
    await expect(bar.locator('.topbar-row .brand-name')).toHaveText('Ikisai');
    await expect(bar.locator('.topbar-row .spacer')).toHaveCount(1);
    const tabs = bar.locator('.tabstrip .tabpill');
    await expect(tabs).toHaveCount(4);
    await expect(tabs.nth(0)).toHaveClass(/general/);
    const active = bar.locator('.tabpill.active');
    await expect(active).toHaveClass(/colored/);
    await expect(active).toHaveAttribute('aria-pressed', 'true');
    await expect(active.locator('.tabcount')).toHaveText('7');
    expect(await active.evaluate((n) => getComputedStyle(n).backgroundColor)).toBe('rgb(138, 90, 68)');
    await expect(bar.locator('.viewstrip .viewpill.active')).toHaveText('Mis tareas');
    const menu = host.locator('#demoNavMenu');
    await expect(menu.locator('details.navgroup')).toHaveCount(2);
    await expect(menu.locator('details.navgroup').first()).toHaveAttribute('open', '');
    await expect(menu.locator('.navitem.active')).toHaveAttribute('aria-current', 'page');
    await expect(menu.locator('.navitem[disabled]')).toHaveCount(1);
    await menu.locator('details.navgroup').nth(1).locator('summary').click();
    await expect(menu.locator('details.navgroup').nth(1)).toHaveAttribute('open', '');
    await expect(menu.locator('.navmenu-hint')).toContainText('Área actual: Ikisai');
    await expect(host.locator('nav.tabbar .navbtn')).toHaveCount(5);
    await expect(host.locator('nav.tabbar .navbtn.active')).toHaveAttribute('aria-current', 'page');
  });
});
