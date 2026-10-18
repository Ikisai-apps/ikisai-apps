import { expect, test, type Page } from 'playwright/test';
import { countTargets, fefoPlan, movementToFields, type ItemRow, type ItemSnapshot } from '../src/items/model.ts';

test.describe('ui-kit v0.38 · modelo de movimientos y recuento (Node)', () => {
  test.beforeEach(({}, info) => { test.skip(info.project.name !== 'escritorio', 'funciones puras: una vez basta'); });

  test('@smoke primero lo que caduca antes, sin lote al final y lo que falta aparte', () => {
    const stock = [
      { itemId: 'a', spaceId: 's', lotId: null, quantity: 5 },
      { itemId: 'a', spaceId: 's', lotId: 'late', quantity: 3 },
      { itemId: 'a', spaceId: 's', lotId: 'soon', quantity: 2 },
      { itemId: 'a', spaceId: 'otro', lotId: 'soon', quantity: 9 },
    ];
    const lots = [{ id: 'late', itemId: 'a', code: 'L2', expiresOn: '2026-12-01' }, { id: 'soon', itemId: 'a', code: 'L1', expiresOn: '2026-10-20' }];
    expect(fefoPlan('a', 's', 4, stock, lots)).toEqual({ parts: [{ lotId: 'soon', quantity: 2 }, { lotId: 'late', quantity: 2 }], shortfall: 0 });
    expect(fefoPlan('a', 's', 12, stock, lots)).toEqual({ parts: [{ lotId: 'soon', quantity: 2 }, { lotId: 'late', quantity: 3 }, { lotId: null, quantity: 5 }], shortfall: 2 });
  });

  test('qué se espera contar: stock del sitio por lote y lo que se guarda ahí aunque esté a cero', () => {
    const item = (id: string, extra: Partial<ItemRow> = {}) => ({ id, name: id, kind: 'ingrediente', baseUnit: 'kg', category: null, minQuantity: null, reorderQuantity: null, defaultSpaceId: null, defaultSupplierId: null, tracksLots: false, tracksExpiry: false, aliases: [], attributes: {}, active: true, notes: null, ...extra }) as ItemRow;
    const snap: ItemSnapshot = {
      items: [item('a'), item('b', { defaultSpaceId: 's' }), item('c', { active: false })], units: [], kinds: [],
      stock: [{ itemId: 'a', spaceId: 's', lotId: 'l1', quantity: 2 }, { itemId: 'a', spaceId: 'x', lotId: null, quantity: 1 }, { itemId: 'c', spaceId: 's', lotId: null, quantity: 4 }],
    };
    expect(countTargets(snap, ['s'])).toEqual([{ itemId: 'a', spaceId: 's', lotId: 'l1', expected: 2 }, { itemId: 'b', spaceId: 's', lotId: null, expected: 0 }]);
    expect(countTargets(snap, null, ['a']).map((t) => t.spaceId).sort()).toEqual(['s', 'x']);
    expect(movementToFields({ id: 'm', itemId: 'a', spaceId: 's', lotId: null, quantity: -1, kind: 'salida_manual', reason: 'merma', unitCost: null, transferId: null, sourceApp: null, sourceRef: null, note: 'x' }))
      .toEqual({ item_id: 'a', space_id: 's', lot_id: null, quantity: -1, kind: 'salida_manual', reason: 'merma', unit_cost: null, transfer_id: null, source_app: null, source_ref: null, note: 'x' });
  });
});

const catalog = (page: Page) => page.locator('#invCatalog');
const row = (page: Page, id: string) => catalog(page).locator(`.stk-row[data-item-id="${id}"]`);
const dialog = (page: Page) => page.getByRole('dialog');
const moves = (page: Page) => page.evaluate(() => (window as any).invSource.snapshot().movements as Array<Record<string, unknown>>);

test.describe('ui-kit v0.38 · createMovementForm', () => {
  test('@smoke «Gastar» con motivo: sale del lote que caduca antes y lo dice', async ({ page }) => {
    await page.goto('/#inventory');
    await row(page, 'yogur').getByRole('button', { name: 'Gastar' }).click();
    const d = dialog(page);
    await expect(d.getByRole('radio', { name: 'Salida' })).toHaveAttribute('aria-checked', 'true');
    await d.getByLabel('Cuánto sale', { exact: true }).fill('4');
    await d.getByRole('button', { name: 'Registrar salida' }).click();
    await expect(d.locator('.stk-mov-error')).toHaveText('Elige el motivo.');
    await d.getByRole('radio', { name: 'Caducado' }).click();
    await expect(d.locator('.stk-mov-summary')).toContainText('Sale del lote L-1018 · caduca mañana. Quedarán 8 ud en Cámara.');
    await d.getByRole('button', { name: 'Registrar salida' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(row(page, 'yogur')).toContainText('8 ud');
    const last = (await moves(page)).at(-1)!;
    expect(last).toMatchObject({ itemId: 'yogur', spaceId: 'camara', lotId: 'lot-yog', quantity: -4, kind: 'salida_manual', reason: 'caducado' });
  });

  test('traslado: dos filas con el mismo transfer_id en un solo registro', async ({ page }) => {
    await page.goto('/#inventory');
    await row(page, 'leche-avena').locator('.stk-open').click();
    await page.locator('#invSheetHost').getByRole('button', { name: 'Trasladar' }).click();
    const d = dialog(page);
    await d.getByLabel('Cuánto', { exact: true }).fill('2');
    await d.getByRole('combobox', { name: 'A', exact: true }).fill('desp');
    await d.getByRole('option', { name: /Despensa/ }).click();
    await expect(d.locator('.stk-mov-summary')).toContainText('Quedarán 4 l en Cámara y habrá 2 l en Despensa.');
    await d.getByRole('button', { name: 'Trasladar' }).click();
    await expect(dialog(page)).toHaveCount(0);
    const all = await moves(page);
    const pair = all.slice(-2);
    expect(pair.map((m) => [m.spaceId, m.quantity, m.kind])).toEqual([['camara', -2, 'traslado'], ['despensa', 2, 'traslado']]);
    expect(pair[0]!.transferId).toBe(pair[1]!.transferId);
    expect(pair[0]!.lotId).toBe('lot-avena');
    await expect(row(page, 'leche-avena')).toContainText('2 sitios');
  });

  test('entrada con lote nuevo: pide la caducidad y guarda lote, coste y stock', async ({ page }) => {
    await page.goto('/#inventory');
    await row(page, 'harina-espelta').getByRole('button', { name: 'Entrada' }).click();
    const d = dialog(page);
    await d.getByLabel('Cuánto entra', { exact: true }).fill('2');
    await d.getByLabel('Unidad de cuánto entra').selectOption('iu-esp-saco');
    await d.getByRole('button', { name: 'Registrar entrada' }).click();
    await expect(d.locator('.stk-mov-error')).toHaveText('Indica la fecha de caducidad.');
    await d.getByLabel('Código del lote').fill('L-1101');
    await d.getByLabel('Caduca el', { exact: true }).fill('2027-01-31');
    await d.getByLabel('Coste por kg (opcional)').fill('1,10');
    await d.getByRole('button', { name: 'Registrar entrada' }).click();
    await expect(dialog(page)).toHaveCount(0);
    const last = (await moves(page)).at(-1)!;
    expect(last).toMatchObject({ itemId: 'harina-espelta', spaceId: 'despensa', kind: 'entrada_manual', unitCost: 1.1, quantity: 50 });
    const lots = await page.evaluate(() => (window as any).invSource.snapshot().lots as Array<Record<string, unknown>>);
    expect(lots.at(-1)).toMatchObject({ itemId: 'harina-espelta', code: 'L-1101', expiresOn: '2027-01-31', id: last.lotId });
    await expect(row(page, 'harina-espelta')).toContainText('51,2 kg');
  });

  test('avisa sin bloquear si sale más de lo que consta', async ({ page }) => {
    await page.goto('/#inventory');
    await page.locator('#invMove').click();
    const d = dialog(page);
    await d.getByRole('combobox', { name: 'Artículo' }).fill('cloro');
    await d.locator('[role="option"][data-item-id="cloro"]').click();
    await d.getByLabel('Cuánto sale', { exact: true }).fill('5');
    await d.getByRole('radio', { name: 'Uso' }).click();
    await expect(d.locator('.stk-mov-warn')).toContainText('En este dispositivo constan 3,5 kg: se registra igual');
    await expect(d.getByRole('button', { name: 'Registrar salida' })).toBeEnabled();
  });
});

test.describe('ui-kit v0.38 · createCountSession', () => {
  test('@smoke a ciegas, línea a línea, revisar la diferencia y cerrar al sincronizar', async ({ page }) => {
    await page.goto('/#inventory');
    await page.locator('#invCountKitchen').click();
    const d = dialog(page);
    await expect(d.locator('.stk-count-progress-text')).toHaveText('0 de 4 contados');
    await expect(d.locator('.stk-count-lines')).not.toContainText('calculado');
    const trigo = d.locator('.stk-count-line[data-item-id="harina-trigo"]');
    await trigo.locator('input').fill('17');
    await trigo.locator('input').press('Enter');
    await expect(d.locator('.stk-count-progress-text')).toHaveText('1 de 4 contados');
    await d.getByRole('button', { name: 'Ver lo calculado' }).click();
    await expect(trigo).toContainText('calculado 18,5 kg');
    await d.getByRole('button', { name: 'Revisar y cerrar' }).click();
    await expect(d.locator('.stk-callout')).toHaveText('1 contados · 1 con diferencia · 0 cuadran');
    await expect(d.locator('.stk-diff')).toContainText('−1,5 kg');
    await expect(d.locator('.stk-close-note')).toContainText('Se cierra al sincronizar');
    await d.getByRole('button', { name: 'Cerrar y ajustar' }).click();
    await expect(d.locator('.stk-count-done')).toContainText('Recuento cerrado');
    await expect(row(page, 'harina-trigo')).toContainText('17 kg');
    const last = (await moves(page)).at(-1)!;
    expect(last).toMatchObject({ itemId: 'harina-trigo', kind: 'ajuste_recuento', quantity: -1.5 });
  });

  test('pasar a la siguiente casilla no pierde lo escrito; «Seguir luego» y retomar', async ({ page }) => {
    await page.goto('/#inventory');
    await page.locator('#invCountKitchen').click();
    let d = dialog(page);
    const inputs = d.locator('.stk-count-line input');
    await inputs.nth(0).fill('1');
    await inputs.nth(1).fill('17');
    await inputs.nth(1).blur();
    await expect(d.locator('.stk-count-progress-text')).toHaveText('2 de 4 contados');
    await expect(inputs.nth(1)).toHaveValue('17');
    await d.getByRole('button', { name: 'Seguir luego' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await page.locator('#invCountKitchen').click();
    d = dialog(page);
    await expect(d.locator('.stk-count-progress-text')).toHaveText('2 de 4 contados');
    await expect(d.locator('.stk-count-line input').nth(1)).toHaveValue('17');
  });

  test('«Contar» de una fila: solo ese artículo, también a ciegas; − y +', async ({ page }) => {
    await page.goto('/#inventory');
    await row(page, 'cloro').getByRole('button', { name: 'Contar' }).click();
    const d = dialog(page);
    await expect(d.locator('.stk-count-line')).toHaveCount(1);
    await expect(d.locator('.stk-count-lines')).not.toContainText('calculado');
    await d.getByRole('button', { name: 'Sumar uno a Cloro en pastillas' }).click();
    await d.getByRole('button', { name: 'Sumar uno a Cloro en pastillas' }).click();
    await d.getByRole('button', { name: 'Restar uno a Cloro en pastillas' }).click();
    await expect(d.locator('.stk-count-line input')).toHaveValue('1');
    await expect(d.locator('.stk-count-progress-text')).toHaveText('1 de 1 contados');
  });

  test('@smoke 0.38.1: contar todo con el foco en las casillas (sin «Ver lo calculado») activa «Revisar y cerrar»', async ({ page }) => {
    await page.goto('/#inventory');
    await page.locator('#invCountKitchen').click();
    const d = dialog(page);
    const review = d.getByRole('button', { name: 'Revisar y cerrar' });
    await expect(review).toBeDisabled();
    const inputs = d.locator('.stk-count-line input');
    await inputs.nth(0).fill('6');
    // Con lo escrito ya se puede pulsar; al pulsar se guarda.
    await expect(review).toBeEnabled();
    for (const [i, v] of [[1, '12'], [2, '1'], [3, '18']] as const) await inputs.nth(i).fill(v);
    // Intro guarda sin sacar el foco de la casilla: el repintado es parcial.
    await inputs.nth(3).press('Enter');
    await expect(inputs.nth(3)).toBeFocused();
    await expect(d.locator('.stk-count-progress-text')).toHaveText('4 de 4 contados');
    await expect(d.locator('.stk-count-pending-chip')).toHaveText('Sin contar (0)');
    await expect(review).toBeEnabled();
    await review.click();
    await expect(d.locator('.stk-callout')).toHaveText('4 contados · 2 con diferencia · 2 cuadran');
  });

  test('0.38.1: la primera cantidad y «Revisar y cerrar» directamente: se guarda y se revisa', async ({ page }) => {
    await page.goto('/#inventory');
    await row(page, 'cloro').getByRole('button', { name: 'Contar' }).click();
    const d = dialog(page);
    await d.locator('.stk-count-line input').fill('3');
    await d.getByRole('button', { name: 'Revisar y cerrar' }).click();
    await expect(d.locator('.stk-callout')).toHaveText('1 contados · 1 con diferencia · 0 cuadran');
    await expect(d.locator('.stk-diff')).toContainText('−0,5 kg');
  });

  test('«Contar otro artículo aquí» añade lo que no constaba', async ({ page }) => {
    await page.goto('/#inventory');
    await page.locator('#invCountKitchen').click();
    const d = dialog(page);
    await d.getByRole('button', { name: 'Contar otro artículo aquí' }).click();
    await d.locator('.stk-count-add').getByRole('combobox', { name: 'Artículo' }).fill('cloro');
    await d.locator('[role="option"][data-item-id="cloro"]').click();
    await expect(d.locator('.stk-count-line[data-item-id="cloro"]')).toBeVisible();
    await expect(d.locator('.stk-count-progress-text')).toHaveText('0 de 5 contados');
  });
});
