#!/usr/bin/env node
/**
 * Qué pruebas PGlite corre la CI de una PR (job «Qué ha cambiado» de checks.yml). Sin dependencias: corre antes de npm ci.
 *
 * - Solo documentación (docs/, MUELA/, CODEOWNERS o *.md): nada (`code=false`).
 * - Solo una o varias apps (apps/<x>, <x>-api, _domain/<x>, domain-<x>, migraciones *_<x>_*, tests/<x>, docs/<x>): solo
 *   las pruebas de esas apps. Antes iban también las carpetas que nombraban su schema o importaban su código, y una PR de
 *   Flow o de Booking corría 7-11 carpetas en 8 jobs: con unas 30 PR abiertas y 20 runners, la release esperaba (27-10-2026,
 *   decisión de Core). Lo que rompa a otra app lo para la release, que corre todas antes de publicar, y la pasada de cada noche.
 * - Cualquier otra cosa (kit, sync-client, test-kit, _kit, núcleo, CI, scripts, dependencias) y fuera de una PR: todas.
 *
 * Salida: grupos para la matriz de PGlite, uno por carpeta grande y las pequeñas juntas, para que el tiempo sea el del
 * grupo más lento y no la suma. Uso: git diff --name-only … | node scripts/ci_plan.mjs [--event pull_request]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Carpetas de tests/ que no son de una app: si cambian, corre todo. */
const SHARED_FOLDERS = new Set(['core', 'sync-client', 'scripts']);
/** Por debajo de estos archivos *.test.ts, una carpeta va en el grupo de las pequeñas. */
const SMALL = 12;
/** Desde estos, la carpeta se parte en dos trozos (`--test-shard`): booking pasaba de 3 min sola (run 40435076631). */
const SPLIT = 45;
/** Como mucho estos jobs de PGlite además de los trozos: el plan Free da 20 jobs a la vez para todo el repo y, con unas 30 PR
 *  abiertas, la release esperaba runner (27-10: 16 min en cola). Con más, las carpetas se juntan por tamaño. */
const PACK = 4;

export const isDoc = (file) => /^(docs\/|MUELA\/|CODEOWNERS$)|\.md$/.test(file);

/** Carpetas de tests/ con pruebas node:test. */
export function testFolders(root = ROOT) {
  const dir = path.join(root, 'tests');
  return fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory()
    && fs.readdirSync(path.join(dir, d)).some((f) => f.endsWith('.test.ts'))).sort();
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** De qué app es un archivo; `null` si no es de ninguna. */
export function ownerOf(file, apps) {
  for (const app of apps) {
    const a = escape(app);
    if (new RegExp(`^(apps/${a}/|tests/${a}/|docs/${a}/|supabase/functions/${a}-api/|supabase/functions/_domain/${a}/|packages/domain-${a}/|supabase/migrations/[0-9_]+_${a}_)`).test(file)) return app;
  }
  return null;
}

/** Grupos de la matriz: una carpeta grande por grupo (la muy grande, en dos trozos) y las pequeñas juntas. */
export function groups(folders, root = ROOT, split = SPLIT, pack = PACK) {
  const size = (f) => fs.readdirSync(path.join(root, 'tests', f)).filter((n) => n.endsWith('.test.ts')).length;
  const big = folders.filter((f) => size(f) >= SMALL);
  const small = folders.filter((f) => size(f) < SMALL);
  const shards = big.filter((f) => size(f) >= split).flatMap((f) => [1, 2].map((i) => ({ name: `${f} ${i}/2`, folders: f, shard: `${i}/2` })));
  const units = [...big.filter((f) => size(f) < split).map((f) => [f]), ...(small.length ? [small] : [])];
  if (units.length <= pack) return [...shards, ...units.map((u) => ({ name: u.join(' + '), folders: u.join(' ') }))];
  // Más grupos que `pack`: la carpeta más grande, al paquete que menos lleva (por archivos de prueba).
  const weight = (u) => u.reduce((n, f) => n + size(f), 0);
  const bins = Array.from({ length: pack }, () => ({ folders: [], weight: 0 }));
  for (const u of [...units].sort((a, b) => weight(b) - weight(a))) {
    const bin = bins.reduce((min, b) => (b.weight < min.weight ? b : min));
    bin.folders.push(...u); bin.weight += weight(u);
  }
  return [...shards, ...bins.filter((b) => b.folders.length).map((b) => {
    const list = [...b.folders].sort();
    return { name: list.join(' + '), folders: list.join(' ') };
  })];
}

/** El plan de una PR (o de un run fuera de PR, `event !== 'pull_request'`: todo). */
export function plan({ event = 'pull_request', files = [], root = ROOT } = {}) {
  const folders = testFolders(root);
  const all = { code: true, full: true, folders, groups: groups(folders, root) };
  if (event !== 'pull_request' || !files.length) return all;
  const code = files.filter((f) => !isDoc(f));
  if (!code.length) return { code: false, full: false, folders: [], groups: [] };
  const apps = folders.filter((f) => !SHARED_FOLDERS.has(f));
  const touched = new Set();
  for (const file of code) {
    const owner = ownerOf(file, apps);
    if (!owner) return all;
    touched.add(owner);
  }
  const list = folders.filter((f) => touched.has(f));
  return { code: true, full: false, folders: list, groups: groups(list, root) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--event');
  const event = at > 0 ? process.argv[at + 1] : 'pull_request';
  const files = event === 'pull_request' ? fs.readFileSync(0, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean) : [];
  const out = plan({ event, files });
  const lines = [`pglite=${JSON.stringify(out.groups)}`, `code=${out.code}`, `pglite_full=${out.full}`];
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  console.log(`PGlite: ${out.full ? 'todas' : out.folders.join(', ') || 'ninguna'} · ${lines.join('  ')}`);
}
