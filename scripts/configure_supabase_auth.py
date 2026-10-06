#!/usr/bin/env python3
"""Configura Auth del proyecto: site_url, allow-list con los cuatro dominios y alta cerrada. Plan por defecto."""
import argparse

from apps import APPS
from cloud_management import PRIVATE, CloudError, SupabaseManagement, run_cli

FIELDS = {
  'site_url': 'https://' + APPS['tasks']['domain'],
  'uri_allow_list': ','.join(f"https://{host}/**" for app in APPS.values() for host in [app['domain'], *app.get('extra_domains', [])]),
  'disable_signup': True,
}


def configure(client, apply=False):
  current = client.request('/config/auth') or {}
  before = {key: current.get(key) for key in FIELDS}
  if apply:
    client.request('/config/auth', FIELDS, method='PATCH')
    current = client.request('/config/auth') or {}
    if any(current.get(key) != value for key, value in FIELDS.items()):
      raise CloudError(None, 'AUTH_CONFIG_UNVERIFIED')
  return {'apply': apply, 'configuration': FIELDS, 'before': before, 'verified': all(current.get(key) == value for key, value in FIELDS.items())}


if __name__ == '__main__':
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument('--apply', action='store_true', help='aplica la configuración (por defecto solo plan)')
  parser.add_argument('--credentials', help='ruta alternativa a private/cloud-credentials.json')
  parser.add_argument('--report', default=str(PRIVATE / 'auth-configuration.json'))
  args = parser.parse_args()
  run_cli(lambda: configure(SupabaseManagement(args.credentials), args.apply), args.report)
