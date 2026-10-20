/**
 * Central · ayudantes de las pruebas de interfaz:
 * - medidas de accesibilidad en la página real (MUELA-086): contraste WCAG del texto de un elemento con el primer fondo
 *   opaco de sus antepasados, y la altura del objetivo táctil;
 * - abrir el cajón del menú lateral. Lo del feedback con el menú lo hace ya el kit (0.50, P11): `feedbackRoundTrip` y
 *   `setMode` de `packages/ui-kit/testing/feedback-smoke.ts`.
 */
import { expect, type Locator, type Page } from 'playwright/test';

/** Abre el cajón del menú con la marca. */
export async function openMenu(page: Page): Promise<Locator> {
  await page.locator('#appLauncher').click();
  const drawer = page.locator('#appMenu');
  await expect(drawer).toBeVisible();
  return drawer;
}

export async function contrastOf(target: Locator): Promise<number> {
  return target.evaluate((node: Element) => {
    type Rgb = { r: number; g: number; b: number; a: number };
    const parse = (value: string): Rgb | null => {
      const m = /rgba?\(([^)]+)\)/.exec(value);
      if (!m) return null;
      const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
      return { r: p[0]!, g: p[1]!, b: p[2]!, a: p[3] ?? 1 };
    };
    const lum = (c: Rgb) => {
      const f = (x: number) => { const v = x / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const fg = parse(getComputedStyle(node).color);
    if (!fg) throw new Error(`Color sin leer: ${getComputedStyle(node).color}`);
    let bg: Rgb | null = null;
    for (let at: Element | null = node; at && !bg; at = at.parentElement) {
      const c = parse(getComputedStyle(at).backgroundColor);
      if (c && c.a > 0.5) bg = c;
    }
    const [hi, lo] = [lum(fg), lum(bg ?? { r: 255, g: 255, b: 255, a: 1 })].sort((x, y) => y - x);
    return Math.round(((hi! + 0.05) / (lo! + 0.05)) * 100) / 100;
  });
}

export async function heightOf(target: Locator): Promise<number> {
  return (await target.boundingBox())?.height ?? 0;
}
