/** Booking · primer estimado de utilidad (1423, núcleo 0113): la migración sale de docs/booking/USO_ESTIMADO.json. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDatabase } from '../../packages/test-kit/src/pglite.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/booking/USO_ESTIMADO.json'), 'utf8')) as { items: Array<{ id: string; frequency: string; audience: unknown }> };
const migration = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261028_1423_booking_usage_estimate.sql'), 'utf8');
const FREQUENCIES = ['frequent', 'normal', 'occasional', 'rare_critical', 'do_not_evaluate'];

test('la migración dice lo mismo que el JSON, y cada id existe en Booking', () => {
  const inMigration = JSON.parse(migration.slice(migration.indexOf('$uso$') + 5, migration.lastIndexOf('$uso$')));
  assert.deepEqual(inMigration, source.items.map(({ id, frequency, audience }) => ({ id, frequency, audience })), 'regenera la migración desde el JSON');
  const code = fs.readdirSync(path.join(ROOT, 'apps/booking/src'), { recursive: true }).filter((f) => String(f).endsWith('.ts'))
    .map((f) => fs.readFileSync(path.join(ROOT, 'apps/booking/src', String(f)), 'utf8')).join('\n');
  const ids = new Set<string>();
  for (const item of source.items) {
    assert.ok(!ids.has(item.id), `repetido: ${item.id}`);
    ids.add(item.id);
    assert.ok(FREQUENCIES.includes(item.frequency), `${item.id}: ${item.frequency}`);
    assert.ok(code.includes(`'${item.id}'`), `${item.id} no está en apps/booking`);
  }
});

test('el núcleo guarda el estimado de Booking', async () => {
  const t = await createTestDatabase();
  try {
    const rows = (await t.db.query<{ feature_id: string; frequency: string }>(`select feature_id, frequency from core.usage_estimates where app = 'booking'`)).rows;
    assert.equal(rows.length, source.items.length);
    assert.equal(rows.find((r) => r.feature_id === 'booking.recepcion.cobrar')?.frequency, 'frequent');
  } finally {
    await t.close();
  }
});
