"""Tareas del usuario → Tasks: lectura del Markdown (sin red)."""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / 'scripts'))
from user_tasks_sync import NOTE_MAX, parse_tasks  # noqa: E402

DOC = """# Tareas
## 2. Cuentas
### 2.1 **Workspace** (grande)
Paso uno.

Paso dos.
### 2.2 B2
""" + 'x' * 2000 + """
## Hecho
### 9.9 Ya hecha
nada
"""


class ParseTasks(unittest.TestCase):
  def test_apartados_pendientes_con_referencia_estable(self):
    tasks = parse_tasks(DOC)
    self.assertEqual([t[0] for t in tasks], ['TV-2.1', 'TV-2.2'])
    self.assertEqual(tasks[0][1], '2.1 · Workspace (grande)')
    self.assertIn('Paso dos.', tasks[0][2])
    self.assertIn('apartado 2.1', tasks[0][2])

  def test_nota_recortada_al_maximo(self):
    note = parse_tasks(DOC)[1][2]
    self.assertLessEqual(len(note), NOTE_MAX)
    self.assertTrue(note.endswith('apartado 2.2.'))


if __name__ == '__main__':
  unittest.main()
