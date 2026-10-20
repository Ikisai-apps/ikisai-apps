import { expect, test } from 'playwright/test';

/** Tanda 35: ajustes que piden Central y Food (sin cambio de diseño). */
const contrast = `(() => {
  const rgb = (c) => (c.match(/[\\d.]+/g) || []).map(Number);
  const lum = (c) => [c[0], c[1], c[2]].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
  return (a, b) => { const x = lum(rgb(a)); const y = lum(rgb(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
})()`;

test.describe('ui-kit v0.53 · ajustes de Central y Food', () => {
  test('@smoke medallón con color de equipo: las iniciales llegan a 4,5:1 (el fondo se oscurece si hace falta)', async ({ page }) => {
    await page.goto('/#pieces');
    const ratios = await page.evaluate((src) => {
      const ratio = eval(src) as (a: string, b: string) => number;
      const kit = (window as any).ikisaiKit;
      const host = document.createElement('div');
      document.body.append(host);
      const out = ['#c4712f', '#b7791f', '#3f6d8e', '#f2d16b', '#7a7a7a'].map((color) => {
        const m = kit.renderMedal({ name: 'Equipo Cocina', color });
        host.append(m);
        const s = getComputedStyle(m);
        return { color, r: ratio(s.backgroundColor, s.color) };
      });
      host.remove();
      return out;
    }, contrast);
    for (const { color, r } of ratios) expect(r, color).toBeGreaterThanOrEqual(4.5);
    // Un color que ya llega no cambia.
    expect(await page.evaluate(() => (window as any).ikisaiKit.readableColor('#3f6d8e'))).toEqual({ color: '#3f6d8e', ink: '#ffffff' });
  });

  test('@smoke `.filterchip` mide 46 px (chips de `renderGroups`)', async ({ page }) => {
    await page.goto('/#pieces');
    const h = await page.evaluate(() => {
      const kit = (window as any).ikisaiKit;
      const view = kit.renderGroups({ label: 'Pagos', chips: true, row: () => kit.el('li', null, 'x'), toneOf: (x: string) => x, groups: [{ key: 'a', title: 'A', items: ['alert'] }] });
      document.body.append(view.element);
      return [...view.element.querySelectorAll('.filterchip')].map((b: Element) => b.getBoundingClientRect().height);
    });
    expect(h.length).toBeGreaterThan(0);
    for (const x of h) expect(x).toBeGreaterThanOrEqual(46);
  });

  test('@smoke los azulejos del menú no parten palabras («Obligaciones»)', async ({ page }) => {
    await page.goto('/#tokens');
    await page.evaluate(() => { document.querySelector('#app')!.setAttribute('hidden', ''); scrollTo(0, 0); (window as any).ikisaiMenuDemo(); });
    await page.locator('#appLauncher').click();
    const tile = page.locator('.appmenu-drawer .appmenu-tiletext', { hasText: 'Obligaciones' });
    await expect(tile).toBeVisible();
    // Una sola línea para una sola palabra, y sin desbordar el azulejo.
    const box = await tile.evaluate((n) => { const lh = parseFloat(getComputedStyle(n).lineHeight); const tileBox = n.closest('.appmenu-tile')!.getBoundingClientRect(); const r = n.getBoundingClientRect(); return { lines: Math.round(r.height / lh), inside: r.left >= tileBox.left - 0.5 && r.right <= tileBox.right + 0.5 }; });
    expect(box.lines).toBe(1);
    expect(box.inside).toBe(true);
  });

  test('@smoke `renderGroups` con `tail`: la cola plegada al final, sin contar para el grupo', async ({ page }) => {
    await page.goto('/#pieces');
    await page.evaluate(() => {
      const kit = (window as any).ikisaiKit;
      const view = kit.renderGroups({ label: 'Accesos', feedbackId: 'central.accesos', row: (x: string) => kit.el('li', null, x), toneOf: () => null,
        groups: [{ key: 'staff', title: 'Staff', items: ['Ana', 'Luis'], open: true, tail: { label: 'Revocados', items: ['Marta'] } }] });
      view.element.id = 'tailHost';
      document.body.prepend(view.element);
    });
    const group = page.locator('#tailHost .worst-group');
    await expect(group.locator('.worst-head .worst-count')).toHaveText('2');
    const tail = group.locator('.worst-tail');
    await expect(tail).not.toHaveAttribute('open', '');
    await expect(tail.getByText('Marta')).toBeHidden();
    const head = tail.locator('.worst-tailhead');
    await expect(head).toHaveText(/Revocados\s*1/);
    await expect(head).toHaveAttribute('data-feedback-id', 'central.accesos.cola');
    expect((await head.boundingBox())!.height).toBeGreaterThanOrEqual(46);
    await head.click();
    await expect(tail.getByText('Marta')).toBeVisible();
  });

  test('@smoke Food: ruta corta del sitio, foco con «Ver en la Despensa» y su acción, `focusAction` y `setFilter` sin guardar', async ({ page }) => {
    await page.goto('/#inventory');
    // Ruta corta: el padre y el sitio; colgando de una altura, solo el sitio.
    expect(await page.evaluate(() => { const k = (window as any).ikisaiKit; const rows = k.demoSpaces(); return [k.spaceShortPath(rows, 'despensa'), k.spaceShortPath(rows, 'albergue'), k.spaceShortPath(rows, 'nada')]; }))
      .toEqual(['Cocina › Despensa', 'Albergue', '']);
    // Foco: el texto de abrir lo pone la app, y una acción más.
    const log = await page.evaluate(() => {
      const k = (window as any).ikisaiKit;
      const out: string[] = [];
      const f = k.createFocus({ items: [{ id: 'aceite', title: 'Aceite de oliva', kicker: 'Bajo mínimo' }], openLabel: 'Ver en la Despensa', onOpen: (i: { id: string }) => out.push(`open:${i.id}`), action: { label: 'A la compra', onClick: (i: { id: string }) => out.push(`buy:${i.id}`) } });
      f.element.id = 'focusFood';
      document.body.prepend(f.element);
      (window as any).focusLog = out;
      return [...f.element.querySelectorAll('.focus-actions button')].map((b: Element) => b.textContent);
    });
    expect(log).toEqual(['A la compra', 'Ver en la Despensa']);
    await page.locator('#focusFood').getByRole('button', { name: 'Ver en la Despensa' }).click();
    await page.locator('#focusFood').getByRole('button', { name: 'A la compra' }).click();
    expect(await page.evaluate(() => (window as any).focusLog)).toEqual(['open:aceite', 'buy:aceite']);
    // Catálogo: «A la compra» primero y destacado en lo que está bajo mínimo; en lo demás, no.
    const tiles = page.locator('#invTiles');
    const low = tiles.locator('.stk-tilecell[data-item-id="harina-espelta"] .stk-tileactions button');
    await expect(low.first()).toHaveAccessibleName('A la compra: Harina de espelta');
    await expect(low.first()).toHaveClass(/softbtn/);
    await expect(tiles.locator('.stk-tilecell[data-item-id="harina-trigo"]').getByRole('button', { name: /A la compra/ })).toHaveCount(0);
    // `persist: false`: el filtro que llega por enlace no pisa el guardado.
    const stored = await page.evaluate(() => {
      const c = (window as any).invTiles;
      c.setFilter({ low: true }, { persist: false });
      const a = localStorage.getItem('ikisai-inventory:demo-despensa');
      const shown = document.querySelectorAll('#invTiles .stk-tilecell').length;
      c.setFilter({});
      const b = localStorage.getItem('ikisai-inventory:demo-despensa');
      return { a, b, shown };
    });
    expect(stored.a).toBeNull();
    expect(stored.b).toBe('{}');
    expect(stored.shown).toBeGreaterThan(0);
  });
  test('@smoke `FocusItem.openLabel`: el texto de abrir por tarjeta, y si no, el de la pieza', async ({ page }) => {
    await page.goto('/#pieces');
    const texts = await page.evaluate(() => {
      const k = (window as any).ikisaiKit;
      const f = k.createFocus({ openLabel: 'Ver en la Despensa', onOpen: () => undefined,
        items: [{ id: 'a', title: 'Lentejas', openLabel: 'Confirmar consumo' }, { id: 'b', title: 'Aceite' }] });
      document.body.prepend(f.element);
      const first = f.element.querySelector('.focus-actions button:not(.focus-next)')!.textContent;
      f.next();
      const second = f.element.querySelector('.focus-actions button:not(.focus-next)')!.textContent;
      return [first, second];
    });
    expect(texts).toEqual(['Confirmar consumo', 'Ver en la Despensa']);
  });
});
