import { expect, test, type Page } from 'playwright/test';
import { baseQuantity, itemFromRow, sameNameItem, searchItems, similarItems, stockFromMovements, stockSummary, unitsFor, type ItemRow, type ItemUnitRow } from '../src/items/model.ts';

const item = (id: string, name: string, extra: Partial<ItemRow> = {}): ItemRow => ({
  id, name, kind: 'ingrediente', baseUnit: 'kg', category: null, minQuantity: null, reorderQuantity: null, defaultSpaceId: null, defaultSupplierId: null,
  tracksLots: false, tracksExpiry: false, aliases: [], attributes: {}, active: true, notes: null, ...extra,
});
const ITEMS = [item('a', 'Harina de trigo', { aliases: ['Harina floja'] }), item('b', 'Harina de espelta', { minQuantity: 5 }), item('c', 'Azúcar moreno'), item('d', 'Taladro', { kind: 'herramienta', baseUnit: 'ud', active: false })];
const UNITS: ItemUnitRow[] = [
  { id: 'u1', itemId: 'b', unit: 'saco', factor: 25, supplierId: 'molinos' },
  { id: 'u2', itemId: 'b', unit: 'bolsa', factor: 1, supplierId: 'eco' },
  { id: 'u3', itemId: 'b', unit: 'caja', factor: 12, supplierId: null },
];

test.describe('ui-kit v0.36 · modelo de artículos (Node)', () => {
  test.beforeEach(({}, info) => { test.skip(info.project.name !== 'escritorio', 'funciones puras: una vez basta'); });

  test('@smoke buscar sin tildes, por alias y sin archivados', () => {
    expect(searchItems(ITEMS, 'azucar').map((i) => i.id)).toEqual(['c']);
    expect(searchItems(ITEMS, 'harina').map((i) => i.id)).toEqual(['b', 'a']);
    expect(searchItems(ITEMS, 'floja').map((i) => i.id)).toEqual(['a']);
    expect(searchItems(ITEMS, 'taladro')).toEqual([]);
    expect(searchItems(ITEMS, 'taladro', { includeArchived: true }).map((i) => i.id)).toEqual(['d']);
    expect(searchItems(ITEMS, 'harina', { aliases: { c: ['harina dulce'] } }).map((i) => i.id)).toEqual(['b', 'a', 'c']);
    expect(searchItems(ITEMS, 'trigo', { kinds: ['bebida'] })).toEqual([]);
  });

  test('mismo nombre como el índice del servidor y parecidos para avisar', () => {
    expect(sameNameItem(ITEMS, '  harina de TRIGO ')?.id).toBe('a');
    expect(sameNameItem(ITEMS, 'Harina de trígo')).toBeNull();
    expect(similarItems(ITEMS, 'Harina de trígo').map((i) => i.id)).toEqual(['a', 'b']);
    expect(similarItems(ITEMS, 'Harina de centeno').map((i) => i.id)).toEqual(['b', 'a']);
    expect(similarItems(ITEMS, 'Sal')).toEqual([]);
  });

  test('unidades: base, métricas, las del proveedor primero y equivalencia', () => {
    const plain = unitsFor(ITEMS[1]!, UNITS, { supplierName: (id) => ({ molinos: 'Molinos Sur', eco: 'EcoGranel' })[id] ?? null });
    // Sin proveedor en contexto, las de proveedor llevan su nombre.
    expect(plain.map((u) => u.label)).toEqual(['kg', 'g', 'caja', 'bolsa (de EcoGranel)', 'saco (de Molinos Sur)']);
    const molinos = unitsFor(ITEMS[1]!, UNITS, { supplierId: 'molinos', supplierName: (id) => ({ molinos: 'Molinos Sur', eco: 'EcoGranel' })[id] ?? null });
    expect(molinos.map((u) => u.label)).toEqual(['kg', 'saco', 'g', 'caja', 'bolsa (de EcoGranel)']);
    expect(baseQuantity(2, 'u1', molinos)).toBe(50);
    expect(baseQuantity(250, 'metric:g', molinos)).toBe(0.25);
    expect(baseQuantity(2, 'nada', molinos)).toBeNull();
    expect(baseQuantity(null, 'u1', molinos)).toBeNull();
  });

  test('stock: suma de movimientos, por sitio y bajo mínimo', () => {
    const stock = stockFromMovements([
      { item_id: 'b', space_id: 'despensa', quantity: 3 }, { item_id: 'b', space_id: 'despensa', quantity: -1.8 },
      { item_id: 'b', space_id: 'camara', quantity: 1 }, { item_id: 'b', space_id: 'camara', quantity: -1 },
      { item_id: 'a', space_id: 'despensa', quantity: 2, deleted_at: '2026-10-01' },
    ]);
    expect(stock).toEqual([{ itemId: 'b', spaceId: 'despensa', lotId: null, quantity: 1.2 }]);
    const s = stockSummary(ITEMS[1]!, stock, { spaceName: (id) => (id === 'despensa' ? 'Despensa' : null) });
    expect(s.low).toBe(true);
    expect(s.text).toBe('1,2 kg · Despensa · bajo mínimo (5 kg)');
    expect(stockSummary(ITEMS[0]!, stock).text).toBe('sin stock');
  });

  test('fila del espejo → artículo, con los alias de attributes', () => {
    const row = itemFromRow({ id: 'x', name: 'Cloro', kind: 'limpieza', base_unit: 'kg', min_quantity: '2', attributes: { aliases: ['CLORO 5KG', '', 3] }, _pending: true });
    expect(row).toMatchObject({ id: 'x', baseUnit: 'kg', minQuantity: 2, aliases: ['CLORO 5KG'], pending: true, active: true });
  });
});

const recipe = (page: Page) => page.locator('#itemPickRecipe');
const spend = (page: Page) => page.locator('#itemPickSpend');
const invoice = (page: Page) => page.locator('#itemPickInvoice');
const out = (page: Page) => page.locator('#itemPickOut');

test.describe('ui-kit v0.36 · createItemPicker', () => {
  test('@smoke buscar, ver tipo y stock, elegir y dar cantidad en sacos', async ({ page }) => {
    await page.goto('/#items');
    const input = recipe(page).getByRole('combobox', { name: 'Ingrediente' });
    await input.fill('harin');
    const options = recipe(page).getByRole('option');
    await expect(options).toHaveCount(4);
    await expect(recipe(page).locator('[data-item-id="harina-arroz"]')).toContainText('sin stock');
    await expect(recipe(page).locator('[data-item-id="harina-espelta"]')).toContainText('1,2 kg · Despensa · bajo mínimo (5 kg)');
    await expect(recipe(page).locator('[data-item-id="harina-trigo"]')).toContainText('18,5 kg · Despensa');
    await expect(options.last()).toContainText('Crear «harin»');
    await expect(options.last()).toContainText('Se parece a «Harina de arroz» y 2 más');
    await recipe(page).locator('[data-item-id="harina-espelta"]').click();
    await expect(recipe(page).locator('.item-chosen')).toContainText('Harina de espelta');
    await expect(input).toBeHidden();
    const qty = recipe(page).getByLabel('Cantidad', { exact: true });
    await qty.fill('2');
    await recipe(page).locator('select').selectOption({ label: 'saco (de Molinos Sur)' });
    await expect(recipe(page).locator('.item-conv')).toContainText('= 50 kg');
    await expect(out(page)).toContainText('"itemId":"harina-espelta"');
    await expect(out(page)).toContainText('"baseQuantity":50');
  });

  test('con teclado: flechas e Intro eligen; Esc cierra la lista', async ({ page }) => {
    await page.goto('/#items');
    const input = recipe(page).getByRole('combobox');
    await input.fill('avena');
    await expect(input).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(input).toHaveAttribute('aria-expanded', 'false');
    await input.fill('harina');
    // Arroz, espelta, trigo: dos abajo es trigo.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(recipe(page).locator('.item-chosen')).toContainText('Harina de trigo');
    await recipe(page).getByRole('button', { name: 'Cambiar Harina de trigo' }).click();
    await expect(recipe(page).getByRole('combobox')).toBeFocused();
  });

  test('@smoke crear al momento: avisa del parecido, no deja repetir y queda elegido', async ({ page }) => {
    await page.goto('/#items');
    const input = recipe(page).getByRole('combobox');
    await input.fill('Harina de centeno');
    await recipe(page).getByRole('option', { name: /Crear «Harina de centeno»/ }).click();
    const form = recipe(page).getByRole('group', { name: 'Crear artículo' });
    await expect(form).toBeVisible();
    await expect(form.locator('.hint.suggest')).toContainText('Se parece a «Harina de arroz», «Harina de espelta», «Harina de trigo»');
    // Solo los tipos que admite el campo (ingrediente y bebida).
    await expect(form.getByRole('radio')).toHaveCount(2);
    const name = form.getByLabel('Nombre');
    await name.fill('harina de TRIGO');
    await expect(form.locator('.hint.suggest')).toContainText('Ya existe «Harina de trigo».');
    await expect(form.getByRole('button', { name: 'Crear y usar' })).toBeDisabled();
    await name.fill('Harina de centeno');
    await form.getByRole('radio', { name: 'Ingrediente' }).click();
    await form.getByRole('button', { name: 'Crear y usar' }).click();
    await expect(recipe(page).locator('.item-chosen')).toContainText('Harina de centeno');
    await expect(recipe(page).locator('.item-chosen')).toContainText('Sin subir todavía');
    await expect(recipe(page).locator('.item-chosen')).not.toContainText('Sin subir todavía');
    await expect(out(page)).toContainText('"itemId"');
    // El nuevo ya sale al buscar desde otro campo.
    await invoice(page).getByRole('combobox', { name: 'Mi nombre · artículo' }).fill('centeno');
    await expect(invoice(page).getByRole('option').first()).toContainText('Harina de centeno');
  });

  test('nombre repetido entre dos dispositivos: «Ya existe»: usar ese', async ({ page }) => {
    await page.goto('/#items');
    await recipe(page).getByRole('combobox').fill('Aceite de oliva');
    await recipe(page).getByRole('option', { name: /Crear «Aceite de oliva»/ }).click();
    await recipe(page).getByRole('button', { name: 'Crear y usar' }).click();
    const notice = recipe(page).locator('.item-notice');
    await expect(notice).toContainText('Ya existe «Aceite de oliva» (lo dio de alta otro dispositivo).');
    await expect(recipe(page).locator('.item-chosen')).toHaveCount(0);
    await notice.getByRole('button', { name: 'Usar ese' }).click();
    await expect(recipe(page).locator('.item-chosen')).toContainText('Aceite de oliva');
    await expect(out(page)).toContainText('"itemId":"aceite-oliva"');
    await expect(notice).toBeHidden();
  });

  test('crear sin red avisa de que se sube luego', async ({ page, context }) => {
    await page.goto('/#items');
    await context.setOffline(true);
    await recipe(page).getByRole('combobox').fill('Sal gorda');
    await recipe(page).getByRole('option', { name: /Crear «Sal gorda»/ }).click();
    await expect(recipe(page).locator('.item-offline')).toContainText('Sin conexión: se crea en este dispositivo');
    await context.setOffline(false);
  });

  test('«Gastar»: fijo en el artículo, sitio habitual propuesto y unidades propias', async ({ page }) => {
    await page.goto('/#items');
    await expect(spend(page).locator('.item-chosen')).toContainText('Cloro en pastillas');
    await expect(spend(page).locator('.item-chosen')).toContainText('3,5 kg · Piscina');
    await expect(spend(page).getByRole('button', { name: /Cambiar/ })).toHaveCount(0);
    await expect(spend(page).locator('.space-chip')).toContainText('Piscina');
    await spend(page).getByLabel('Cuánto', { exact: true }).fill('1');
    await spend(page).locator('select').selectOption('u-cloro-cubo');
    await expect(spend(page).locator('.item-conv')).toContainText('= 5 kg');
    await expect(out(page)).toContainText('"spaceId":"piscina"');
  });

  test('factura: alias del proveedor, sus unidades primero y «sin artículo»', async ({ page }) => {
    await page.goto('/#items');
    const input = invoice(page).getByRole('combobox', { name: 'Mi nombre · artículo' });
    await input.fill('har esp eco');
    await expect(invoice(page).getByRole('option').first()).toContainText('Harina de espelta');
    await invoice(page).getByRole('option').first().click();
    const units = await invoice(page).locator('select option').allTextContents();
    expect(units.slice(0, 2)).toEqual(['kg', 'saco']);
    await expect(invoice(page).locator('.space-chip')).toContainText('Despensa');
    await invoice(page).getByRole('button', { name: 'Cambiar Harina de espelta' }).click();
    await invoice(page).getByRole('combobox', { name: 'Mi nombre · artículo' }).fill('Portes');
    await invoice(page).getByRole('option', { name: /Usar «Portes» sin artículo/ }).click();
    await expect(invoice(page).locator('.item-chosen')).toContainText('Sin artículo: solo texto');
    await expect(out(page)).toContainText('"itemId":null,"text":"Portes"');
  });

  test('en inglés, con el idioma del portal', async ({ page }) => {
    await page.goto('/#items');
    await page.evaluate(() => (window as any).ikisaiI18n.start().setLocale('en'));
    await recipe(page).getByRole('combobox').fill('zzz');
    await expect(recipe(page).getByRole('option').last()).toContainText('Create “zzz”');
  });
});
