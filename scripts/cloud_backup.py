#!/usr/bin/env python3
"""Copia de seguridad del proyecto: schemas `core`, `tasks`, `invoices`, `booking`, `food` (los que existan) y los
buckets registrados en `scripts/apps.py`, con hash SHA-256 de cada tabla y de cada objeto.

  backup  --output RUTA.zip           exporta por /database/query en lotes y descarga los objetos; verifica el zip
  verify  --source RUTA.zip           comprueba inventario y hashes
  restore --source RUTA.zip --plan    plan de restauración (solo lectura)
  restore --source RUTA.zip --apply   restauración real en el proyecto de ensayo de private/restore-target.json (nunca producción)

No se guardan tokens ni sesiones en el archivo. La service key (solo para Storage) se revela desde la Management
API y vive en memoria.
"""
import argparse
import hashlib
import json
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from apps import ALL_SCHEMAS, BUCKETS
from cloud_management import PRIVATE, CloudError, SupabaseManagement, run_cli
from backup_restore import RestoreTarget, restore

FORMAT = 'IkisaiAppsBackup'
BATCH = 500
IDENT = re.compile(r'^[a-z_][a-z0-9_]*$')
OBJECT = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*$')
MAX_ENTRY = 256 * 1024 * 1024


def ident(name):
  if not isinstance(name, str) or not IDENT.fullmatch(name) or len(name) > 63:
    raise ValueError('Invalid SQL identifier')
  return name


def existing_schemas(client):
  names = ','.join("'" + s + "'" for s in ALL_SCHEMAS)
  rows = client.query(f"select nspname from pg_catalog.pg_namespace where nspname in ({names}) order by nspname", read_only=True) or []
  return [ident(r['nspname']) for r in rows]


def tables(client, schema):
  rows = client.query(f"select tablename from pg_catalog.pg_tables where schemaname = '{ident(schema)}' order by tablename", read_only=True) or []
  return [ident(r['tablename']) for r in rows]


def order_columns(client, schema, table):
  rows = client.query(
    "select a.attname from pg_catalog.pg_index i join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)"
    f" where i.indrelid = '{ident(schema)}.{ident(table)}'::regclass and i.indisprimary order by array_position(i.indkey, a.attnum)", read_only=True) or []
  columns = [ident(r['attname']) for r in rows]
  return ', '.join('"' + c + '"' for c in columns) if columns else 'ctid'


def export_table(client, schema, table):
  """Devuelve (bytes JSONL, filas, orden). Lotes de BATCH filas por /database/query, solo lectura."""
  order = order_columns(client, schema, table)
  lines = []
  offset = 0
  while True:
    rows = client.query(f'select to_jsonb(t) as row from (select * from "{ident(schema)}"."{ident(table)}" order by {order} offset {offset} limit {BATCH}) t', read_only=True) or []
    lines.extend(json.dumps(r['row'], ensure_ascii=False, allow_nan=False, sort_keys=True) for r in rows)
    if len(rows) < BATCH:
      break
    offset += BATCH
  data = ('\n'.join(lines) + ('\n' if lines else '')).encode('utf-8')
  return data, len(lines), order


class Storage:
  def __init__(self, client):
    self.client = client

  def buckets(self):
    raw = self.client.project_request('/storage/v1/bucket', error_code='BACKUP_STORAGE_FAILED')
    return [b['id'] for b in json.loads(raw) if isinstance(b, dict) and b.get('id') in BUCKETS]

  def list(self, bucket, prefix=''):
    objects = {}
    offset = 0
    while True:
      raw = self.client.project_request('/storage/v1/object/list/' + bucket, {'prefix': prefix, 'limit': 1000, 'offset': offset, 'sortBy': {'column': 'name', 'order': 'asc'}}, error_code='BACKUP_STORAGE_FAILED')
      entries = json.loads(raw) or []
      for entry in entries:
        name = (prefix + entry['name']) if prefix else entry['name']
        if entry.get('id') is None:
          objects.update(self.list(bucket, name + '/'))
        else:
          if not OBJECT.fullmatch(name):
            raise ValueError('Unexpected object path')
          objects[name] = {'size': (entry.get('metadata') or {}).get('size')}
      if len(entries) < 1000:
        return objects
      offset += 1000

  def download(self, bucket, path):
    if not OBJECT.fullmatch(path):
      raise ValueError('Invalid object path')
    return self.client.project_request(f'/storage/v1/object/{bucket}/{path}', headers={'Content-Type': 'application/octet-stream'}, error_code='BACKUP_STORAGE_FAILED')


def backup(client, destination):
  destination = Path(destination).resolve()
  if destination.exists():
    raise ValueError('Backup destination already exists')
  manifest = {'format': FORMAT, 'version': 1, 'projectRef': client.ref, 'createdAt': datetime.now(timezone.utc).isoformat(), 'schemas': {}, 'buckets': {}, 'credentialsTransferred': False}
  storage = Storage(client)
  destination.parent.mkdir(parents=True, exist_ok=True)
  try:
    with zipfile.ZipFile(destination, 'x', zipfile.ZIP_DEFLATED) as archive:
      for schema in existing_schemas(client):
        manifest['schemas'][schema] = {}
        for table in tables(client, schema):
          data, count, order = export_table(client, schema, table)
          manifest['schemas'][schema][table] = {'rows': count, 'sha256': hashlib.sha256(data).hexdigest(), 'orderBy': order}
          archive.writestr(f'data/{schema}/{table}.jsonl', data)
      # Cuentas sin contraseñas ni sesiones: id, correo y metadatos, para que una restauración no deje pertenencias sin dueño.
      users = client.query("select jsonb_build_object('id', id, 'email', email, 'created_at', created_at, 'user_metadata', coalesce(raw_user_meta_data, '{}'::jsonb)) as u "
                           "from auth.users where email is not null order by created_at") or []
      user_data = ('\n'.join(json.dumps(r['u'], ensure_ascii=False, sort_keys=True) for r in users) + ('\n' if users else '')).encode('utf-8')
      manifest['authUsers'] = {'rows': len(users), 'sha256': hashlib.sha256(user_data).hexdigest()}
      archive.writestr('auth/users.jsonl', user_data)
      for bucket in storage.buckets():
        manifest['buckets'][bucket] = {}
        for path, meta in sorted(storage.list(bucket).items()):
          blob = storage.download(bucket, path)
          if isinstance(meta.get('size'), int) and meta['size'] != len(blob):
            raise ValueError('Object size mismatch while downloading')
          manifest['buckets'][bucket][path] = {'size': len(blob), 'sha256': hashlib.sha256(blob).hexdigest()}
          archive.writestr(f'objects/{bucket}/{path}', blob)
      archive.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, allow_nan=False, sort_keys=True))
    try:
      destination.chmod(0o600)
    except OSError:
      pass
    validate(destination)
  except BaseException:
    destination.unlink(missing_ok=True)
    raise
  return {'status': 'PASS', 'output': str(destination), 'schemas': {s: len(t) for s, t in manifest['schemas'].items()}, 'rows': sum(t['rows'] for s in manifest['schemas'].values() for t in s.values()),
          'buckets': {b: len(o) for b, o in manifest['buckets'].items()}, 'credentialsTransferred': False}


def validate(source):
  """Comprueba inventario exacto y hashes. Devuelve el manifiesto."""
  with zipfile.ZipFile(source) as archive:
    names = archive.namelist()
    if len(names) != len(set(names)) or 'manifest.json' not in names:
      raise ValueError('Invalid backup entries')
    for item in archive.infolist():
      if item.file_size > MAX_ENTRY or (item.filename not in ('manifest.json', 'auth/users.jsonl') and not re.fullmatch(r'(data/[a-z_][a-z0-9_]*/[a-z_][a-z0-9_]*\.jsonl|objects/[a-z0-9-]+/[A-Za-z0-9][A-Za-z0-9._/-]*)', item.filename)) or '..' in item.filename.split('/'):
        raise ValueError('Invalid backup path or size')
    manifest = json.loads(archive.read('manifest.json'))
    if manifest.get('format') != FORMAT or manifest.get('version') != 1 or manifest.get('credentialsTransferred') is not False:
      raise ValueError('Invalid backup manifest')
    expected = {'manifest.json'}
    if 'authUsers' in manifest:
      expected.add('auth/users.jsonl')
      data = archive.read('auth/users.jsonl')
      if hashlib.sha256(data).hexdigest() != manifest['authUsers']['sha256'] or data.count(b'\n') != manifest['authUsers']['rows']:
        raise ValueError('Auth users hash or row count mismatch')
    for schema, items in manifest['schemas'].items():
      for table, meta in items.items():
        entry = f'data/{ident(schema)}/{ident(table)}.jsonl'
        expected.add(entry)
        data = archive.read(entry)
        if hashlib.sha256(data).hexdigest() != meta['sha256'] or data.count(b'\n') != meta['rows']:
          raise ValueError('Table hash or row count mismatch: ' + entry)
    for bucket, objects in manifest['buckets'].items():
      for path, meta in objects.items():
        entry = f'objects/{bucket}/{path}'
        expected.add(entry)
        blob = archive.read(entry)
        if len(blob) != meta['size'] or hashlib.sha256(blob).hexdigest() != meta['sha256']:
          raise ValueError('Object hash mismatch: ' + entry)
    if set(names) != expected:
      raise ValueError('Backup inventory mismatch')
  return manifest


def restore_plan(source):
  """Plan documentado de restauración. La ejecución real queda pendiente (ver docs/core/DESPLIEGUE.md)."""
  manifest = validate(source)
  plan = {
    'schemas': {s: {'tables': len(t), 'rows': sum(m['rows'] for m in t.values())} for s, t in manifest['schemas'].items()},
    'buckets': {b: {'objects': len(o), 'bytes': sum(m['size'] for m in o.values())} for b, o in manifest['buckets'].items()},
    'steps': [
      'Proyecto destino vacío (sin schemas core/tasks/invoices/booking/food) y migraciones de este repo aplicadas con deploy_supabase_schema.py.',
      'Desactivar triggers core_touch_revision durante la carga y cargar data/<schema>/<tabla>.jsonl en orden core → apps (padres antes que hijos).',
      'Restaurar objetos de objects/<bucket>/<ruta> en buckets privados creados con configure_supabase_storage.py y verificar hashes.',
      'Recalcular core.app_state.cursor = max(core.changes.cursor) por app y verificar recuentos frente al manifiesto.',
      'Las pertenencias (core.memberships) no se activan automáticamente: se revisan a mano.',
    ],
  }
  return {'apply': False, 'restoreImplemented': True, 'sourceProject': manifest['projectRef'], 'createdAt': manifest['createdAt'], 'plan': plan, 'credentialsTransferred': False}


if __name__ == '__main__':
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  sub = parser.add_subparsers(dest='command', required=True)
  b = sub.add_parser('backup')
  b.add_argument('--output', required=True)
  b.add_argument('--credentials')
  v = sub.add_parser('verify')
  v.add_argument('--source', required=True)
  r = sub.add_parser('restore')
  r.add_argument('--source', required=True)
  r.add_argument('--plan', action='store_true', help='plan de solo lectura')
  r.add_argument('--apply', action='store_true', help='restaura en el proyecto de ensayo (private/restore-target.json)')
  r.add_argument('--no-objects', action='store_true', help='solo base de datos y cuentas')
  args = parser.parse_args()
  if args.command == 'restore' and args.plan == args.apply:
    parser.error('restore necesita --plan o --apply (uno de los dos)')

  def action():
    if args.command == 'verify':
      manifest = validate(args.source)
      return {'status': 'PASS', 'schemas': {s: len(t) for s, t in manifest['schemas'].items()}, 'buckets': {k: len(o) for k, o in manifest['buckets'].items()}}
    if args.command == 'backup':
      return backup(SupabaseManagement(args.credentials), args.output)
    if args.plan:
      return restore_plan(args.source)
    target = json.loads((PRIVATE / 'restore-target.json').read_text(encoding='utf-8'))
    return restore(args.source, RestoreTarget(SupabaseManagement(restore_target=target)), validate, objects=not args.no_objects)

  try:
    run_cli(action)
  except zipfile.BadZipFile:
    print(json.dumps({'status': 'invalid_backup_archive'}))
    raise SystemExit(1)
