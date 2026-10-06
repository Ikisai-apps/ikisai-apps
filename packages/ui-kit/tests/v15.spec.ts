import { expect, test } from 'playwright/test';

test.describe('ui-kit v0.11.1', () => {
  test('openSheet acepta ganchos en el fondo, el panel y el botón de cerrar, y cierra al momento con force', async ({ page }) => {
    await page.goto('/#overlays');
    const result = await page.evaluate(async () => {
      const kit = (window as any).ikisaiKit;
      const sheet = kit.openSheet({ title: 'Prueba', body: kit.el('p', null, 'Hola'), backAttrs: { id: 'sheetBack' }, panelAttrs: { id: 'sheet' }, closeAttrs: { id: 'closeDialog' } });
      const ids = ['sheetBack', 'sheet', 'closeDialog'].map((id) => document.getElementById(id)?.className ?? null);
      const showBefore = document.getElementById('sheetBack')!.classList.contains('show');
      void sheet.close(true);
      const goneNow = !document.getElementById('sheetBack');
      return { ids, showBefore, goneNow };
    });
    expect(result.ids[0]).toContain('sheetback');
    expect(result.ids[1]).toContain('sheet');
    expect(result.ids[2]).toContain('iconbtn');
    expect(result.showBefore).toBe(true);
    expect(result.goneNow).toBe(true);
    await page.evaluate(() => { const kit = (window as any).ikisaiKit; kit.openSheet({ title: 'Otra', body: 'x', closeAttrs: { id: 'closeDialog' } }); });
    await page.locator('#closeDialog').click();
    await expect(page.locator('.sheetback')).toHaveCount(0);
  });
});

test.describe('ui-kit v0.11.2', () => {
  test('hideTitle deja el título solo para lectores y bodyAttrs pone ganchos y clases en el cuerpo desplazable', async ({ page }) => {
    await page.goto('/#overlays');
    const r = await page.evaluate(() => {
      const kit = (window as any).ikisaiKit;
      const long = Array.from({ length: 60 }, (_, i) => kit.el('p', null, `Línea ${i}`));
      const sheet = kit.openSheet({ title: 'Áreas de trabajo', hideTitle: true, body: [kit.el('h2', { class: 'sheettitle' }, 'Áreas de trabajo'), ...long], bodyAttrs: { id: 'sheet', class: 'ikisai-legacy' } });
      const body = document.getElementById('sheet')!;
      body.scrollTop = 200;
      const head = sheet.panel.querySelector('.sheet-head h2') as HTMLElement;
      return { bodyClass: body.className, scrolls: body.scrollTop > 0, titleHidden: head.classList.contains('vh'), labelled: sheet.panel.getAttribute('aria-labelledby') === head.id, notitle: sheet.panel.classList.contains('notitle'), closeTop: (sheet.panel.querySelector('.sheet-head') as HTMLElement).getBoundingClientRect().top - sheet.panel.getBoundingClientRect().top };
    });
    expect(r.bodyClass).toBe('sheet-body ikisai-legacy');
    expect(r.scrolls).toBe(true);
    expect(r.titleHidden).toBe(true);
    expect(r.labelled).toBe(true);
    expect(r.notitle).toBe(true);
    expect(r.closeTop).toBeLessThan(20);
  });
});

test.describe('ui-kit v0.12', () => {
  test('renderProposalReview devuelve cuerpo y pie para la hoja de la app; openProposalReview pasa los atributos de la hoja', async ({ page }) => {
    await page.goto('/#agents');
    const r = await page.evaluate(async () => {
      const kit = (window as any).ikisaiKit;
      const proposal = { id: 'x', agent: 'Asistente', status: 'pending', createdAt: new Date().toISOString(), affected: 2 };
      const changes = [{ op: 'update', table: 'tarea', tablePlural: 'tareas', title: 'Uno' }, { op: 'update', table: 'tarea', tablePlural: 'tareas', title: 'Dos' }];
      let approved = 0;
      const parts = kit.renderProposalReview({ proposal, changes, onApprove: () => { approved++; }, approveAttrs: { id: 'approveProposal' } });
      const host = document.createElement('div'); host.append(parts.body, parts.foot); document.body.append(host);
      (document.getElementById('approveProposal') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
      const readOnly = kit.renderProposalReview({ proposal: { ...proposal, status: 'consumed' }, changes, onApprove: () => {} });
      host.remove();
      const sheet = kit.openProposalReview({ proposal, changes, onApprove: () => {}, sheet: { panelAttrs: { id: 'reviewPanel' }, closeAttrs: { id: 'reviewClose' } } });
      const ids = [!!document.getElementById('reviewPanel'), !!document.getElementById('reviewClose'), sheet.foot?.querySelectorAll('button').length];
      await sheet.close(true);
      return { footClass: parts.foot.className, approved, readOnlyFoot: readOnly.foot, ids };
    });
    expect(r.footClass).toBe('proposalreview-foot');
    expect(r.approved).toBe(1);
    expect(r.readOnlyFoot).toBeNull();
    expect(r.ids).toEqual([true, true, 1]);
  });

  test('la paleta admite otro límite sin consulta y montarse en un contenedor', async ({ page }) => {
    await page.goto('/#agents');
    const r = await page.evaluate(() => {
      const kit = (window as any).ikisaiKit;
      const host = document.createElement('div'); host.id = 'paletteHost'; document.body.append(host);
      const items = Array.from({ length: 30 }, (_, i) => ({ group: 'Ir a', text: `Elemento ${i}`, run: () => {} }));
      const palette = kit.createCommandPalette({ items: () => items, limit: 16, limitWhenEmpty: 18, hotkey: false, container: () => host });
      palette.open();
      const empty = document.querySelectorAll('#paletteHost #palette .palette-item').length;
      const input = document.getElementById('paletteInput') as HTMLInputElement;
      input.value = 'elemento'; input.dispatchEvent(new Event('input'));
      const query = document.querySelectorAll('#palette .palette-item').length;
      palette.close();
      return { empty, query };
    });
    expect(r).toEqual({ empty: 18, query: 16 });
  });
});

test('la paleta resalta una sola fila: la seleccionada, que sigue al ratón', async ({ page }) => {
  await page.goto('/#agents');
  await page.evaluate(() => {
    const kit = (window as any).ikisaiKit;
    const items = Array.from({ length: 6 }, (_, i) => ({ group: 'Ir a', text: `Elemento ${i}`, run: () => {} }));
    kit.createCommandPalette({ items: () => items, hotkey: false }).open();
  });
  const rows = page.locator('#palette .palette-item');
  await rows.nth(3).hover();
  await expect(page.locator('#palette .palette-item.on')).toHaveCount(1);
  await expect(rows.nth(3)).toHaveClass(/on/);
  await page.keyboard.press('ArrowDown');
  const highlighted = await rows.evaluateAll((nodes) => nodes.filter((n) => getComputedStyle(n).backgroundColor !== 'rgba(0, 0, 0, 0)').length);
  expect(highlighted).toBe(1);
  await expect(rows.nth(4)).toHaveClass(/on/);
});
