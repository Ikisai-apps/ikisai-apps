import { expect, test } from 'playwright/test';
import { shouldAutoApply } from '../src/sync/updates.ts';

/** Versiones nuevas automáticas al abrir (petición del usuario; mismo criterio que Tasks). */
test.describe('ui-kit v0.23 · versiones nuevas al abrir', () => {
  test('se aplica sola solo al abrir, antes de tocar nada y si es seguro', () => {
    const base = { autoApply: true, openedAt: 1_000, now: 5_000, windowMs: 15_000, interacted: false, safe: true };
    expect(shouldAutoApply(base)).toBe(true);
    expect(shouldAutoApply({ ...base, safe: false })).toBe(false);          // cola, conflicto, editor abierto o fallo de sync
    expect(shouldAutoApply({ ...base, interacted: true })).toBe(false);     // ya está usando la app
    expect(shouldAutoApply({ ...base, now: 1_000 + 15_001 })).toBe(false);  // fuera de la ventana: queda el aviso
    expect(shouldAutoApply({ ...base, autoApply: false })).toBe(false);
  });

  /** Monta un service worker falso con una versión esperando y arranca `initAppUpdates`. */
  async function run(page: import('playwright/test').Page, opts: { safe: boolean; touchFirst?: boolean }) {
    await page.goto('/#tokens');
    return page.evaluate(async ({ safe, touchFirst }) => {
      const posted: string[] = [];
      let announced = 0;
      const listeners: Record<string, ((e: unknown) => void)[]> = {};
      const waiting = { postMessage: (m: { type: string }) => posted.push(m.type) };
      const registration = { waiting, installing: null, addEventListener: () => undefined, update: async () => undefined };
      const fakeSw = {
        controller: {},
        register: async () => registration,
        addEventListener: (name: string, fn: (e: unknown) => void) => { (listeners[name] ??= []).push(fn); },
      };
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: fakeSw });
      window.addEventListener('ikisai:update-available', () => { announced += 1; });
      (window as any).ikisaiKit.initAppUpdates({ isSafe: () => safe, checkEveryMs: 3_600_000 });
      // La persona ya está tocando la app cuando se descubre la versión (el registro del SW es asíncrono).
      if (touchFirst) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      await new Promise((r) => setTimeout(r, 200));
      return { posted, announced };
    }, opts);
  }

  test('al abrir con versión esperando y seguro, se aplica sola', async ({ page }) => {
    const r = await run(page, { safe: true });
    expect(r.posted).toContain('APPLY_UPDATE');
    expect(r.announced).toBe(0);
    await expect(page.locator('.toast.show')).toContainText('Actualizando a la versión nueva');
  });

  test('si no es seguro, no se aplica: queda el aviso «Nueva versión disponible»', async ({ page }) => {
    const r = await run(page, { safe: false });
    expect(r.posted).toEqual([]);
    expect(r.announced).toBeGreaterThan(0);
  });

  test('si ya se ha tocado la app, no recarga: queda el aviso', async ({ page }) => {
    const r = await run(page, { safe: true, touchFirst: true });
    expect(r.posted).toEqual([]);
    expect(r.announced).toBeGreaterThan(0);
  });
});
