import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from 'playwright/test';
import { KIT_EN } from '../src/i18n/kit-en.ts';

const en = (spanish: string): string => {
  const entry = KIT_EN[spanish];
  if (entry === undefined) throw new Error(`Falta en KIT_EN: ${spanish}`);
  return typeof entry === 'string' ? entry : entry.other;
};

async function start(page: Page): Promise<void> {
  await page.goto('/#i18n');
  await page.evaluate(() => { localStorage.removeItem('ikisai-locale:demo-portal'); });
  await page.reload();
  await page.locator('#i18nStart').click();
}

test.describe('ui-kit v0.19 · idiomas: textos del kit', () => {
  test('todo kt(\'…\') del código tiene su traducción en KIT_EN', () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
    walk(join(dirname(fileURLToPath(import.meta.url)), '..', 'src'));
    const missing: string[] = [];
    let count = 0;
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\bkt\(\s*'((?:[^'\\]|\\.)*)'/g)) {
        count += 1;
        const key = m[1]!.replace(/\\'/g, "'");
        if (!(key in KIT_EN)) missing.push(`${file.split(/[\\/]src[\\/]/)[1]}: ${key}`);
      }
    }
    expect(count).toBeGreaterThan(100);
    expect(missing).toEqual([]);
    // Las variables se conservan en la traducción.
    const vars = (s: string) => new Set(s.match(/\{\w+\}/g) ?? []);
    for (const [key, value] of Object.entries(KIT_EN)) {
      const allowed = vars(key);
      allowed.add('{count}');
      for (const out of typeof value === 'string' ? [value] : Object.values(value)) {
        for (const v of vars(out ?? '')) expect(allowed.has(v), `${key} → ${out}`).toBe(true);
      }
    }
  });
});

test.describe('ui-kit v0.19 · idiomas en un portal (navegador en inglés)', () => {
  test.use({ locale: 'en-GB' });

  test('elige el idioma del navegador; t(), plurales, reserva, fechas, números y monedas con Intl', async ({ page }) => {
    await start(page);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
    await expect(page.locator('#i18nGreeting')).toHaveText('Hello, Ana');
    await expect(page.locator('#i18nNights')).toHaveText('1 night · 3 nights');
    await expect(page.locator('#i18nFallback')).toHaveText('Solo en español');
    await expect(page.locator('#i18nDate')).toHaveText('7 October 2026');
    await expect(page.locator('#i18nMoney')).toHaveText('€1,234.50');
    await expect(page.locator('#i18nNumber')).toHaveText('1,234,567.89');
  });

  test('los textos del kit siguen el idioma: diálogo, composer y lanzador', async ({ page }) => {
    await start(page);
    await page.locator('#i18nDialog').click();
    await expect(page.locator('.dialog')).toContainText(en('Cancelar'));
    await page.keyboard.press('Escape');
    await page.locator('#i18nComposer').click();
    await expect(page.locator('.fb-composer .fb-send')).toHaveText(en('Enviar'));
    await expect(page.locator('.fb-composer .fb-blocking')).toContainText(en('Me bloquea: no puedo seguir trabajando'));
    await page.keyboard.press('Escape');
    await page.locator('#demoLauncher').click();
    await expect(page.locator('.launcher-signal strong')).toContainText(en('Señalar para comentar'));
  });

  test('el formulario progresivo acepta textos por idioma y se repinta al cambiar', async ({ page }) => {
    await start(page);
    const form = page.locator('#fbPortal');
    await expect(form.locator('.fb-step-q').first()).toHaveText('What would you like to tell us about?');
    await expect(form.locator('.fb-choice', { hasText: 'A space' })).toBeVisible();
    await page.locator('#i18nSelect [data-locale="es"]').click();
    await expect(form.locator('.fb-step-q').first()).toHaveText('¿Sobre qué quieres comentarnos algo?');
    await expect(form.locator('.fb-choice', { hasText: 'Espacio' })).toBeVisible();
  });

  test('el cambio manual se recuerda en el dispositivo y repinta', async ({ page }) => {
    await start(page);
    await page.locator('#i18nSelect [data-locale="es"]').click();
    await expect(page.locator('#i18nGreeting')).toHaveText('Hola, Ana');
    await expect(page.locator('#i18nMoney')).toHaveText('1234,50 €');
    await expect(page.locator('#i18nSelect [data-locale="es"]')).toHaveAttribute('aria-checked', 'true');
    await page.reload();
    await page.locator('#i18nStart').click();
    await expect(page.locator('#i18nGreeting')).toHaveText('Hola, Ana');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('es');
  });
});

test.describe('ui-kit v0.19 · idiomas: las apps internas no cambian', () => {
  test('sin createI18n el kit sigue en español aunque el navegador esté en inglés', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'en-GB' });
    const page = await context.newPage();
    await page.goto('/#feedback');
    await page.locator('#fbOpen').click();
    await expect(page.locator('.fb-composer .fb-send')).toHaveText('Enviar');
    await context.close();
  });
});
