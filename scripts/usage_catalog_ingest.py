"""Sube al núcleo el catálogo de funcionalidades de una app publicada (perspectiva «Uso» del Revisor, contrato §3.8).

El catálogo lo genera el kit al compilar (`apps/<app>/dist/feature-catalog.json`) a partir de los `data-feedback-id` y de las
llamadas `usage.run`/`usage.track` del código. Lo llama release.yml después de publicar cada app. Sin archivo, no hace nada.

Uso: python scripts/usage_catalog_ingest.py --app booking --release v0.1.0-build.230 [--apply]
"""
import argparse
import json
import pathlib
import sys

from apps import get_app
from cloud_management import SupabaseManagement, sql_literal

ROOT = pathlib.Path(__file__).resolve().parents[1]


def main():
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument('--app', required=True)
  parser.add_argument('--release', required=True)
  parser.add_argument('--apply', action='store_true', help='sube el catálogo (por defecto solo lo lee y lo resume)')
  args = parser.parse_args()
  entry = get_app(args.app)
  path = ROOT / entry['dist_dir'] / 'feature-catalog.json'
  if not path.exists():
    print(json.dumps({'app': args.app, 'catalog': None, 'reason': 'sin feature-catalog.json en la versión'}))
    return 0
  catalog = json.loads(path.read_text(encoding='utf-8'))
  features = [f for f in catalog.get('features', []) if isinstance(f, dict) and isinstance(f.get('id'), str)]
  result = {'app': args.app, 'release': args.release, 'features': len(features), 'apply': args.apply, 'ingest': None}
  if args.apply:
    payload = sql_literal(json.dumps(features, ensure_ascii=False)) + '::jsonb'
    rows = SupabaseManagement().query(f'select core.usage_catalog_ingest({sql_literal(args.app)}, {sql_literal(args.release)}, {payload}) as r')
    result['ingest'] = rows[0]['r'] if rows else None
  print(json.dumps(result, ensure_ascii=False))
  return 0


if __name__ == '__main__':
  sys.exit(main())
