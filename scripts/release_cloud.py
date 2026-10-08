#!/usr/bin/env python3
"""Publica una versión de una app en orden (schema → function → pages [→ domain]) y verifica la release exacta.

`python scripts/release_cloud.py --app <app> --version vX.Y.Z[-sufijo] [--apply] [--bind-domain]`
Plan por defecto: cada paso informa de lo que haría. Con --apply publica y después comprueba hasta 6 veces que
`https://<app>.ikisai.com/version.json` y `/api/v1/health` devuelven la misma `release`. Nunca importa datos.
Informe en `private/release-<app>.json` (también cuando un paso falla, con `status: error`).
"""
import argparse
import json
import os
import re
import time
import urllib.request

from apps import add_app_argument, get_app
from cloud_management import PRIVATE, CloudError, SupabaseManagement, run_cli, write_report
from deploy_cloudflare_pages import deploy as pages
from deploy_supabase_function import deploy as edge
from deploy_supabase_schema import deploy as schema

VERSION = re.compile(r'v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?')


def fetch_json(url):
  req = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36'})
  with urllib.request.urlopen(req, timeout=20) as response:
    return json.loads(response.read())


def verify(domain, version, attempts=12, wait=10):
  # ~2 min: la Edge nueva tarda a veces más de 30 s en propagarse (falsos RELEASE_VERIFICATION_FAILED, 8-10-2026).
  # El cuerpo sigue igual.
  base = 'https://' + domain
  last = None
  for attempt in range(attempts):
    try:
      site = fetch_json(base + '/version.json')
      health = fetch_json(base + '/api/v1/health')
      last = {'versionJson': site.get('release'), 'health': health.get('release'), 'attempt': attempt + 1}
      if site.get('release') == version and health.get('release') == version:
        return {'verified': True, **last}
    except (OSError, ValueError, KeyError, AttributeError):
      last = {'attempt': attempt + 1, 'error': 'unreachable_or_invalid'}
    if attempt < attempts - 1:
      time.sleep(wait)
  raise CloudError(None, 'RELEASE_VERIFICATION_FAILED', json.dumps(last))


def release(app_name, version, apply=False, bind_domain=False, credentials=None, report_path=None, skip_schema=False):
  app = get_app(app_name)
  if not VERSION.fullmatch(version):
    raise ValueError('Expected a version such as v0.1.0-beta.1')
  os.environ['IKISAI_RELEASE'] = version
  report_path = report_path or PRIVATE / f'release-{app_name}.json'
  report = {'app': app_name, 'release': version, 'apply': apply, 'bindDomain': bind_domain, 'domain': app['domain'], 'steps': {}, 'status': 'planned' if not apply else 'in_progress'}
  client = SupabaseManagement(credentials)
  current = 'schema'
  try:
    # En la CI las migraciones se aplican una vez en un trabajo previo (`--skip-schema`): si cada app las aplicara en
    # paralelo, dos trabajos podían aplicar la misma a la vez (42P07, release de la #141).
    report['steps']['schema'] = {'skipped': True} if skip_schema else schema(client, apply)
    current = 'function'
    report['steps']['function'] = edge(client, app_name, apply, release=version)
    current = 'pages'
    report['steps']['pages'] = pages(app_name, apply, bind_domain, credentials)
    if apply:
      current = 'verification'
      report['verification'] = verify(app['domain'], version)
      report['status'] = 'PASS'
  except CloudError as error:
    report.update({'status': 'error', 'failedStep': current, 'code': error.code})
    write_report(report_path, report)
    raise
  return report


if __name__ == '__main__':
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  add_app_argument(parser)
  parser.add_argument('--version', required=True, help='vX.Y.Z o vX.Y.Z-sufijo')
  parser.add_argument('--apply', action='store_true', help='publica de verdad (solo Core/CI); por defecto plan')
  parser.add_argument('--bind-domain', action='store_true', help='tras publicar Pages, enlaza <app>.ikisai.com y su CNAME')
  parser.add_argument('--credentials', help='ruta alternativa a private/cloud-credentials.json')
  parser.add_argument('--report', help='informe JSON (por defecto private/release-<app>.json)')
  parser.add_argument('--skip-schema', action='store_true', help='no aplica migraciones (ya las aplicó el trabajo de migraciones de la release)')
  args = parser.parse_args()
  path = args.report or str(PRIVATE / f'release-{args.app}.json')
  run_cli(lambda: release(args.app, args.version, args.apply, args.bind_domain, args.credentials, path, args.skip_schema), path)
