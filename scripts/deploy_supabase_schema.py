#!/usr/bin/env python3
"""Aplica las migraciones pendientes de `supabase/migrations/*.sql` al proyecto autorizado. Plan por defecto.

- Ejecuta antes `node scripts/lint_migrations.mjs` y aborta si falla.
- El historial del proyecto puede contener migraciones del antiguo repo `ikisai-tasks` (schema `ikisai.*`,
  nombres `202610050…_<hash>`): se ignoran y nunca se tocan ni se reescriben.
- Una migración ya aplicada cuyo contenido cambió aborta con APPLIED_MIGRATION_CHANGED (son inmutables).
- Si el schema `core` existe pero ninguna migración de este repo consta en el historial, aborta
  (EXISTING_SCHEMA_WITHOUT_OWNED_MIGRATION) para no pisar un proyecto desconocido.
"""
import argparse
import hashlib
import re
import shutil
import subprocess

from apps import ALL_SCHEMAS
from cloud_management import ROOT, PRIVATE, CloudError, SupabaseManagement, run_cli

MIGRATIONS = ROOT / 'supabase/migrations'
LEGACY_PREFIX = '202610050'  # migraciones del antiguo ikisai-tasks (schema ikisai.*)
NAME_PATTERN = re.compile(r'^\d{8}_\d{4}_(core|tasks|invoices|booking|food)_[a-z0-9_]+$')


def lint():
  node = shutil.which('node')
  if not node:
    raise CloudError(None, 'MIGRATION_LINT_UNAVAILABLE', 'node no está disponible para ejecutar scripts/lint_migrations.mjs')
  result = subprocess.run([node, str(ROOT / 'scripts/lint_migrations.mjs')], cwd=ROOT, capture_output=True, text=True)
  if result.returncode != 0:
    raise CloudError(None, 'MIGRATION_LINT_FAILED', (result.stderr or result.stdout).strip()[:2000])
  return (result.stdout or '').strip()


def migration_files():
  files = sorted(p for p in MIGRATIONS.glob('*.sql') if p.is_file())
  for file in files:
    if not NAME_PATTERN.fullmatch(file.stem):
      raise ValueError('Invalid migration name: ' + file.name)
  return files


def deploy(client, apply=False):
  lint_output = lint()
  history = client.request('/database/migrations') or []
  names = {entry.get('name') for entry in history if isinstance(entry, dict) and isinstance(entry.get('name'), str)}
  legacy = sorted(name for name in names if name.startswith(LEGACY_PREFIX))
  owned_history = names - set(legacy)
  core_present = client.query("select exists(select 1 from pg_catalog.pg_namespace where nspname='core') as present", read_only=True)[0]['present']
  files = migration_files()
  plan = []
  for file in files:
    raw = file.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    name = file.stem + '_' + digest[:12]
    same_stem = [n for n in owned_history if n.startswith(file.stem + '_')]
    if same_stem and name not in owned_history:
      raise CloudError(None, 'APPLIED_MIGRATION_CHANGED', file.name)
    plan.append({'file': file.name, 'sha256': digest, 'name': name, 'status': 'applied' if name in owned_history else 'pending'})
  if core_present and not any(item['status'] == 'applied' for item in plan):
    raise CloudError(None, 'EXISTING_SCHEMA_WITHOUT_OWNED_MIGRATION')
  report = {'projectRef': client.ref, 'apply': apply, 'lint': lint_output, 'legacyMigrationsIgnored': len(legacy), 'migrations': plan, 'pending': sum(1 for p in plan if p['status'] == 'pending'), 'checks': None, 'userDataImported': False}
  if not apply:
    return report
  for item, file in zip(plan, files):
    if item['status'] == 'pending':
      client.request('/database/migrations', {'name': item['name'], 'query': file.read_text(encoding='utf-8')})
      item['status'] = 'applied'
  verified = {entry.get('name') for entry in (client.request('/database/migrations') or []) if isinstance(entry, dict)}
  if not all(item['name'] in verified for item in plan):
    raise CloudError(None, 'MIGRATION_HISTORY_UNVERIFIED')
  schemas = ','.join("'" + s + "'" for s in ALL_SCHEMAS)
  report['checks'] = client.query(
    f"select (select count(*) from pg_catalog.pg_tables where schemaname in ({schemas})) as tables,"
    f" (select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname in ({schemas}) and c.relkind='r' and c.relrowsecurity) as rls_tables,"
    " (select count(*) from core.apps) as apps,"
    " (select coalesce(jsonb_agg(nspname order by nspname),'[]'::jsonb) from pg_catalog.pg_namespace where nspname in (" + schemas + ")) as schemas",
    read_only=True)[0]
  return report


if __name__ == '__main__':
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument('--apply', action='store_true', help='aplica las migraciones pendientes (por defecto solo plan)')
  parser.add_argument('--credentials', help='ruta alternativa a private/cloud-credentials.json')
  parser.add_argument('--report', default=str(PRIVATE / 'supabase-schema-deployment.json'))
  args = parser.parse_args()
  run_cli(lambda: deploy(SupabaseManagement(args.credentials), args.apply), args.report)
