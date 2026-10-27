/** Booking · «Montaje» del evento (dominio, sobre resources.plans_with_decor): lo que se dibuja y las tareas padre e hijas. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { montage } from '../../supabase/functions/_domain/booking/mod.ts';

const EV = 'ev-1';
const row = (r: Partial<montage.DecorRow> & Pick<montage.DecorRow, 'id'>): montage.DecorRow => ({
  planId: 'plan-a', iconId: 'planta', cellX: 0, cellY: 0, scale: 1, size: 1, rotation: 0, layer: 'general', eventId: null, op: 'add', replacesItemId: null, ...r,
});
const rows: montage.DecorRow[] = [
  row({ id: 'g-planta' }),
  row({ id: 'g-mesa', iconId: 'mesa', cellX: 4, size: 4 }),
  row({ id: 'e-atril', layer: 'event', eventId: EV, iconId: 'atril', cellX: 2 }),
  row({ id: 'e-quita-mesa', layer: 'event', eventId: EV, op: 'remove', iconId: null, replacesItemId: 'g-mesa' }),
  row({ id: 'e-cambia-planta', layer: 'event', eventId: EV, op: 'replace', iconId: 'planta-grande', size: 4, replacesItemId: 'g-planta' }),
  row({ id: 'otro', layer: 'event', eventId: 'ev-2', iconId: 'escenario' }),
];

test('montaje · lo que se dibuja para el evento: la general con sus cambios, sin los de otros eventos', () => {
  assert.deepEqual(montage.resolveEventDecor(rows, EV).map((r) => r.id).sort(), ['e-atril', 'e-cambia-planta']);
  assert.deepEqual(montage.resolveEventDecor(rows, 'ev-sin-cambios').map((r) => r.id).sort(), ['g-mesa', 'g-planta']);
});

test('montaje · tareas: padre por evento y una hija por cambio, con referencias estables; sin cambios, ninguna', () => {
  const event = { code: 'EVT_2026_031', title: 'Carrera sintética', start_date: '2026-10-30' };
  const names = { icon: (id: string | null) => ({ planta: 'Planta', mesa: 'Mesa larga', atril: 'Atril', 'planta-grande': 'Planta grande' } as Record<string, string>)[id ?? ''] ?? 'objeto', plan: () => 'Albergue' };
  const tasks = montage.montageTasks(event, montage.eventChanges(rows, EV), names);
  assert.deepEqual(tasks.map((t) => [t.external_ref, t.parent_external_ref, t.title]), [
    ['EVT_2026_031-MONTAJE', null, 'Montaje del evento · Carrera sintética'],
    ['EVT_2026_031-MONTAJE-e-atril', 'EVT_2026_031-MONTAJE', 'Montar: Atril (Albergue)'],
    ['EVT_2026_031-MONTAJE-e-cambia-planta', 'EVT_2026_031-MONTAJE', 'Sustituir: Planta por Planta grande (Albergue)'],
    ['EVT_2026_031-MONTAJE-e-quita-mesa', 'EVT_2026_031-MONTAJE', 'Retirar: Mesa larga (Albergue)'],
  ]);
  assert.ok(tasks.every((t) => t.due === '2026-10-30'));
  assert.deepEqual(montage.montageTasks(event, montage.eventChanges(rows, 'ev-sin-cambios'), names), []);
});
