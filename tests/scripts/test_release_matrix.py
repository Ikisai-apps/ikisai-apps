"""Selector de la release (scripts/release_matrix.py): apps afectadas y si hay que aplicar migraciones (PROD-001, 14-10-2026)."""
import sys, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from release_matrix import affected, needs_migrations  # noqa: E402

RESOURCES = 'supabase/migrations/20261014_0802_resources_inventory.sql'


class ReleaseMatrixTest(unittest.TestCase):
  def test_solo_recursos_no_publica_apps_pero_aplica_migraciones(self):
    apps, _ = affected([RESOURCES, 'docs/resources/API.md', 'tests/resources/inventory.test.ts'])
    self.assertEqual(apps, set())
    self.assertTrue(needs_migrations([RESOURCES, 'docs/resources/API.md'], []))

  def test_mezcla_de_recursos_y_una_app(self):
    files = [RESOURCES, 'supabase/migrations/20261014_0196_food_house_suggestion.sql', 'apps/food/src/main.ts']
    apps, _ = affected(files)
    self.assertEqual(apps, {'food'})
    self.assertTrue(needs_migrations(files, sorted(apps)))

  def test_sin_cambios_relevantes_no_hace_nada(self):
    files = ['docs/resources/API.md', 'coordinacion.md', 'tests/resources/inventory.test.ts']
    apps, _ = affected(files)
    self.assertEqual(apps, set())
    self.assertFalse(needs_migrations(files, []))

  def test_sin_historial_se_aplican_por_si_acaso(self):
    self.assertTrue(needs_migrations(None, []))

  def test_migracion_core_sigue_marcando_todas(self):
    apps, _ = affected(['supabase/migrations/20261013_0092_core_outsider.sql'])
    self.assertIn('food', apps)
    self.assertIn('tasks', apps)


  def test_un_workflow_que_no_publica_no_marca_apps(self):
    apps, _ = affected(['.github/workflows/checks.yml', 'apps/invoices/src/app/day-receipt.ts'])
    self.assertEqual(apps, {'invoices'})

  def test_release_yml_sigue_marcando_todas(self):
    apps, _ = affected(['.github/workflows/release.yml'])
    self.assertIn('organizers', apps)
    self.assertIn('booking', apps)

if __name__ == '__main__':
  unittest.main()
