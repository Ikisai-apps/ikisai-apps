import { expect, test, type Page } from 'playwright/test';

/** Oficios en dos niveles (VG, 6-11): «Fontanería › ACS»; el oficio entero o una especialidad, y buscar por ambos. */
async function setup(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => {
    const K = (window as any).ikisaiKit;
    const w = window as any;
    // Filas como las de `central.trade_options`.
    w.trades = [
      { trade_id: 'fonta', parent_id: null, name: 'Fontanería', path: 'Fontanería', position: 1 },
      { trade_id: 'acs', parent_id: 'fonta', name: 'ACS', path: 'Fontanería › ACS', position: 1 },
      { trade_id: 'riego', parent_id: 'fonta', name: 'Riego', path: 'Fontanería › Riego', position: 2 },
      { trade_id: 'elec', parent_id: null, name: 'Electricidad', path: 'Electricidad', position: 2 },
      { trade_id: 'cerr', parent_id: null, name: 'Llaves y cierres', path: 'Llaves y cierres', position: 3, icon: 'cerrajeria' },
    ];
    w.values = [];
    const picker = K.createTradePicker({ label: 'Oficio de la tarea', trades: w.trades, feedbackId: 'tasks.ficha.oficio', onChange: (v: string[]) => w.values.push(v) });
    document.body.replaceChildren(picker.element);
  });
}
const last = (page: Page) => page.evaluate(() => (window as any).values.at(-1));

test.describe('ui-kit · createTradePicker', () => {
  test('@smoke oficio entero o especialidad: uno cubre al otro y nunca quedan juntos', async ({ page }) => {
    await setup(page);
    await page.getByText('Elegir en la lista de oficios').click();
    await page.locator('.space-tree-group > summary', { hasText: 'Fontanería' }).click();
    await page.locator('.space-tree-chip', { hasText: 'ACS' }).click();
    await page.locator('.space-tree-chip', { hasText: 'Riego' }).click();
    expect(await last(page)).toEqual(['acs', 'riego']);
    // El oficio entero se queda solo: cubre sus especialidades.
    await page.locator('.space-tree-chip', { hasText: 'Fontanería' }).click();
    expect(await last(page)).toEqual(['fonta']);
    await expect(page.locator('.space-chip')).toHaveCount(1);
    // Una especialidad con el padre marcado lo acota.
    await page.locator('.space-tree-chip', { hasText: 'ACS' }).click();
    expect(await last(page)).toEqual(['acs']);
    expect(await page.evaluate(() => { const K = (window as any).ikisaiKit; const t = (window as any).trades; return [K.tradeCovers(t, ['fonta'], 'acs'), K.tradeCovers(t, ['acs'], 'riego'), K.expandTrades(t, ['fonta'])]; }))
      .toEqual([true, false, ['fonta', 'acs', 'riego']]);
  });

  test('buscar por el oficio o por la especialidad, con la ruta', async ({ page }) => {
    await setup(page);
    const search = page.getByRole('combobox');
    await search.fill('acs');
    await expect(page.locator('.space-result')).toHaveCount(1);
    await expect(page.locator('.space-result-path')).toContainText('Fontanería');
    await search.fill('fontaneria');
    await expect(page.locator('.space-result')).toHaveCount(3);
    await page.keyboard.press('Enter');
    expect(await last(page)).toEqual(['fonta']);
    await search.fill('zzz');
    await expect(page.locator('.space-result.empty')).toContainText('Ningún oficio coincide con «zzz».');
  });

  test('icono por oficio: por la clave de Central o por el nombre; las especialidades, el de su oficio', async ({ page }) => {
    await setup(page);
    await page.getByText('Elegir en la lista de oficios').click();
    for (const name of ['Fontanería', 'Electricidad', 'Llaves y cierres']) await expect(page.locator('.space-tree-group > summary, .space-tree-chip', { hasText: name }).first().locator('svg')).toHaveCount(1);
    await page.getByRole('combobox').fill('acs');
    await expect(page.locator('.space-result-name svg')).toHaveCount(1);
    expect(await page.evaluate(() => { const K = (window as any).ikisaiKit; return [K.tradeIcon(null, 'Fontanería'), K.tradeIcon('piscina'), K.tradeIcon('Climatización'), K.tradeIcon('zzz', 'Otro')]; }))
      .toEqual(['faucet', 'pool', 'fan', null]);
  });
});
