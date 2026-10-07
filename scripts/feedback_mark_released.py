"""Marca como «pendiente de verificar» los reportes de feedback cuyo código (FB_AAAA_NNN) aparece en los commits publicados.

Lo llama la publicación (release.yml) tras desplegar: busca los códigos en los mensajes de commit entre el commit anterior
y el actual, y llama a core.feedback_mark_released con la versión publicada. A quien informó (y al owner) le aparece el pin
verde «Esto ya está corregido. ¿Lo compruebas?» (contrato §3.7).

Uso: python scripts/feedback_mark_released.py --since <sha> --build <versión> [--apply]
"""
import argparse
import json
import re
import subprocess
import sys

from cloud_management import SupabaseManagement, sql_literal

CODE = re.compile(r'\bFB_\d{4}_\d{3,}\b', re.IGNORECASE)
GEN = re.compile(r'^\s*GEN:\s*([a-z][a-z0-9_]*(?:\.[a-z0-9_-]+){1,7})\s*$', re.MULTILINE)


def log_since(since):
  if not since or set(since) == {'0'}:
    return ''
  return subprocess.run(['git', 'log', '--format=%B', f'{since}..HEAD'], capture_output=True, text=True, check=True).stdout


def codes_since(since):
  return sorted({c.upper() for c in CODE.findall(log_since(since))})


def generations_since(since):
  return sorted(set(GEN.findall(log_since(since))))


def main():
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument('--since', required=True, help='commit publicado anterior (github.event.before)')
  parser.add_argument('--build', required=True, help='versión publicada (IKISAI_RELEASE)')
  parser.add_argument('--apply', action='store_true', help='marca en la base (por defecto solo dice qué códigos encuentra)')
  args = parser.parse_args()
  codes = codes_since(args.since)
  gens = generations_since(args.since)
  result = {'codes': codes, 'generations': gens, 'build': args.build, 'apply': args.apply, 'marked': None, 'bumped': None}
  if codes and args.apply:
    array = 'array[' + ','.join(sql_literal(c) for c in codes) + ']::text[]'
    rows = SupabaseManagement().query(f'select core.feedback_mark_released({array}, {sql_literal(args.build)}) as n')
    result['marked'] = rows[0]['n'] if rows else 0
  if gens and args.apply:
    array = 'array[' + ','.join(sql_literal(g) for g in gens) + ']::text[]'
    rows = SupabaseManagement().query(f'select core.usage_bump_generation({array}, {sql_literal(args.build)}) as n')
    result['bumped'] = rows[0]['n'] if rows else 0
  print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
  sys.exit(main())
