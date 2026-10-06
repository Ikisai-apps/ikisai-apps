#!/usr/bin/env python3
"""Registro único de las apps de Ikisai: dominio, proyecto Pages, Edge Function, directorios y bucket.

Todo script de despliegue toma de aquí lo que depende de la app; nada de esto se duplica en otro sitio.
Uso: `python scripts/apps.py` lista las apps; `python scripts/apps.py <app>` muestra una.
"""
import argparse
import json
import re
import sys

ZONE = 'ikisai.com'
PROJECT_REF = 'ctytaorylbninfyupfsn'
ALL_SCHEMAS = ('core', 'tasks', 'invoices', 'booking', 'food')

# Dominios adicionales que sirve el mismo proyecto Pages (mismo contenido, sin redirección). Invoices pasa a llamarse Finance
# (decisión del usuario, 6 oct 2026): fase A, finance.ikisai.com sirve la app junto a invoices.ikisai.com; en la fase C
# finance será el dominio principal y invoices/tramita redirigirán. Los alias que solo redirigen viven en Cloudflare.
EXTRA_DOMAINS = {'invoices': [f'finance.{ZONE}']}

_BUCKETS = {'tasks': 'ikisai-files', 'invoices': 'purchase-documents', 'booking': 'booking-documents', 'food': 'kitchen-media'}

# Límites y tipos de los buckets (contrato §11.3: PDF hasta el techo de Storage, fotos recomprimidas en cliente).
BUCKET_LIMITS = {'purchase-documents': 52428800, 'ikisai-files': 26214400}
DEFAULT_BUCKET_LIMIT = 15728640
BUCKET_MIME_TYPES = {
  'ikisai-files': ['image/webp', 'image/jpeg', 'image/png', 'application/pdf', 'text/plain', 'text/csv', 'application/zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet', 'application/vnd.oasis.opendocument.presentation'],
  'kitchen-media': ['image/webp', 'image/jpeg', 'image/png'],
  'purchase-documents': ['application/pdf', 'image/webp', 'image/jpeg', 'image/png'],
}


def _entry(name):
  return {
    'name': name,
    'domain': f'{name}.{ZONE}',
    'pages_project': f'ikisai-{name}',
    'function_slug': f'{name}-api',
    'function_dir': f'supabase/functions/{name}-api',
    'app_dir': f'apps/{name}',
    'dist_dir': f'apps/{name}/dist',
    'schema': name,
    'bucket': _BUCKETS[name],
    'extra_domains': list(EXTRA_DOMAINS.get(name, [])),
  }


APPS = {name: _entry(name) for name in ('tasks', 'invoices', 'booking', 'food')}
APP_NAMES = tuple(APPS)
BUCKETS = tuple(dict.fromkeys(app['bucket'] for app in APPS.values()))


def get_app(name):
  """Devuelve la ficha de la app o lanza ValueError si el nombre no está registrado."""
  if not isinstance(name, str) or not re.fullmatch(r'[a-z]+', name) or name not in APPS:
    raise ValueError('Unknown app: ' + repr(name))
  return APPS[name]


def bucket_settings(bucket):
  if bucket not in BUCKETS:
    raise ValueError('Unknown bucket: ' + repr(bucket))
  return {'id': bucket, 'public': False, 'file_size_limit': BUCKET_LIMITS.get(bucket, DEFAULT_BUCKET_LIMIT), 'allowed_mime_types': BUCKET_MIME_TYPES.get(bucket)}


def add_app_argument(parser, required=True):
  parser.add_argument('--app', required=required, choices=APP_NAMES, help='app registrada: ' + ', '.join(APP_NAMES))
  return parser


if __name__ == '__main__':
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument('app', nargs='?', help='nombre de la app a mostrar (sin argumento: todas)')
  args = parser.parse_args()
  try:
    print(json.dumps(get_app(args.app) if args.app else APPS, indent=2, ensure_ascii=False))
  except ValueError as error:
    print(json.dumps({'status': 'error', 'code': 'UNKNOWN_APP', 'message': str(error)}))
    sys.exit(1)
