#!/usr/bin/env node
/**
 * Lint de migraciones: nombre YYYYMMDD_NNNN_<schema>_<tema>.sql, un único schema por archivo,
 * las migraciones de app solo usan helpers permitidos de core y toda tabla nueva queda registrada.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'supabase/migrations');
const SCHEMAS = ['core', 'tasks', 'invoices', 'booking', 'food', 'central', 'guests', 'organizers'];
// Helpers y objetos de core que una migración de app puede usar. Lectura: memberships, changes, files. Escritura solo vía apply_row_op.
const CORE_HELPERS = ['core.ensure_app', 'core.register_table', 'core.unregister_table', 'core.allow_procedure', 'core.add_validate_hook', 'core.allow_read', 'core.disallow_read', 'core.apply_row_op', 'core.next_code', 'core.fail', 'core.next_seq', 'core.memberships', 'core.changes', 'core.files', 'core.synced_tables', 'core.profiles', 'core.apps', 'core.allow_portal_resolver', 'core.apply_portal_operations', 'core.portal_revoke_scope'];
const NAME = /^(\d{8})_(\d{4})_(core|tasks|invoices|booking|food|central|guests|organizers)_[a-z0-9_]+\.sql$/;

const problems = [];
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const seen = new Set();
for (const file of files) {
  const match = file.match(NAME);
  if (!match) { problems.push(`${file}: nombre inválido (YYYYMMDD_NNNN_<schema>_<tema>.sql)`); continue; }
  const key = `${match[1]}_${match[2]}`;
  if (seen.has(key)) problems.push(`${file}: prefijo ${key} repetido`);
  seen.add(key);
  const schema = match[3];
  const sql = fs.readFileSync(path.join(DIR, file), 'utf8').replace(/--[^\n]*/g, '');
  for (const other of SCHEMAS.filter((s) => s !== schema)) {
    const refs = [...sql.matchAll(new RegExp(`\\b${other}\\.([a-z_][a-z0-9_]*)`, 'g'))].map((m) => `${other}.${m[1]}`);
    for (const ref of new Set(refs)) {
      if (ref.endsWith('.ikisai')) continue; // dominio (central.ikisai.com…), no un objeto de schema
      if (other === 'core' && CORE_HELPERS.includes(ref)) continue;
      if (schema === 'food' && other === 'booking' && /booking\.events\b/.test(ref) && /references\s+booking\.events/.test(sql)) continue; // FK permitida por contrato
      problems.push(`${file}: referencia a ${ref} fuera de su schema`);
    }
  }
  if (schema !== 'core' && /\bpublic\./.test(sql)) problems.push(`${file}: solo las migraciones core definen wrappers public.*`);
  if (schema !== 'core') {
    const created = [...sql.matchAll(new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${schema}\\.([a-z0-9_]+)`, 'gi'))].map((m) => m[1]);
    for (const table of created) {
      if (!new RegExp(`core\\.register_table\\(\\s*'[a-z_]+'\\s*,\\s*'${schema}'\\s*,\\s*'${table}'`).test(sql)) {
        problems.push(`${file}: la tabla ${schema}.${table} no se registra con core.register_table en la misma migración`);
      }
    }
  }
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`migraciones correctas: ${files.length}`);
