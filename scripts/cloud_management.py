"""Clientes de la Management API de Supabase y de la API de Cloudflare.

Los tokens viven en el entorno de CI o en `private/cloud-credentials.json` (ignorado por Git):

  {"supabase":  {"projectRef": "ctytaorylbninfyupfsn", "projectUrl": "https://...supabase.co", "accessToken": "sbp_..."},
   "cloudflare": {"accountId": "...", "zoneId": "...", "apiToken": "...", "zone": "ikisai.com"}}

Reglas defensivas compartidas por todos los scripts: sin redirecciones, solo rutas conocidas,
nunca se imprime el cuerpo de error del proveedor (solo un código de dominio) y los informes van a `private/`.
"""
import json, time
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / 'private'
PROJECT_REF = 'ctytaorylbninfyupfsn'
ZONE = 'ikisai.com'
DEFAULT_CREDENTIALS = PRIVATE / 'cloud-credentials.json'

# Códigos de dominio del núcleo (contrato §5) y del antiguo ikisai.* que todavía pueden aparecer en errores SQL.
DATABASE_ERRORS = {
  'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VERSION_CONFLICT', 'CURSOR_CONFLICT', 'IDEMPOTENCY_REUSE',
  'INVALID_FIELDS', 'INVALID_OPERATION', 'PAYLOAD_TOO_LARGE', 'CONFIRMATION_REQUIRED', 'BACKEND_UNAVAILABLE',
  'NO_MEMBERSHIP', 'APP_NOT_FOUND', 'APP_EXISTS_NO_OVERWRITE', 'INVALID_REQUEST', 'INVALID_EVENT', 'INVALID_STATE',
}


class CloudError(Exception):
  def __init__(self, status, code='CLOUD_REQUEST_FAILED', message=None, path=None):
    self.status = status
    self.code = code
    self.message = message
    self.path = path
    super().__init__(code)


class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self, *args, **kwargs):
    return None


def load_credentials(file=None):
  """Devuelve el JSON de credenciales. Lanza OSError/ValueError si no existe o está mal formado."""
  data = json.loads(Path(file or DEFAULT_CREDENTIALS).read_text(encoding='utf-8'))
  if not isinstance(data, dict):
    raise ValueError('Credentials file must contain an object')
  return data


def sql_literal(value):
  """Literal SQL seguro para texto (comillas duplicadas); los scripts validan antes el formato del valor."""
  if not isinstance(value, str) or '\x00' in value:
    raise ValueError('Invalid SQL text value')
  return "'" + value.replace("'", "''") + "'"


def json_literal(value):
  return "'" + json.dumps(value, ensure_ascii=False, allow_nan=False).replace("'", "''") + "'::jsonb"


class SupabaseManagement:
  def __init__(self, file=None, restore_target=None):
    if restore_target is not None:
      # Proyecto de ensayo para restauraciones: nunca el de producción.
      config = restore_target
      if not isinstance(config.get('projectRef'), str) or not re.fullmatch(r'[a-z]{20}', config['projectRef']) or config['projectRef'] == PROJECT_REF:
        raise ValueError('Restore target must be a different, valid project')
      if not isinstance(config.get('accessToken'), str) or not config['accessToken'].startswith('sbp_'):
        raise ValueError('Invalid administrative token for the restore target')
    elif os.environ.get('SUPABASE_ACCESS_TOKEN'):
      config = {'projectRef': PROJECT_REF, 'accessToken': os.environ['SUPABASE_ACCESS_TOKEN']}
    else:
      config = load_credentials(file)['supabase']
    if restore_target is None and (config.get('projectRef') != PROJECT_REF or not isinstance(config.get('accessToken'), str) or not config['accessToken'].startswith('sbp_')):
      raise ValueError('Invalid authorized project or administrative token')
    self.ref = config['projectRef']
    self.token = config['accessToken']
    self.base = 'https://api.supabase.com/v1/projects/' + self.ref
    self.project_url = 'https://' + self.ref + '.supabase.co'
    self.opener = urllib.request.build_opener(NoRedirect())
    self._service_key = None

  def request(self, path, body=None, method=None, params=None):
    if not isinstance(path, str) or not re.fullmatch(r'/[A-Za-z0-9_/-]+', path) or '..' in path:
      raise ValueError('Invalid API route')
    url = self.base + path
    if params:
      url += '?' + urllib.parse.urlencode(params)
    payload = None if body is None else json.dumps(body, ensure_ascii=False, allow_nan=False).encode('utf-8')
    req = urllib.request.Request(url, data=payload, method=method, headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json', 'Accept': 'application/json'})
    try:
      try:
        with self.opener.open(req, timeout=45) as response:
          raw = response.read()
          return json.loads(raw) if raw else None
      except urllib.error.HTTPError as first:
        # Reintentos con espera creciente ante 5xx del proveedor, solo en llamadas idempotentes
        # (GET y la consulta de solo lectura). Observado: "FGA Authentication Error" intermitente desde runners de GitHub.
        if first.code < 500 or (method not in (None, 'GET') and not (path == '/database/query' and body and body.get('read_only'))):
          raise
        first.read()
        last = first
        for delay in (5, 20, 60):
          time.sleep(delay)
          try:
            with self.opener.open(req, timeout=45) as response:
              raw = response.read()
              return json.loads(raw) if raw else None
          except urllib.error.HTTPError as again:
            if again.code < 500:
              raise
            again.read()
            last = again
        raise last
    except urllib.error.HTTPError as e:
      # Solo se devuelve un nombre de error conocido, nunca el cuerpo del proveedor ni el SQL.
      raw = e.read(16384).decode('utf-8', errors='replace')
      if os.environ.get('IKISAI_DEBUG'):
        sys.stderr.write('[cloud] %s %s -> %s %s\n' % (method or 'GET', path, e.code, raw[:300].replace(self.token, '[redacted]').replace('\n', ' ')))
      code = 'CLOUD_REQUEST_FAILED'
      for expected in DATABASE_ERRORS:
        if re.search(r'\b' + expected + r'\b', raw):
          code = expected
          break
      sqlstate = re.search(r'ERROR:\s*([A-Z0-9]{5}):', raw)
      if code == 'CLOUD_REQUEST_FAILED' and sqlstate:
        code = 'DATABASE_ERROR_' + sqlstate.group(1)
      raise CloudError(e.code, code, path=path) from None
    except (urllib.error.URLError, TimeoutError, OSError):
      raise CloudError(None, 'CLOUD_NETWORK_FAILED') from None

  def query(self, sql, parameters=None, read_only=False):
    body = {'query': sql, 'read_only': read_only}
    if parameters is not None:
      body['parameters'] = parameters
    return self.request('/database/query', body)

  def service_role_key(self):
    """Clave service_role revelada por la Management API; solo vive en memoria del proceso."""
    if self._service_key is None:
      keys = self.request('/api-keys', params={'reveal': 'true'})
      key = next((k.get('api_key') for k in keys if k.get('name') == 'service_role'), None)
      if not isinstance(key, str) or not key:
        raise CloudError(None, 'SERVICE_KEY_UNAVAILABLE')
      self._service_key = key
    return self._service_key

  def project_request(self, path, body=None, method=None, headers=None, timeout=45, raw_body=None, error_code='PROJECT_REQUEST_FAILED'):
    """Petición al proyecto (Auth Admin / Storage) con la service key. Devuelve bytes."""
    if not isinstance(path, str) or not path.startswith('/') or '..' in path:
      raise ValueError('Invalid project route')
    key = self.service_role_key()
    base_headers = {'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}
    base_headers.update(headers or {})
    data = raw_body if raw_body is not None else None if body is None else json.dumps(body, ensure_ascii=False, allow_nan=False).encode('utf-8')
    req = urllib.request.Request(self.project_url + path, data=data, method=method, headers=base_headers)
    try:
      with self.opener.open(req, timeout=timeout) as response:
        return response.read()
    except urllib.error.HTTPError as error:
      error.read()
      raise CloudError(error.code, error_code) from None
    except (urllib.error.URLError, TimeoutError, OSError):
      raise CloudError(None, 'PROJECT_NETWORK_FAILED') from None


class Cloudflare:
  """API de Cloudflare (Pages + DNS). Lee CLOUDFLARE_* del entorno o la sección `cloudflare` de las credenciales."""

  def __init__(self, file=None):
    if os.environ.get('CLOUDFLARE_API_TOKEN'):
      config = {'apiToken': os.environ['CLOUDFLARE_API_TOKEN'], 'accountId': os.environ.get('CLOUDFLARE_ACCOUNT_ID'), 'zoneId': os.environ.get('CLOUDFLARE_ZONE_ID'), 'zone': ZONE}
    else:
      config = load_credentials(file)['cloudflare']
    for field in ('apiToken', 'accountId'):
      if not isinstance(config.get(field), str) or not config[field]:
        raise ValueError('Missing Cloudflare ' + field)
    if config.get('zone', ZONE) != ZONE:
      raise ValueError('Unexpected authorized zone')
    if 'domain' in config:
      raise ValueError('The cloudflare section no longer takes a fixed domain; the app decides it')
    self.token = config['apiToken']
    self.account = config['accountId']
    self.zone = config.get('zoneId') or None
    self.opener = urllib.request.build_opener(NoRedirect())

  def request(self, path, body=None, method=None, token=None, content_type='application/json', params=None):
    if not isinstance(path, str) or not path.startswith('/') or '..' in path or '?' in path:
      raise ValueError('Invalid route')
    url = 'https://api.cloudflare.com/client/v4' + path
    if params:
      url += '?' + urllib.parse.urlencode(params)
    raw = body if isinstance(body, bytes) else None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=raw, method=method, headers={'Authorization': 'Bearer ' + (token or self.token), 'Content-Type': content_type})
    try:
      with self.opener.open(req, timeout=60) as response:
        result = json.loads(response.read())
    except urllib.error.HTTPError as error:
      error.read()
      raise CloudError(error.code, 'CLOUDFLARE_REQUEST_FAILED') from None
    except (urllib.error.URLError, TimeoutError, OSError):
      raise CloudError(None, 'CLOUDFLARE_NETWORK_FAILED') from None
    if not result.get('success'):
      raise CloudError(None, 'CLOUDFLARE_OPERATION_REJECTED')
    return result.get('result')


def write_report(path, report):
  """Escribe un informe JSON en private/ (creándolo) y devuelve el informe."""
  path = Path(path)
  path.parent.mkdir(parents=True, exist_ok=True)
  path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
  return report


def run_cli(action, report_path=None):
  """Ejecuta `action()` e imprime JSON. Códigos de salida: 0 OK, 1 error de nube o configuración inválida."""
  try:
    report = action()
    if report_path:
      write_report(report_path, report)
    print(json.dumps(report, ensure_ascii=False))
    return 0
  except CloudError as error:
    payload = {'status': 'error', 'code': error.code, 'httpStatus': error.status}
    if getattr(error, 'path', None):
      payload['path'] = error.path
    if error.message:
      payload['message'] = error.message
    print(json.dumps(payload))
    sys.exit(1)
  except (OSError, ValueError, KeyError, TypeError):
    if os.environ.get('IKISAI_DEBUG'):
      raise
    print(json.dumps({'status': 'invalid_configuration'}))
    sys.exit(1)
