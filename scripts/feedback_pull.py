"""Vuelca los reportes de feedback abiertos en el buzón de cada agente: coordinacion/<app>/QA.md.

Lo lanza Core cuando el usuario lo pide en el chat («trae los reportes de QA»). Usa las credenciales de private/ (token de
gestión de Supabase): sin claves de IA ni API de pago. Solo reportes internos de aplicación aprobados por el usuario (modo revisor, FEEDBACK.md §9); los de huéspedes y organizadores
no salen de la base (datos personales). Cada reporte va con el bloque para agente (FEEDBACK.md §8.2).

Uso: python scripts/feedback_pull.py [--app booking] [--out ../coordinacion]
"""
import argparse
import json
import pathlib
import sys

from cloud_management import SupabaseManagement, sql_literal

ROOT = pathlib.Path(__file__).resolve().parents[1]
APP_DIRS = {'invoices': 'invoices', 'tasks': 'tasks', 'booking': 'booking', 'food': 'food', 'central': 'central', 'organizers': 'organizers', 'guests': 'guests'}
DISPLAY = {'open': 'Abierto', 'in_progress': 'En trabajo', 'pending_verify': 'Pendiente de verificar'}


def block(r):
  ctx = r.get('context') or {}
  path = ' › '.join(r.get('node_path') or [])
  lines = [
    f"## {r['code']} · {r['intent']}{' · ME BLOQUEA' if r['blocking'] else ''} · {DISPLAY.get(r['display'], r['display'])}",
    '',
    f"- Elemento: `{r['node_id'] or '(sin nodo)'}`{' · ' + path if path else ''}",
    f"- Versión: {ctx.get('release', '?')}{' (' + ctx['commit'] + ')' if ctx.get('commit') else ''} · ruta {r.get('source_route') or '?'}",
    f"- Dispositivo: {ctx.get('deviceClass', '?')} {(ctx.get('viewport') or {}).get('width', '?')}×{(ctx.get('viewport') or {}).get('height', '?')}"
    f" · {'sin red' if ctx.get('online') is False else 'en línea'} · apoyos {r['supporters_count']} · reabierto {r['reopen_count']}",
    f"- Fecha: {r['created_at'][:16].replace('T', ' ')}",
    '',
    r['message'],
  ]
  steps = ctx.get('steps') or []
  if steps:
    lines += ['', 'Últimos pasos:', *[f"1. {s.get('action') or 'tocó'} `{s.get('node') or ''}` ({s.get('route') or ''})" for s in steps]]
  errors = ctx.get('errors') or []
  if errors:
    lines += ['', 'Errores recientes:', *[f"- {e.get('type')}: {e.get('message')}" for e in errors]]
  http = ctx.get('http') or []
  if http:
    lines += ['', 'Fallos HTTP recientes:', *[f"- {h.get('method')} {h.get('path')} → {h.get('status')}" for h in http]]
  if r['attachments']:
    lines += ['', f"Imágenes: {r['attachments']} (verlas en la app, Sugerencias y QA)"]
  return '\n'.join(lines)


def main():
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument('--app', choices=sorted(APP_DIRS), help='solo esta app (por defecto, todas)')
  parser.add_argument('--out', default=str(ROOT.parent / 'coordinacion'), help='carpeta de coordinación')
  args = parser.parse_args()
  where = "r.reporter_kind = 'internal' and r.subject = 'application' and r.status = 'open' and r.review_status = 'approved'"
  if args.app:
    where += ' and r.origin_app = ' + sql_literal(args.app)
  rows = SupabaseManagement().query(f"""
    select r.code, r.origin_app, r.intent, r.blocking, r.node_id, r.node_path, r.message, r.context, r.source_route, r.supporters_count,
           r.reopen_count, r.created_at::text, core.feedback_display(r) as display,
           (select count(*) from core.feedback_attachments a where a.report_id = r.id)::int as attachments
      from core.feedback_reports r where {where}
     order by r.origin_app, r.blocking desc, r.supporters_count desc, r.created_at""")
  by_app = {}
  for r in rows:
    by_app.setdefault(r['origin_app'], []).append(r)
  out = pathlib.Path(args.out)
  summary = {}
  for app in ([args.app] if args.app else sorted(APP_DIRS)):
    items = by_app.get(app, [])
    target = out / APP_DIRS[app] / 'QA.md'
    if not items and not target.exists():
      continue
    target.parent.mkdir(parents=True, exist_ok=True)
    todo = [r for r in items if r['display'] != 'pending_verify']
    waiting = [r for r in items if r['display'] == 'pending_verify']
    text = [f'# QA de {app} · reportes abiertos', '',
            'Volcado por Core con scripts/feedback_pull.py. Arregla por orden (lo que bloquea primero) y pon el código FB_… en el título o la',
            'descripción de tu PR: al publicarse, el reporte pasa solo a «pendiente de verificar» y quien lo informó lo comprueba.', '',
            f'Por arreglar: {len(todo)} · Pendientes de verificar: {len(waiting)}', '']
    text += [block(r) + '\n' for r in todo]
    if waiting:
      text += ['# Ya publicados, esperando verificación (no tocar salvo que se reabran)', ''] + [f"- {r['code']} · {r['message'][:80]}" for r in waiting]
    target.write_text('\n'.join(text).rstrip() + '\n', encoding='utf-8')
    summary[app] = {'porArreglar': len(todo), 'pendientesDeVerificar': len(waiting)}
  print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
  sys.exit(main())
