/**
 * Organizers · idiomas (API.md §13.1): cada texto `t('…')` y `L('…')` del código tiene su traducción inglesa en
 * `apps/organizers/src/app/i18n-en.ts`, con las mismas `{variables}`, y el diccionario no guarda claves que ya no se usan.
 * Comprobación estática del código fuente (el cambio de idioma en pantalla está en `portal.spec.ts`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EN } from '../../apps/organizers/src/app/i18n-en.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../apps/organizers/src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sources(full) : full.endsWith('.ts') && !full.endsWith('i18n-en.ts') ? [full] : [];
  });
}

function keys(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sources(SRC)) {
    // Sin comentarios: la documentación cita `t('…')` como ejemplo.
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const m of text.matchAll(/\b[tL]\(\s*'((?:[^'\\]|\\.)*)'/g)) found.set(m[1]!.replace(/\\'/g, "'"), path.relative(SRC, file));
  }
  return found;
}

const vars = (text: string) => [...text.matchAll(/\{([a-z_]+)\}/gi)].map((m) => m[1]).sort();

test('organizers · cada texto traducible tiene su versión inglesa', () => {
  const found = keys();
  assert.ok(found.size >= 200, `se esperaban muchos textos y hay ${found.size}`);
  const missing = [...found].filter(([key]) => !(key in EN)).map(([key, file]) => `${file}: «${key}»`);
  assert.deepEqual(missing, []);
});

test('organizers · las traducciones conservan las {variables}', () => {
  const bad: string[] = [];
  for (const [key, value] of Object.entries(EN)) {
    const text = typeof value === 'string' ? value : value.other;
    if (JSON.stringify(vars(key)) !== JSON.stringify(vars(text))) bad.push(`«${key}» → «${text}»`);
  }
  assert.deepEqual(bad, []);
});

test('organizers · el diccionario no guarda textos que ya no están en el código', () => {
  const found = keys();
  assert.deepEqual(Object.keys(EN).filter((key) => !found.has(key)), []);
});
