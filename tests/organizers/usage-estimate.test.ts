/**
 * Organizers · primer estimado de utilidad (0707 con `core.usage_estimate`, 0113; UTILIDAD_ESTIMADA.md): cada funcionalidad
 * del catálogo lleva su frecuencia y la audiencia `kinds: organizers`, y se aplica a la que entra después por el catálogo de
 * una publicación, sin pisar lo que ya haya decidido Dirección.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createOrganizersApp, ORGANIZERS_ORIGINS } from '../../supabase/functions/organizers-api/app.ts';

let app: TestApp;
test.before(async () => {
  app = await createTestApp({
    app: 'organizers', slug: 'organizers-api', origin: ORGANIZERS_ORIGINS[0]!,
    createHandler: (config) => createOrganizersApp({ ...config, origins: [ORGANIZERS_ORIGINS[0]!] }),
  });
});
test.after(async () => { await app.close(); });

test('organizers · estimado de utilidad: todas las funcionalidades, por área, y se aplica al entrar por el catálogo', async () => {
  const q = async <T>(sql: string, args: unknown[] = []) => (await app.t.db.query<T>(sql, args)).rows;
  const counts = await q<{ frequency: string; n: number }>(`select frequency, count(*)::int n from core.usage_estimates where app = 'organizers' group by 1 order by 1`);
  assert.deepEqual(Object.fromEntries(counts.map((r) => [r.frequency, r.n])), { frequent: 96, normal: 111, occasional: 63, rare_critical: 19 });
  const one = async (id: string) => (await q<{ frequency: string; audience: unknown }>(`select frequency, audience from core.usage_estimates where app = 'organizers' and feature_id = $1`, [id]))[0];
  assert.deepEqual(await one('organizers.asistente.restriccion.gravedad'), { frequency: 'rare_critical', audience: { kinds: ['organizers'] } });
  assert.equal((await one('organizers.pagos.pagar_ahora'))?.frequency, 'normal');
  assert.equal((await one('organizers.diseno.expected_guests'))?.frequency, 'occasional');
  assert.equal((await one('organizers.entrada.codigo.correo'))?.frequency, 'occasional', '0708: el código por correo es la entrada de repuesto');
  // Entra por el catálogo de una publicación: recibe el estimado.
  await q(`select core.usage_catalog_ingest('organizers', 'v9.9.9', $1::jsonb)`, [JSON.stringify([{ id: 'organizers.asistentes.lista', label: 'Asistentes', kind: 'element' }])]);
  assert.deepEqual((await q<{ frequency: string; audience: unknown }>(`select frequency, audience from core.usage_features where feature_id = 'organizers.asistentes.lista'`))[0],
    { frequency: 'frequent', audience: { teams: [], people: [], kinds: ['organizers'] } });
});
