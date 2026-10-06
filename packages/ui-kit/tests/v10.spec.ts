import { expect, test } from 'playwright/test';

test.describe('ui-kit v0.7.1', () => {
  test('en móvil, los tramos del mes muestran el título abreviado cuando el evento lo trae', async ({ page }, info) => {
    test.skip(info.project.name !== 'movil', 'solo en móvil: en escritorio los tramos muestran el título completo');
    await page.goto('/#calendar');
    const host = page.locator('#calendarHost');
    const ortega = host.locator('.cal-event[data-event-id="r1"]').first();
    await expect(ortega).toHaveAttribute('data-abbr', 'Ortega');
    const text = ortega.locator('.cal-event-text');
    await expect(text).toBeVisible();
    expect(await text.evaluate((node) => getComputedStyle(node, '::before').content)).toBe('"Ortega"');
    const box = await ortega.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(14);
    // Un evento sin abreviatura sigue siendo una barra fina.
    const plain = host.locator('.cal-event:not([data-abbr="Ortega"]):not([data-abbr="Yoga"])').first();
    const plainBox = await plain.boundingBox();
    expect(plainBox!.height).toBeLessThanOrEqual(8);
  });

  test('con una hoja abierta, el toast se coloca bajo la cabecera de la hoja', async ({ page }) => {
    await page.goto('/#overlays');
    await page.locator('#openSheet').click();
    await expect(page.locator('.sheetback.show .sheet-head')).toBeVisible();
    await page.evaluate(() => (window as any).ikisaiKit.toast('Aviso con hoja abierta'));
    const toast = page.locator('.toast.show');
    await expect(toast).toHaveClass(/top/);
    const head = await page.locator('.sheetback.show .sheet-head').boundingBox();
    const box = await toast.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(head!.y + head!.height);
    await page.keyboard.press('Escape');
    await expect(page.locator('.sheetback.show')).toHaveCount(0);
    await page.evaluate(() => (window as any).ikisaiKit.toast('Aviso sin hoja'));
    expect(await page.locator('.toast').evaluate((n) => n.style.top)).toBe('');
  });

  test('renderLogin acepta ids propios y restaura el título al desmontar', async ({ page }) => {
    await page.goto('/#shell');
    const result = await page.evaluate(async () => {
      const kit = (window as any).ikisaiKit;
      const before = document.title;
      const host = document.createElement('div');
      document.body.append(host);
      const unmount = kit.renderLogin(host, { appName: 'Tareas', title: 'Ikisai · Tareas', ids: { form: 'accountLoginForm', email: 'loginUsername', password: 'loginPassword', submit: 'accountLogin' }, onLogin: async () => {} });
      const ids = ['accountLoginForm', 'loginUsername', 'loginPassword', 'accountLogin'].map((id) => !!document.getElementById(id));
      const titleWhileOpen = document.title;
      const labelFor = (document.querySelector('label[for="loginUsername"]') as HTMLLabelElement | null)?.htmlFor;
      unmount();
      host.remove();
      return { ids, titleWhileOpen, labelFor, titleAfter: document.title, before };
    });
    expect(result.ids).toEqual([true, true, true, true]);
    expect(result.titleWhileOpen).toBe('Entrar · Ikisai · Tareas');
    expect(result.labelFor).toBe('loginUsername');
    expect(result.titleAfter).toBe(result.before);
  });
});
