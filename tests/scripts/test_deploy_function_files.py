"""Archivos de cada Edge Function (scripts/deploy_supabase_function.py): los `_domain/<x>/` que importa se suben con ella.

El release del 27-10 (run 40558469860, commit 77343b9) falló con FUNCTION_DEPLOY_FAILED 400 porque invoices-api importa
`../_domain/payments/stripe.ts` (finance-18) y solo se subía `_domain/invoices`.
"""
import sys, tempfile, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from deploy_supabase_function import function_files, with_domains  # noqa: E402


class FunctionFilesTest(unittest.TestCase):
  def test_invoices_lleva_el_adaptador_de_pagos(self):
    # El import de 77343b9 (invoices-api/index.ts:4), contra el _domain real.
    files = with_domains({'invoices-api/index.ts': b"import { createStripeGateway } from '../_domain/payments/stripe.ts';\n"})
    self.assertIn('_domain/payments/stripe.ts', files)
    self.assertFalse([name for name in files if name.endswith(('.test.ts', '.spec.ts'))], 'sin pruebas')
    bundle = function_files('invoices')
    self.assertIn('invoices-api/index.ts', bundle)
    self.assertIn('_domain/invoices/mod.ts', bundle)

  def test_cada_import_relativo_de_domain_se_resuelve_en_el_bundle(self):
    import re
    spec = re.compile(r"""(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}/[^'"]+)['"]""")
    for app in ('invoices', 'organizers', 'booking'):
      files = function_files(app)
      for name, raw in files.items():
        if not name.endswith('.ts'):
          continue
        for target in spec.findall(raw.decode('utf-8', 'replace')):
          resolved = Path(name).parent.joinpath(target).as_posix()
          parts = []
          for part in resolved.split('/'):
            if part == '..':
              parts.pop()
            elif part != '.':
              parts.append(part)
          joined = '/'.join(parts)
          if joined.startswith('_domain/'):
            self.assertIn(joined, files, f'{app}: {name} importa {target}')

  def test_recursivo_y_solo_dentro_de_domain(self):
    with tempfile.TemporaryDirectory() as tmp:
      root = Path(tmp)
      for path, text in {
        'demo-api/index.ts': "import { a } from '../_domain/alfa/mod.ts';\nimport type { X } from '../otra-api/app.ts';\n",
        '_domain/alfa/mod.ts': "export { b } from '../beta/b.ts';\n",
        '_domain/alfa/mod.test.ts': "import '../gamma/g.ts';\n",
        '_domain/beta/b.ts': "export const b = await import('../gamma/g.ts');\n",
        '_domain/gamma/g.ts': 'export const g = 1;\n',
        '_domain/delta/d.ts': 'export const d = 1;\n',
        'otra-api/app.ts': 'export type X = 1;\n',
      }.items():
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_text(text, encoding='utf-8')
      files = with_domains({'demo-api/index.ts': (root / 'demo-api/index.ts').read_bytes()}, root)
      self.assertEqual(sorted(files), ['_domain/alfa/mod.ts', '_domain/beta/b.ts', '_domain/gamma/g.ts', 'demo-api/index.ts'])


if __name__ == '__main__':
  unittest.main()
