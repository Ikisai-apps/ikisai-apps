import { expect, test } from 'playwright/test';

test.describe('ui-kit v0.11.1', () => {
  test('openSheet acepta ganchos en el fondo, el panel y el botón de cerrar, y cierra al momento con force', async ({ page }) => {
    await page.goto('/#overlays');
    const result = await page.evaluate(async () => {
      const kit = (window as any).ikisaiKit;
      const sheet = kit.openSheet({ title: 'Prueba', body: kit.el('p', null, 'Hola'), backAttrs: { id: 'sheetBack' }, panelAttrs: { id: 'sheet' }, closeAttrs: { id: 'closeDialog' } });
      const ids = ['sheetBack', 'sheet', 'closeDialog'].map((id) => document.getElementById(id)?.className ?? null);
      const showBefore = document.getElementById('sheetBack')!.classList.contains('show');
      void sheet.close(true);
      const goneNow = !document.getElementById('sheetBack');
      return { ids, showBefore, goneNow };
    });
    expect(result.ids[0]).toContain('sheetback');
    expect(result.ids[1]).toContain('sheet');
    expect(result.ids[2]).toContain('iconbtn');
    expect(result.showBefore).toBe(true);
    expect(result.goneNow).toBe(true);
    await page.evaluate(() => { const kit = (window as any).ikisaiKit; kit.openSheet({ title: 'Otra', body: 'x', closeAttrs: { id: 'closeDialog' } }); });
    await page.locator('#closeDialog').click();
    await expect(page.locator('.sheetback')).toHaveCount(0);
  });
});
