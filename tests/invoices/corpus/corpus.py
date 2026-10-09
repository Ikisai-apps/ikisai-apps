#!/usr/bin/env python3
"""
Corpus real del lector de facturas (fase 2, PR 7; excepción aprobada por Core el 9-10-2026).

Las facturas reales viven solo en el bucket privado `test-corpus` del proyecto de producción, cada una como
`<id>.pdf` junto a `<id>.expected.json` (los valores esperados). En el repositorio no hay nada real.

  python tests/invoices/corpus/corpus.py upload <id> <factura.pdf> <esperado.json>   # local, con private/cloud-credentials.json
  python tests/invoices/corpus/corpus.py download <carpeta>                         # el job nocturno (SUPABASE_ACCESS_TOKEN)
  python tests/invoices/corpus/corpus.py list

Credenciales como `scripts/cloud_management.py`: la clave de servicio se pide a la API de gestión y solo vive en memoria
(en Actions se enmascara con `::add-mask::`). Solo se usa para leer (y, en local, subir) este bucket. Nunca se imprime el
contenido de una factura: solo ids y códigos.
"""
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'scripts'))
from cloud_management import CloudError, SupabaseManagement  # noqa: E402

BUCKET = 'test-corpus'
ID = re.compile(r'^[A-Za-z0-9_-]{1,40}$')
FIELDS = {'supplier_tax_id', 'invoice_number', 'invoice_date', 'base', 'vat', 'withholding', 'total'}


def client():
  m = SupabaseManagement()
  key = m.service_role_key()
  if os.environ.get('GITHUB_ACTIONS') == 'true':
    print('::add-mask::' + key)
  return m


def list_objects(m):
  raw = m.project_request(f'/storage/v1/object/list/{BUCKET}', body={'prefix': '', 'limit': 1000, 'offset': 0}, method='POST', error_code='CORPUS_LIST_FAILED')
  return sorted(o['name'] for o in json.loads(raw) if isinstance(o, dict) and isinstance(o.get('name'), str))


def upload(m, corpus_id, pdf, expected):
  if not ID.match(corpus_id):
    raise ValueError('El id solo admite letras, cifras, «-» y «_» (hasta 40)')
  data = json.loads(Path(expected).read_text(encoding='utf-8'))
  if not isinstance(data, dict) or not set(data) <= FIELDS or not data:
    raise ValueError(f'El esperado es un objeto con algunos de: {", ".join(sorted(FIELDS))}')
  pdf_bytes = Path(pdf).read_bytes()
  if not pdf_bytes.startswith(b'%PDF'):
    raise ValueError('No es un PDF')
  for name, body, mime in ((f'{corpus_id}.pdf', pdf_bytes, 'application/pdf'), (f'{corpus_id}.expected.json', json.dumps(data, ensure_ascii=False).encode('utf-8'), 'application/json')):
    m.project_request(f'/storage/v1/object/{BUCKET}/{name}', method='POST', raw_body=body, headers={'Content-Type': mime, 'x-upsert': 'true'}, error_code='CORPUS_UPLOAD_FAILED')
  print(f'subido: {corpus_id}')


def download(m, folder):
  out = Path(folder)
  out.mkdir(parents=True, exist_ok=True)
  names = [n for n in list_objects(m) if re.match(r'^[A-Za-z0-9_-]{1,40}\.(pdf|expected\.json)$', n)]
  for name in names:
    (out / name).write_bytes(m.project_request(f'/storage/v1/object/authenticated/{BUCKET}/{name}', method='GET', error_code='CORPUS_DOWNLOAD_FAILED'))
  print(f'descargados: {len([n for n in names if n.endswith(".pdf")])} documentos')


def main(argv):
  if len(argv) < 2 or argv[1] not in ('upload', 'download', 'list'):
    print(__doc__)
    return 2
  try:
    m = client()
    if argv[1] == 'upload' and len(argv) == 5:
      upload(m, argv[2], argv[3], argv[4])
    elif argv[1] == 'download' and len(argv) == 3:
      download(m, argv[2])
    elif argv[1] == 'list':
      for name in list_objects(m):
        print(name)
    else:
      print(__doc__)
      return 2
  except CloudError as error:
    print(f'error: {error}', file=sys.stderr)
    return 1
  except (OSError, ValueError) as error:
    print(f'error: {error}', file=sys.stderr)
    return 1
  return 0


if __name__ == '__main__':
  sys.exit(main(sys.argv))
