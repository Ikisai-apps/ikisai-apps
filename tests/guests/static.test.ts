/**
 * Guests · comprobaciones estáticas del código de la PWA:
 * - idiomas (API.md §9.10): español e inglés tienen las mismas claves y toda clave que usa el código existe;
 * - «Ayuda y sugerencias» y uso (§9.11): los `data-feedback-id` tienen la forma `guests.<pantalla>.<sección>.<elemento>`,
 *   son literales, llevan etiqueta y el catálogo de la publicación los recoge todos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../apps/guests/src');
const PATTERN = /^guests(\.[a-z0-9_]+){1,4}$/;
/** Cadenas `guests.…` que no son ids de feedback: claves de los textos de Central. */
const NOT_IDS = new Set(['guests.data_why', 'guests.signature_statement', 'guests.allergies_notice', 'guests.menu_notice']);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sources(full) : full.endsWith('.ts') ? [full] : [];
  });
}
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');

/** Claves de un diccionario (`'clave': …` al principio de línea). */
function dictionaryKeys(file: string): Set<string> {
  return new Set([...readFileSync(path.join(SRC, 'app', file), 'utf8').matchAll(/^\s+'([a-zA-Z0-9_.]+)':/gm)].map((m) => m[1]!));
}

test('guests · español e inglés tienen exactamente las mismas claves', () => {
  const es = dictionaryKeys('i18n-es.ts');
  const en = dictionaryKeys('i18n-en.ts');
  assert.ok(es.size > 200, `hay ${es.size} claves`);
  assert.deepEqual([...es].filter((k) => !en.has(k)), [], 'faltan en inglés');
  assert.deepEqual([...en].filter((k) => !es.has(k)), [], 'sobran en inglés');
});

test('guests · toda clave que usa el código existe (también las de catálogo construidas con prefijo)', async () => {
  const es = dictionaryKeys('i18n-es.ts');
  const used = new Set<string>();
  const prefixes = new Set<string>();
  for (const file of sources(SRC)) {
    if (file.includes('i18n')) continue;
    const text = strip(readFileSync(file, 'utf8'));
    for (const m of text.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) used.add(m[1]!);
    for (const m of text.matchAll(/\bt\(`([a-z]+(?:\.[a-z]+)*)\.\$\{/g)) prefixes.add(m[1]!);
    for (const m of text.matchAll(/'(help\.status\.[a-z]+)'/g)) used.add(m[1]!);
  }
  assert.deepEqual([...used].filter((k) => !es.has(k)), []);
  // Cada familia construida en ejecución (`t(\`field.${key}\`)`) tiene sus valores en el diccionario.
  const { KINSHIP_CODES } = await import('../../supabase/functions/_domain/booking/portal.ts');
  const families: Record<string, string[]> = {
    field: ['first_name', 'last_name_1', 'last_name_2', 'sex', 'birth_date', 'nationality', 'document_type', 'document_number', 'document_support_number',
      'residence_address', 'residence_postal_code', 'residence_city', 'residence_country', 'phone', 'email', 'is_minor', 'guardian_name', 'kinship'],
    missing: ['first_name', 'last_name_1', 'last_name_2', 'birth_date', 'document_type', 'document_number', 'document_support_number', 'residence_address',
      'residence_postal_code', 'residence_city', 'residence_country', 'contact', 'kinship'],
    kinship: Object.keys(KINSHIP_CODES),
    sex: ['H', 'M', 'X'], doc: ['DNI', 'NIE', 'Pasaporte', 'TIE', 'Otro'],
    diet: ['alergia', 'intolerancia', 'vegetariano', 'vegano', 'sin_gluten', 'sin_lactosa', 'preferencia', 'otra'], severity: ['leve', 'moderada', 'grave'],
    group: ['identity', 'document', 'residence', 'contact', 'minor'],
    page: ['inicio', 'datos', 'alimentacion', 'firma', 'info', 'programa', 'menu', 'alojamiento', 'materiales', 'preguntas', 'mas'],
    menu: ['desayuno', 'comida', 'cena', 'picnic', 'merienda', 'otro'],
    'help.event': ['schedule', 'organization', 'activities', 'communication', 'food', 'other'],
    'help.place': ['habitacion', 'comedor', 'sala', 'banos', 'exterior', 'piscina', 'otro'],
    'help.kind': ['damage', 'cleaning', 'missing', 'utilities', 'safety', 'other'],
    info: ['arrival', 'parking', 'facilities', 'rules', 'bring'],
  };
  assert.deepEqual([...prefixes].filter((p) => !(p in families)), [], 'familia sin lista en esta prueba');
  const missing = Object.entries(families).flatMap(([prefix, values]) => values.map((v) => `${prefix}.${v}`)).filter((k) => !es.has(k));
  assert.deepEqual(missing, []);
});

function collectIds(): Array<{ id: string; file: string; line: number }> {
  const found: Array<{ id: string; file: string; line: number }> = [];
  for (const file of sources(path.join(SRC, 'ui'))) {
    const text = strip(readFileSync(file, 'utf8'));
    const rel = path.relative(SRC, file).replaceAll('\\', '/');
    for (const match of text.matchAll(/(['"`])(guests\.[^'"`\n]*)\1/g)) {
      if (NOT_IDS.has(match[2]!)) continue;
      found.push({ id: match[2]!, file: rel, line: text.slice(0, match.index).split('\n').length });
    }
  }
  return found;
}

test('guests · todos los ids de feedback cumplen el patrón, son literales y no llevan uuids', () => {
  const found = collectIds();
  assert.ok(found.length >= 40, `se esperaban bastantes ids y hay ${found.length}`);
  const bad: string[] = [];
  for (const { id, file, line } of found) {
    if (id.includes('${')) bad.push(`${file}:${line} «${id}» se construye en ejecución`);
    else if (!PATTERN.test(id)) bad.push(`${file}:${line} «${id}» no cumple ${PATTERN}`);
    if (/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)) bad.push(`${file}:${line} «${id}» lleva un uuid`);
  }
  assert.deepEqual(bad, []);
});

test('guests · cada data-feedback-id escrito en un el(...) lleva su data-feedback-label', () => {
  const bad: string[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, 'utf8');
    const ids = (text.match(/'data-feedback-id':/g) ?? []).length;
    const labels = (text.match(/'data-feedback-label':/g) ?? []).length;
    if (ids !== labels) bad.push(`${path.relative(SRC, file)}: ${ids} data-feedback-id y ${labels} data-feedback-label`);
  }
  assert.deepEqual(bad, []);
});

test('guests · la raíz de cada id es una pantalla conocida', () => {
  const roots = new Set(collectIds().map((f) => f.id.split('.')[1]));
  const allowed = new Set(['entrada', 'aviso', 'inicio', 'datos', 'alimentacion', 'firma', 'info', 'ayuda', 'acceso', 'app', 'cuenta', 'cabecera',
    'navegacion', 'programa', 'menu', 'alojamiento', 'materiales', 'preguntas', 'mas']);
  assert.deepEqual([...roots].filter((root) => !allowed.has(root!)), []);
});

test('guests · el catálogo de la publicación recoge todos los ids con su etiqueta', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'guests-catalog-'));
  try {
    const out = path.join(dir, 'feature-catalog.json');
    const repo = path.resolve(here, '../..');
    execFileSync(process.execPath, [path.join(repo, 'packages/ui-kit/scripts/feature-catalog.mjs'), '--app', 'guests', '--root', repo, '--out', out], { cwd: repo, stdio: 'pipe' });
    const catalog = JSON.parse(readFileSync(out, 'utf8')) as { features: Array<{ id: string; label: string | null }>; dynamic: unknown[] };
    assert.deepEqual(catalog.dynamic, []);
    assert.ok(catalog.features.length >= 30, `hay ${catalog.features.length} funciones`);
    assert.deepEqual(catalog.features.filter((f) => !f.label).map((f) => f.id), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
