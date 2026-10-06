#!/usr/bin/env python3
"""Carga secretos en las Edge Functions del proyecto Supabase leyéndolos de archivos (nunca de la línea de órdenes).

  python scripts/set_edge_secrets.py ANTHROPIC_API_KEY=private/anthropic-api-key.txt [OTRO=ruta ...] [--apply]

Cada valor se lee del archivo indicado (se recorta el salto de línea final); el informe solo recoge nombres y longitudes,
nunca valores. Por defecto es un plan; con --apply se envían a la Management API. Los secretos quedan disponibles para todas
las funciones del proyecto tras su siguiente despliegue o arranque.
"""
import argparse
from pathlib import Path

from cloud_management import ROOT, SupabaseManagement, run_cli

NAME_RE = r'^[A-Z][A-Z0-9_]{1,63}$'


def set_secrets(client, assignments, apply=False):
  import re
  secrets = []
  for item in assignments:
    if '=' not in item:
      raise ValueError('Usa NOMBRE=ruta')
    name, file = item.split('=', 1)
    if not re.fullmatch(NAME_RE, name):
      raise ValueError('Nombre de secreto inválido: ' + name)
    path = Path(file)
    if not path.is_absolute():
      path = ROOT / path
    value = path.read_text(encoding='utf-8').strip()
    if not value:
      raise ValueError('El archivo del secreto está vacío: ' + name)
    secrets.append({'name': name, 'value': value})
  report = {'apply': apply, 'secrets': [{'name': s['name'], 'length': len(s['value'])} for s in secrets]}
  if not apply:
    return report
  client.request('/secrets', secrets, method='POST')
  current = client.request('/secrets') or []
  names = {s.get('name') for s in current}
  report['present'] = [s['name'] in names for s in secrets]
  return report


if __name__ == '__main__':
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument('assignments', nargs='+', help='NOMBRE=ruta-del-archivo-con-el-valor')
  parser.add_argument('--apply', action='store_true', help='envía los secretos (por defecto solo plan)')
  parser.add_argument('--credentials', help='ruta alternativa a private/cloud-credentials.json')
  args = parser.parse_args()
  run_cli(lambda: set_secrets(SupabaseManagement(args.credentials), args.assignments, args.apply))
