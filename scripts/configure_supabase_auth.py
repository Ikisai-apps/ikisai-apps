#!/usr/bin/env python3
"""Configura Auth del proyecto: site_url, allow-list con los cuatro dominios y alta cerrada. Plan por defecto."""
import argparse

from apps import APPS
from cloud_management import PRIVATE, CloudError, SupabaseManagement, run_cli

FIELDS = {
  'site_url': 'https://' + APPS['tasks']['domain'],
  'uri_allow_list': ','.join(f"https://{host}/**" for app in APPS.values() for host in [app['domain'], *app.get('extra_domains', [])]),
  'disable_signup': True,
  # «¿Has olvidado tu contraseña?»: el enlace vuelve a la app con token_hash (la app usa rutas con # y no puede recibir el fragmento de Auth).
  'mailer_subjects_recovery': 'Cambia tu contraseña de Ikisai',
  'mailer_templates_recovery_content': (
    '<p>Hola:</p><p>Alguien ha pedido cambiar la contraseña de tu cuenta de Ikisai. Si has sido tú, pulsa el enlace (vale una hora y una sola vez):</p>'
    '<p><a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery">Elegir una contraseña nueva</a></p>'
    '<p>Si no lo has pedido tú, ignora este correo: tu contraseña no cambia.</p>'),
  'mailer_otp_exp': 3600,
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
