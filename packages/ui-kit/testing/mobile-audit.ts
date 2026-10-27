/**
 * Revisión móvil común para **todas las apps** (sale de la revisión a 390 px del 27-10,
 * `MUELA/equipo/feedback/ui-kit/REVISION_MOVIL_27-10.md`). Mide la pantalla que se ve, sin tocar nada:
 * - `desborde`: la página es más ancha que la pantalla, o algo sobresale fuera de un contenedor con scroll propio;
 * - `toque`: botón, enlace, pestaña, casilla o desplegable de menos de 44 px en algún lado (con su etiqueta, en las casillas);
 * - `cortado`: texto con elipsis o recortado que no cabe (no cuenta lo escondido para el lector: `.vh` y cajas de 1 px);
 * - `contraste` (con `dark: true`): texto por debajo de WCAG AA (4,5:1; 3:1 si es grande), contra su primer fondo opaco.
 *
 *   import { mobileAudit, formatFindings } from '../../packages/ui-kit/testing/mobile-audit.ts';
 *   test('Inicio a 390 px sin desborde ni toques pequeños @smoke', async ({ page }) => {
 *     await page.setViewportSize({ width: 390, height: 844 });
 *     await login(page);
 *     const found = await mobileAudit(page, { kinds: ['desborde', 'toque'] });
 *     expect(found, formatFindings(found)).toEqual([]);
 *   });
 *
 * `ignore` quita lo que la app acepta a sabiendas (selectores CSS: `ignore: ['.year-barlabel']`).
 */
import type { Page } from 'playwright/test';

export type MobileFindingKind = 'desborde' | 'toque' | 'cortado' | 'contraste';

export interface MobileFinding {
  kind: MobileFindingKind;
  /** `[data-feedback-id="…"]` si lo tiene; si no, etiqueta, id y dos clases. */
  sel: string;
  text: string;
  detail: string;
}

export interface MobileAuditOptions {
  /** Qué medir; por defecto, todo. */
  kinds?: MobileFindingKind[];
  /** Medir el contraste en oscuro (cambia `prefers-color-scheme` y lo devuelve a claro). Por defecto, sí si se pide `contraste`. */
  dark?: boolean;
  /** Selectores que no cuentan (lo que la app acepta a sabiendas). */
  ignore?: string[];
  /** Lado mínimo de un objetivo de toque; por defecto, 44 px. */
  minTarget?: number;
}

const ALL: MobileFindingKind[] = ['desborde', 'toque', 'cortado', 'contraste'];

export async function mobileAudit(page: Page, options: MobileAuditOptions = {}): Promise<MobileFinding[]> {
  const kinds = options.kinds ?? ALL;
  const ignore = options.ignore ?? [];
  const min = options.minTarget ?? 44;
  const out: MobileFinding[] = [];
  const light = kinds.filter((k) => k !== 'contraste');
  if (light.length) out.push(...await page.evaluate(measure, { dark: false, kinds: light, ignore, min }));
  if (kinds.includes('contraste') && options.dark !== false) {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(300);
    out.push(...await page.evaluate(measure, { dark: true, kinds: ['contraste'], ignore, min }));
    await page.emulateMedia({ colorScheme: 'light' });
  }
  return out;
}

/** Una línea por hallazgo, para el mensaje de `expect`. */
export function formatFindings(found: MobileFinding[]): string {
  return found.map((f) => `${f.kind} · ${f.sel}${f.text ? ` «${f.text}»` : ''} · ${f.detail}`).join('\n');
}

function measure(args: { dark: boolean; kinds: string[]; ignore: string[]; min: number }): MobileFinding[] {
  const { dark, kinds, ignore, min } = args;
  const out: MobileFinding[] = [];
  const vw = innerWidth;
  const ignored = (n: Element) => ignore.some((s) => { try { return !!n.closest(s); } catch { return false; } });
  const sel = (n: Element) => {
    const id = (n as HTMLElement).id ? `#${(n as HTMLElement).id}` : '';
    const fb = n.getAttribute('data-feedback-id');
    const cls = [...n.classList].slice(0, 2).map((c) => `.${c}`).join('');
    return fb ? `[data-feedback-id="${fb}"]` : `${n.tagName.toLowerCase()}${id}${cls}`;
  };
  const txt = (n: Element) => ((n as HTMLElement).innerText || n.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 50);
  const shown = (n: Element) => {
    const r = n.getBoundingClientRect();
    const s = getComputedStyle(n);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && (n as HTMLElement).checkVisibility?.() !== false && !ignored(n);
  };
  // Lo escondido para el lector (`.vh` y parecidos): 1 px o recortado con `clip`.
  const srOnly = (n: Element) => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n); return (r.width <= 1 && r.height <= 1) || (s.position === 'absolute' && s.clip !== 'auto' && s.clip !== ''); };
  if (!dark) {
    if (kinds.includes('desborde')) {
      const over = document.documentElement.scrollWidth - vw;
      if (over > 1) out.push({ kind: 'desborde', sel: 'html', text: '', detail: `la página mide ${document.documentElement.scrollWidth} px (+${over})` });
      const inScroller = (n: Element) => {
        for (let p = n.parentElement; p; p = p.parentElement) {
          if (p === document.body || p === document.documentElement) return false;
          if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX)) return true;
        }
        return false;
      };
      for (const n of document.body.querySelectorAll('*')) {
        if (!shown(n)) continue;
        const r = n.getBoundingClientRect();
        if (r.right > vw + 1 && r.width < vw * 3 && !inScroller(n) && getComputedStyle(n).position !== 'fixed') out.push({ kind: 'desborde', sel: sel(n), text: txt(n), detail: `llega a ${Math.round(r.right)} px` });
      }
    }
    if (kinds.includes('toque')) {
      for (const n of document.querySelectorAll('button, a[href], input[type=checkbox], input[type=radio], select, summary, [role=button], [role=tab], [role=switch], [role=menuitem]')) {
        if (!shown(n) || srOnly(n) || (n as HTMLElement).closest('[inert],[aria-hidden="true"]')) continue;
        // Un enlace dentro de un párrafo es texto, no un botón.
        if (n.tagName === 'A' && n.closest('p, .hint, small') && !n.getAttribute('class')) continue;
        const r = n.getBoundingClientRect();
        let w = r.width;
        let h = r.height;
        const labels = (n as HTMLInputElement).labels;
        if (labels && labels.length) { const l = labels[0]!.getBoundingClientRect(); w = Math.max(w, l.width); h = Math.max(h, l.height); }
        if (w < min - 0.5 || h < min - 0.5) out.push({ kind: 'toque', sel: sel(n), text: txt(n), detail: `${Math.round(w)}×${Math.round(h)} px` });
      }
    }
    if (kinds.includes('cortado')) {
      for (const n of document.body.querySelectorAll('*')) {
        if (!shown(n) || srOnly(n) || !n.childNodes.length) continue;
        const s = getComputedStyle(n);
        const el = n as HTMLElement;
        const cut = (s.textOverflow === 'ellipsis' || /(hidden|clip)/.test(s.overflowX)) && el.clientWidth > 1 && el.scrollWidth > el.clientWidth + 1;
        const hasText = [...n.childNodes].some((c) => c.nodeType === 3 && (c.textContent ?? '').trim());
        if (cut && hasText) out.push({ kind: 'cortado', sel: sel(n), text: txt(n), detail: `${el.scrollWidth} px en ${el.clientWidth}` });
      }
    }
    return out;
  }
  // `color(srgb …)` (color-mix y similares) viene en 0–1; rgb() en 0–255.
  const parse = (c: string) => {
    const srgb = /^color\(srgb/.test(c);
    const m = (c.replace(/^color\(srgb/, '').match(/[\d.]+/g) ?? ['0', '0', '0', '1']).map(Number);
    const k = srgb ? 255 : 1;
    return { r: m[0]! * k, g: m[1]! * k, b: m[2]! * k, a: m[3] ?? 1 };
  };
  const lum = (c: { r: number; g: number; b: number }) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const bgOf = (n: Element) => {
    for (let p: Element | null = n; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      // Sobre una imagen o un degradado no se puede saber: no se mide.
      if (s.backgroundImage !== 'none') return null;
      const c = parse(s.backgroundColor);
      if (c.a > 0.95) return c;
    }
    return parse(getComputedStyle(document.body).backgroundColor);
  };
  const seen = new Set<string>();
  for (const n of document.body.querySelectorAll('*')) {
    if (!shown(n) || srOnly(n)) continue;
    const own = [...n.childNodes].filter((c) => c.nodeType === 3 && (c.textContent ?? '').trim()).map((c) => (c.textContent ?? '').trim()).join(' ');
    if (!own) continue;
    const s = getComputedStyle(n);
    const fg = parse(s.color);
    if (fg.a < 0.3) continue;
    const bg = bgOf(n);
    if (!bg) continue;
    const mix = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
    const a = lum(mix);
    const b = lum(bg);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const size = parseFloat(s.fontSize);
    const bold = Number(s.fontWeight) >= 700;
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    const key = `${s.color}|${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)}`;
    if (ratio < need && !seen.has(key)) {
      seen.add(key);
      out.push({ kind: 'contraste', sel: sel(n), text: own.slice(0, 50), detail: `${ratio.toFixed(2)}:1 (pide ${need}) · ${s.color} sobre rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})` });
    }
  }
  return out;
}
