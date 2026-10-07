"""Restauración real de una copia `IkisaiAppsBackup` en un proyecto Supabase de ensayo (ALMACENAMIENTO.md fase 4).

Nunca restaura sobre producción: el destino se lee de `private/restore-target.json` ({"projectRef", "accessToken"}) y se
rechaza si coincide con el proyecto de producción. El destino debe tener ya las migraciones aplicadas
(`deploy_supabase_schema.py` contra él) y las tablas de datos vacías.

Pasos (cada uno verificable y reanudable):
  1. Cuentas: crea en Auth del destino los usuarios de la copia con el mismo id y correo y una contraseña aleatoria que
     nadie conoce (cada persona pone una nueva). Sin contraseñas en la copia.
  2. Datos: carga cada tabla en lotes con los disparadores y las claves ajenas desactivados durante la sesión
     (`session_replication_role = replica`); las filas que ya existen por las migraciones (catálogos) se respetan.
  3. Cursores: core.app_state.cursor = máximo de core.changes por app.
  4. Objetos: los sube a los buckets del destino y comprueba tamaño y huella.
  5. Verificación: recuentos por tabla frente al manifiesto.
"""
import hashlib
import json
import secrets
import string
import zipfile

BATCH = 300


class RestoreTarget:
  """Destino de ensayo: SQL por la Management API y Auth/Storage con su service key. Se inyecta para poder probarlo."""

  def __init__(self, client):
    self.client = client

  def query(self, sql):
    return self.client.query(sql) or []

  def create_user(self, user):
    alphabet = string.ascii_letters + string.digits
    body = {'id': user['id'], 'email': user['email'], 'password': ''.join(secrets.choice(alphabet) for _ in range(40)), 'email_confirm': True,
            'user_metadata': user.get('user_metadata') or {}}
    try:
      self.client.project_request('/auth/v1/admin/users', body, method='POST', error_code='RESTORE_AUTH_FAILED')
      return 'created'
    except Exception as error:  # ya existe (reanudación): no es un fallo
      if getattr(error, 'status', None) in (409, 422):
        return 'exists'
      raise

  def upload(self, bucket, path, blob, mime='application/octet-stream'):
    self.client.project_request(f'/storage/v1/object/{bucket}/{path}', method='POST', raw_body=blob,
                                headers={'Content-Type': mime, 'x-upsert': 'true'}, error_code='RESTORE_STORAGE_FAILED')

  def download(self, bucket, path):
    return self.client.project_request(f'/storage/v1/object/{bucket}/{path}', headers={'Content-Type': 'application/octet-stream'}, error_code='RESTORE_STORAGE_FAILED')


def sql_text(value):
  return "'" + value.replace("'", "''") + "'"


def insertable_columns(target, schema, table):
  rows = target.query("select column_name from information_schema.columns where table_schema = " + sql_text(schema) + " and table_name = " + sql_text(table)
                      + " and is_generated = 'NEVER' and (identity_generation is null or identity_generation <> 'ALWAYS') order by ordinal_position")
  return [r['column_name'] for r in rows]


def restore(source, target, validate, objects=True):
  manifest = validate(source)
  report = {'users': {'created': 0, 'exists': 0}, 'tables': {}, 'objects': {'uploaded': 0, 'bytes': 0}, 'mismatches': []}
  with zipfile.ZipFile(source) as archive:
    # 1. Cuentas
    if 'auth/users.jsonl' in archive.namelist():
      for line in archive.read('auth/users.jsonl').decode('utf-8').splitlines():
        if line.strip():
          report['users'][target.create_user(json.loads(line))] += 1

    # 2. Datos, núcleo primero (los catálogos de apps dependen de core)
    order = sorted(manifest['schemas'].items(), key=lambda kv: (kv[0] != 'core', kv[0]))
    for schema, tables in order:
      for table, meta in sorted(tables.items()):
        columns = insertable_columns(target, schema, table)
        if not columns:
          report['mismatches'].append(f'{schema}.{table}: no existe en el destino')
          continue
        cols = ', '.join('"' + c + '"' for c in columns)
        rows = [line for line in archive.read(f'data/{schema}/{table}.jsonl').decode('utf-8').splitlines() if line.strip()]
        for i in range(0, len(rows), BATCH):
          payload = '[' + ','.join(rows[i:i + BATCH]) + ']'
          target.query("set session_replication_role = replica; "
                       f'insert into "{schema}"."{table}" ({cols}) select {cols} from jsonb_populate_recordset(null::"{schema}"."{table}", {sql_text(payload)}::jsonb) '
                       "on conflict do nothing; set session_replication_role = origin;")
        count = target.query(f'select count(*)::int as n from "{schema}"."{table}"')[0]['n']
        report['tables'][f'{schema}.{table}'] = {'expected': meta['rows'], 'restored': count}
        if count < meta['rows']:
          report['mismatches'].append(f'{schema}.{table}: {count} de {meta["rows"]} filas')

    # 3. Cursores de sincronización
    if 'core' in manifest['schemas'] and 'changes' in manifest['schemas']['core']:
      target.query("update core.app_state s set cursor = coalesce((select max(c.cursor) from core.changes c where c.app = s.app), 0)")

    # 4. Objetos
    if objects:
      for bucket, items in manifest['buckets'].items():
        for path, meta in sorted(items.items()):
          blob = archive.read(f'objects/{bucket}/{path}')
          target.upload(bucket, path, blob)
          back = target.download(bucket, path)
          if len(back) != meta['size'] or hashlib.sha256(back).hexdigest() != meta['sha256']:
            report['mismatches'].append(f'objeto {bucket}/{path}: huella distinta tras subirlo')
          report['objects']['uploaded'] += 1
          report['objects']['bytes'] += meta['size']

  report['status'] = 'PASS' if not report['mismatches'] else 'FAIL'
  return report
