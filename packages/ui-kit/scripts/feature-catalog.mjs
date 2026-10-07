#!/usr/bin/env node
/**
 * Catálogo de funciones de una app (USO.md §2.1): recorre su código y saca cada `data-feedback-id` (con su
 * `data-feedback-label` y el tipo de control cuando se deduce) y cada `usage.run('…')` / `usage.track('…')`.
 * Escribe `{ app, release, commit, generatedAt, features: [{ id, label, kind, parent }], dynamic }`.
 * Sin dependencias: solo Node.
 *
 *   node packages/ui-kit/scripts/feature-catalog.mjs --app booking [--release v1.2.3] [--commit abc123]
 *        [--src apps/booking/src --src apps/booking/public] [--out apps/booking/dist/feature-catalog.json]
 *
 * Por defecto lee `apps/<app>/src`, `apps/<app>/public` (sin `sw.js`) y `apps/<app>/index.html`, y escribe en
 * `apps/<app>/dist/feature-catalog.json`. `release` y `commit` salen de los argumentos, de `RELEASE`/`GITHUB_SHA`, o del
 * `version.json` que haya junto a la salida.
 * Los ids construidos en tiempo de ejecución (`${…}`, concatenaciones) no se pueden catalogar: se listan en `dynamic`
 * con el archivo y la línea, para que el equipo los marque con un id fijo o con su prefijo.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const EXTENSIONS = /\.(ts|tsx|js|mjs|jsx|html)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'test-results']);
const SKIP_FILES = /(^|[\\/])(sw|service-worker)\.(js|ts)$|\.(spec|test)\.(ts|js)$|\.d\.ts$/;
const ID = /^[a-z][a-z0-9_]*(\.[a-z0-9_-]+){0,7}$/;

export function parseArgs(argv) {
  const out = { src: [] };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--app') { out.app = value; i++; }
    else if (key === '--release') { out.release = value; i++; }
    else if (key === '--commit') { out.commit = value; i++; }
    else if (key === '--out') { out.out = value; i++; }
    else if (key === '--src') { out.src.push(value); i++; }
    else if (key === '--root') { out.root = value; i++; }
  }
  return out;
}

function walk(path, files) {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (stat.isFile()) { if (EXTENSIONS.test(path) && !SKIP_FILES.test(path)) files.push(path); return; }
  for (const name of readdirSync(path)) {
    if (SKIP_DIRS.has(name)) continue;
    walk(join(path, name), files);
  }
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Tipo de control a partir de su propia etiqueta u objeto: desde el último `<tag` o `el('tag'` anterior al atributo hasta
 * el siguiente cierre (`>` o `}`), sin mirar a los vecinos.
 */
function kindNear(before, after) {
  const opener = /(?:<|el\(\s*['"])([a-z][a-z0-9-]*)(?=[\s'">,])(?![\s\S]*(?:<[a-z]|el\(\s*['"]))/.exec(before.slice(-600));
  const own = (opener ? before.slice(-600).slice(opener.index) : '') + after.slice(0, Math.max(0, after.search(/[>}]/))) ;
  const role = /role['"]?\s*[:=]\s*['"](tab|menuitem|link|switch|checkbox|option|button)['"]/.exec(own)?.[1];
  if (role) return { tab: 'tab', menuitem: 'menu', link: 'link', switch: 'toggle', checkbox: 'toggle', option: 'option', button: 'button' }[role];
  const tag = opener?.[1];
  if (!tag) return 'element';
  if (tag === 'button') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return 'field';
  if (tag === 'form') return 'form';
  if (/^(section|article|main|aside|nav|header|footer|dialog)$/.test(tag)) return 'section';
  if (tag === 'li' || tag === 'tr') return 'item';
  return 'element';
}

/** Etiqueta junto al id: `data-feedback-label="…"`, `'data-feedback-label': '…'` o `feedbackLabel: '…'`. */
function labelNear(before, after) {
  const end = after.search(/[>}]/);
  const opener = Math.max(before.lastIndexOf('<'), before.lastIndexOf('{'));
  const own = (opener >= 0 ? before.slice(opener) : '') + ' ' + (end >= 0 ? after.slice(0, end) : after.slice(0, 200));
  return /(?:data-feedback-label|feedbackLabel)['"]?\s*[:=]\s*(['"`])([^'"`$]{1,80})\1/.exec(own)?.[2]?.trim() ?? null;
}

/**
 * Argumentos de primer nivel de una llamada que empieza en `open` (índice del `(`): respeta paréntesis, corchetes,
 * llaves, comillas y plantillas. Devuelve `null` si la llamada no se cierra.
 */
export function splitArgs(text, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) { args.push(text.slice(start, i).trim()); return args; }
      depth--;
    } else if (c === ',' && depth === 0) { args.push(text.slice(start, i).trim()); start = i + 1; }
  }
  return null;
}

const literal = (arg) => /^(['"])([^'"]*)\1$/.exec(arg ?? '')?.[2] ?? /^`([^`$]*)`$/.exec(arg ?? '')?.[1] ?? null;

/** Tipo a partir del nodo que se marca: `el('button', …)`, `listRow(…)`, `shell.header`… */
function kindOfNode(arg) {
  const tag = /^el\(\s*['"]([a-z][a-z0-9-]*)['"]/.exec(arg)?.[1];
  if (tag) return kindNear(`el('${tag}'`, '');
  if (/^listRow\(/.test(arg)) return 'item';
  if (/header|topbar/i.test(arg)) return 'section';
  return 'element';
}

/** Expresión desde `at` hasta la primera `,`, `}`, `)` o `]` de primer nivel (respeta anidación y cadenas). */
function exprAt(text, at) {
  let depth = 0;
  for (let i = at; i < Math.min(text.length, at + 600); i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return text.slice(at, i).trim(); depth--; }
    else if (c === ',' && depth === 0) return text.slice(at, i).trim();
  }
  return '';
}

/** Literales de un ternario `c ? 'x' : 'y'` que empieza en `at` (hasta `,` o `}` de primer nivel); si no lo es, `null`. */
function ternaryLiterals(text, at) {
  const expr = exprAt(text, at);
  if (!/\?/.test(expr) || !/:/.test(expr) || expr.includes('${')) return null;
  const parts = expr.slice(expr.indexOf('?') + 1).split(/\s:\s|\s:(?=\s*['"`])/).map((x) => literal(x.trim()));
  return parts.length === 2 && parts.every((x) => x && (ID.test(x) || !x.includes('.'))) ? parts : null;
}

/**
 * Componentes del kit que marcan sus propios controles a partir de una base (`feedbackId`): el catálogo añade los hijos.
 * Mantener al día con `CONFLICT_MARKS` de `src/sync/conflict.ts`.
 */
const KIT_CHILDREN = {
  renderConflict: [['mantener_mia', 'Mantener la mía', 'button'], ['tomar_servidor', 'Tomar la del servidor', 'button'], ['combinar', 'Combinar campo a campo', 'button'], ['guardar_combinacion', 'Guardar combinación', 'button'], ['volver', 'Volver', 'button']],
};
KIT_CHILDREN.renderConflicts = KIT_CHILDREN.renderConflict;

/** Nombre de la llamada que contiene la posición `at` (el `(` sin cerrar más cercano hacia atrás). */
function enclosingCall(text, at) {
  let depth = 0;
  for (let i = at - 1; i >= Math.max(0, at - 4000); i--) {
    const c = text[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') {
      if (depth === 0 && c === '(') return /([A-Za-z_$][\w$]*)\s*$/.exec(text.slice(Math.max(0, i - 60), i))?.[1] ?? null;
      if (depth > 0) depth--;
    }
  }
  return null;
}

/** Extrae funciones de un texto. Exportada para las pruebas. */
export function extractFeatures(text, file = '') {
  const features = [];
  const dynamic = [];
  const attr = /(?:data-feedback-id|feedbackId)['"]?\s*[:=]\s*(?:(['"])([^'"]*)\1|(`)([^`]*)`|([^\s,}>]+))/g;
  for (const m of text.matchAll(attr)) {
    const raw = m[2] ?? m[4];
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 3);
    const concatenated = /^\s*\+/.test(tail);
    if (raw === undefined || (m[3] && raw.includes('${')) || concatenated || !ID.test(raw)) {
      // `cond ? 'a.b' : 'a.c'`: cada rama es una función fija (con su etiqueta si la etiqueta es otro ternario igual).
      const branches = ternaryLiterals(text, m.index + m[0].length - (m[5]?.length ?? 0));
      if (branches) {
        const labelAt = /(?:data-feedback-label|feedbackLabel)['"]?\s*[:=]\s*/.exec(text.slice(m.index, m.index + 600));
        const labels = labelAt ? ternaryLiterals(text, m.index + labelAt.index + labelAt[0].length) : null;
        const before = text.slice(0, m.index);
        branches.forEach((id, k) => features.push({ id, label: labels?.length === branches.length ? labels[k] : null, kind: kindNear(before, ''), file, line: lineOf(text, m.index) }));
        continue;
      }
      dynamic.push({ file, line: lineOf(text, m.index), expr: m[0].slice(0, 120) });
      continue;
    }
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + m[0].length);
    const call = /feedbackId/.test(m[0]) ? enclosingCall(text, m.index) : null;
    const children = call ? KIT_CHILDREN[call] : null;
    if (children) {
      features.push({ id: raw, label: labelNear(before, after) ?? 'Conflicto', kind: 'section', file, line: lineOf(text, m.index) });
      for (const [suffix, label, kind] of children) features.push({ id: `${raw}.${suffix}`, label, kind, file, line: lineOf(text, m.index) });
      continue;
    }
    features.push({ id: raw, label: labelNear(before, after), kind: kindNear(before, after), file, line: lineOf(text, m.index) });
  }
  const calls = /\busage\s*\.\s*(run|track)\s*\(\s*(?:(['"])([^'"]+)\2|(`)([^`]*)`|([^,)]+))/g;
  for (const m of text.matchAll(calls)) {
    const raw = m[3] ?? m[5];
    if (raw === undefined || (m[4] && raw.includes('${')) || !ID.test(raw)) {
      dynamic.push({ file, line: lineOf(text, m.index), expr: m[0].slice(0, 120) });
      continue;
    }
    features.push({ id: raw, label: null, kind: 'operation', file, line: lineOf(text, m.index) });
  }
  // Ayudantes de las apps: `fbMark(nodo, 'id', 'etiqueta')` (Booking, Tasks, Finance).
  const marks = /\bfbMark\s*\(/g;
  for (const m of text.matchAll(marks)) {
    if (/function\s+$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
    const args = splitArgs(text, m.index + m[0].length - 1);
    const id = literal(args?.[1]);
    if (!args || !id || !ID.test(id)) { dynamic.push({ file, line: lineOf(text, m.index), expr: text.slice(m.index, m.index + 120).split('\n')[0] }); continue; }
    features.push({ id, label: literal(args[2]), kind: kindOfNode(args[0] ?? ''), file, line: lineOf(text, m.index) });
  }
  return { features, dynamic };
}

/** Une repeticiones (la etiqueta y el tipo más concretos ganan) y calcula el padre: el prefijo catalogado más largo. */
export function buildCatalog(found) {
  const byId = new Map();
  for (const f of found) {
    const prev = byId.get(f.id);
    if (!prev) { byId.set(f.id, { id: f.id, label: f.label, kind: f.kind }); continue; }
    prev.label ??= f.label;
    if ((prev.kind === 'element' || prev.kind === 'operation') && f.kind !== 'element' && f.kind !== 'operation') prev.kind = f.kind;
  }
  const features = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const f of features) {
    const parts = f.id.split('.');
    f.parent = null;
    for (let n = parts.length - 1; n > 0; n--) {
      const candidate = parts.slice(0, n).join('.');
      if (byId.has(candidate)) { f.parent = candidate; break; }
    }
    f.label ??= labelFromId(f.id);
  }
  return features;
}

function labelFromId(id) {
  const last = id.split('.').pop().replace(/[-_]+/g, ' ').trim();
  return last ? last[0].toUpperCase() + last.slice(1) : id;
}

export function generateCatalog({ app, root = process.cwd(), src = [], release, commit, out }) {
  if (!app || !/^[a-z][a-z0-9_]{1,30}$/.test(app)) throw new Error('Falta --app (id de la app, p. ej. booking).');
  const appDir = join(root, 'apps', app);
  const dirs = src.length ? src.map((s) => resolve(root, s)) : [join(appDir, 'src'), join(appDir, 'public'), join(appDir, 'index.html')];
  const target = out ? resolve(root, out) : join(appDir, 'dist', 'feature-catalog.json');
  const files = [];
  for (const d of dirs) walk(d, files);
  const found = [];
  const dynamic = [];
  for (const file of files) {
    const rel = relative(root, file).replace(/\\/g, '/');
    const result = extractFeatures(readFileSync(file, 'utf8'), rel);
    found.push(...result.features);
    dynamic.push(...result.dynamic);
  }
  let version = {};
  const versionFile = join(dirname(target), 'version.json');
  if (existsSync(versionFile)) { try { version = JSON.parse(readFileSync(versionFile, 'utf8')); } catch { version = {}; } }
  const catalog = {
    app,
    release: release ?? process.env.RELEASE ?? version.release ?? null,
    commit: commit ?? process.env.GITHUB_SHA ?? version.commit ?? null,
    generatedAt: new Date().toISOString(),
    features: buildCatalog(found),
    dynamic,
  };
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  return { catalog, target, files: files.length };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (invoked) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { catalog, target, files } = generateCatalog({ ...args, root: args.root ?? process.cwd() });
    console.log(`feature-catalog: ${catalog.features.length} funciones de ${files} archivos → ${relative(process.cwd(), target)}${catalog.dynamic.length ? ` (${catalog.dynamic.length} ids dinámicos sin catalogar)` : ''}`);
  } catch (error) {
    console.error(`feature-catalog: ${error.message}`);
    process.exit(1);
  }
}
