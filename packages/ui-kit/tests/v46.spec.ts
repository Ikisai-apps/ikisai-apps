import { expect, test } from 'playwright/test';
import { sameValue } from '../src/sync/conflict.ts';

/** Tanda 26 (revisión de MUELA-075): conflictos, aviso con «Deshacer» y contraste del tema claro. */
test.describe('ui-kit v0.41 · conflictos', () => {
  test('@smoke compara por contenido: listas y objetos iguales no cuentan como cambio', () => {
    expect(sameValue(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameValue({ city: 'Jaén', zip: '23001' }, { zip: '23001', city: 'Jaén' })).toBe(true);
    expect(sameValue([{ a: 1 }], [{ a: 1 }])).toBe(true);
    expect(sameValue(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameValue([], {})).toBe(false);
    expect(sameValue(null, {})).toBe(false);
    expect(sameValue(Number.NaN, Number.NaN)).toBe(true);
  });

  test('@smoke la principal es «Reintentar con lo mío», va primero, y la tabla no enseña lo que no cambió', async ({ page }) => {
    await page.goto('/#conflicts');
    const card = page.locator('#conflictHost [data-request-id="req-1"]');
    const buttons = card.locator('.choices > button');
    await expect(buttons.first()).toHaveAttribute('data-choice', 'mine');
    await expect(card.locator('[data-choice="mine"]')).toHaveClass(/primary/);
    await expect(card.locator('[data-choice="theirs"]')).not.toHaveClass(/primary/);
    await expect(card.locator('.primary')).toHaveCount(1);
    // La muestra lleva `tags` (lista) y `address` (objeto, otro orden) iguales en las dos versiones.
    await card.locator('[data-choice="diff"]').click();
    await expect(card.locator('tbody tr')).toHaveCount(3);
    await expect(card.locator('tbody th', { hasText: /tags|address/ })).toHaveCount(0);
  });
});

test.describe('ui-kit v0.41 · aviso con acción', () => {
  test('@smoke el botón mide al menos 46 px y al pulsarlo hace la acción y se va', async ({ page }) => {
    await page.goto('/#status');
    await page.evaluate(() => {
      const k = (window as unknown as { ikisaiKit: { toastWithAction: (m: string, a: { label: string; onClick(): void }) => void } }).ikisaiKit;
      k.toastWithAction('Tarea completada', { label: 'Deshacer', onClick: () => { document.body.dataset.undone = '1'; } });
    });
    const button = page.locator('.toast.show').getByRole('button', { name: 'Deshacer' });
    await expect(button).toBeVisible();
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(46);
    await button.click();
    await expect.poll(() => page.evaluate(() => document.body.dataset.undone)).toBe('1');
    await expect(page.locator('.toast.show')).toHaveCount(0);
  });

  test('@smoke un aviso posterior no quita «Deshacer»: se apila, cada uno con su tiempo', async ({ page }) => {
    await page.goto('/#status');
    await page.evaluate(() => {
      const k = (window as unknown as { ikisaiKit: { toast: (m: string, ms?: number) => void; toastWithAction: (m: string, a: { label: string; onClick(): void }, ms?: number) => void } }).ikisaiKit;
      k.toastWithAction('Borrada la tarea', { label: 'Deshacer', onClick: () => { document.body.dataset.undone = 'tarea'; } }, 4000);
      k.toast('Guardado', 800);
    });
    const box = page.locator('.toast.show');
    await expect(box).toContainText('Borrada la tarea');
    await expect(box).toContainText('Guardado');
    await expect(box.locator('.toast-item')).toHaveCount(2);
    // El simple se va a su tiempo; «Deshacer» sigue.
    await expect(box).not.toContainText('Guardado');
    await expect(box.getByRole('button', { name: 'Deshacer' })).toBeVisible();
    await expect(box.locator('.toast-item')).toHaveCount(0);

    // Dos con acción: cada botón deshace lo suyo y el otro se queda.
    await page.evaluate(() => {
      const k = (window as unknown as { ikisaiKit: { toastWithAction: (m: string, a: { label: string; onClick(): void }, ms?: number) => void } }).ikisaiKit;
      k.toastWithAction('Archivado el proyecto', { label: 'Deshacer', onClick: () => { document.body.dataset.undone = 'proyecto'; } }, 6000);
    });
    await expect(box.getByRole('button', { name: 'Deshacer' })).toHaveCount(2);
    await box.locator('.toast-item', { hasText: 'Archivado el proyecto' }).getByRole('button').click();
    await expect.poll(() => page.evaluate(() => document.body.dataset.undone)).toBe('proyecto');
    await expect(box).toContainText('Borrada la tarea');
    await expect(box.getByRole('button', { name: 'Deshacer' })).toHaveCount(1);
  });

  test('un aviso simple sigue sustituyendo al anterior simple, y hideToast quita todo', async ({ page }) => {
    await page.goto('/#status');
    await page.evaluate(() => {
      const k = (window as unknown as { ikisaiKit: { toast: (m: string) => void } }).ikisaiKit;
      k.toast('Primero');
      k.toast('Segundo');
    });
    await expect(page.locator('.toast.show')).toHaveText('Segundo');
    await page.evaluate(() => {
      const k = (window as unknown as { ikisaiKit: { toastWithAction: (m: string, a: { label: string; onClick(): void }) => void; hideToast: () => void } }).ikisaiKit;
      k.toastWithAction('Con acción', { label: 'Deshacer', onClick: () => undefined });
      k.hideToast();
    });
    await expect(page.locator('.toast.show')).toHaveCount(0);
  });
});

test.describe('ui-kit v0.41 · contraste (WCAG AA, 4,5:1)', () => {
  test('@smoke texto secundario y chips «ok» y «alerta» en claro y oscuro', async ({ page }) => {
    await page.goto('/#status');
    for (const theme of ['light', 'dark']) {
      const ratios = await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
        const css = getComputedStyle(document.documentElement);
        const probe = document.createElement('span');
        document.body.append(probe);
        const toRgb = (v: string) => { probe.style.color = v; return getComputedStyle(probe).color.match(/[\d.]+/g)!.slice(0, 3).map(Number); };
        const lum = (c: number[]) => { const [r, g, b] = c.map((x) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
        const ratio = (a: string, b: string) => { const la = lum(toRgb(css.getPropertyValue(a))), lb = lum(toRgb(css.getPropertyValue(b))); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
        const out = {
          'muted/bg': ratio('--muted', '--bg'), 'muted/paper': ratio('--muted', '--paper'), 'muted/paper-2': ratio('--muted', '--paper-2'),
          'ok/ok-soft': ratio('--ok', '--ok-soft'), 'alert/alert-soft': ratio('--alert', '--alert-soft'),
        };
        probe.remove();
        return out;
      }, theme);
      for (const [pair, value] of Object.entries(ratios)) expect(value, `${theme} ${pair}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
