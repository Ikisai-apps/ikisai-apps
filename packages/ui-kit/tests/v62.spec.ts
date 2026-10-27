import { expect, test } from 'playwright/test';

/** Tanda 41 (peticiones K1, K2 y K3 de Tasks): la cifra elegida, la barra inferior en la app instalada y «Mis reportes». */
test.describe('ui-kit v0.58 · cifra elegida, barra en la app instalada y «Mis reportes»', () => {
  test('@smoke K1: con `selected`, aria-pressed en todas las cifras con botón y la marca en la elegida', async ({ page }) => {
    await page.goto('/');
    const out = await page.evaluate(() => {
      const K = (window as any).ikisaiKit;
      const noop = () => undefined;
      const row = K.renderStats([
        { value: 5, label: 'Pedidas', onClick: noop, selected: true },
        { value: 2, label: 'Aprobadas', onClick: noop, selected: false },
        { value: 1, label: 'Compradas', onClick: noop },
        { value: 9, label: 'Sin botón' },
      ]);
      const plain = K.renderStats([{ value: 1, label: 'Una', onClick: noop }]);
      document.body.append(row);
      const items = [...row.querySelectorAll('.stat-item')] as HTMLElement[];
      return {
        pressed: items.map((b) => b.getAttribute('aria-pressed')),
        selected: items.map((b) => b.classList.contains('stat-selected')),
        shadow: getComputedStyle(items[0]!).boxShadow,
        plain: plain.querySelector('.stat-item')!.hasAttribute('aria-pressed'),
      };
    });
    expect(out.pressed).toEqual(['true', 'false', 'false', null]);
    expect(out.selected).toEqual([true, false, false, false]);
    expect(out.shadow).toContain('inset');
    expect(out.plain).toBe(false);
  });

  test('K2: en la app instalada la barra se esconde al bajar, vuelve al subir y con el foco, y mueve --tabbar-offset', async ({ page }) => {
    // Playwright no emula `display-mode`: se simula la app instalada en matchMedia, que es lo que mira el vigilante.
    await page.addInitScript(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = ((q: string) => (q.includes('display-mode: standalone') ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : real(q))) as typeof window.matchMedia;
    });
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/');
    await page.evaluate(() => {
      const K = (window as any).ikisaiKit;
      document.body.append(K.el('div', { id: 'k2Tall', style: 'height:4000px' }));
      document.body.append(K.renderTabBar({ label: 'Vistas', standalone: 'both', attrs: { id: 'k2Bar' }, items: [{ label: 'Inicio', icon: 'home', active: true }, { label: 'Tareas', icon: 'tasks' }] }));
    });
    const bar = page.locator('#k2Bar');
    await expect(bar).toHaveClass(/tabbar-flush/);
    await expect(bar).toHaveClass(/tabbar-autohide/);
    const offset = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--tabbar-offset'));

    await page.evaluate(() => window.scrollTo(0, 50));
    await page.evaluate(() => window.scrollTo(0, 600));
    await expect(bar).toHaveClass(/tabbar-hidden/);
    expect(await offset()).toBe('0px');

    await page.evaluate(() => window.scrollTo(0, 500));
    await expect(bar).not.toHaveClass(/tabbar-hidden/);
    expect(await offset()).toMatch(/^\d+px$/);
    expect(await offset()).not.toBe('0px');

    await page.evaluate(() => window.scrollTo(0, 1200));
    await expect(bar).toHaveClass(/tabbar-hidden/);
    await page.evaluate(() => (document.querySelector('#k2Bar button') as HTMLElement).focus());
    await expect(bar).not.toHaveClass(/tabbar-hidden/);

    // Al final de la página, a la vista.
    await page.evaluate(() => window.scrollTo(0, 1600));
    await expect(bar).toHaveClass(/tabbar-hidden/);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(bar).not.toHaveClass(/tabbar-hidden/);
  });

  test('K2: en el navegador (sin app instalada) la barra no se esconde', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/');
    await page.evaluate(() => {
      const K = (window as any).ikisaiKit;
      document.body.append(K.el('div', { style: 'height:4000px' }));
      document.body.append(K.renderTabBar({ label: 'Vistas', standalone: 'both', attrs: { id: 'k2Web' }, items: [{ label: 'Inicio', icon: 'home', active: true }] }));
    });
    await page.evaluate(() => window.scrollTo(0, 50));
    await page.evaluate(() => window.scrollTo(0, 900));
    await page.waitForTimeout(150);
    await expect(page.locator('#k2Web')).not.toHaveClass(/tabbar-hidden/);
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--tabbar-offset'))).toBe('');
  });

  test('K3: `scope: \'mine\'` abre «Mis reportes» con tres vistas y pide solo lo de quien mira', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      const K = (window as any).ikisaiKit;
      const calls: string[] = [];
      (window as any).k3Calls = calls;
      const api = async (path: string) => { calls.push(path); return { items: [] }; };
      K.openFeedbackCenter({ api, app: 'tasks', scope: 'mine' });
    });
    const sheet = page.locator('.sheet').last();
    await expect(sheet.locator('.sheet-head')).toContainText('Mis reportes');
    const tabs = sheet.locator('.fb-tabs [role="tab"]');
    await expect(tabs).toHaveText(['Abiertos', 'Pendientes de verificar', 'Mis borradores']);
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    const calls = await page.evaluate(() => (window as any).k3Calls as string[]);
    expect(calls[0]).toContain('status=open');
    expect(calls.at(-1)).toContain('status=pending_verify');
    for (const c of calls) { expect(c).toContain('mine=true'); expect(c).toContain('app=tasks'); expect(c).not.toContain('/feedback/tree'); }
  });
});
