import { expect, test } from 'playwright/test';

/** C-05 (Tasks, FB_2026_080): «Elegir en el árbol» del selector de espacios, con chips que se marcan ahí mismo. */
test('createSpacePicker({ tree: true }): altura › ala › espacios como chips; marcar, desmarcar y el contenedor elegible', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const K = (window as any).ikisaiKit;
    const w = window as any;
    const row = (id: string, parentId: string | null, kind: string, name: string, position = 0) => ({ id, parentId, kind, name, publicName: null, code: null, position, active: true, notes: null, attributes: {}, planId: null, planShape: null });
    w.picked = [];
    const picker = K.createSpacePicker({ label: 'Espacio', multiple: true, tree: true, feedbackId: 'tasks.ficha.espacio',
      rows: [row('a3', null, 'altura', 'Altura 3'), row('ala', 'a3', 'ala', 'Ala norte', 1), row('h1', 'ala', 'habitacion', 'Hab 1', 1), row('h2', 'ala', 'habitacion', 'Hab 2', 2)],
      kindFilter: ['habitacion', 'ala'], onChange: (ids: string[]) => { w.picked = ids; } });
    document.body.replaceChildren(picker.element);
  });
  await page.locator('.space-browse > summary').click();
  await page.locator('.space-tree-group > summary', { hasText: 'Altura 3' }).click();
  await page.locator('.space-tree-group > summary', { hasText: 'Ala norte' }).click();
  const chip = (name: string) => page.locator('.space-tree-chip', { hasText: name });
  await expect(chip('Ala norte')).toBeVisible();
  await chip('Hab 2').click();
  await expect(chip('Hab 2')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => (window as any).picked)).toEqual(['h2']);
  // El árbol sigue abierto tras marcar.
  await expect(chip('Hab 1')).toBeVisible();
  await chip('Hab 2').click();
  expect(await page.evaluate(() => (window as any).picked)).toEqual([]);
  // «Altura 3» no es elegible (kindFilter): no tiene chip.
  await expect(chip('Altura 3')).toHaveCount(0);
});
