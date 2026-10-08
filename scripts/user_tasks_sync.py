#!/usr/bin/env python3
"""Tareas del usuario (coordinacion/TAREAS_VICTOR.md) → Tasks, área Aplicaciones › «Tareas de Core».

Cada apartado `### N.M Título` de las secciones pendientes (todo lo anterior a `## Hecho`) se envía como petición de
sistema `core.user_task` con `external_ref` `TV-N.M` (idempotente: reenviar no duplica). Con `--status` lista cuáles
ha completado el usuario en Tasks, para pasarlas a «Hecho» en el Markdown.

La clave de worker se lee de Supabase Vault en memoria (nunca se imprime ni se guarda). Sin `--apply`, solo enseña
lo que enviaría.
Uso: python scripts/user_tasks_sync.py [--apply] [--status]
"""
import argparse
import json
import pathlib
import re
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
TASKS_FILE = ROOT / 'coordinacion' / 'TAREAS_VICTOR.md'
# Directo a la Edge: el proxy de tasks.ikisai.com no reenvía la cabecera de la clave de worker.
WORKER_BASE = 'https://ctytaorylbninfyupfsn.supabase.co/functions/v1/tasks-api/api/v1/worker'
NOTE_MAX = 1000


def parse_tasks(markdown):
  """[(ref, title, note)] de los apartados `### N.M …` anteriores a `## Hecho`."""
  pending = markdown.split('\n## Hecho', 1)[0]
  out = []
  for m in re.finditer(r'^### (\d+(?:\.\d+)?[a-z]?) (.+?)\n(.*?)(?=^### |^## |\Z)', pending, re.S | re.M):
    num, title, body = m.group(1), m.group(2).strip(), m.group(3).strip()
    clean = re.sub(r'\*\*|`', '', title)
    tail = f'\n\nDetalle completo: coordinacion/TAREAS_VICTOR.md, apartado {num}.'
    text = re.sub(r'\n{3,}', '\n\n', body)
    if len(text) + len(tail) > NOTE_MAX:
      text = text[: NOTE_MAX - len(tail) - 2].rsplit('\n', 1)[0] + '\n…'
    out.append((f'TV-{num}', f'{num} · {clean}'[:120], text + tail))
  return out


def worker_key():
  sys.path.insert(0, str(pathlib.Path(__file__).parent))
  from cloud_management import SupabaseManagement
  rows = SupabaseManagement(None).query("select decrypted_secret k from vault.decrypted_secrets where name = 'ikisai_worker_key' limit 1")  # solo lectura, pero el rol read_only no ve Vault
  if not rows or not rows[0].get('k'):
    raise SystemExit('ikisai_worker_key no está en Vault')
  return rows[0]['k']


def post(path, body, key):
  req = urllib.request.Request(f'{WORKER_BASE}/{path}', data=json.dumps(body).encode(), method='POST',
                               headers={'content-type': 'application/json', 'x-ikisai-worker-key': key,
                                        # Cloudflare bloquea el agente por defecto de urllib (error 1010).
                                        'user-agent': 'ikisai-core-sync/1.0'})
  with urllib.request.urlopen(req, timeout=30) as res:
    return json.loads(res.read() or b'null')


def main():
  ap = argparse.ArgumentParser(description=__doc__)
  ap.add_argument('--apply', action='store_true', help='envía las tareas a Tasks')
  ap.add_argument('--status', action='store_true', help='lista el estado de cada tarea en Tasks')
  a = ap.parse_args()
  tasks = parse_tasks(TASKS_FILE.read_text(encoding='utf-8'))
  if not (a.apply or a.status):
    for ref, title, note in tasks:
      print(f'{ref}: {title} ({len(note)} caracteres)')
    return 0
  key = worker_key()
  if a.apply:
    for ref, title, note in tasks:
      out = post('requests/task', {'source': 'core', 'kind': 'core.user_task', 'kind_label': 'Core · Tarea para ti',
                                   'external_ref': ref, 'title': title, 'note': note}, key)
      print(ref, (out or {}).get('status'))
  if a.status:
    out = post('requests/status', {'externalRefs': [f'core:{ref}' for ref, _, _ in tasks]}, key)
    print(json.dumps(out, ensure_ascii=False, indent=1))
  return 0


if __name__ == '__main__':
  sys.exit(main())
