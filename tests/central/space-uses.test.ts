/** Central · usos de los espacios (VG, 06-11; Recursos #1305): claves de Recursos, etiquetas de Central. Datos ficticios. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SPACE_USES, SPACE_USE_LABELS, spaceUses, spaceUsesText } from '../../supabase/functions/_domain/central/mod.ts';

test('usos · lista, orden, sin repetir y texto', () => {
  assert.deepEqual([...SPACE_USES], ['alojamiento', 'eventos', 'trabajo', 'almacen', 'cocina', 'comedor', 'ocio', 'servicio', 'exterior']);
  assert.equal(SPACE_USE_LABELS.almacen, 'Almacén');
  assert.deepEqual(spaceUses(['ocio', 'alojamiento', 'ocio', 'inventado']), ['alojamiento', 'ocio']);
  assert.deepEqual(spaceUses(null), []);
  assert.equal(spaceUsesText(['comedor', 'eventos']), 'Eventos · Comedor');
  assert.equal(spaceUsesText([]), 'Sin uso marcado');
});
