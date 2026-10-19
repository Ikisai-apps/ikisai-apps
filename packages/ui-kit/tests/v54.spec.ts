import { expect, test, type Page } from 'playwright/test';

/** Tanda 29: ajustes que piden las pasadas (Organizers, #623). */
const host = (page: Page) => page.evaluate(() => {
  document.querySelector('#app')!.setAttribute('hidden', '');
  const h = document.createElement('div');
  h.id = 't29';
  document.body.prepend(h);
});

test.describe('ui-kit v0.49 · ajustes de las pasadas', () => {
  test('@smoke portada con encabezado: h2 con id, botón dentro que cubre la portada', async ({ page }) => {
    await page.goto('/#tokens');
    await host(page);
    await page.evaluate(() => {
      const kit = (window as any).ikisaiKit;
      (window as any).opened = 0;
      document.getElementById('t29')!.append(kit.renderCover({ title: 'Yoga de otoño', headingLevel: 2, titleId: 'cv1', pill: 'Ahora', onOpen: () => { (window as any).opened += 1; } }));
    });
    const heading = page.getByRole('heading', { level: 2, name: 'Yoga de otoño' });
    await expect(heading).toHaveAttribute('id', 'cv1');
    await expect(page.locator('#t29 section.cover-box')).toHaveAttribute('aria-labelledby', 'cv1');
    await expect(heading.getByRole('button', { name: 'Yoga de otoño' })).toBeVisible();
    // Tocar en cualquier parte de la portada abre (el botón se estira).
    const box = (await page.locator('#t29 .cover-box').boundingBox())!;
    await page.mouse.click(box.x + box.width - 20, box.y + 20);
    expect(await page.evaluate(() => (window as any).opened)).toBe(1);
  });

  test('@smoke salir: traducible y, con `logoutOnMobile`, también en el móvil', async ({ page }, info) => {
    await page.goto('/#tokens');
    await host(page);
    await page.evaluate(() => {
      const kit = (window as any).ikisaiKit;
      kit.createAppShell(document.getElementById('t29'), { appName: 'Organizers', backNavigation: false, nav: [], onLogout: () => undefined, logoutOnMobile: true });
    });
    const btn = page.locator('#t29 #logoutButton');
    await expect(btn).toBeVisible();
    await expect(btn).not.toHaveClass(/desktop-only/);
    await page.evaluate(() => (window as any).ikisaiI18n.start().setLocale('en'));
    await page.evaluate(() => {
      const kit = (window as any).ikisaiKit;
      document.getElementById('t29')!.replaceChildren();
      kit.createAppShell(document.getElementById('t29'), { appName: 'Organizers', backNavigation: false, nav: [], onLogout: () => undefined });
    });
    await expect(page.locator('#t29 #logoutButton')).toHaveAttribute('aria-label', 'Sign out');
    await expect(page.locator('#t29 #logoutButton')).toHaveClass(/desktop-only/);
    if (info.project.name === 'movil') await expect(page.locator('#t29 #logoutButton')).toBeHidden();
  });

  test('@smoke `listRow`: Intro o Espacio sobre una acción no abren la fila', async ({ page }) => {
    await page.goto('/#tokens');
    await host(page);
    await page.evaluate(() => {
      const kit = (window as any).ikisaiKit;
      const w = window as any;
      w.rowOpened = 0; w.actionRan = 0;
      const ul = document.createElement('ul'); ul.className = 'list';
      ul.append(kit.listRow({ id: 'r', title: 'Fila', onClick: () => { w.rowOpened += 1; }, actions: [kit.el('button', { type: 'button', class: 'ghost small', id: 'rowAct', onclick: () => { w.actionRan += 1; } }, 'Recordar')] }));
      document.getElementById('t29')!.append(ul);
    });
    await page.locator('#rowAct').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press(' ');
    expect(await page.evaluate(() => [(window as any).rowOpened, (window as any).actionRan])).toEqual([0, 2]);
    await page.locator('#t29 .row').focus();
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => (window as any).rowOpened)).toBe(1);
  });

  test('@smoke `renderChecks`: la acción mide 46 px y lleva su nombre accesible', async ({ page }) => {
    await page.goto('/#tokens');
    await host(page);
    await page.evaluate(() => {
      const kit = (window as any).ikisaiKit;
      document.getElementById('t29')!.append(kit.renderChecks({ items: [
        { ok: false, text: 'Falta la fecha de Ana', action: { label: 'Rellenar', aria: 'Rellenar la fecha de Ana', onClick: () => undefined } },
        { ok: false, text: 'Falta la fecha de Luis', action: { label: 'Rellenar', aria: 'Rellenar la fecha de Luis', onClick: () => undefined } },
      ] }));
    });
    const ana = page.getByRole('button', { name: 'Rellenar la fecha de Ana' });
    await expect(ana).toHaveText('Rellenar');
    expect((await ana.boundingBox())!.height).toBeGreaterThanOrEqual(46);
    await expect(page.getByRole('button', { name: 'Rellenar la fecha de Luis' })).toBeVisible();
  });

  test('@smoke ids de feedback literales en grupos y pasos (los construidos ya no salen)', async ({ page }) => {
    await page.goto('/#tokens');
    await host(page);
    const ids = await page.evaluate(() => {
      const kit = (window as any).ikisaiKit;
      const t = document.getElementById('t29')!;
      t.append(kit.renderGroups({ label: 'Pagos', feedbackId: 'org.pagos', row: () => kit.el('li', null, 'x'), toneOf: () => null,
        groups: [{ key: 'a', title: 'Señal', items: [1], feedbackId: 'org.pagos.senal' }, { key: 'b', title: 'Saldo', items: [1] }] }).element);
      t.append(kit.renderSteps({ feedbackId: 'org.resumen', items: [{ id: 'datos', title: 'Datos', done: false, onClick: () => undefined, feedbackId: 'org.resumen.datos' }, { id: 'firma', title: 'Firma', done: false, onClick: () => undefined }] }));
      return [...t.querySelectorAll('[data-feedback-id]')].map((n) => n.getAttribute('data-feedback-id'));
    });
    expect(ids).toContain('org.pagos.senal');
    expect(ids).toContain('org.pagos.grupo');
    expect(ids).toContain('org.resumen.datos');
    expect(ids).not.toContain('org.resumen.firma');
  });

  test('@smoke `bindOnline`: varios botones comparten una sola línea de motivo', async ({ page }) => {
    await page.goto('/#tokens');
    await host(page);
    await page.evaluate(() => {
      const kit = (window as any).ikisaiKit;
      const w = window as any;
      w.net = 'online';
      const ls = new Set<(s: { network: string }) => void>();
      w.setNet = (n: string) => { w.net = n; ls.forEach((l) => l({ network: n })); };
      const client = { status: () => ({ network: w.net }), onStatus: (l: any) => { ls.add(l); return () => ls.delete(l); } };
      const line = kit.renderOfflineReason({ reason: 'Pagar y descargar necesitan conexión.' });
      const a = kit.el('button', { type: 'button', id: 'payBtn' }, 'Pagar');
      const b = kit.el('button', { type: 'button', id: 'pdfBtn' }, 'Descargar');
      document.getElementById('t29')!.append(a, b, line);
      kit.bindOnline(a, { client, line });
      kit.bindOnline(b, { client, line });
    });
    const line = page.locator('#t29 .offline-why');
    await expect(line).toHaveCount(1);
    await expect(line).toBeHidden();
    await page.evaluate(() => (window as any).setNet('offline'));
    await expect(line).toBeVisible();
    const id = await line.getAttribute('id');
    await expect(page.locator('#payBtn')).toHaveAttribute('aria-describedby', id!);
    await expect(page.locator('#pdfBtn')).toHaveAttribute('aria-describedby', id!);
    await expect(page.locator('#pdfBtn')).toHaveAttribute('aria-disabled', 'true');
    await page.evaluate(() => (window as any).setNet('online'));
    await expect(line).toBeHidden();
    await expect(page.locator('#t29 .offline-why')).toHaveCount(1);
  });

  test('@smoke extracto: «Cómo pagar» entre «Próximamente» y «Movimientos»', async ({ page }) => {
    await page.goto('/#tokens');
    await host(page);
    const order = await page.evaluate(() => {
      const kit = (window as any).ikisaiKit;
      const node = kit.renderMoneyBreakdown({ mode: 'statement', total: 100, upcoming: [{ label: 'Saldo', amount: 100 }], moves: [], afterUpcoming: kit.el('section', { class: 'howto' }, 'Cómo pagar') });
      document.getElementById('t29')!.append(node);
      return [...node.children].map((n: Element) => n.className || n.tagName);
    });
    expect(order.indexOf('howto')).toBe(2);
    expect(order[1]).toBe('mb-feed');
    expect(order[3]).toBe('mb-feed');
  });
});
