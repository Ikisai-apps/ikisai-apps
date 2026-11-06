import { expect, test, type Page } from 'playwright/test';

/** Selector visual de espacio (VG, 6-11): altura → interior/exterior → plano del edificio → cuadrante de 1 m². */
async function setup(page: Page, opts: { value?: unknown; cell?: boolean; layout?: string } = {}): Promise<void> {
  await page.goto('/');
  await page.evaluate((opts) => {
    const K = (window as any).ikisaiKit;
    const w = window as any;
    const rect = (x0: number, y0: number, x1: number, y1: number) => ({ points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
    const row = (id: string, parentId: string | null, kind: string, name: string, planId: string | null = null, shape: unknown = null, position = 0) => ({ id, parentId, kind, name, publicName: null, code: null, position, active: true, notes: null, attributes: {}, planId, planShape: shape });
    const rows = [
      row('a1', null, 'altura', 'Altura 1', null, null, 1), row('a3', null, 'altura', 'Altura 3', null, null, 3),
      row('alb', 'a3', 'edificio', 'Albergue', null, null, 1), row('patio', 'a3', 'exterior', 'Patio', null, null, 2),
      row('h1', 'alb', 'habitacion', 'Hab 1', 'p-alb', rect(0.1, 0.1, 0.5, 0.6), 1), row('h2', 'alb', 'habitacion', 'Hab 2', 'p-alb', rect(0.5, 0.1, 0.9, 0.6), 2),
      row('huerto', 'patio', 'otro', 'Huerto', null, null, 1),
    ];
    // 800 × 600 unidades a 0,02 m/unidad: 16 × 12 m; la Hab 1 (0,1–0,5 × 0,1–0,6) mide 6,4 × 6 m.
    const plans = [{ id: 'p-alb', buildingId: 'alb', floor: 'Planta baja', position: 0, fileId: null, width: 800, height: 600, grid: { metersPerUnit: 0.02 } }];
    w.values = [];
    const picker = K.createPlacePicker({ label: 'Espacio de la tarea', source: K.createMemorySpaceSource(rows), plans, cell: opts.cell, layout: opts.layout, value: opts.value ?? null,
      feedbackId: 'tasks.ficha.sitio', onChange: (v: unknown) => w.values.push(v) });
    w.picker = picker;
    document.body.replaceChildren(picker.element);
  }, opts);
}
const values = (page: Page) => page.evaluate(() => (window as any).values);

test.describe('ui-kit · createPlacePicker', () => {
  test('@smoke altura → interior → plano → habitación; exterior sin dibujo en chips', async ({ page }) => {
    await setup(page);
    await page.getByRole('button', { name: 'Altura 3' }).click();
    await expect(page.locator('.place-side')).toBeVisible();
    await page.getByRole('button', { name: 'Albergue' }).click();
    await page.locator('.map-shape[data-space-id="h2"]').click();
    expect(await values(page)).toEqual([{ spaceId: 'h2' }]);
    await expect(page.locator('.place-crumbs')).toContainText('Hab 2');
    // La ruta entera a la vista, con el lado porque la altura tiene de los dos.
    await expect(page.locator('.place-crumb')).toHaveText(['Alturas', 'Altura 3', 'Interior', 'Albergue', 'Hab 2']);
    // Volver a la altura por la miga y elegir el exterior, que no tiene dibujo.
    await page.locator('.place-crumb', { hasText: 'Altura 3' }).click();
    await page.locator('.place-side button', { hasText: 'Exterior' }).click();
    await page.getByRole('button', { name: 'Patio' }).click();
    await page.getByRole('button', { name: 'Huerto' }).click();
    expect((await values(page)).at(-1)).toEqual({ spaceId: 'huerto' });
  });

  test('cuadrante de 1 m²: retícula de la habitación en celdas del dibujo, flechas e Intro; abre en su sitio con valor', async ({ page }) => {
    await setup(page, { cell: true });
    await page.getByRole('button', { name: 'Altura 3' }).click();
    await page.getByRole('button', { name: 'Albergue' }).click();
    await page.locator('.map-shape[data-space-id="h1"]').click();
    await expect(page.locator('.place-cell')).toHaveCount(7 * 7);
    await page.locator('.place-cell[data-cell="0,0"]').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    // Celdas del dibujo: la Hab 1 empieza en la x = 80 u = 1,6 m → celda 1; y = 60 u = 1,2 m → celda 1.
    expect((await values(page)).at(-1)).toEqual({ spaceId: 'h1', cell: { cellX: 2, cellY: 2, scale: 1 } });
    await expect(page.locator('.place-here')).toHaveText('Cuadrante B2');
    expect(await page.evaluate(() => (window as any).picker.path())).toBe('Altura 3 › Interior · Albergue › Hab 1 › cuadrante B2');
    await setup(page, { cell: true, value: { spaceId: 'h1', cell: { cellX: 2, cellY: 2, scale: 1 } } });
    await expect(page.locator('.place-crumbs')).toContainText('Hab 1');
    await expect(page.locator('.place-cell.on')).toHaveCount(1);
  });

  test('dos planos a la vez (borrador aprobado): chips de altura y lado, plano y estancia con sus cuadrantes', async ({ page }) => {
    await setup(page, { layout: 'stacked' });
    await expect(page.locator('.place-crumbs')).toBeHidden();
    // La altura abre ya su edificio; las zonas salen con su lado y siguen a la vista.
    await page.getByRole('button', { name: 'Altura 3' }).click();
    await expect(page.getByRole('button', { name: 'Interior · Albergue' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Exterior · Patio' })).toBeVisible();
    await expect(page.locator('.place-below')).toContainText('Elige una estancia en el plano de arriba');
    // Tocar la estancia ya es el valor; abajo sale con su retícula y los cuadrantes nombrados.
    await page.locator('.map-shape[data-space-id="h1"]').click();
    expect((await values(page)).at(-1)).toEqual({ spaceId: 'h1' });
    await expect(page.locator('.place-below .place-map-title')).toContainText('Hab 1 (7 × 7 m)');
    await expect(page.locator('.place-cell')).toHaveCount(7 * 7);
    await expect(page.locator('.place-cell-name').first()).toHaveText('A1');
    // Otra estancia arriba cambia la de abajo, con el plano aún a la vista.
    await page.locator('.map-shape[data-space-id="h2"]').click();
    await expect(page.locator('.place-below .place-map-title')).toContainText('Hab 2');
    await page.locator('.place-cell[data-cell="2,1"]').click();
    expect((await values(page)).at(-1)).toMatchObject({ spaceId: 'h2', cell: { scale: 1 } });
    await expect(page.locator('.place-cell-foot')).toContainText('Cuadrante B3');
    await expect(page.locator('.map-shape[data-space-id="h1"]')).toBeVisible();
    expect(await page.evaluate(() => (window as any).picker.path())).toMatch(/^Altura 3 › Interior · Albergue › Hab 2 › cuadrante B3$/);
    // «Toda la estancia» quita el cuadrante.
    await page.locator('.place-cell-foot button', { hasText: 'Toda la estancia' }).click();
    expect((await values(page)).at(-1)).toEqual({ spaceId: 'h2' });
    await expect(page.locator('.place-cell.on')).toHaveCount(0);
  });
});
