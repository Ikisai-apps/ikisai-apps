import { expect, test } from 'playwright/test';

test.describe('ui-kit v0.28 · conflictos que se pueden descartar y con nombre legible', () => {
  test('@smoke las decisiones van arriba y a la vista; las diferencias se despliegan', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#conflicts');
    const card = page.locator('#conflictHost [data-request-id="req-1"]');
    await card.scrollIntoViewIfNeeded();
    const theirs = card.getByRole('button', { name: 'Quedarme con lo del servidor' });
    const mine = card.getByRole('button', { name: 'Reintentar con lo mío' });
    await expect(theirs).toBeVisible();
    await expect(mine).toBeVisible();
    await expect(card.locator('table')).toBeHidden();
    // Botones antes que la tabla.
    const order = await card.evaluate((node) => [...node.children].map((child) => child.tagName.toLowerCase() + (child.className ? `.${child.className}` : '')));
    expect(order.indexOf('div.choices')).toBeLessThan(order.indexOf('table'));
    await card.getByRole('button', { name: 'Ver diferencias' }).click();
    await expect(card.locator('table')).toBeVisible();
    await expect(card.locator('tr.overlap th')).toHaveText('Notas');
    await card.getByRole('button', { name: 'Ocultar diferencias' }).click();
    await expect(card.locator('table')).toBeHidden();
    await expect(card.locator('p.who')).toHaveText('Lo cambió otra persona.');
    await theirs.click();
    await expect(page.locator('.toast.show')).toContainText('req-1: theirs');
    await expect(card).toHaveCount(0);
  });

  test('una fila sin nombre se titula con la tabla, nunca con el id; si el cambio es tuyo, lo dice', async ({ page }) => {
    await page.goto('/#conflicts');
    const card = page.locator('#conflictHost [data-request-id="req-4"]');
    await expect(card.locator('h3')).toHaveText('Un registro de facturas');
    await expect(card).not.toContainText('1edf75e5');
    await expect(card.locator('p.who')).toHaveText('Lo cambiaste tú desde otra pestaña o dispositivo.');
    await card.getByRole('button', { name: 'Reintentar con lo mío' }).click();
    await expect(page.locator('.toast.show')).toContainText('req-4: mine');
  });

  test('un `call` aparcado (validar) sin tabla ni nombre se pinta igual, sin id y con sus decisiones', async ({ page }) => {
    await page.goto('/#conflicts');
    const card = page.locator('#conflictHost [data-request-id="req-5"]');
    await expect(card.locator('h3')).toHaveText('Un cambio pendiente');
    await expect(card).not.toContainText('1edf75e5');
    await card.getByRole('button', { name: 'Quedarme con lo del servidor' }).click();
    await expect(page.locator('.toast.show')).toContainText('req-5: theirs');
  });

  test('nombre de la fila: código y nombre; frase de cabecera según quién cambió', async () => {
    const { conflictIntro, conflictRowName } = await import('../src/sync/conflict.ts');
    const row = (extra: Record<string, unknown>) => ({ id: 'x', revision: 2, created_at: '', updated_at: '', updated_by: 'u1', deleted_at: null, ...extra });
    const conflict = (extra: Record<string, unknown>) => ({ requestId: 'r', operation: { op: 'update', table: 'invoices.invoices', id: 'x', expectedRevision: 1, fields: {} }, base: null, current: row(extra), overlapping: [], detectedAt: '' }) as never;
    expect(conflictRowName(conflict({ code: 'FVR_2026_003', name: 'Intermodalidad de Levante' }))).toBe('FVR_2026_003 · Intermodalidad de Levante');
    expect(conflictRowName(conflict({}))).toBe('');
    expect(conflictIntro([conflict({})], 'u1')).toContain('Lo cambiaste tú desde otra pestaña o dispositivo');
    expect(conflictIntro([conflict({})], 'u2')).toContain('Otra persona cambió lo mismo que tú');
    expect(conflictIntro([conflict({})])).toContain('se cambió también en el servidor');
  });
});
