/** Booking · «Montaje» del evento (dominio): cambios sobre la decoración general y las tareas de montaje (padre e hijas). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { montage } from '../../supabase/functions/_domain/booking/mod.ts';

const general: montage.DecorItem[] = [
  { item_id: 'p1', icon_id: 'planta', x: 1, y: 1, size: 1, label: 'Planta de la entrada' },
  { item_id: 'm1', icon_id: 'mesa', x: 4, y: 2, size: 4, label: 'Mesa larga' },
];

test('montaje · cambios normalizados: el último manda, fuera lo que no toca nada, orden estable', () => {
  const out = montage.normalizeChanges(general, [
    { op: 'remove', item_id: 'p1' },
    { op: 'replace', item_id: 'p1', icon_id: 'planta-grande', size: 4 },
    { op: 'replace', item_id: 'm1', icon_id: 'mesa', x: 4, y: 2 },          // igual que la general: nada
    { op: 'remove', item_id: 'no-existe' },                                 // no está en la general: nada
    { op: 'add', key: 'atril', icon_id: 'atril', x: 0, y: 0, size: 1, label: 'Atril' },
  ]);
  assert.deepEqual(out.map(montage.changeKey), ['add:atril', 'replace:p1']);
});

test('montaje · la decoración del evento: la general con sus cambios', () => {
  const items = montage.applyChanges(general, [{ op: 'remove', item_id: 'm1' }, { op: 'add', key: 'atril', icon_id: 'atril', x: 0, y: 0, size: 1 }]);
  assert.deepEqual(items.map((i) => [i.item_id, i.icon_id]), [['p1', 'planta'], ['add:atril', 'atril']]);
});

test('montaje · tareas: una padre por evento y una hija por cambio, con referencias estables; sin cambios, ninguna', () => {
  const event = { code: 'EVT_2026_031', title: 'Carrera sintética', start_date: '2026-10-30' };
  const edits: montage.DecorEdit[] = [{ plan_id: 'plano-albergue-0001', plan_label: 'Albergue', changes: [
    { op: 'remove', item_id: 'm1' }, { op: 'add', key: 'atril', icon_id: 'atril', x: 0, y: 0, size: 1, label: 'Atril' },
  ] }];
  const tasks = montage.montageTasks(event, edits, new Map([['plano-albergue-0001', general]]));
  assert.deepEqual(tasks.map((t) => [t.external_ref, t.parent_external_ref, t.title]), [
    ['EVT_2026_031-MONTAJE', null, 'Montaje del evento · Carrera sintética'],
    ['EVT_2026_031-MONTAJE-plano-al-add-atril', 'EVT_2026_031-MONTAJE', 'Montar: Atril (Albergue)'],
    ['EVT_2026_031-MONTAJE-plano-al-remove-m1', 'EVT_2026_031-MONTAJE', 'Retirar: Mesa larga (Albergue)'],
  ]);
  assert.ok(tasks.every((t) => t.due === '2026-10-30'));
  // las mismas entradas, las mismas referencias (idempotente)
  assert.deepEqual(montage.montageTasks(event, edits, new Map([['plano-albergue-0001', general]])).map((t) => t.external_ref), tasks.map((t) => t.external_ref));
  assert.deepEqual(montage.montageTasks(event, [{ plan_id: 'x', changes: [] }], new Map()), []);
});
