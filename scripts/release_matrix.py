#!/usr/bin/env python3
"""Decide qué apps publica el workflow de release y con qué versión. Escribe `apps=<json>` y `version=<v>` en stdout.

- `workflow_dispatch`: la app del input `app`; versión del input `version` o `v0.1.0-build.<run_number>`.
- `push` a main: para cada app, cambios entre el commit que tiene publicado (`https://<app>.ikisai.com/version.json`)
  y HEAD (`apps/<app>`, `supabase/functions/<app>-api`, `supabase/functions/_domain/<app>`, `packages/domain-<app>`,
  migraciones `*_<app>_*`). Así una release cancelada en cola por la concurrencia de GitHub no deja una app sin publicar.
  Si no se puede leer el commit publicado, se usa `github.event.before`. Un cambio compartido
  (`_kit`, migraciones core, `sync-client`, `ui-kit`, `scripts`, workflows) marca todas las apps.
- Solo se publican apps «publicables»: existen `supabase/functions/<app>-api/index.ts` y `apps/<app>/package.json`.
Variables: EVENT, INPUT_APP, INPUT_VERSION, BEFORE, RUN_NUMBER (las pone el workflow). Sin red ni credenciales.
"""
import json
import os
import urllib.request
import re
import subprocess
import sys

from apps import APPS, get_app
from cloud_management import ROOT

SHARED = ('supabase/functions/_kit/', 'packages/sync-client/', 'packages/ui-kit/', 'packages/test-kit/', 'scripts/', '.github/workflows/', 'package.json', 'package-lock.json', 'tsconfig.json')
VERSION = re.compile(r'v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?')


def publishable(app):
  return (ROOT / app['function_dir'] / 'index.ts').is_file() and (ROOT / app['app_dir'] / 'package.json').is_file()


def changed_files(before):
  if not before or re.fullmatch(r'0+', before):
    return None
  try:
    output = subprocess.check_output(['git', 'diff', '--name-only', before, 'HEAD'], cwd=ROOT, text=True, stderr=subprocess.DEVNULL)
  except (OSError, subprocess.CalledProcessError):
    return None
  return [line.strip().replace('\\', '/') for line in output.splitlines() if line.strip()]


def deployed_commit(app):
  """Commit que sirve hoy el dominio de la app, o None (sin red, sin dominio o respuesta inesperada)."""
  if os.environ.get('IKISAI_RELEASE_OFFLINE'):
    return None
  try:
    # Cloudflare rechaza el agente de usuario por defecto de urllib (403).
    request = urllib.request.Request(f"https://{app['domain']}/version.json", headers={'User-Agent': 'ikisai-release/1.0'})
    with urllib.request.urlopen(request, timeout=10) as response:
      commit = json.loads(response.read()).get('commit')
  except Exception:
    return None
  return commit if isinstance(commit, str) and re.fullmatch(r'[0-9a-f]{40}', commit) else None


def affected(files):
  if files is None:
    return set(APPS), ['historial no disponible: se consideran todas las apps']
  apps = set()
  reasons = []
  for path in files:
    if path.startswith(SHARED) or re.match(r'supabase/migrations/\d{8}_\d{4}_core_', path):
      reasons.append(f'{path}: compartido, afecta a todas')
      return set(APPS), reasons
    for name, app in APPS.items():
      if path.startswith((app['app_dir'] + '/', app['function_dir'] + '/', f'packages/domain-{name}/', f'supabase/functions/_domain/{name}/')) or re.match(rf'supabase/migrations/\d{{8}}_\d{{4}}_{name}_', path):
        apps.add(name)
        reasons.append(f'{path}: {name}')
  return apps, reasons


def main():
  event = os.environ.get('EVENT', '')
  version = (os.environ.get('INPUT_VERSION') or '').strip() or f"v0.1.0-build.{os.environ.get('RUN_NUMBER', '0')}"
  if not VERSION.fullmatch(version):
    print('::error::versión inválida: ' + version, file=sys.stderr)
    return 1
  if event == 'workflow_dispatch':
    chosen = {get_app(os.environ.get('INPUT_APP', ''))['name']}
    reasons = ['dispatch manual']
  else:
    before = os.environ.get('BEFORE', '')
    chosen, reasons = set(), []
    for name, app in APPS.items():
      base = deployed_commit(app)
      if base:
        files = changed_files(base)
        if files is None:
          reasons.append(f'{name}: commit publicado {base[:7]} no está en el historial; se compara con el push')
          files = changed_files(before)
      else:
        files = changed_files(before)
        reasons.append(f'{name}: sin version.json legible; se compara con el push')
      apps, why = affected(files)
      if name in apps:
        chosen.add(name)
        reasons.extend(r for r in why if r.endswith(name) or 'todas' in r)
  skipped = sorted(name for name in chosen if not publishable(APPS[name]))
  selected = sorted(name for name in chosen if name not in skipped)
  for line in reasons:
    print('::notice::' + line, file=sys.stderr)
  for name in skipped:
    print(f'::warning::{name} no es publicable todavía (faltan {APPS[name]["function_dir"]}/index.ts o {APPS[name]["app_dir"]}/package.json)', file=sys.stderr)
  print('apps=' + json.dumps(selected))
  print('version=' + version)
  return 0


if __name__ == '__main__':
  try:
    sys.exit(main())
  except ValueError as error:
    print('::error::' + str(error), file=sys.stderr)
    sys.exit(1)
