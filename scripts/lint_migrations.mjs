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
const CORE_HELPERS = ['core.ensure_app', 'core.register_table', 'core.unregister_table', 'core.allow_procedure', 'core.add_validate_hook', 'core.allow_read', 'core.disallow_read', 'core.apply_row_op', 'core.next_code', 'core.fail', 'core.next_seq', 'core.memberships', 'core.changes', 'core.files', 'core.synced_tables', 'core.profiles', 'core.apps', 'core.allow_portal_resolver', 'core.apply_portal_operations', 'core.portal_revoke_scope', 'core.schedule_tick', 'core.register_file_field', 'core.enable_file_gc', 'core.apply_system_operations', 'core.service_actor', 'core.apply_migration_operations', 'core.allow_public_read', 'core.portal_in_scope', 'core.allow_portal_file'];
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
      if (schema === 'food' && other === 'booking' && ref === 'booking.food_event_projection') continue; // proyección publicada para Food (petición P14 de Food)
      if (schema === 'organizers' && other === 'booking' && ref === 'booking.reservation_end_dates') continue; // fechas de fin para purgar respuestas (B18 de Organizers)
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
// Aviso (aún no error): columnas que guardan file_id y no se declaran con core.register_file_field (ALMACENAMIENTO.md fase 2).
// Sin declarar, la recogida de huérfanos no puede activarse en esa app (core.enable_file_gc).
const all = files.map((f) => fs.readFileSync(path.join(DIR, f), 'utf8').replace(/--[^\n]*/g, '')).join('\n');
const registered = new Set([...all.matchAll(/core\.register_file_field\(\s*(?:'[a-z_]+'|null)\s*,\s*'([a-z_]+)'\s*,\s*'([a-z0-9_]+)'\s*,\s*'([a-z0-9_]+)'/g)].map((m) => `${m[1]}.${m[2]}.${m[3]}`));
const unregistered = [];
for (const m of all.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_]+)\.([a-z0-9_]+)\s*\(([\s\S]*?)\n\);/gi)) {
  for (const col of m[3].matchAll(/^\s+([a-z_]*file_id)\s+uuid/gm)) {
    const key = `${m[1]}.${m[2]}.${col[1]}`;
    if (m[1] !== 'core' && !registered.has(key)) unregistered.push(key);
  }
}
for (const m of all.matchAll(/alter\s+table\s+([a-z_]+)\.([a-z0-9_]+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_]*file_id)\s+uuid/gi)) {
  const key = `${m[1]}.${m[2]}.${m[3]}`;
  if (m[1] !== 'core' && !registered.has(key)) unregistered.push(key);
}
if (unregistered.length) console.warn(`aviso: campos de archivo sin core.register_file_field: ${[...new Set(unregistered)].sort().join(', ')}`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`migraciones correctas: ${files.length}`);
