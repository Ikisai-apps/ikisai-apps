import { expect, test } from 'playwright/test';
import { qrMatrix } from '../src/print/qr.ts';
import { readQr } from './qr-read.ts';

/** Petición de Booking (visión V0.2): QR de entrada de visitantes para imprimir, sin red ni dependencias. */
test.describe('ui-kit v0.60 · renderQr', () => {
  test('se lee de vuelta: nivel M, síndromes RS a cero y el mismo texto, de 1 a 213 bytes', () => {
    const cases = ['A', 'https://ven.ikisai.com/e/AB12CD', 'https://ven.ikisai.com/e/ABCDEFGHJK?utm=imprimir-cartel-2026', 'Café · Ñandú ✓', 'x'.repeat(100), 'y'.repeat(150), 'z'.repeat(213)];
    const versions = cases.map((text) => {
      const r = readQr(qrMatrix(text));
      expect(r).toMatchObject({ ecl: 'M', syndromesOk: true, text });
      return r.version;
    });
    expect(versions).toEqual([1, 3, 4, 2, 6, 8, 10]);
    expect(() => qrMatrix('w'.repeat(214))).toThrow(/no cabe/);
  });

  test('patrones fijos: módulo oscuro, dos copias del formato iguales e información de versión de la norma (7 a 10)', () => {
    const VERSION_BITS: Record<number, number> = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };
    for (const n of [130, 150, 180, 213]) {
      const m = qrMatrix('q'.repeat(n));
      const size = m.length;
      const version = (size - 17) / 4;
      let top = 0; let left = 0;
      for (let i = 0; i < 18; i++) {
        if (m[Math.floor(i / 3)]![size - 11 + (i % 3)]) top |= 1 << i;
        if (m[size - 11 + (i % 3)]![Math.floor(i / 3)]) left |= 1 << i;
      }
      expect([top, left]).toEqual([VERSION_BITS[version], VERSION_BITS[version]]);
      const first: [number, number][] = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
      let f1 = 0; let f2 = 0;
      first.forEach(([x, y], i) => { if (m[y]![x]) f1 |= 1 << i; });
      for (let i = 0; i < 8; i++) if (m[8]![size - 1 - i]) f2 |= 1 << i;
      for (let i = 8; i < 15; i++) if (m[size - 15 + i]![8]) f2 |= 1 << i;
      expect(f1).toBe(f2);
      expect(m[size - 8]![8]).toBe(true);
    }
  });

  test('@smoke el SVG: negro sobre blanco también en oscuro, role="img", aria-label, tamaño y margen; se lee desde el dibujo', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    const text = 'https://ven.ikisai.com/e/AB12CD';
    const out = await page.evaluate((text) => {
      const K = (window as any).ikisaiKit;
      const svg = K.renderQr(text, { size: 200, label: 'QR de entrada de visitantes' }) as SVGSVGElement;
      const plain = K.renderQr('A') as SVGSVGElement;
      document.body.append(svg);
      const rect = svg.getBoundingClientRect();
      return {
        role: svg.getAttribute('role'), label: svg.getAttribute('aria-label'), plainLabel: plain.getAttribute('aria-label'),
        viewBox: svg.getAttribute('viewBox'), plainBox: plain.getAttribute('viewBox'), w: Math.round(rect.width), h: Math.round(rect.height),
        bg: getComputedStyle(svg.querySelector('rect')!).fill, ink: getComputedStyle(svg.querySelector('path')!).fill,
        d: svg.querySelector('path')!.getAttribute('d'),
      };
    }, text);
    expect(out).toMatchObject({ role: 'img', label: 'QR de entrada de visitantes', plainLabel: 'A', viewBox: '0 0 37 37', plainBox: '0 0 29 29', w: 200, h: 200, bg: 'rgb(255, 255, 255)', ink: 'rgb(0, 0, 0)' });
    // Del dibujo a la matriz (margen 4) y al texto.
    const size = 37 - 8;
    const m = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
    for (const [, x, y] of out.d!.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) m[Number(y) - 4]![Number(x) - 4] = true;
    expect(readQr(m)).toMatchObject({ text, version: 3, syndromesOk: true });
  });
});
