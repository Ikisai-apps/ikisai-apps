import { expect, test } from 'playwright/test';

/** Tanda 40 (MUELA-093 y 094, Food y Tasks): la pieza «envase», la baldosa con varios mandos y la estantería. */
test.describe('ui-kit v0.57 · envase, baldosa con varios mandos y estantería', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '.demo-head{position:static!important}'; document.head.append(s); }); });
    await page.goto('/#envase');
  });

  test('@smoke las cuentas: envases enteros del habitual, a granel lo justo, en unidades el entero, sin precio null', async ({ page }) => {
    const out = await page.evaluate(() => {
      const E = (window as any).ikisaiKit.Envase;
      const pick = (r: any) => ({ kind: r.kind, count: r.count, buy: Math.round(r.buy * 1000) / 1000, extra: Math.round(r.extra * 1000) / 1000, cost: r.cost === null ? null : Math.round(r.cost * 100) / 100, fmt: r.fmt?.label ?? null, buyText: E.buyText(r), extraText: E.extraText(r) });
      // Filas de `item_units` tal cual: `unit` es la etiqueta y `factor` el tamaño.
      const row = { id: 'u1', unit: 'paquete de 1 kg', factor: '1000', price: '1.20', usual: true };
      const harina = E.plan({ need: 4800, unit: 'g', formats: [row] });
      return {
        harina: pick(harina),
        source: harina.fmt.source === row,
        // Varios envases: manda el habitual, no el primero.
        habitual: pick(E.plan({ need: 1100, unit: 'g', formats: [{ unit: 'paquete de 1 kg', factor: 1000, price: 1.2 }, { unit: 'bolsa de 200 g', factor: 200, price: 0.5, usual: true }] })),
        // Sin precio del envase ni `perBase`: el coste es null, nunca 0.
        sinPrecio: pick(E.plan({ need: 5500, unit: 'ml', formats: [{ unit: 'brik de 1 l', factor: 1000, price: null }] })),
        precioCero: pick(E.plan({ need: 5500, unit: 'ml', formats: [{ unit: 'brik de 1 l', factor: 1000, price: 0 }] })),
        // A granel, lo justo y al precio medio.
        granel: pick(E.plan({ need: 750, unit: 'g', granel: true, perBase: 0.004 })),
        // En unidades sin envase, el entero: un resto de menos de uno no es sobra.
        limones: pick(E.plan({ need: 2.4, unit: 'unidad' })),
        // Sin envase ni granel: lo justo, sin precio.
        sin: pick(E.plan({ need: 1100, unit: 'g' })),
        // Nada que comprar.
        cero: pick(E.plan({ need: 0, unit: 'g', formats: [row] })),
        // Envase exacto: no sobra.
        justo: pick(E.plan({ need: 2000, unit: 'g', formats: [row] })),
      };
    });
    expect(out.harina).toEqual({ kind: 'envase', count: 5, buy: 5000, extra: 200, cost: 6, fmt: 'paquete de 1 kg', buyText: '5 paquetes de 1 kg', extraText: '200 g' });
    expect(out.source).toBe(true);
    expect(out.habitual).toMatchObject({ count: 6, buy: 1200, extra: 100, cost: 3, fmt: 'bolsa de 200 g', buyText: '6 bolsas de 200 g' });
    expect(out.sinPrecio).toMatchObject({ count: 6, cost: null, buyText: '6 briks de 1 l', extraText: '500 ml' });
    expect(out.precioCero.cost).toBeNull();
    expect(out.granel).toMatchObject({ kind: 'granel', buy: 750, extra: 0, cost: 3, extraText: null });
    expect(out.limones).toMatchObject({ kind: 'entero', buy: 3, buyText: '3 unidades', extraText: null, cost: null });
    expect(out.sin).toMatchObject({ kind: 'sin', buy: 1100, cost: null, buyText: '1,1 kg' });
    expect(out.cero).toMatchObject({ count: 0, buy: 0, extra: 0, cost: 0 });
    expect(out.justo).toMatchObject({ count: 2, extra: 0, extraText: null });
  });

  test('@smoke la frase accesible y el dibujo: role="img", «al almacén» en Tasks, «+N» con más de 6', async ({ page }) => {
    const out = await page.evaluate(() => {
      const E = (window as any).ikisaiKit.Envase;
      const harina = E.plan({ need: 4800, unit: 'g', formats: [{ unit: 'paquete de 1 kg', factor: 1000, usual: true }] });
      const leche = E.plan({ need: 5500, unit: 'ml', formats: [{ unit: 'brik de 1 l', factor: 1000 }], perishable: true });
      const lejia = E.plan({ need: 19000, unit: 'ml', formats: [{ unit: 'garrafa de 5 l', factor: 5000 }] });
      const muchos = E.plan({ need: 9, unit: 'kg', formats: [{ unit: 'bolsa de 1 kg', factor: 1 }] });
      const svg = E.draw(harina);
      const big = E.draw(muchos);
      return {
        harina: E.words(harina), leche: E.words(leche), lejia: E.words(lejia, { keep: 'al almacén' }),
        justo: E.words(E.plan({ need: 2000, unit: 'g', formats: [{ unit: 'paquete de 1 kg', factor: 1000 }] })),
        sin: E.words(E.plan({ need: 1100, unit: 'g' })),
        role: svg.getAttribute('role'), label: svg.getAttribute('aria-label'), drawn: svg.querySelectorAll('.ev-out').length,
        more: big.querySelector('.ev-more')?.textContent, bigDrawn: big.querySelectorAll('.ev-out').length,
        tube: E.tube(lejia, { keep: 'al almacén' }).getAttribute('aria-label'),
        legend: E.legend({ keep: 'al almacén' }).textContent,
      };
    });
    expect(out.harina).toBe('5 paquetes de 1 kg: se usa 4,8 kg y 200 g van a la Despensa.');
    expect(out.leche).toBe('6 briks de 1 l: se usa 5,5 l y 500 ml van a la Despensa (caduca pronto).');
    expect(out.lejia).toBe('4 garrafas de 5 l: se usa 19 l y 1 l van al almacén.');
    expect(out.justo).toBe('2 paquetes de 1 kg: se usa 2 kg, sin que sobre.');
    expect(out.sin).toBe('Sin envase: se compra lo justo, 1,1 kg.');
    expect(out.role).toBe('img');
    expect(out.label).toBe(out.harina);
    expect(out.drawn).toBe(5);
    expect(out.more).toBe('+4');
    expect(out.bigDrawn).toBe(5);
    expect(out.tube).toBe(out.lejia);
    expect(out.legend).toBe('Lo que se usaAl almacénAl almacén, caduca pronto');
    // En la demo, los dibujos tienen su nombre y no se repiten ids.
    await expect(page.locator('#envaseShelves').getByRole('img', { name: '5 paquetes de 1 kg: se usa 4,8 kg y 200 g van a la Despensa.' })).toBeVisible();
    const dup = await page.evaluate(() => { const ids = [...document.querySelectorAll('#envase [id], #evDefs [id]')].map((n) => n.id); const all = [...document.querySelectorAll('[id]')].map((n) => n.id); return { inside: ids.filter((x) => all.indexOf(x) !== all.lastIndexOf(x)), defs: document.querySelectorAll('#evDefs').length }; });
    expect(dup).toEqual({ inside: [], defs: 1 });
  });

  test('@smoke la hoja: el último ticket primero, sugerencias por familia, «Otro envase» sin cambiar los que hay y el foco de vuelta', async ({ page }) => {
    const shelves = page.locator('#envaseShelves');
    const lentejas = shelves.getByRole('button', { name: '¿Cómo se vende? Lentejas' });
    await lentejas.click();
    const sheet = page.getByRole('dialog', { name: '¿Cómo se vende lentejas?' });
    await expect(sheet).toBeVisible();
    const chips = sheet.locator('.fs-chip');
    await expect(chips.first()).toContainText('Como en el último ticket');
    await expect(chips.first()).toContainText('bolsa de 200 g · 3,40 € · Mercadona, 3 de octubre');
    await expect(chips.locator('b')).toContainText(['Como en el último ticket', 'bolsa de 250 g', 'paquete de 500 g', 'paquete de 1 kg', 'saco de 5 kg']);
    await chips.first().click();
    await expect(chips.first()).toHaveAttribute('aria-pressed', 'true');
    await expect(sheet.locator('.fs-preview p')).toHaveText('Hace falta 1,1 kg → compras 6 bolsas de 200 g · sobran 100 g');
    await expect(sheet.locator('.fs-preview svg')).toHaveAttribute('aria-label', '6 bolsas de 200 g: se usa 1,1 kg y 100 g van a la Despensa.');
    await sheet.getByRole('button', { name: 'Guardar en la Despensa' }).click();
    await expect(sheet).toBeHidden();
    await expect(page.locator('#envaseLog')).toHaveText('lentejas: bolsa de 200 g · nuevo · 1 envases');
    // La baldosa redondea al momento y el foco vuelve al dibujo.
    const changed = shelves.getByRole('button', { name: 'Cambiar el envase: Lentejas' });
    await expect(changed).toBeFocused();
    await expect(shelves.locator('.shelf-cell[data-shelf-key="lentejas"] .tile-value')).toHaveText('6 bolsas de 200 g');

  });

  test('@smoke «Otro envase» devuelve una fila nueva y no cambia el tamaño de la que había', async ({ page }) => {
    await page.evaluate(() => {
      const E = (window as any).ikisaiKit.Envase;
      const r = E.plan({ need: 4800, unit: 'g', formats: [{ id: 'u1', unit: 'paquete de 1 kg', factor: 1000, usual: true, price: 1.2 }] });
      E.formatSheet({ name: 'Harina', r, onSave: (f: any, all: any[]) => { (window as any).lastEnvase = { f: { label: f.label, size: f.size, isNew: f.isNew, usual: f.usual }, all: all.map((a) => ({ label: a.label, size: a.size, usual: a.usual, isNew: a.isNew, id: (a.source as any)?.id ?? null })) }; } });
    });
    const sheet = page.getByRole('dialog', { name: 'Envase de harina' });
    // El habitual sale marcado.
    await expect(sheet.locator('.fs-chip[aria-pressed="true"]')).toContainText('paquete de 1 kg');
    await expect(sheet.locator('.fs-chip[aria-pressed="true"]')).toContainText('el habitual');
    await sheet.getByText('Otro envase').click();
    await sheet.getByRole('combobox', { name: 'Tipo de envase' }).selectOption('saco');
    await sheet.getByRole('textbox', { name: 'Cuánto trae cada envase' }).fill('2');
    await sheet.getByRole('combobox', { name: 'Unidad' }).selectOption('kg');
    await expect(sheet.locator('.fs-preview p')).toHaveText('Hace falta 4,8 kg → compras 3 sacos de 2 kg · sobran 1,2 kg');
    await sheet.getByRole('button', { name: 'Guardar en la Despensa' }).click();
    await expect(sheet).toBeHidden();
    expect(await page.evaluate(() => (window as any).lastEnvase)).toEqual({
      f: { label: 'saco de 2 kg', size: 2000, isNew: true, usual: true },
      all: [{ label: 'paquete de 1 kg', size: 1000, usual: false, isNew: false, id: 'u1' }, { label: 'saco de 2 kg', size: 2000, usual: true, isNew: true, id: null }],
    });
  });

  test('@smoke la baldosa con varios mandos: sin botones anidados, 46 px sin crecer, carrito con aria-pressed y pulsación larga = «⋯»', async ({ page }) => {
    const shelves = page.locator('#envaseShelves');
    expect(await shelves.locator('button button').count()).toBe(0);
    const cell = shelves.locator('.shelf-cell[data-shelf-key="harina"]');
    const more = cell.getByRole('button', { name: 'Más: Harina' });
    const cart = cell.getByRole('button', { name: 'Marcar comprado: Harina' });
    for (const b of [more, cart]) {
      const box = (await b.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(46);
      expect(box.height).toBeGreaterThanOrEqual(46);
    }
    // El «⋯» va en la fila del medallón, a la izquierda del carrito, sin que la fila crezca.
    const [m, c, medal, title] = [(await more.boundingBox())!, (await cart.boundingBox())!, (await cell.locator('.medal-disc').first().boundingBox())!, (await cell.locator('.tile-title').boundingBox())!];
    expect(m.x + m.width).toBeLessThanOrEqual(c.x + 0.5);
    expect(Math.abs((m.y + m.height / 2) - (medal.y + medal.height / 2))).toBeLessThan(4);
    expect(Math.abs((c.y + c.height / 2) - (medal.y + medal.height / 2))).toBeLessThan(4);
    // El nombre, justo debajo del medallón: los 46 px no empujan nada.
    expect(title.y - (medal.y + medal.height)).toBeLessThanOrEqual(5);
    expect(title.y - (medal.y + medal.height)).toBeGreaterThanOrEqual(0);
    // Los mandos no se tapan entre sí.
    const media = (await cell.locator('.tile-media').boundingBox())!;
    expect(media.y).toBeGreaterThanOrEqual(m.y + m.height - 6.5);
    await expect(cart).toHaveAttribute('aria-pressed', 'false');
    await expect(more).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(cell.getByRole('button', { name: 'Cambiar el envase: Harina' })).toHaveAccessibleDescription('Mantén pulsado para más acciones');
    // Marcar: la baldosa dice «En el carro» y el dibujo deja de ser botón.
    await cart.click();
    const bought = cell.getByRole('button', { name: 'Quitar del carro: Harina' });
    await expect(bought).toHaveAttribute('aria-pressed', 'true');
    await expect(cell.locator('.tile-level')).toHaveText('En el carro');
    await expect(cell.locator('button.tile-media')).toHaveCount(0);
    await expect(cell.locator('.tile-media svg')).toHaveAttribute('role', 'img');
    await bought.click();
    await expect(cell.getByRole('button', { name: 'Marcar comprado: Harina' })).toHaveAttribute('aria-pressed', 'false');
    // Pulsación larga: la hoja del «⋯», y el clic de después no cambia el envase.
    const target = (await cell.locator('.tile-value').boundingBox())!;
    await page.mouse.move(target.x + 5, target.y + 5);
    await page.mouse.down();
    await page.waitForTimeout(650);
    await page.mouse.up();
    await expect(page.getByRole('dialog', { name: 'Harina' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Envase de harina' })).toHaveCount(0);
  });

  test('@smoke la estantería: «Mover a…» y Alt+↓ con el teclado, con anuncio, foco en su sitio y lo comprado sin mover', async ({ page }) => {
    const shelves = page.locator('#envaseShelves');
    const fruteria = shelves.getByRole('region', { name: 'Frutería Paqui' });
    const mercadona = shelves.getByRole('region', { name: 'Mercadona' });
    await expect(fruteria.getByRole('listitem')).toHaveCount(2);
    // Teclado: Alt+↓ desde el «⋯» lleva la baldosa a la fila de abajo y el foco la sigue.
    await mercadona.getByRole('button', { name: 'Más: Aceite' }).focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect(fruteria.getByRole('button', { name: 'Más: Aceite' })).toBeFocused();
    await expect(shelves.locator('[role="status"]')).toHaveText('Aceite: movido a Frutería Paqui.');
    await expect(page.locator('#envaseLog')).toHaveText('aceite: mercadona → fruteria');
    await expect(fruteria.locator('.shelf-cell[data-shelf-key="aceite"]')).toHaveAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
    // «Mover a…» desde el «⋯»: la lista de las demás filas.
    await fruteria.getByRole('button', { name: 'Más: Aceite' }).click();
    await page.getByRole('dialog', { name: 'Aceite' }).getByRole('button', { name: 'Mover a…' }).click();
    const move = page.getByRole('dialog', { name: 'Mover Aceite a otra tienda' });
    await expect(move.getByRole('button')).toContainText(['Mercadona']);
    await move.getByRole('button', { name: 'Mercadona' }).click();
    await expect(mercadona.locator('.shelf-cell[data-shelf-key="aceite"]')).toHaveCount(1);
    await expect(page.locator('#envaseLog')).toHaveText('aceite: fruteria → mercadona');
    // Lo comprado no se mueve: sin atajo ni destinos.
    await mercadona.getByRole('button', { name: 'Marcar comprado: Leche' }).click();
    const leche = mercadona.locator('.shelf-cell[data-shelf-key="leche"]');
    await expect(leche).toHaveAttribute('data-shelf-drag', '0');
    await expect(leche).not.toHaveAttribute('aria-keyshortcuts', /Alt/);
    await leche.getByRole('button', { name: 'Más: Leche' }).focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect(mercadona.locator('.shelf-cell[data-shelf-key="leche"]')).toHaveCount(1);
  });

  test('@smoke la estantería: arrastrar con el ratón a otra fila, con «Deshacer»', async ({ page }) => {
    // Las dos filas a la vista (en el móvil van una debajo de otra).
    await page.setViewportSize({ width: page.viewportSize()!.width, height: 1500 });
    await page.locator('#envaseShelves').scrollIntoViewIfNeeded();
    const shelves = page.locator('#envaseShelves');
    const from = (await shelves.locator('.shelf-cell[data-shelf-key="harina"] .tile-value').boundingBox())!;
    const to = (await shelves.getByRole('region', { name: 'Frutería Paqui' }).locator('.shelf-grid').boundingBox())!;
    await page.mouse.move(from.x + 5, from.y + 5);
    await page.mouse.down();
    await page.mouse.move(from.x + 30, from.y + 30, { steps: 4 });
    await expect(shelves.locator('.shelf-ghost')).toHaveCount(1);
    await page.mouse.move(to.x + 20, to.y + 20, { steps: 8 });
    await expect(shelves.getByRole('region', { name: 'Frutería Paqui' })).toHaveClass(/shelf-over/);
    await page.mouse.up();
    await expect(shelves.locator('.shelf-ghost')).toHaveCount(0);
    await expect(shelves.getByRole('region', { name: 'Frutería Paqui' }).locator('.shelf-cell[data-shelf-key="harina"]')).toHaveCount(1);
    await expect(page.locator('#envaseLog')).toHaveText('harina: mercadona → fruteria');
    // Soltar no abre la hoja del envase ni la del «⋯».
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.locator('.toast').getByRole('button', { name: 'Deshacer' }).click();
    await expect(shelves.getByRole('region', { name: 'Mercadona' }).locator('.shelf-cell[data-shelf-key="harina"]')).toHaveCount(1);
  });
  test('@smoke el asa de createSortableList mide 46 × 46 (MUELA-095)', async ({ page }) => {
    await page.goto('/#sortable');
    const handles = page.locator('.sortable-handle:visible');
    expect(await handles.count()).toBeGreaterThan(0);
    const box = (await handles.first().boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(46);
    expect(box.height).toBeGreaterThanOrEqual(46);
  });
});
