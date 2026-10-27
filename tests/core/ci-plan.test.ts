/** CI por app (scripts/ci_plan.mjs): qué carpetas de PGlite corre una PR según lo que toca. Sobre un repo de mentira. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { groups, plan } from '../../scripts/ci_plan.mjs';

function fakeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-plan-'));
  const write = (file: string, text = '') => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  // booking es grande (12 archivos); el resto, pequeñas.
  for (let i = 0; i < 12; i++) write(`tests/booking/b${i}.test.ts`);
  write('tests/core/a.test.ts');
  write('tests/sync-client/a.test.ts');
  write('tests/food/a.test.ts', "await db.query('select * from booking.portal_reservations');");
  write('tests/organizers/a.test.ts', "import { x } from '../../apps/organizers/src/app/x.ts';");
  write('tests/guests/a.test.ts', "import { y } from '../../apps/organizers/src/app/y.ts'; const booking = { t: 1 }; booking.t;");
  write('supabase/migrations/20261001_1100_food_offers.sql', 'create view food.v as select 1;');
  write('supabase/migrations/20261001_0400_booking_x.sql', 'select 1;');
  return root;
}

test('ci por app · solo documentación: nada', () => {
  const root = fakeRepo();
  assert.deepEqual(plan({ root, files: ['docs/organizers/ESTADO.md', 'MUELA/equipo/x.md', 'CODEOWNERS', 'README.md'] }),
    { code: false, full: false, folders: [], groups: [] });
});

test('ci por app · el cliente de una app: sus pruebas y las que importan su app', () => {
  const root = fakeRepo();
  const out = plan({ root, files: ['apps/organizers/src/ui/retreats.ts', 'docs/organizers/API.md'] });
  assert.deepEqual(out.folders, ['guests', 'organizers']);
  assert.equal(out.full, false);
});

test('ci por app · el servidor de una app: también las que nombran su schema (no una variable con su nombre)', () => {
  const root = fakeRepo();
  assert.deepEqual(plan({ root, files: ['supabase/migrations/20261001_0400_booking_x.sql'] }).folders, ['booking', 'food']);
  assert.deepEqual(plan({ root, files: ['supabase/functions/food-api/app.ts'] }).folders, ['food']);
});

test('ci por app · lo compartido y fuera de una PR: todas, la grande sola y las pequeñas juntas', () => {
  const root = fakeRepo();
  const all = ['booking', 'core', 'food', 'guests', 'organizers', 'sync-client'];
  for (const files of [['packages/ui-kit/src/a.ts'], ['supabase/functions/_kit/a.ts'], ['.github/workflows/checks.yml'], ['apps/food/a.ts', 'package-lock.json'], ['tests/core/x.test.ts']]) {
    const out = plan({ root, files });
    assert.deepEqual(out.folders, all, files.join());
    assert.equal(out.full, true);
  }
  assert.deepEqual(plan({ root, event: 'schedule' }).groups, [
    { name: 'booking', folders: 'booking' },
    { name: 'core + food + guests + organizers + sync-client', folders: 'core food guests organizers sync-client' },
  ]);
});

test('ci por app · con más grupos que el tope, las carpetas se juntan por tamaño; los trozos, aparte', () => {
  const root = fakeRepo();
  // booking, 30 archivos (se parte con split 20); tasks, food, core y central, de 12 a 14 (grandes); el resto, pequeñas.
  const add = (f: string, n: number) => { fs.mkdirSync(path.join(root, 'tests', f), { recursive: true }); for (let i = 0; i < n; i++) fs.writeFileSync(path.join(root, 'tests', f, `p${i}.test.ts`), ''); };
  add('booking', 18); add('tasks', 14); add('food', 12); add('core', 11); add('central', 12);
  const out = groups(['booking', 'central', 'core', 'food', 'guests', 'organizers', 'sync-client', 'tasks'], root, 20, 3);
  assert.deepEqual(out.filter((g) => g.shard).map((g) => g.name), ['booking 1/2', 'booking 2/2']);
  const packed = out.filter((g) => !g.shard);
  assert.equal(packed.length, 3);
  assert.deepEqual(packed.flatMap((g) => g.folders.split(' ')).sort(), ['central', 'core', 'food', 'guests', 'organizers', 'sync-client', 'tasks']);
  assert.ok(packed.every((g) => g.name === g.folders.split(' ').join(' + ')));
});

test('ci por app · una carpeta muy grande va en dos trozos', () => {
  const root = fakeRepo();
  assert.deepEqual(groups(['booking', 'food'], root, 12), [
    { name: 'booking 1/2', folders: 'booking', shard: '1/2' },
    { name: 'booking 2/2', folders: 'booking', shard: '2/2' },
    { name: 'food', folders: 'food' },
  ]);
});
