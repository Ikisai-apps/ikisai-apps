#!/usr/bin/env python3
"""Construye y publica el frontend de una app en Cloudflare Pages. Plan por defecto; --apply publica; --domain enlaza DNS.

Flujo: `apps/<app>/dist` (si no existe: `npm run build --workspace apps/<app>`) → copia a `private/pages-build/<app>`
→ `version.json` (release, commit, frontendHash) + `_headers` + `_worker.js` (el del dist si la app trae
`public/_worker.js`; si no, uno generado que solo reenvía `/api/v1/*` al slug `<app>-api` y rechaza orígenes cruzados)
→ API de Pages al proyecto `ikisai-<app>` (se crea si no existe, rama de producción `main`).
Con --domain añade el dominio `<app>.ikisai.com` y un CNAME proxied a `ikisai-<app>.pages.dev`, sin sobrescribir
registros DNS ajenos (EXISTING_DOMAIN_RECORD_NO_OVERWRITE).
"""
import argparse
import base64
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import uuid

from apps import PROJECT_REF, add_app_argument, get_app
from cloud_management import PRIVATE, ROOT, CloudError, Cloudflare, run_cli

MIME = {'.js': 'application/javascript', '.mjs': 'application/javascript', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon'}
HEADERS = '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: same-origin\n  X-Frame-Options: DENY\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n\n/version.json\n  Cache-Control: no-cache\n\n/sw.js\n  Cache-Control: no-cache\n\n/index.html\n  Cache-Control: no-cache\n'
WORKER_TEMPLATE = """/* Pages advanced mode: proxy same-origin hacia la Edge de esta app; sin credenciales privadas en el bundle. */
const BACKEND='https://%(ref)s.supabase.co/functions/v1/%(slug)s';
export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(url.pathname.startsWith('/api/v1/') || url.pathname==='/health') {
      const origin=request.headers.get('origin');
      if(origin&&origin!==url.origin)return Response.json({error:{code:'ORIGIN_REJECTED',message:'Origen no autorizado.',details:null}},{status:403,headers:{'Cache-Control':'no-store'}});
      const headers=new Headers();
      for(const key of ['authorization','content-type','content-length','accept','if-none-match']) if(request.headers.has(key)) headers.set(key,request.headers.get(key));
      headers.set('Origin',url.origin);
      const response=await fetch(BACKEND+url.pathname+url.search,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body,redirect:'manual'});
      const outgoing=new Headers(response.headers);outgoing.set('Cache-Control','no-store');outgoing.set('X-Content-Type-Options','nosniff');
      return new Response(response.body,{status:response.status,headers:outgoing});
    }
    return env.ASSETS.fetch(request);
  }
};
"""


def mime_for(path):
  return MIME.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or 'application/octet-stream'


def ensure_dist(app):
  dist = ROOT / app['dist_dir']
  if dist.is_dir() and any(dist.iterdir()):
    return dist, False
  npm = shutil.which('npm')
  if not npm:
    raise CloudError(None, 'FRONTEND_BUILD_FAILED', 'npm no está disponible y no existe ' + app['dist_dir'])
  result = subprocess.run([npm, 'run', 'build', '--workspace', app['app_dir']], cwd=ROOT, capture_output=True, text=True)
  if result.returncode != 0 or not dist.is_dir() or not any(dist.iterdir()):
    detail = (result.stderr or result.stdout or '').strip()[-1500:]
    raise CloudError(None, 'FRONTEND_BUILD_FAILED', f'`npm run build --workspace {app["app_dir"]}` falló o no produjo {app["dist_dir"]}: {detail}')
  return dist, True


def commit_hash():
  sha = os.environ.get('GITHUB_SHA')
  if sha:
    return sha
  try:
    return subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True, stderr=subprocess.DEVNULL).strip()
  except (OSError, subprocess.CalledProcessError):
    return 'unknown'


def build(app, release=None):
  dist, built = ensure_dist(app)
  target = PRIVATE / 'pages-build' / app['name']
  if target.exists():
    shutil.rmtree(target)
  shutil.copytree(dist, target)
  worker_source = 'dist' if (target / '_worker.js').is_file() else 'generated'
  if worker_source == 'generated':
    (target / '_worker.js').write_text(WORKER_TEMPLATE % {'ref': PROJECT_REF, 'slug': app['function_slug']}, encoding='utf-8')
  (target / '_headers').write_text(HEADERS, encoding='utf-8')
  (target / 'version.json').unlink(missing_ok=True)
  digest = hashlib.sha256()
  for file in sorted(target.rglob('*')):
    if file.is_file():
      digest.update(file.relative_to(target).as_posix().encode())
      digest.update(file.read_bytes())
  frontend = digest.hexdigest()
  release = release or os.environ.get('IKISAI_RELEASE') or frontend[:12]
  version = {'release': release, 'commit': commit_hash(), 'frontendHash': frontend}
  (target / 'version.json').write_text(json.dumps(version), encoding='utf-8')
  sw = target / 'sw.js'
  if sw.is_file():
    sw.write_text(re.sub(r'ikisai-shell-[A-Za-z0-9_-]+', 'ikisai-shell-' + frontend[:16], sw.read_text(encoding='utf-8'), count=1), encoding='utf-8')
  return target, version, {'built': built, 'worker': worker_source}


def deploy(app_name, apply=False, domain=False, credentials=None):
  app = get_app(app_name)
  client = Cloudflare(credentials)  # también en plan: valida la configuración sin llamar a la API
  if domain and not client.zone:
    raise ValueError('CLOUDFLARE_ZONE_ID is required to bind the domain')
  target, version, info = build(app)
  files = [p for p in sorted(target.rglob('*')) if p.is_file() and p.name not in ('_worker.js', '_headers')]
  project = app['pages_project']
  report = {'app': app_name, 'project': project, 'domain': app['domain'], 'apply': apply, 'bindDomain': domain, 'assets': len(files), 'buildDir': str(target.relative_to(ROOT)).replace('\\', '/'), 'version': version, 'privateCredentialsIncluded': False, **info}
  if not apply:
    return report
  route = f'/accounts/{client.account}/pages/projects/{project}'
  try:
    client.request(route)
    report['projectCreated'] = False
  except CloudError as error:
    if error.status != 404:
      raise
    client.request(f'/accounts/{client.account}/pages/projects', {'name': project, 'production_branch': 'main'})
    report['projectCreated'] = True
  token = client.request(route + '/upload-token')['jwt']
  assets = []
  manifest = {}
  for file in files:
    data = file.read_bytes()
    name = '/' + file.relative_to(target).as_posix()
    digest = hashlib.sha256(data + file.suffix.encode()).hexdigest()[:32]
    manifest[name] = digest
    assets.append({'key': digest, 'value': base64.b64encode(data).decode(), 'base64': True, 'metadata': {'contentType': mime_for(file)}})
  missing = set(client.request('/pages/assets/check-missing', {'hashes': list(manifest.values())}, token=token) or [])
  if missing:
    pending = [asset for asset in assets if asset['key'] in missing]
    for start in range(0, len(pending), 50):
      client.request('/pages/assets/upload', pending[start:start + 50], token=token)
  client.request('/pages/assets/upsert-hashes', {'hashes': list(manifest.values())}, token=token)
  boundary = 'ikisai-' + uuid.uuid4().hex
  parts = []
  for name, value in [('manifest', json.dumps(manifest)), ('branch', 'main'), ('commit_hash', version['commit']), ('commit_message', f'Ikisai {app_name} {version["release"]}'), ('commit_dirty', 'false')]:
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
  for name in ('_worker.js', '_headers'):
    mime = 'application/javascript' if name.endswith('.js') else 'text/plain'
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{name}"\r\nContent-Type: {mime}\r\n\r\n'.encode() + (target / name).read_bytes() + b'\r\n')
  parts.append(f'--{boundary}--\r\n'.encode())
  result = client.request(route + '/deployments', b''.join(parts), method='POST', content_type='multipart/form-data; boundary=' + boundary)
  report.update({'deploymentId': result['id'], 'url': result.get('url'), 'stage': (result.get('latest_stage') or {}).get('status'), 'newAssetsUploaded': len(missing)})
  if domain:
    report.update(bind_domains(client, app))
  return report


def bind_domains(client, app):
  """Enlaza al proyecto Pages el dominio de la app y sus dominios adicionales (CNAME proxied a <proyecto>.pages.dev)."""
  project = app['pages_project']
  route = f'/accounts/{client.account}/pages/projects/{project}'
  out = {'domains': {}}
  for hostname in [app['domain'], *app.get('extra_domains', [])]:
    out['domains'][hostname] = bind_hostname(client, route, project, hostname)
  return out


def bind_hostname(client, route, project, hostname):
    report = {}
    cname = project + '.pages.dev'
    domains = client.request(route + '/domains') or []
    if not any(d.get('name') == hostname for d in domains):
      client.request(route + '/domains', {'name': hostname})
    records = client.request(f'/zones/{client.zone}/dns_records', params={'name': hostname}) or []
    if records:
      if len(records) != 1 or records[0].get('type') != 'CNAME' or records[0].get('content') != cname:
        raise CloudError(None, 'EXISTING_DOMAIN_RECORD_NO_OVERWRITE')
      report['dnsRecord'] = 'existing'
    else:
      client.request(f'/zones/{client.zone}/dns_records', {'type': 'CNAME', 'name': hostname, 'content': cname, 'proxied': True, 'ttl': 1})
      report['dnsRecord'] = 'created'
    report['domainStatus'] = (client.request(route + '/domains/' + hostname) or {}).get('status')
    return report


if __name__ == '__main__':
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  add_app_argument(parser)
  parser.add_argument('--apply', action='store_true', help='publica en Pages (por defecto solo plan y build local)')
  parser.add_argument('--domain', action='store_true', help='con --apply, enlaza <app>.ikisai.com, sus dominios adicionales y sus CNAME')
  parser.add_argument('--bind-only', action='store_true', help='solo enlaza los dominios (sin construir ni publicar); con --apply')
  parser.add_argument('--credentials', help='ruta alternativa a private/cloud-credentials.json')
  parser.add_argument('--report', help='informe JSON (por defecto private/pages-deployment-<app>.json)')
  args = parser.parse_args()
  if args.bind_only:
    run_cli(lambda: bind_domains(Cloudflare(args.credentials), get_app(args.app)) if args.apply else {'plan': [get_app(args.app)['domain'], *get_app(args.app)['extra_domains']]})
  else:
    run_cli(lambda: deploy(args.app, args.apply, args.domain, args.credentials), args.report or str(PRIVATE / f'pages-deployment-{args.app}.json'))
