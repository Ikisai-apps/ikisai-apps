#!/usr/bin/env node
/**
 * Flow · importa las representaciones gráficas de los productos (decisión de VG del 26-10-2026) a
 * `apps/flow/public/assets/<categoria>/<slug>/{icono.svg, medallon.svg, miniatura.webp, zoom.webp}`.
 *
 * Uso: node apps/flow/scripts/assets.mjs "<carpeta con assets_manifest.json>" [--chrome <ruta de chrome.exe>]
 *
 * - Lee `assets_manifest.json` (id, nombre, categoria, icono, medallon, miniatura, zoom) y deriva la clave de imagen
 *   `image_key` = `<categoria>/<slug>` de la ruta del icono (`assets/montaditos/serrano/icono.svg` → `montaditos/serrano`).
 * - Los SVG pasan por el mismo saneado que Central (`apps/central/src/app/svg-plan.ts`: DOMPurify, perfil SVG, fuera los
 *   enlaces externos y el CSS activo) y se rechazan si aún llevan contenido activo.
 * - Los PNG se convierten a webp bajando la calidad hasta caber en el presupuesto (miniatura ≤ 40 KB, zoom ≤ 150 KB).
 * - Al final imprime el mapeo `nombre → image_key` para la semilla o una migración. No toca la base de datos.
 * Usa Chrome (Playwright) para el DOM y el codificador webp: es una herramienta local, no de la CI.
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../..');
const OUT = path.resolve(here, '../public/assets');
const BUDGET = { miniatura: 40 * 1024, zoom: 150 * 1024 };
const SIZE = { miniatura: 480, zoom: 1000 };

const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith('--'));
const chromeAt = args.includes('--chrome') ? args[args.indexOf('--chrome') + 1] : 'C:/Program Files/Google/Chrome/Application/chrome.exe';
if (!source) { console.error('Uso: node apps/flow/scripts/assets.mjs "<carpeta con assets_manifest.json>"'); process.exit(1); }
const manifest = JSON.parse(readFileSync(path.join(source, 'assets_manifest.json'), 'utf8'));

const KEY = /^assets\/([a-z0-9-]+)\/([a-z0-9-]+)\/[^/]+$/;
const browser = await chromium.launch(existsSync(chromeAt) ? { executablePath: chromeAt } : {});
const page = await browser.newPage();
await page.setContent('<!doctype html><html><body></body></html>');
await page.addScriptTag({ path: path.join(ROOT, 'node_modules/dompurify/dist/purify.min.js') });

/** Saneado de Central, en el navegador. Devuelve el SVG limpio o null. */
async function cleanSvg(text) {
  return page.evaluate((text) => {
    const ACTIVE_LINK = /(?:java|vb)script\s*:|data\s*:\s*text\/html|expression\s*\(|@import/i;
    const flat = (v) => v.replace(/&#x?[0-9a-f]+;?|[\t\n\r]/gi, '');
    const active = (t0) => {
      const t = t0.replace(/<!--[\s\S]*?-->/g, '');
      return /<\s*(?:[a-z0-9_-]+:)?(?:script|foreignObject|iframe|embed|object)\b/i.test(t) || /[\s"'/]on[a-z]+\s*=/i.test(t)
        || /(?:java|vb)script\s*:|data\s*:\s*text\/html/i.test(flat(t)) || /<!ENTITY/i.test(t);
    };
    const fragment = window.DOMPurify.sanitize(text, { USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM_FRAGMENT: true });
    const svg = [...fragment.children].find((c) => c.localName === 'svg');
    if (!svg) return null;
    for (const node of [svg, ...svg.querySelectorAll('*')]) {
      if (node.localName === 'style' && ACTIVE_LINK.test(flat(node.textContent ?? ''))) { node.remove(); continue; }
      for (const attr of [...node.attributes]) {
        const value = flat(attr.value);
        const isLink = attr.localName === 'href';
        if ((!attr.namespaceURI && attr.name.includes(':')) || ACTIVE_LINK.test(value)
          || (isLink && !value.trim().startsWith('#') && !/^data:image\/(?:png|jpe?g|gif|webp);/i.test(value.trim()))) node.removeAttributeNode(attr);
      }
    }
    const out = new XMLSerializer().serializeToString(svg);
    return active(out) ? null : out;
  }, text);
}

/** PNG/JPEG → webp de como mucho `max` px de ancho, bajando la calidad hasta caber en `budget` bytes. */
async function toWebp(file, max, budget) {
  const mime = file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  const dataUrl = `data:${mime};base64,${readFileSync(file).toString('base64')}`;
  for (const quality of [0.82, 0.74, 0.66, 0.58, 0.5, 0.42]) {
    const b64 = await page.evaluate(async ({ dataUrl, max, quality }) => {
      const img = new Image(); img.src = dataUrl; await img.decode();
      const scale = Math.min(1, max / img.naturalWidth);
      const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/webp', quality).split(',')[1];
    }, { dataUrl, max, quality });
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length <= budget) return bytes;
  }
  throw new Error(`${path.basename(file)} no cabe en ${Math.round(budget / 1024)} KB ni con la calidad más baja`);
}

const mapping = [];
let failed = 0;
for (const item of manifest) {
  const m = String(item.icono ?? '').match(KEY);
  if (!m) { console.error(`✖ ${item.id}: no se puede derivar la clave de «${item.icono}»`); failed++; continue; }
  const key = `${m[1]}/${m[2]}`;
  const dir = path.join(OUT, m[1], m[2]);
  mkdirSync(dir, { recursive: true });
  try {
    for (const kind of ['icono', 'medallon']) {
      const clean = await cleanSvg(readFileSync(path.join(source, item[kind]), 'utf8'));
      if (!clean) throw new Error(`${kind}.svg con contenido activo o ilegible`);
      writeFileSync(path.join(dir, `${kind}.svg`), clean);
    }
    for (const kind of ['miniatura', 'zoom']) {
      const bytes = await toWebp(path.join(source, item[kind]), SIZE[kind], BUDGET[kind]);
      writeFileSync(path.join(dir, `${kind}.webp`), bytes);
    }
    mapping.push({ id: item.id, nombre: item.nombre, image_key: key, estado: item.estado ?? null });
    console.log(`✔ ${item.nombre} → ${key}`);
  } catch (error) {
    console.error(`✖ ${item.id}: ${error.message}`);
    failed++;
  }
}
await browser.close();
console.log(JSON.stringify(mapping, null, 2));
process.exit(failed ? 1 : 0);
