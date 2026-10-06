#!/usr/bin/env python3
"""Despliega la Edge Function de una app (`supabase/functions/<app>-api` + `supabase/functions/_kit`). Plan por defecto.

Una sola función con slug `<app>-api` (o `<app>-api-qa` con --qa). Cada archivo se sube con su ruta relativa a
`supabase/functions/` como nombre (`invoices-api/index.ts`, `_kit/auth.ts`) para que los imports `../_kit/x.ts`
funcionen, y `entrypoint_path` es `<app>-api/index.ts`. Si IKISAI_RELEASE está definido se sustituye en index.ts
el literal `Deno.env.get('IKISAI_RELEASE') ?? 'development'` por la versión. `verify_jwt` es false: cada ruta
privada verifica el JWT en _kit y relee la pertenencia. `supabase/functions/import_map.json` se sube con cada función y se
declara como `import_map_path` para que Deno resuelva los paquetes npm del kit.
"""
import argparse
import hashlib
import json
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
RELEASE_LITERALS = (b"Deno.env.get('IKISAI_RELEASE') ?? 'development'", b'Deno.env.get("IKISAI_RELEASE") ?? "development"')


def collect(directory):
  """Archivos desplegables de un directorio, como {ruta relativa a supabase/functions: bytes}."""
  files = {}
  for path in sorted(directory.rglob('*')):
    if not path.is_file() or path.suffix not in EXTENSIONS or TEST_FILE.fullmatch(path.name):
      continue
    relative = path.relative_to(FUNCTIONS)
    if any(part in EXCLUDED_DIRS or part.startswith('.') for part in relative.parts[:-1]):
      continue
    files[relative.as_posix()] = path.read_bytes()
  return files


def deploy(client, app_name, apply=False, qa=False, release=None):
  app = get_app(app_name)
  slug = app['function_slug'] + ('-qa' if qa else '')
  source = ROOT / app['function_dir']
  entrypoint = f"{app['function_slug']}/index.ts"
  files = collect(source) if source.is_dir() else {}
  files.update(collect(KIT) if KIT.is_dir() else {})
  # Código de dominio compartido con el frontend: supabase/functions/_domain/<app>/ (el paquete packages/domain-<app> lo reexporta).
  domain = FUNCTIONS / '_domain' / app_name
  files.update(collect(domain) if domain.is_dir() else {})
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
  try:
    with client.opener.open(request, timeout=90) as response:
      result = json.loads(response.read())
  except urllib.error.HTTPError as error:
    # El cuerpo del proveedor solo se guarda en private/, redactando el token; nunca se imprime.
    raw = error.read(16384).decode('utf-8', errors='replace').replace(client.token, '[redacted]')
    PRIVATE.mkdir(parents=True, exist_ok=True)
    (PRIVATE / f'edge-deployment-error-{slug}.txt').write_text(raw, encoding='utf-8')
    raise CloudError(error.code, 'FUNCTION_DEPLOY_FAILED') from None
  except (urllib.error.URLError, TimeoutError, OSError):
    raise CloudError(None, 'FUNCTION_NETWORK_FAILED') from None
  report.update({key: result.get(key) for key in ('status', 'version', 'id')})
  report['deployedSlug'] = result.get('slug')
  return report


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
