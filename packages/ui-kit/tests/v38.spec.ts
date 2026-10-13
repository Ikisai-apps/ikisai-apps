import { expect, test, type Page } from 'playwright/test';
import { demoSpaces, seatsLabel, spaceSeats, type SpaceRow } from '../src/spaces/model.ts';

const row = (page: Page, id: string) => page.locator(`#spaceTreeHost .space-row[data-id="${id}"]`);
const rowsOf = (page: Page) => page.evaluate(() => (window as unknown as { spaceSource: { rows(): SpaceRow[] } }).spaceSource.rows());

test.describe('ui-kit v0.31 · el árbol de espacios para Booking (§17: no perder nada)', () => {
  test('plazas: suma de las camas (1 si no lo dicen), supletorias aparte; sin camas, la capacidad escrita', () => {
    const rows = demoSpaces();
    const hab3 = rows.find((r) => r.id === 'hab-3')!;
    expect(spaceSeats(hab3, rows)).toEqual({ seats: 4, extras: 0, fromBeds: true });
    const bed = (id: string, attrs: Record<string, unknown>): SpaceRow => ({ id, parentId: 'hab-3', kind: 'cama', name: id, publicName: null, code: null, position: 9, active: true, notes: null, attributes: attrs });
    const more = [...rows, bed('x1', {}), bed('x2', { bed_kind: 'supletoria' }), { ...bed('x3', { capacity: 2 }), active: false }];
    expect(spaceSeats(hab3, more)).toEqual({ seats: 5, extras: 1, fromBeds: true });
    expect(seatsLabel(spaceSeats(hab3, more))).toBe('5 plazas + 1 supletoria');
    expect(seatsLabel({ seats: 1, extras: 2 })).toBe('1 plaza + 2 supletorias');
    expect(spaceSeats(rows.find((r) => r.id === 'sala-roble')!, rows)).toEqual({ seats: 30, extras: 0, fromBeds: false });
  });

  test('@smoke la fila de la habitación enseña las plazas de sus camas y se actualiza al añadir una supletoria', async ({ page }) => {
    await page.goto('/#spaces');
    await expect(row(page, 'hab-3').locator('.space-sub')).toContainText('4 plazas');
    await expect(row(page, 'hab-3').locator('.space-sub')).not.toContainText('Capacidad');
    await expect(row(page, 'sala-roble').locator('.space-sub')).toContainText('Capacidad 30');
    await page.evaluate(() => (window as unknown as { spaceSource: { create(r: unknown): Promise<void> } }).spaceSource.create({ id: 'sup', parentId: 'hab-3', kind: 'cama', name: 'Supletoria', publicName: null, code: null, position: 9000, active: true, notes: null, attributes: { bed_kind: 'supletoria' } }));
    await expect(row(page, 'hab-3').locator('.space-sub')).toContainText('4 plazas + 1 supletoria');
  });

  test('acciones de la app en la fila, a un toque y de 44×44: «Añadir cama» y «Duplicar»', async ({ page }) => {
    await page.goto('/#spaces');
    const add = row(page, 'hab-1').getByRole('button', { name: 'Añadir cama: Hab 1' });
    const dup = row(page, 'hab-1').getByRole('button', { name: 'Duplicar: Hab 1' });
    for (const b of [add, dup]) {
      const box = (await b.boundingBox())!;
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    }
    await expect(row(page, 'sala-roble').getByRole('button', { name: /^Añadir cama/ })).toHaveCount(0);
    await dup.click();
    await expect.poll(async () => (await rowsOf(page)).filter((r) => r.name === 'Hab 1 (copia)').length).toBe(1);
    await add.click();
    const sheet = page.locator('.sheet').last();
    await expect(sheet).toContainText('Dentro de Altura 3 › Albergue › Hab 1');
    await sheet.locator('input[name="name"]').fill('Cama 2');
    await page.getByRole('button', { name: 'Crear' }).click();
    await expect.poll(async () => (await rowsOf(page)).find((r) => r.name === 'Cama 2' && r.parentId === 'hab-1')?.kind).toBe('cama');
    await expect(row(page, 'hab-1').locator('.space-sub')).toContainText('3 plazas');
  });

  test('«+» en una habitación trae «Cama» como tipo; en un edificio, el primero de la lista', async ({ page }) => {
    await page.goto('/#spaces');
    await row(page, 'hab-3').getByRole('button', { name: 'Añadir dentro de Hab 3' }).click();
    const sheet = page.locator('.sheet').last();
    await expect(sheet).toContainText('Tipo de cama');
    await page.keyboard.press('Escape');
    await row(page, 'albergue').getByRole('button', { name: 'Añadir dentro de Albergue' }).click();
    await expect(page.locator('.sheet').last().getByLabel('Tipo')).toHaveValue('habitacion');
  });
});
