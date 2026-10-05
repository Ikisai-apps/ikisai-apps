#!/usr/bin/env python3
"""Da el rol `owner` de una app a un usuario (`--app <app> --email <email>`). Plan por defecto.

- Busca el usuario en Auth por email con la Management API (consulta de solo lectura sobre auth.users).
- Si no existe y se pasa --apply, lo crea con la Auth Admin API (service key revelada por la Management API)
  con una contraseña aleatoria que se guarda SOLO en `private/owner-<app>.json` (ignorado por Git).
- Después inserta `core.profiles` (on conflict do nothing) y `core.memberships (app, user_id, role='owner')`
  (on conflict do update set role='owner'). La app debe existir en `core.apps` (lo hacen las migraciones).
- Si la cuenta se creó aquí y la transacción SQL falla, se borra esa cuenta nueva.
"""
import argparse
import json
import re
import secrets
from datetime import datetime, timezone

from apps import add_app_argument, get_app
from cloud_management import PRIVATE, CloudError, SupabaseManagement, run_cli, sql_literal

EMAIL = re.compile(r'^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')


def find_user(client, email):
  rows = client.query(f"select id::text as id from auth.users where lower(email) = lower({sql_literal(email)}) limit 2", read_only=True) or []
  if len(rows) > 1:
    raise CloudError(None, 'AMBIGUOUS_AUTH_USER')
  user = rows[0]['id'] if rows else None
  if user is not None and not UUID.fullmatch(user):
    raise ValueError('Unexpected user id')
  return user


def membership(client, app, user):
  if not user:
    return None
  rows = client.query(f"select role from core.memberships where app = {sql_literal(app)} and user_id = {sql_literal(user)}::uuid", read_only=True) or []
  return rows[0]['role'] if rows else None


def initialize(client, app_name, email, apply=False):
  app = get_app(app_name)
  email = email.strip().lower()
  if not EMAIL.fullmatch(email) or len(email) > 320:
    raise ValueError('Invalid owner email')
  registered = client.query(f"select exists(select 1 from core.apps where id = {sql_literal(app_name)}) as present", read_only=True)[0]['present']
  if not registered:
    raise CloudError(None, 'APP_NOT_FOUND', f'la app {app_name} no está en core.apps: aplica antes las migraciones')
  user = find_user(client, email)
  current_role = membership(client, app_name, user)
  report = {'app': app_name, 'email': email, 'apply': apply, 'userExists': user is not None, 'currentRole': current_role, 'targetRole': 'owner', 'accountCreated': False, 'passwordStoredIn': None, 'emailSent': False}
  if not apply:
    return report
  created = False
  if user is None:
    password = secrets.token_urlsafe(24)
    raw = client.project_request('/auth/v1/admin/users', {'email': email, 'password': password, 'email_confirm': True}, error_code='OWNER_AUTH_SETUP_FAILED')
    user = json.loads(raw)['id']
    if not UUID.fullmatch(user):
      raise ValueError('Unexpected user id')
    created = True
    PRIVATE.mkdir(parents=True, exist_ok=True)
    secret_file = PRIVATE / f'owner-{app_name}.json'
    secret_file.write_text(json.dumps({'app': app_name, 'email': email, 'userId': user, 'initialPassword': password, 'createdAt': datetime.now(timezone.utc).isoformat()}, indent=2), encoding='utf-8')
    try:
      secret_file.chmod(0o600)
    except OSError:
      pass
    report.update({'accountCreated': True, 'passwordStoredIn': str(secret_file.relative_to(PRIVATE.parent)).replace('\\', '/')})
  committed = False
  try:
    sql = (
      f"insert into core.profiles (user_id, display_name, kind) values ({sql_literal(user)}::uuid, {sql_literal(email.split('@')[0])}, 'human') on conflict (user_id) do nothing;"
      f" insert into core.memberships (app, user_id, role) values ({sql_literal(app_name)}, {sql_literal(user)}::uuid, 'owner')"
      " on conflict (app, user_id) do update set role = 'owner';"
    )
    client.query(sql)
    committed = True
  finally:
    if created and not committed:
      client.project_request('/auth/v1/admin/users/' + user, method='DELETE', error_code='OWNER_AUTH_CLEANUP_FAILED')
      (PRIVATE / f'owner-{app_name}.json').unlink(missing_ok=True)
  role = membership(client, app_name, user)
  if role != 'owner':
    raise CloudError(None, 'OWNER_MEMBERSHIP_UNVERIFIED')
  report.update({'userId': user, 'currentRole': role, 'status': 'PASS'})
  return report


if __name__ == '__main__':
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  add_app_argument(parser)
  parser.add_argument('--email', required=True)
  parser.add_argument('--apply', action='store_true', help='crea la cuenta si falta y asigna owner (por defecto solo plan)')
  parser.add_argument('--credentials', help='ruta alternativa a private/cloud-credentials.json')
  parser.add_argument('--report', help='informe JSON sin secretos (por defecto private/owner-initialization-<app>.json)')
  args = parser.parse_args()
  run_cli(lambda: initialize(SupabaseManagement(args.credentials), args.app, args.email, args.apply), args.report or str(PRIVATE / f'owner-initialization-{args.app}.json'))
