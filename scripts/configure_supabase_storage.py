#!/usr/bin/env python3
"""Crea o verifica un bucket privado de Storage (`--bucket <nombre>`). Plan por defecto.

Nunca cambia un bucket existente que sea público (EXISTING_PUBLIC_BUCKET_NO_CHANGE). Límite por archivo:
`purchase-documents` 50 MiB, el resto 15 MiB. Tipos permitidos: `kitchen-media` imágenes webp/jpeg/png;
`purchase-documents` PDF + imágenes; los demás sin restricción (la Edge valida el tipo en `uploads`).
La service key se obtiene de la Management API (`/api-keys?reveal=true`) y solo vive en memoria.
"""
import argparse
import json

from apps import BUCKETS, bucket_settings
from cloud_management import PRIVATE, CloudError, SupabaseManagement, run_cli


def storage(client, path, body=None, method=None):
  raw = client.project_request('/storage/v1/bucket' + path, body=body, method=method, error_code='STORAGE_CONFIG_FAILED')
  return json.loads(raw) if raw else None


def configure(client, bucket, apply=False):
  wanted = bucket_settings(bucket)
  buckets = storage(client, '') or []
  existing = next((b for b in buckets if b.get('id') == bucket), None)
  if existing and existing.get('public'):
    raise CloudError(None, 'EXISTING_PUBLIC_BUCKET_NO_CHANGE')
  drift = {}
  if existing:
    for key in ('file_size_limit', 'allowed_mime_types'):
      if existing.get(key) != wanted[key]:
        drift[key] = {'current': existing.get(key), 'wanted': wanted[key]}
  if apply:
    if not existing:
      storage(client, '', {'id': bucket, 'name': bucket, 'public': False, 'file_size_limit': wanted['file_size_limit'], 'allowed_mime_types': wanted['allowed_mime_types']})
    elif drift:
      storage(client, '/' + bucket, {'public': False, 'file_size_limit': wanted['file_size_limit'], 'allowed_mime_types': wanted['allowed_mime_types']}, method='PUT')
    existing = storage(client, '/' + bucket)
    if not existing or existing.get('public') or existing.get('file_size_limit') != wanted['file_size_limit'] or existing.get('allowed_mime_types') != wanted['allowed_mime_types']:
      raise CloudError(None, 'STORAGE_CONFIG_UNVERIFIED')
  return {'apply': apply, 'bucket': bucket, 'wanted': wanted, 'exists': existing is not None, 'private': (not existing.get('public')) if existing else None,
          'fileSizeLimit': existing.get('file_size_limit') if existing else None, 'allowedMimeTypes': existing.get('allowed_mime_types') if existing else None,
          'drift': drift if not apply else {}, 'action': 'none' if existing and not drift else ('update' if existing else 'create')}


if __name__ == '__main__':
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument('--bucket', required=True, choices=BUCKETS, help='bucket registrado en scripts/apps.py')
  parser.add_argument('--apply', action='store_true', help='crea o ajusta el bucket (por defecto solo plan)')
  parser.add_argument('--credentials', help='ruta alternativa a private/cloud-credentials.json')
  parser.add_argument('--report', help='informe JSON (por defecto private/storage-configuration-<bucket>.json)')
  args = parser.parse_args()
  run_cli(lambda: configure(SupabaseManagement(args.credentials), args.bucket, args.apply), args.report or str(PRIVATE / f'storage-configuration-{args.bucket}.json'))
