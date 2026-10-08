/**
 * Organizers · «Ayuda y sugerencias» y uso: los `data-feedback-id` tienen la forma estable `organizers.<pantalla>.<sección>.<elemento>`
 * (minúsculas, sin acentos, sin identificadores de negocio), van con su etiqueta, y el catálogo de la publicación los recoge
 * todos (ninguno se construye en ejecución). Comprobación estática del código fuente.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../apps/organizers/src');
const PATTERN = /^organizers(\.[a-z0-9_]+){1,4}$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Cadenas `organizers.…` que no son ids de feedback: claves de los textos comunes de Central. */
const NOT_IDS = new Set(['organizers.declaration']);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sources(full) : full.endsWith('.ts') ? [full] : [];
  });
}

function collect(): Array<{ id: string; file: string; line: number }> {
  const found: Array<{ id: string; file: string; line: number }> = [];
  for (const file of sources(path.join(SRC, 'ui'))) {
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');
    const rel = path.relative(SRC, file).replaceAll('\\', '/');
    for (const match of text.matchAll(/(['"`])(organizers\.[^'"`\n]*)\1/g)) {
      if (NOT_IDS.has(match[2]!)) continue;
      found.push({ id: match[2]!, file: rel, line: text.slice(0, match.index).split('\n').length });
    }
  }
  return found;
}

test('organizers · todos los ids cumplen el patrón, son literales y no llevan uuids', () => {
  const found = collect();
  assert.ok(found.length >= 40, `se esperaban bastantes ids y hay ${found.length}`);
  const bad: string[] = [];
  for (const { id, file, line } of found) {
    if (id.includes('${')) bad.push(`${file}:${line} «${id}» se construye en ejecución`);
    else if (!PATTERN.test(id)) bad.push(`${file}:${line} «${id}» no cumple ${PATTERN}`);
    if (UUID.test(id)) bad.push(`${file}:${line} «${id}» lleva un uuid`);
  }
  assert.deepEqual(bad, []);
});

test('organizers · cada data-feedback-id escrito en un el(...) lleva su data-feedback-label', () => {
  const bad: string[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, 'utf8');
    const ids = (text.match(/'data-feedback-id':/g) ?? []).length;
    const labels = (text.match(/'data-feedback-label':/g) ?? []).length;
    if (ids !== labels) bad.push(`${path.relative(SRC, file)}: ${ids} data-feedback-id y ${labels} data-feedback-label`);
  }
  assert.deepEqual(bad, []);
});

test('organizers · la raíz de cada id es una pantalla conocida', () => {
  const roots = new Set(collect().map((f) => f.id.split('.')[1]));
  const allowed = new Set(['entrada', 'retiros', 'retiro', 'fechas', 'asistentes', 'asistente', 'cocina', 'ayuda', 'acceso', 'cabecera']);
  assert.deepEqual([...roots].filter((root) => !allowed.has(root!)), []);
});

test('organizers · el catálogo de la publicación recoge todos los ids con su etiqueta', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'organizers-catalog-'));
  try {
    const out = path.join(dir, 'feature-catalog.json');
    const repo = path.resolve(here, '../..');
    execFileSync(process.execPath, [path.join(repo, 'packages/ui-kit/scripts/feature-catalog.mjs'), '--app', 'organizers', '--root', repo, '--out', out], { cwd: repo, stdio: 'pipe' });
    const catalog = JSON.parse(readFileSync(out, 'utf8')) as { features: Array<{ id: string; label: string | null }>; dynamic: unknown[] };
    assert.deepEqual(catalog.dynamic, []);
    assert.ok(catalog.features.length >= 30, `hay ${catalog.features.length} funciones`);
    assert.deepEqual(catalog.features.filter((f) => !f.label).map((f) => f.id), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
