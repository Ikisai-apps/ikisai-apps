/**
 * Central · pasada única de la tanda 27 (MUELA-017, 019 y 069): los mapas puros que dicen dónde sale cada dato de la
 * Entidad y dónde se lee cada texto. Si un portal cambia sus claves o la Entidad gana una columna, estas pruebas lo dicen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import {
  ENTITY_GAPS, ENTITY_USES, PORTAL_TEXTS, PORTAL_TEXT_FALLBACKS, entityGaps, portalTextKeys, textPlaces,
} from '../../supabase/functions/_domain/central/mod.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.resolve(here, '../..', rel), 'utf8');
const strings = (text: string) => [...text.matchAll(/'([a-z][a-z0-9_.]+)'/g)].map((m) => m[1]!);

test('entidad · «dónde sale» cubre todas las columnas de central.entity (salvo las del contrato)', async () => {
  const app = await createTestApp({ app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!, createHandler: (c) => createCentralApp({ ...c, origins: [CENTRAL_ORIGINS[0]!] }) });
  try {
    const { rows } = await app.t.db.query<{ column_name: string }>(`select column_name from information_schema.columns where table_schema = 'central' and table_name = 'entity'`);
    const contract = new Set(['id', 'revision', 'created_at', 'updated_at', 'updated_by', 'deleted_at']);
    const columns = rows.map((r) => r.column_name).filter((c) => !contract.has(c)).sort();
    assert.deepEqual(Object.keys(ENTITY_USES).sort(), columns);
  } finally {
    await app.close();
  }
});

test('entidad · los seis datos que se notan fuera, en su orden; la dirección es la del lugar, nunca el domicilio fiscal', () => {
  assert.deepEqual(ENTITY_GAPS.map((g) => g.field), ['iban', 'venue_address', 'logo_file_id', 'site_plan_file_id', 'bizum', 'venue_map_url']);
  assert.ok(!ENTITY_GAPS.some((g) => (g.field as string) === 'address_line'));
  assert.equal(entityGaps(null).length, 6);
  assert.deepEqual(entityGaps({ iban: 'ES9121000418450200051332', venue_address: '  ', bizum: '600000000' }).map((g) => g.field), ['venue_address', 'logo_file_id', 'site_plan_file_id', 'venue_map_url']);
});

test('textos · el mapa «dónde se lee» coincide con lo que piden los common-texts.ts de Guests y Organizers', () => {
  const guests = read('apps/guests/src/app/common-texts.ts');
  const guestKeys = new Set([
    ...strings(guests.match(/export const INFO_KEYS = \[([^\]]+)\]/)![1]!),
    ...strings(guests.match(/const KEYS = \[([^\]]+)\]/)![1]!),
  ]);
  const organizers = read('apps/organizers/src/app/common-texts.ts');
  const organizerKeys = new Set(strings(organizers.match(/const KEYS: readonly TextKey\[\] = \[([^\]]+)\]/)![1]!));
  // Organizers pide «contact.email» y lo rellena con el correo de su público (ORGANIZERS_EMAIL).
  assert.match(organizers, /const ORGANIZERS_EMAIL = 'contact\.organizers\.email'/);
  organizerKeys.delete('contact.email');
  organizerKeys.add('contact.organizers.email');
  guestKeys.delete('contact.email'); // reserva del correo de los huéspedes
  const mapped = (portal: 'guests' | 'organizers') => new Set(PORTAL_TEXTS[portal].flatMap((s) => s.slots.map((x) => x.key)));
  assert.deepEqual([...mapped('guests')].sort(), [...guestKeys].sort());
  assert.deepEqual([...mapped('organizers')].sort(), [...organizerKeys].sort());
  assert.ok('contact.email' in PORTAL_TEXT_FALLBACKS);
});

test('textos · dónde se lee cada clave y las claves que pide algún portal, sin repetir', () => {
  assert.deepEqual(textPlaces('contact.phone'), [{ portal: 'guests', screen: 'Ayuda y contacto' }, { portal: 'organizers', screen: 'Contacto' }]);
  assert.deepEqual(textPlaces('organizers.quote_note'), []);
  const keys = portalTextKeys();
  assert.equal(keys.length, new Set(keys).size);
  assert.ok(keys.includes('portal.privacy') && keys.includes('payment.instructions'));
});
