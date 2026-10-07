"""Restauración de copias (scripts/backup_restore.py) contra un destino simulado: cuentas, datos, cursores, objetos y verificación."""
import hashlib, json, sys, tempfile, unittest, zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from backup_restore import restore  # noqa: E402
from cloud_backup import validate  # noqa: E402


class FakeTarget:
  def __init__(self):
    self.sql, self.users, self.objects, self.counts = [], [], {}, {}

  def query(self, sql):
    self.sql.append(sql)
    if sql.startswith('select column_name'):
      return [{'column_name': 'id'}, {'column_name': 'name'}]
    if sql.startswith('select count(*)'):
      table = sql.split('from ')[1].strip()
      return [{'n': self.counts.get(table, 0)}]
    if 'insert into' in sql:
      table = sql.split('insert into ')[1].split(' (')[0]
      payload = sql.split("jsonb_populate_recordset(null::" + table + ", '")[1].rsplit("'::jsonb", 1)[0].replace("''", "'")
      self.counts[table] = self.counts.get(table, 0) + len(json.loads(payload))
    return []

  def create_user(self, user):
    self.users.append(user['id'])
    return 'created'

  def upload(self, bucket, path, blob, mime='application/octet-stream'):
    self.objects[f'{bucket}/{path}'] = blob

  def download(self, bucket, path):
    return self.objects[f'{bucket}/{path}']


def make_backup(folder):
  rows = [json.dumps({'id': f'00000000-0000-0000-0000-00000000000{i}', 'name': f"O'Neill {i}"}) for i in range(3)]
  data = ('\n'.join(rows) + '\n').encode()
  users = (json.dumps({'id': 'u1', 'email': 'a@example.invalid'}) + '\n').encode()
  blob = b'imagen'
  manifest = {'format': 'IkisaiAppsBackup', 'version': 1, 'projectRef': 'x', 'createdAt': 'hoy', 'credentialsTransferred': False,
              'schemas': {'tasks': {'notes': {'rows': 3, 'sha256': hashlib.sha256(data).hexdigest(), 'orderBy': 'id'}}},
              'buckets': {'ikisai-files': {'tasks/a.webp': {'size': len(blob), 'sha256': hashlib.sha256(blob).hexdigest()}}},
              'authUsers': {'rows': 1, 'sha256': hashlib.sha256(users).hexdigest()}}
  path = Path(folder) / 'copia.zip'
  with zipfile.ZipFile(path, 'w') as z:
    z.writestr('manifest.json', json.dumps(manifest))
    z.writestr('data/tasks/notes.jsonl', data)
    z.writestr('auth/users.jsonl', users)
    z.writestr('objects/ikisai-files/tasks/a.webp', blob)
  return path


class RestoreTest(unittest.TestCase):
  def test_restaura_cuentas_datos_objetos_y_verifica(self):
    with tempfile.TemporaryDirectory() as folder:
      source = make_backup(folder)
      target = FakeTarget()
      report = restore(source, target, validate)
      self.assertEqual(report['status'], 'PASS', report)
      self.assertEqual(target.users, ['u1'])
      self.assertEqual(report['tables']['tasks.notes'], {'expected': 3, 'restored': 3})
      self.assertEqual(report['objects']['uploaded'], 1)
      self.assertTrue(any('session_replication_role = replica' in s for s in target.sql), 'sin disparadores ni claves ajenas durante la carga')

  def test_falla_si_faltan_filas(self):
    with tempfile.TemporaryDirectory() as folder:
      source = make_backup(folder)
      target = FakeTarget()
      target.query = lambda sql, q=target.query: [{'n': 1}] if sql.startswith('select count(*)') else q(sql)
      self.assertEqual(restore(source, target, validate, objects=False)['status'], 'FAIL')


if __name__ == '__main__':
  unittest.main()


class GuardTest(unittest.TestCase):
  def test_nunca_restaura_en_produccion(self):
    from cloud_management import PROJECT_REF, SupabaseManagement
    with self.assertRaises(ValueError):
      SupabaseManagement(restore_target={'projectRef': PROJECT_REF, 'accessToken': 'sbp_x'})
