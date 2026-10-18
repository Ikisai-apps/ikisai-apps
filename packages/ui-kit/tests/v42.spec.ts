import { expect, test, type Page } from 'playwright/test';
import { averageCost, itemToFields, nextExpiry, type ItemRow, type MovementRow } from '../src/items/model.ts';
import { expiryText } from '../src/items/catalog.ts';

const mv = (id: string, quantity: number, kind: string, extra: Partial<MovementRow> = {}): MovementRow => ({
  id, itemId: 'a', spaceId: 's', lotId: null, quantity, kind, reason: null, unitCost: null, transferId: null, countId: null, sourceApp: null, sourceRef: null, note: null, at: '2026-10-01T10:00:00Z', createdBy: null, ...extra,
});

test.describe('ui-kit v0.37 · modelo del inventario (Node)', () => {
  test.beforeEach(({}, info) => { test.skip(info.project.name !== 'escritorio', 'funciones puras: una vez basta'); });

  test('@smoke coste medio: entradas con coste, coste que llega después y contrarios', () => {
    const moves = [mv('e1', 10, 'entrada_factura', { unitCost: 2 }), mv('e2', 10, 'entrada_manual'), mv('e3', 5, 'entrada_factura'), mv('c1', -4, 'consumo_servicio'), mv('k1', -5, 'entrada_factura', { unitCost: 2 })];
    expect(averageCost('a', moves)).toEqual({ averageCost: 2, costedQuantity: 5 });
    expect(averageCost('a', moves, [{ movementId: 'e3', unitCost: 4 }])).toEqual({ averageCost: 3, costedQuantity: 10 });
    expect(averageCost('a', [mv('e2', 10, 'entrada_manual')])).toBeNull();
  });

  test('caducidades: la primera con stock dentro del plazo, y en palabras', () => {
    const stock = [{ itemId: 'a', spaceId: 's', lotId: 'l1', quantity: 2 }, { itemId: 'a', spaceId: 's', lotId: 'l2', quantity: 0 }];
    const lots = [{ id: 'l1', itemId: 'a', code: 'X', expiresOn: '2026-10-20' }, { id: 'l2', itemId: 'a', code: 'Y', expiresOn: '2026-10-15' }];
    expect(nextExpiry('a', stock, lots, '2026-10-18', 7)).toBe('2026-10-20');
    expect(nextExpiry('a', stock, lots, '2026-10-10', 7)).toBeNull();
    expect(expiryText('2026-10-17', '2026-10-18')).toBe('caducado');
    expect(expiryText('2026-10-18', '2026-10-18')).toBe('caduca hoy');
    expect(expiryText('2026-10-19', '2026-10-18')).toBe('caduca mañana');
    expect(expiryText('2026-11-02', '2026-10-18')).toBe('caduca el 02/11');
  });

  test('cambios de la ficha a columnas: los alias van en attributes sin perder lo demás', () => {
    const current = { attributes: { brand: 'Honda', aliases: ['A'] }, aliases: ['A'] } as unknown as ItemRow;
    expect(itemToFields({ minQuantity: 8, defaultSpaceId: null }, current)).toEqual({ min_quantity: 8, default_space_id: null });
    expect(itemToFields({ aliases: ['A', 'B'] }, current)).toEqual({ attributes: { brand: 'Honda', aliases: ['A', 'B'] } });
    expect(itemToFields({ aliases: [] }, current)).toEqual({ attributes: { brand: 'Honda' } });
  });
});

const catalog = (page: Page) => page.locator('#invCatalog');
const sheet = (page: Page) => page.locator('#invSheetHost');
const row = (page: Page, id: string) => catalog(page).locator(`.stk-row[data-item-id="${id}"]`);
const open = async (page: Page, id: string) => { await row(page, id).locator('.stk-open').click(); await expect(sheet(page).locator('.stk-sheet')).toBeVisible(); };

test.describe('ui-kit v0.37 · createItemCatalog', () => {
  test('@smoke agrupa por sitio, avisa con texto y la app pone «Pedir»', async ({ page }) => {
    await page.goto('/#inventory');
    await expect(catalog(page).locator('.stk-group').first()).toHaveText('Cocina · 4');
    await expect(row(page, 'harina-espelta')).toHaveClass(/low/);
    await expect(row(page, 'harina-espelta')).toContainText('Bajo mínimo');
    await expect(row(page, 'harina-espelta').getByRole('button', { name: 'Pedir' })).toBeVisible();
    await expect(row(page, 'harina-trigo').getByRole('button', { name: 'Pedir' })).toHaveCount(0);
    await expect(row(page, 'yogur')).toContainText('caduca mañana');
    await expect(row(page, 'sabanas')).toContainText('2 sitios');
    await expect(row(page, 'taladro')).toHaveCount(0);
  });

  test('filtros a un toque con cuántos hay, búsqueda y archivados', async ({ page }) => {
    await page.goto('/#inventory');
    const chips = catalog(page).locator('.stk-chips');
    await chips.getByRole('button', { name: 'Bajo mínimo (1)' }).click();
    await expect(catalog(page).locator('.stk-row')).toHaveCount(1);
    await chips.getByRole('button', { name: 'Bajo mínimo (1)' }).click();
    await chips.getByRole('button', { name: 'Caduca pronto (2)' }).click();
    await expect(catalog(page).locator('.stk-row')).toHaveCount(2);
    await chips.getByRole('button', { name: 'Caduca pronto (2)' }).click();
    await chips.getByRole('button', { name: 'Piscina' }).click();
    await expect(catalog(page).locator('.stk-row')).toHaveCount(1);
    await expect(row(page, 'cloro')).toBeVisible();
    await chips.getByRole('button', { name: 'Piscina' }).click();
    await catalog(page).getByRole('searchbox').fill('esp eco');
    await expect(catalog(page).locator('.stk-row')).toHaveCount(1);
    await expect(row(page, 'harina-espelta')).toBeVisible();
    await catalog(page).getByRole('searchbox').fill('');
    await chips.getByRole('button', { name: 'Archivados' }).click();
    await expect(row(page, 'taladro')).toContainText('archivado');
    await expect(catalog(page).locator('.stk-row')).toHaveCount(1);
  });

  test('«+ Artículo»: alta rápida y se abre su ficha', async ({ page }) => {
    await page.goto('/#inventory');
    await catalog(page).getByRole('button', { name: 'Artículo' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nuevo artículo' });
    await dialog.getByRole('combobox').fill('Lentejas pardinas');
    await dialog.getByRole('option', { name: /Crear «Lentejas pardinas»/ }).click();
    await dialog.getByRole('button', { name: 'Crear y usar' }).click();
    await expect(sheet(page).locator('.stk-sheet-title')).toHaveText('Lentejas pardinas');
    await expect(catalog(page).locator('.stk-row', { hasText: 'Lentejas pardinas' })).toBeVisible();
  });
});

test.describe('ui-kit v0.37 · createItemSheet', () => {
  test('@smoke stock por sitio y lote, coste medio y movimientos con su origen', async ({ page }, info) => {
    await page.goto('/#inventory');
    await open(page, 'harina-espelta');
    const stock = sheet(page).locator('.stk-panel').first();
    await expect(stock).toContainText('Despensa');
    await expect(stock).toContainText('1,2 kg');
    await expect(stock).toContainText('lote L-0912');
    await expect(stock).toContainText('bajo mínimo (5 kg)');
    await expect(stock).toContainText('1,256 €/kg (con 50 kg con coste)');
    await expect(sheet(page).locator('.stk-sheet-meta')).toContainText('Molinos Sur');
    if (info.project.name === 'movil') await sheet(page).getByRole('tab', { name: 'Movimientos' }).click();
    const moves = sheet(page).locator('.stk-movements');
    await expect(moves.locator('.stk-mov').first()).toContainText('Consumo del servicio');
    await expect(moves.locator('.stk-mov').first()).toContainText('−48,8 kg');
    await expect(moves.getByRole('button', { name: 'Factura 2026-311' })).toBeVisible();
  });

  test('traslado en palabras y Movimientos como pestaña en el móvil', async ({ page }, info) => {
    await page.goto('/#inventory');
    await open(page, 'leche-avena');
    const tab = sheet(page).getByRole('tab', { name: 'Movimientos' });
    if (info.project.name === 'movil') {
      await expect(sheet(page).locator('.stk-movements')).toBeHidden();
      await tab.click();
    } else {
      await expect(tab).toBeHidden();
    }
    await expect(sheet(page).locator('.stk-movements')).toContainText('Traslado a Cámara');
    await expect(sheet(page).locator('.stk-movements')).toContainText('Traslado desde Despensa');
  });

  test('Datos: guardar el mínimo, sin repetir nombre', async ({ page }) => {
    await page.goto('/#inventory');
    await open(page, 'harina-espelta');
    await sheet(page).getByRole('tab', { name: 'Datos' }).click();
    const name = sheet(page).getByLabel('Nombre', { exact: true });
    await name.fill('harina de TRIGO');
    await expect(sheet(page).locator('.hint.suggest')).toHaveText('Ya existe «Harina de trigo».');
    await expect(sheet(page).getByRole('button', { name: 'Guardar' })).toBeDisabled();
    await name.fill('Harina de espelta');
    await sheet(page).getByLabel('Mínimo', { exact: true }).fill('8');
    await sheet(page).getByRole('button', { name: 'Guardar' }).click();
    await expect(sheet(page).locator('.stk-save-status')).toHaveText('Guardado.');
    await expect(sheet(page).locator('.stk-sheet-meta')).toContainText('mínimo 8 kg');
    await expect(row(page, 'harina-espelta')).toContainText('8 kg');
  });

  test('Datos de una máquina: marca y estado; un ingrediente no los enseña', async ({ page }) => {
    await page.goto('/#inventory');
    await open(page, 'cortacesped');
    await sheet(page).getByRole('tab', { name: 'Datos' }).click();
    await expect(sheet(page).getByLabel('Marca')).toHaveValue('Honda');
    await expect(sheet(page).getByLabel('Estado')).toHaveValue('limitado');
    await open(page, 'harina-trigo');
    await sheet(page).getByRole('tab', { name: 'Datos' }).click();
    await expect(sheet(page).locator('.stk-equipment')).toBeHidden();
  });

  test('Unidades: añadir con validación', async ({ page }) => {
    await page.goto('/#inventory');
    await open(page, 'harina-trigo');
    await sheet(page).getByRole('tab', { name: 'Unidades' }).click();
    await sheet(page).getByRole('button', { name: 'Añadir unidad' }).click();
    const fresh = sheet(page).locator('.stk-unit.new');
    await fresh.getByLabel('Unidad').fill('kg');
    await fresh.getByLabel('Cuántas kg').fill('1');
    await fresh.getByRole('button', { name: 'Guardar' }).click();
    await expect(fresh.locator('.fielderror')).toHaveText('Es la unidad base: no hace falta.');
    await fresh.getByLabel('Unidad').fill('saco');
    await fresh.getByLabel('Cuántas kg').fill('25');
    await fresh.getByRole('button', { name: 'Guardar' }).click();
    await expect(sheet(page).locator('.stk-unit:not(.new)')).toHaveCount(1);
    await expect(sheet(page).locator('.stk-unit:not(.new) input').first()).toHaveValue('saco');
  });

  test('archivar con confirmación: sale de la lista y queda en «Archivados»', async ({ page }) => {
    await page.goto('/#inventory');
    await open(page, 'harina-trigo');
    await sheet(page).getByRole('tab', { name: 'Datos' }).click();
    await sheet(page).getByRole('button', { name: 'Archivar' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Archivar' }).click();
    await expect(sheet(page).locator('.stk-sheet-meta')).toContainText('archivado');
    await expect(row(page, 'harina-trigo')).toHaveCount(0);
    await catalog(page).getByRole('button', { name: 'Archivados' }).click();
    await expect(row(page, 'harina-trigo')).toBeVisible();
  });

  test('pestañas con flechas', async ({ page }) => {
    await page.goto('/#inventory');
    await open(page, 'harina-espelta');
    await sheet(page).getByRole('tab', { name: 'Stock' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(sheet(page).getByRole('tab', { name: 'Datos' })).toBeFocused();
    await expect(sheet(page).getByRole('tab', { name: 'Datos' })).toHaveAttribute('aria-selected', 'true');
  });
});
