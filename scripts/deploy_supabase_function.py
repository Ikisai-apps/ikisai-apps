#!/usr/bin/env python3
"""Despliega la Edge Function de una app (`supabase/functions/<app>-api` + `supabase/functions/_kit`). Plan por defecto.

Una sola función con slug `<app>-api` (o `<app>-api-qa` con --qa). Cada archivo se sube con su ruta relativa a
`supabase/functions/` como nombre (`invoices-api/index.ts`, `_kit/auth.ts`) para que los imports `../_kit/x.ts`
funcionen, y `entrypoint_path` es `<app>-api/index.ts`. Si IKISAI_RELEASE está definido se sustituye en index.ts
el literal `Deno.env.get('IKISAI_RELEASE') ?? 'development'` por la versión. `verify_jwt` es false: cada ruta
privada verifica el JWT en _kit y relee la pertenencia. `supabase/functions/import_map.json` se sube con cada función y se
declara como `import_map_path` para que Deno resuelva los paquetes npm del kit.
Además de `_domain/<app>`, se sube cada carpeta de `supabase/functions/_domain/<x>/` que importan los archivos subidos
(recursivo; p. ej. `invoices-api` → `_domain/payments`, finance-18). Sin ella, Supabase no resuelve el import y responde 400.
"""
import argparse
import hashlib
import json
import time
import os
import re
import urllib.error
import urllib.request
import uuid

from apps import add_app_argument, get_app
from cloud_management import PRIVATE, ROOT, CloudError, SupabaseManagement, run_cli

FUNCTIONS = ROOT / 'supabase/functions'
KIT = FUNCTIONS / '_kit'
# Mapa de importación de Deno: resuelve los especificadores npm que usa el kit (SDK de Anthropic en `_kit/extract.ts`).
IMPORT_MAP = FUNCTIONS / 'import_map.json'
EXTENSIONS = {'.ts': 'application/typescript', '.js': 'application/javascript', '.mjs': 'application/javascript', '.txt': 'text/plain', '.json': 'application/json'}
EXCLUDED_DIRS = {'node_modules', 'tests', 'test', '__tests__', 'fixtures'}
TEST_FILE = re.compile(r'.*[._](test|spec)\.(ts|js|mjs)$')
# Especificadores relativos de import/export (`from '../x.ts'`, `import '../x.ts'`, `import('../x.ts')`), también `import type`.
RELATIVE_IMPORT = re.compile(rb"""(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}/[^'"]+)['"]""")
RELEASE_LITERALS = (b"Deno.env.get('IKISAI_RELEASE') ?? 'development'", b'Deno.env.get("IKISAI_RELEASE") ?? "development"')


def collect(directory, functions=FUNCTIONS):
  """Archivos desplegables de un directorio, como {ruta relativa a supabase/functions: bytes}."""
  files = {}
  for path in sorted(directory.rglob('*')):
    if not path.is_file() or path.suffix not in EXTENSIONS or TEST_FILE.fullmatch(path.name):
      continue
    relative = path.resolve().relative_to(functions.resolve())
    if any(part in EXCLUDED_DIRS or part.startswith('.') for part in relative.parts[:-1]):
      continue
    files[relative.as_posix()] = path.read_bytes()
  return files


def with_domains(files, functions=FUNCTIONS):
  """Añade a `files` las carpetas de `<functions>/_domain/<x>/` que importan sus archivos, y las que importan esas.

  Solo dentro de `_domain`: un import a otra función o fuera de `supabase/functions` no se sigue.
  """
  domain = (functions / '_domain').resolve()
  pending = list(files)
  done = set()
  while pending:
    name = pending.pop()
    for spec in RELATIVE_IMPORT.findall(files[name]):
      target = ((functions / name).parent / spec.decode()).resolve()
      try:
        parts = target.relative_to(domain).parts
      except ValueError:
        continue
      folder = domain / parts[0]
      if folder in done:
        continue
      done.add(folder)
      found = collect(folder, functions) if folder.is_dir() else ({target.relative_to(functions.resolve()).as_posix(): target.read_bytes()} if target.is_file() else {})
      for key, raw in found.items():
        if key not in files:
          files[key] = raw
          pending.append(key)
  return files


def function_files(app_name):
  """Los archivos que se suben con la función de una app: la suya, `_kit`, `_domain/<app>` y los `_domain` que importan."""
  app = get_app(app_name)
  source = ROOT / app['function_dir']
  files = collect(source) if source.is_dir() else {}
  files.update(collect(KIT) if KIT.is_dir() else {})
  # Código de dominio compartido con el frontend: supabase/functions/_domain/<app>/ (el paquete packages/domain-<app> lo reexporta).
  domain = FUNCTIONS / '_domain' / app_name
  files.update(collect(domain) if domain.is_dir() else {})
  return with_domains(files)


def deploy(client, app_name, apply=False, qa=False, release=None):
  app = get_app(app_name)
  slug = app['function_slug'] + ('-qa' if qa else '')
  entrypoint = f"{app['function_slug']}/index.ts"
  files = function_files(app_name)
  if IMPORT_MAP.is_file():
    files[IMPORT_MAP.name] = IMPORT_MAP.read_bytes()
  if entrypoint not in files:
    raise CloudError(None, 'FUNCTION_SOURCE_MISSING', f'falta {app["function_dir"]}/index.ts')
  release = release or os.environ.get('IKISAI_RELEASE')
  injected = False
  if release:
    if not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?', release):
      raise ValueError('Invalid release label')
    for literal in RELEASE_LITERALS:
      if literal in files[entrypoint]:
        files[entrypoint] = files[entrypoint].replace(literal, json.dumps(release).encode())
        injected = True
  report = {'app': app_name, 'slug': slug, 'qa': qa, 'apply': apply, 'entrypoint': entrypoint, 'release': release, 'releaseInjected': injected,
            'files': {name: hashlib.sha256(raw).hexdigest() for name, raw in files.items()}, 'userDataImported': False}
  if not apply:
    return report
  boundary = 'ikisai-' + uuid.uuid4().hex
  metadata = {'name': slug, 'entrypoint_path': entrypoint, 'verify_jwt': False}
  if IMPORT_MAP.name in files:
    metadata['import_map_path'] = IMPORT_MAP.name
  body = f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n'.encode() + json.dumps(metadata).encode() + b'\r\n'
  for name, raw in files.items():
    mime = EXTENSIONS[os.path.splitext(name)[1]]
    body += f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: {mime}\r\n\r\n'.encode() + raw + b'\r\n'
  body += f'--{boundary}--\r\n'.encode()
  request = urllib.request.Request(client.base + '/functions/deploy?slug=' + slug, data=body, method='POST', headers={'Authorization': 'Bearer ' + client.token, 'Content-Type': 'multipart/form-data; boundary=' + boundary})
  # Supabase devuelve a veces un 500 pasajero al empaquetar (visto con invoices-api, 8 y 9-10-2026): hasta 3 intentos.
  for attempt in range(3):
    try:
      with client.opener.open(request, timeout=90) as response:
        result = json.loads(response.read())
      break
    except urllib.error.HTTPError as error:
      if error.code >= 500 and attempt < 2:
        time.sleep(15 * (attempt + 1))
        continue
      _fail_deploy(error, client, slug)
    except (urllib.error.URLError, TimeoutError, OSError):
      if attempt < 2:
        time.sleep(15 * (attempt + 1))
        continue
      raise CloudError(None, 'FUNCTION_NETWORK_FAILED') from None
  report.update({key: result.get(key) for key in ('status', 'version', 'id')})
  report['deployedSlug'] = result.get('slug')
  return report



def _fail_deploy(error, client, slug):
  # El cuerpo del proveedor solo se guarda en private/, redactando el token; nunca se imprime.
  raw = error.read(16384).decode('utf-8', errors='replace').replace(client.token, '[redacted]')
  PRIVATE.mkdir(parents=True, exist_ok=True)
  (PRIVATE / f'edge-deployment-error-{slug}.txt').write_text(raw, encoding='utf-8')
  raise CloudError(error.code, 'FUNCTION_DEPLOY_FAILED') from None

if __name__ == '__main__':
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  add_app_argument(parser)
  parser.add_argument('--apply', action='store_true', help='publica la función (por defecto solo plan)')
  parser.add_argument('--qa', action='store_true', help='despliega al slug <app>-api-qa')
  parser.add_argument('--credentials', help='ruta alternativa a private/cloud-credentials.json')
  parser.add_argument('--report', help='informe JSON (por defecto private/edge-deployment-<app>.json)')
  args = parser.parse_args()
  report_path = args.report or str(PRIVATE / f'edge-deployment-{args.app}{"-qa" if args.qa else ""}.json')
  run_cli(lambda: deploy(SupabaseManagement(args.credentials), args.app, args.apply, args.qa), report_path)
