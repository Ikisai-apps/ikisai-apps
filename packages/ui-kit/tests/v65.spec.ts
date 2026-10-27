import { expect, test, type Page } from 'playwright/test';

/** Encargo de VG (27-10) para Flow v2: carriles en pestañas o lado a lado (API acordada con Flow). */
async function setup(page: Page, opts: { width: number; lanes?: number; empty?: number[]; storage?: string | null }): Promise<void> {
  await page.setViewportSize({ width: opts.width, height: 800 });
  await page.goto('/');
  await page.evaluate(({ storage }) => { try { if (storage) localStorage.setItem('ikisai-lanes:test-board', storage); else localStorage.removeItem('ikisai-lanes:test-board'); } catch { /* */ } }, { storage: opts.storage ?? null });
  await page.evaluate(({ n, empty }) => {
    const K = (window as any).ikisaiKit;
    const w = window as any;
    w.lanesLog = [];
    const lanes = Array.from({ length: n }, (_, i) => ({
      id: `c${i}`, title: `Columna ${i + 1}`, count: empty.includes(i) ? 0 : i + 1, empty: empty.includes(i),
      mount: (body: HTMLElement) => {
        w.lanesLog.push(`mount:c${i}`);
        body.append(K.el('input', { 'aria-label': `Nota ${i}`, class: 'probe' }), ...Array.from({ length: 30 }, (_, k) => K.el('p', null, `Tarjeta ${k}`)));
        return () => w.lanesLog.push(`clean:c${i}`);
      },
    }));
    w.lanesSpec = lanes;
    document.body.replaceChildren();
    document.body.style.margin = '0';
    const box = K.el('div', { style: 'padding:0 16px' });
    document.body.append(box);
    w.lanes = K.createLanes({ label: 'Columnas', lanes, storageKey: 'test-board', feedbackId: 'flow.tablero.carriles', onSelect: (id: string) => w.lanesLog.push(`select:${id}`), onView: (v: string) => w.lanesLog.push(`view:${v}`) });
    box.append(w.lanes.element);
  }, { n: opts.lanes ?? 4, empty: opts.empty ?? [] });
}
const log = (page: Page) => page.evaluate(() => (window as any).lanesLog as string[]);

test.describe('ui-kit v0.61 · createLanes', () => {
  test('@smoke pestañas en el móvil: chips con recuento, teclado, mount perezoso y sin desmontar al cambiar', async ({ page }) => {
    await setup(page, { width: 390 });
    expect(await page.locator('.lanes').getAttribute('data-view')).toBe('tabs');
    const tabs = page.locator('.lanes-tab');
    await expect(tabs).toHaveCount(4);
    expect(await tabs.first().getAttribute('aria-label')).toBe('Columna 1, 1');
    expect(await tabs.first().getAttribute('data-feedback-id')).toBe('flow.tablero.carriles.carril');
    expect(await log(page)).toEqual(['mount:c0']);
    await page.locator('.lanes-body:not([hidden]) .probe').fill('escrito');
    await tabs.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(tabs.nth(3)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    expect(await log(page)).toEqual(['mount:c0', 'mount:c1', 'select:c1', 'mount:c3', 'select:c3', 'select:c0']);
    // El primero no se desmontó: conserva lo escrito.
    await expect(page.locator('.lanes-body:not([hidden]) .probe')).toHaveValue('escrito');
    const panel = page.locator('.lanes-body:not([hidden])');
    expect(await panel.getAttribute('role')).toBe('tabpanel');
    expect(await panel.getAttribute('aria-labelledby')).toBe(await tabs.first().getAttribute('id'));
    expect(await page.locator('.lanes-body[role=tabpanel]').count()).toBe(3);
  });

  test('lado a lado: conmutador recordado, dos carriles en el móvil, el vacío plegado y el principal al desplazar', async ({ page }) => {
    await setup(page, { width: 390, lanes: 5, empty: [2] });
    await page.locator('.lanes-mode[data-view="side"]').click();
    expect(await page.evaluate(() => localStorage.getItem('ikisai-lanes:test-board'))).toBe('side');
    await expect(page.locator('.lanes-mode[data-view="side"]')).toHaveAttribute('aria-pressed', 'true');
    const widths = await page.locator('.lanes-lane').evaluateAll((ns) => ns.map((n) => Math.round(n.getBoundingClientRect().width)));
    expect(widths[2]).toBe(44);
    expect(widths[0]).toBeGreaterThanOrEqual(172);
    expect(widths[0]! + widths[1]! + 8).toBeLessThanOrEqual(390 - 32);
    // El cuerpo desplaza por dentro.
    const body = await page.locator('.lanes-lane').first().locator('.lanes-body').evaluate((b) => ({ over: b.scrollHeight > b.clientHeight, y: getComputedStyle(b).overflowY }));
    expect(body).toEqual({ over: true, y: 'auto' });
    // Mismo nodo al cambiar de vista: lo escrito sigue.
    await setup(page, { width: 390, lanes: 5, empty: [2] });
    await page.locator('.lanes-body:not([hidden]) .probe').fill('sigue');
    await page.locator('.lanes-mode[data-view="side"]').click();
    await expect(page.locator('.lanes-lane').first().locator('.probe')).toHaveValue('sigue');
    // Desplegar el vacío.
    await page.locator('.lanes-unfold').click();
    await expect(page.locator('.lanes-mini')).toHaveCount(0);
    expect(await log(page)).toContain('select:c2');
    // Principal al desplazar.
    await page.evaluate(() => { const t = document.querySelector<HTMLElement>('.lanes-track')!; t.scrollTo({ left: 0 }); });
    await page.waitForTimeout(700);
    await page.evaluate(() => { const t = document.querySelector<HTMLElement>('.lanes-track')!; const last = t.querySelector<HTMLElement>('[data-lane="c4"]')!; t.scrollTo({ left: last.offsetLeft - t.offsetLeft }); });
    await expect.poll(async () => (await log(page)).at(-1), { timeout: 3000 }).toMatch(/^select:c[34]$/);
    await expect(page.locator('.lanes-lane[data-lane="c4"] .lanes-head, .lanes-lane[data-lane="c3"] .lanes-head').and(page.locator('[aria-current="true"]'))).toHaveCount(1);
  });

  test('pantalla ancha: lado a lado por defecto y 5 a 7 carriles a la vista; lo guardado manda', async ({ page }) => {
    await setup(page, { width: 1440, lanes: 9 });
    expect(await page.locator('.lanes').getAttribute('data-view')).toBe('side');
    const visible = await page.locator('.lanes-lane').evaluateAll((ns) => ns.filter((n) => { const r = n.getBoundingClientRect(); return r.right <= window.innerWidth + 1 && r.left >= 0; }).length);
    expect(visible).toBeGreaterThanOrEqual(5);
    expect(visible).toBeLessThanOrEqual(7);
    await setup(page, { width: 1440, lanes: 3, storage: 'tabs' });
    expect(await page.locator('.lanes').getAttribute('data-view')).toBe('tabs');
    // Con pocos carriles, llenan el ancho.
    await setup(page, { width: 1440, lanes: 3, storage: 'side' });
    const total = await page.locator('.lanes-lane').evaluateAll((ns) => ns.reduce((s, n) => s + n.getBoundingClientRect().width, 0));
    expect(total).toBeGreaterThan(1440 - 32 - 30);
  });

  test('ciclo de vida: setLanes limpia lo que sale, refresh vuelve a montar y destroy limpia todo', async ({ page }) => {
    await setup(page, { width: 1440, lanes: 3, storage: 'side' });
    expect(await log(page)).toEqual(['mount:c0', 'mount:c1', 'mount:c2']);
    await page.evaluate(() => { const w = window as any; w.lanes.setLanes(w.lanesSpec.slice(0, 2).map((l: any) => ({ ...l, count: 9 }))); });
    expect(await log(page)).toEqual(['mount:c0', 'mount:c1', 'mount:c2', 'clean:c2']);
    expect(await page.locator('.lanes-lane').first().locator('.lanes-count').textContent()).toBe('9');
    await page.evaluate(() => (window as any).lanes.refresh('c1'));
    await page.evaluate(() => (window as any).lanes.destroy());
    expect(await log(page)).toEqual(['mount:c0', 'mount:c1', 'mount:c2', 'clean:c2', 'clean:c1', 'mount:c1', 'clean:c0', 'clean:c1']);
    await expect(page.locator('.lanes')).toHaveCount(0);
  });

  test('temas: la pestaña elegida usa el acento del kit en claro y en oscuro', async ({ page }) => {
    await setup(page, { width: 390 });
    const colors = async () => page.locator('.lanes-tab[aria-selected="true"]').evaluate((t) => getComputedStyle(t).backgroundColor);
    const light = await colors();
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    const dark = await colors();
    expect(light).not.toBe(dark);
    expect(light).toBe('rgb(86, 102, 63)');
  });
});
