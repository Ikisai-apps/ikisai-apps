import { expect, test, type Page, type TestInfo } from 'playwright/test';

type Item = { id: string; status: string; comment?: string | null };
const store = (page: Page) => page.evaluate(() => (window as unknown as { proposalStore: Item[] }).proposalStore.map((i) => ({ id: i.id, status: i.status, comment: i.comment ?? null })));
const list = (page: Page) => page.locator('#proposalPanes .proposals');
const card = (page: Page, id: string) => list(page).locator(`.pl-card[data-id="${id}"]`);

/** Pulsa «Aprobar» o «Descartar»: en la tarjeta (móvil) o en el detalle (escritorio). */
async function press(page: Page, info: TestInfo, id: string, name: 'Aprobar' | 'Descartar'): Promise<void> {
  if (info.project.name === 'escritorio') {
    await card(page, id).locator('.pl-open').click();
    await list(page).locator(`.pl-detail .pl-detail-body[data-id="${id}"]`).getByRole('button', { name: new RegExp(`^${name}:`) }).click();
  } else {
    await card(page, id).getByRole('button', { name: new RegExp(`^${name}:`) }).click();
  }
}

test.describe('ui-kit v0.33 · cola de propuestas (O1)', () => {
  test('@smoke aprobar confirma siempre, con comentario opcional, y pasa a «Aprobadas»', async ({ page }, info) => {
    await page.goto('/#proposals');
    await expect(list(page).locator('.pl-card')).toHaveCount(3);
    await expect(list(page).locator('.pl-tabs .pl-count')).toHaveText('3');
    await press(page, info, 'sg-3', 'Aprobar');
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('¿Aprobar esta propuesta?');
    await expect(dialog).toContainText('Yoga y huerto');
    await expect(page.locator('#proposalComment')).toBeFocused();
    await page.locator('#proposalComment').fill('Te damos plaza en la Hab 3.');
    await page.locator('#dialogConfirm').click();
    await expect(page.locator('.toast.show')).toContainText('Propuesta aprobada.');
    await expect(card(page, 'sg-3')).toHaveCount(0);
    await expect(list(page).locator('.pl-tabs .pl-count')).toHaveText('2');
    expect((await store(page)).find((i) => i.id === 'sg-3')).toEqual({ id: 'sg-3', status: 'approved', comment: 'Te damos plaza en la Hab 3.' });
    await list(page).locator('.pl-tabs button[data-status="approved"]').click();
    await expect(card(page, 'sg-3').locator('.pl-quote')).toContainText('«Te damos plaza en la Hab 3.» · Staff');
    await expect(card(page, 'sg-3').locator('.chip.status')).toHaveText('Aprobada');
  });

  test('cancelar el diálogo no cambia nada; descartar es rojo y sin comentario guarda null', async ({ page }, info) => {
    await page.goto('/#proposals');
    await press(page, info, 'sg-2', 'Aprobar');
    await page.locator('#dialogCancel').click();
    await expect(card(page, 'sg-2')).toBeVisible();
    expect((await store(page)).find((i) => i.id === 'sg-2')!.status).toBe('pending');
    await press(page, info, 'sg-2', 'Descartar');
    await expect(page.locator('#dialogConfirm')).toHaveClass(/danger/);
    await expect(page.locator('#dialogConfirm')).toHaveText('Descartar');
    await page.locator('#dialogConfirm').click();
    await expect(page.locator('.toast.show')).toContainText('Propuesta descartada.');
    expect((await store(page)).find((i) => i.id === 'sg-2')).toEqual({ id: 'sg-2', status: 'rejected', comment: null });
  });

  test('si el servidor lo rechaza, se avisa y la propuesta sigue pendiente', async ({ page }, info) => {
    await page.goto('/#proposals');
    await press(page, info, 'sg-1', 'Aprobar');
    await page.locator('#proposalComment').fill('fallo');
    await page.locator('#dialogConfirm').click();
    await expect(page.locator('.toast.show')).toContainText('No se ha guardado: El servidor no lo ha aceptado.');
    await expect(card(page, 'sg-1')).toBeVisible();
    expect((await store(page)).find((i) => i.id === 'sg-1')!.status).toBe('pending');
  });

  test('filtro por tipo', async ({ page }) => {
    await page.goto('/#proposals');
    await list(page).locator('.pl-kinds .filterchip[data-kind="dish"]').click();
    await expect(list(page).locator('.pl-card')).toHaveCount(1);
    await expect(card(page, 'sg-2')).toBeVisible();
    await list(page).locator('.pl-kinds .filterchip', { hasText: 'Todas' }).click();
    await expect(list(page).locator('.pl-card')).toHaveCount(3);
  });

  test('«Mis propuestas»: pendientes y resueltas con el comentario; «Retirar» confirma', async ({ page }) => {
    await page.goto('/#proposals');
    await page.locator('#showMine').click();
    await expect(list(page)).toHaveClass(/mine/);
    await expect(list(page).locator('.pl-group')).toHaveText(['Pendientes', 'Resueltas']);
    await expect(card(page, 'sg-4').locator('.pl-quote')).toContainText('«Este mes no se puede hacer fuego.» · Dirección');
    await expect(card(page, 'sg-1').getByRole('button', { name: /Aprobar|Descartar/ })).toHaveCount(0);
    await card(page, 'sg-1').getByRole('button', { name: /^Retirar/ }).click();
    await expect(page.getByRole('alertdialog')).toContainText('¿Retirar esta propuesta?');
    await page.locator('#dialogConfirm').click();
    await expect(page.locator('.toast.show')).toContainText('Propuesta retirada.');
    await expect(card(page, 'sg-1').locator('.chip.status')).toHaveText('Retirada');
    await expect(list(page).locator('.pl-group')).toHaveText(['Resueltas']);
    await page.locator('#showReview').click();
    await expect(card(page, 'sg-1')).toHaveCount(0);
  });

  test('escritorio: detalle a la derecha, ↑ ↓ cambian de propuesta y al decidir pasa a la siguiente', async ({ page }, info) => {
    test.skip(info.project.name !== 'escritorio', 'lista y detalle lado a lado');
    await page.goto('/#proposals');
    const detail = list(page).locator('.pl-detail');
    await expect(detail).toBeVisible();
    await expect(card(page, 'sg-3').locator('.pl-actions')).toBeHidden();
    await card(page, 'sg-3').locator('.pl-open').focus();
    await page.keyboard.press('ArrowDown');
    await expect(card(page, 'sg-2')).toHaveClass(/on/);
    await expect(detail.locator('.pl-detail-title')).toHaveText('Lentejas con verduras');
    await page.keyboard.press('ArrowDown');
    await expect(detail.locator('.pl-detail-app')).toContainText('Mantenimiento');
    await page.keyboard.press('ArrowUp');
    await detail.getByRole('button', { name: /^Aprobar:/ }).click();
    await page.locator('#dialogConfirm').click();
    await expect(page.locator('.toast.show')).toContainText('Propuesta aprobada.');
    await expect(detail.locator('.pl-detail-title')).toHaveText('Pintar la barandilla del porche');
  });

  test('móvil: tocar la tarjeta abre el detalle en una hoja con sus botones', async ({ page }, info) => {
    test.skip(info.project.name !== 'movil', 'hoja del móvil');
    await page.goto('/#proposals');
    await expect(list(page).locator('.pl-detail')).toBeHidden();
    await card(page, 'sg-1').locator('.pl-open').click();
    const sheet = page.locator('.sheetback.show .sheet');
    await expect(sheet).toContainText('Mantenimiento');
    await sheet.getByRole('button', { name: /^Descartar/ }).click();
    await expect(page.locator('.sheetback.show')).toHaveCount(0);
    await expect(page.getByRole('alertdialog')).toContainText('¿Descartar esta propuesta?');
    await page.locator('#dialogConfirm').click();
    await expect(page.locator('.toast.show')).toContainText('Propuesta descartada.');
  });
});
