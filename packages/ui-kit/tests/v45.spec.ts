import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'playwright/test';

/**
 * Regla del 19-10-2026 (Core, tras el `inv-` que escondía «Validar» en Finance): las clases del kit no usan un prefijo
 * que ya use una app, ni al revés. El prefijo es lo que va antes del primer guion (`stk-row` → `stk`).
 * - **Kit:** clases de su CSS y las que pone su código (`class: '…'`, `classList.add/toggle/remove('…')`).
 * - **Apps:** clases de su CSS (también `<style>` en HTML) que el kit no define; las que sí define son retoques del kit.
 */
const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(pkg, '..', '..');

/**
 * Clases de app que ya compartían prefijo con el kit el 19-10-2026, con su motivo. No crecer: si un prefijo nuevo
 * choca, se cambia el nombre (en el kit, uno propio como `stk-`; en la app, el suyo).
 */
const KNOWN: Record<string, string> = {
  'date-actions': 'Booking, lista de fechas; el kit usa `date-` en el selector de fechas',
  'date-check': 'Booking, lista de fechas',
  'date-list': 'Booking, lista de fechas',
  'date-main': 'Booking, lista de fechas',
  'date-option': 'Booking, lista de fechas',
  'ikisai-kit': 'Tasks y Finance: contenedor al que acotan el CSS del kit; `ikisai-` es el espacio común, a propósito',
  'ikisai-legacy': 'Tasks: contenedor de lo antiguo frente a `.ikisai-kit`',
  'drop-child': 'Tasks, arrastrar en el taller; el kit usa `drop-before/after` en `sortable` y el árbol',
  'drop-project': 'Tasks, arrastrar en el taller',
  'space-item': 'Booking, lista de espacios; el kit usa `space-` en el árbol y el selector',
  'space-main': 'Booking, lista de espacios',
  'star-critical': 'Tasks, prioridad; excluye `.ikisai-kit`',
  'star-slot': 'Tasks, prioridad',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.') || name === 'test-results') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out); else out.push(full);
  }
  return out;
}

const cssClasses = (css: string) => new Set([...css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\([^)]*\)/g, '').replace(/"[^"]*"|'[^']*'/g, '')
  .matchAll(/\.(-?[a-zA-Z_][\w-]*)/g)].map((m) => m[1]!).filter((c) => !/^\d/.test(c)));

function kitClasses(): Set<string> {
  const out = new Set<string>();
  for (const f of walk(join(pkg, 'src'))) {
    const text = readFileSync(f, 'utf8');
    if (f.endsWith('.css')) cssClasses(text).forEach((c) => out.add(c));
    else if (f.endsWith('.ts')) {
      for (const m of text.matchAll(/class: '([^'$]*)'/g)) m[1]!.split(/\s+/).filter(Boolean).forEach((c) => out.add(c));
      for (const m of text.matchAll(/classList\.(?:add|toggle|remove)\(([^)]*)\)/g)) for (const s of m[1]!.matchAll(/'([\w-]+)'/g)) out.add(s[1]!);
    }
  }
  return out;
}

function appClasses(kit: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of walk(join(root, 'apps'))) {
    let css = '';
    if (f.endsWith('.css')) css = readFileSync(f, 'utf8');
    else if (f.endsWith('.html')) css = [...readFileSync(f, 'utf8').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
    for (const c of cssClasses(css)) if (!kit.has(c) && !out.has(c)) out.set(c, relative(root, f).replace(/\\/g, '/'));
  }
  return out;
}

const prefix = (c: string) => (c.includes('-') && !c.startsWith('-') ? c.split('-')[0]! : null);

test.describe('ui-kit · prefijos de clases: el kit y las apps no comparten', () => {
  test.beforeEach(({}, info) => { test.skip(info.project.name !== 'escritorio', 'lee archivos: una vez basta'); });

  test('@smoke ninguna clase de app empieza por un prefijo del kit (salvo las conocidas)', () => {
    const kit = kitClasses();
    const kitPrefixes = new Map<string, string>();
    for (const c of kit) { const p = prefix(c); if (p && !kitPrefixes.has(p)) kitPrefixes.set(p, c); }
    const apps = appClasses(kit);
    expect(kit.has('stk-row'), 'el kit se lee bien').toBe(true);
    expect(apps.size, 'las apps se leen bien').toBeGreaterThan(100);
    const clashes = [...apps].filter(([c]) => { const p = prefix(c); return p && kitPrefixes.has(p) && !KNOWN[c]; })
      .map(([c, file]) => `.${c} (${file}) comparte «${prefix(c)}-» con .${kitPrefixes.get(prefix(c)!)} del kit`);
    expect(clashes, 'cambia el prefijo de la clase nueva: en el kit uno propio, en la app el suyo').toEqual([]);
  });

  test('las conocidas siguen siendo de app y no las define el kit', () => {
    const kit = kitClasses();
    const apps = appClasses(kit);
    // Si una desaparece de la app, se quita de la lista; si el kit la define, ya es una colisión exacta.
    expect(Object.keys(KNOWN).filter((c) => kit.has(c))).toEqual([]);
    expect(Object.keys(KNOWN).filter((c) => !apps.has(c))).toEqual([]);
  });
});
