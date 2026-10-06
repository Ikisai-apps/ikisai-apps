#!/usr/bin/env node
/**
 * Ejecuta con tsx todas las pruebas node:test del repo: tests/<carpeta>/*.test.ts (núcleo, sync-client y cada app).
 * Los *.spec.ts son de Playwright y no entran aquí. Uso: node scripts/run_tests.mjs [carpeta ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = path.join(ROOT, 'tests');
const only = process.argv.slice(2);
const folders = fs.readdirSync(TESTS).filter((d) => fs.statSync(path.join(TESTS, d)).isDirectory() && (!only.length || only.includes(d))).sort();
const files = folders.flatMap((d) => fs.readdirSync(path.join(TESTS, d)).filter((f) => f.endsWith('.test.ts')).sort().map((f) => path.join('tests', d, f)));
if (!files.length) { console.error('No hay pruebas *.test.ts en', folders.join(', ') || 'tests/'); process.exit(1); }
console.log(`Ejecutando ${files.length} archivos de prueba en ${folders.join(', ')}`);
const tsx = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const result = spawnSync(tsx, ['--test', ...files], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(result.status ?? 1);
