import { expect, test, type Page } from 'playwright/test';
import { searchItems, type ItemRow } from '../src/items/model.ts';

/** Peticiones K4 (sugeridos en el selector) y K5 (buscar por palabras) de Tasks, decisiones de VG del 27-10. */
const item = (id: string, name: string, extra: Partial<ItemRow> = {}): ItemRow => ({
  id, name, kind: 'material', baseUnit: 'ud', category: null, minQuantity: null, reorderQuantity: null, defaultSpaceId: null, defaultSupplierId: null,
  tracksLots: false, tracksExpiry: false, aliases: [], attributes: {}, active: true, notes: null, ...extra,
});
const ITEMS = [
  item('t20', 'Tubo multicapa 20 mm'), item('t16', 'Tubo multicapa 16 mm'), item('c20', 'Codo latón 20 mm', { aliases: ['Codo multicapa'] }),
  item('cinta', 'Cinta de teflón'), item('m20', 'Manguito 20', { aliases: ['Empalme multicapa'] }),
];
const ids = (q: string, o = {}) => searchItems(ITEMS, q, o).map((i) => i.id);

test.describe('ui-kit v0.62 · K4 y K5 de Tasks', () => {
  test('K5: cada palabra en cualquier orden, sin tildes ni mayúsculas; con una palabra, como antes', ({}, info) => {
    test.skip(info.project.name !== 'escritorio', 'funciones puras: una vez basta');
    expect(ids('multicapa 20')).toEqual(['t20', 'c20', 'm20']);
    expect(ids('20 MULTICAPA')).toEqual(['t20', 'c20', 'm20']);
    expect(ids('tubo 16')).toEqual(['t16']);
    expect(ids('teflon')).toEqual(['cinta']);
    expect(ids('laton codo')).toEqual(['c20']);
    // La frase manda: «tubo multicapa» empieza el nombre; las palabras sueltas en el alias van después.
    expect(ids('multicapa')).toEqual(['t16', 't20', 'c20', 'm20']);
    expect(ids('codo multicapa')).toEqual(['c20']);
    expect(ids('tubo 25')).toEqual([]);
  });

  test('K4: boost pone delante los sugeridos que coinciden, sin colar los que no', ({}, info) => {
    test.skip(info.project.name !== 'escritorio', 'funciones puras: una vez basta');
    expect(ids('multicapa', { boost: ['m20'] })).toEqual(['m20', 't16', 't20', 'c20']);
    expect(ids('tubo', { boost: ['cinta'] })).toEqual(['t16', 't20']);
  });

  async function picker(page: Page): Promise<void> {
    await page.goto('/');
    await page.evaluate(() => {
      const w = window as any;
      const p = w.ikisaiKit.createItemPicker({ label: 'Material', source: w.itemSource, suggested: ['sabanas', 'cloro'], suggestedLabel: 'Del kit del oficio', feedbackId: 'tasks.gastar.material' });
      p.element.id = 'k4Picker';
      document.body.prepend(p.element);
    });
  }

  test('@smoke K4 en el selector: con el campo vacío ofrece los sugeridos y al buscar van primero y marcados', async ({ page }) => {
    await picker(page);
    const input = page.locator('#k4Picker .item-search');
    await input.focus();
    const rows = page.locator('#k4Picker .item-result');
    await expect(rows).toHaveCount(2);
    expect(await rows.locator('.item-suggested').allTextContents()).toEqual(['Del kit del oficio', 'Del kit del oficio']);
    expect(await rows.evaluateAll((ns) => ns.map((n) => (n as HTMLElement).dataset.itemId))).toEqual(['cloro', 'sabanas']);
    await input.fill('a');
    const first = await rows.first().evaluate((n) => (n as HTMLElement).dataset.itemId);
    expect(['cloro', 'sabanas']).toContain(first);
    expect(await page.locator('#k4Picker .item-result:not(:has(.item-suggested))').count()).toBeGreaterThan(0);
  });

  test('K5 en el selector: palabras en cualquier orden y «→ completa» con la flecha o tocando', async ({ page }) => {
    await picker(page);
    const input = page.locator('#k4Picker .item-search');
    await input.fill('trigo harina');
    await expect(page.locator('#k4Picker .item-result').first()).toHaveAttribute('data-item-id', 'harina-trigo');
    await input.fill('harina de t');
    const hint = page.locator('#k4Picker .item-complete');
    await expect(hint).toContainText('Harina de trigo');
    expect(await hint.getAttribute('data-feedback-id')).toBe('tasks.gastar.material.completar');
    await input.press('End');
    await input.press('ArrowRight');
    await expect(input).toHaveValue('Harina de trigo');
    await expect(hint).toHaveCount(0);
    await input.fill('clo');
    await page.locator('#k4Picker .item-complete').click();
    await expect(input).toHaveValue('Cloro en pastillas');
    await expect(input).toBeFocused();
  });
});
