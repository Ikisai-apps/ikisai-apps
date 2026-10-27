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

test('montaje · petición a Tasks (§42): madre en el proyecto de la reserva y una hija por cambio, con referencias estables', () => {
  const reservation = { id: 'r-80', code: '2026-80', title: 'Carrera sintética', start_date: '2026-10-30' };
  const names = montage.namesFrom({
    icons: [{ id: 'planta', name: 'Planta' }, { id: 'mesa', name: 'Mesa larga' }, { id: 'atril', name: 'Atril' }, { id: 'planta-grande', name: 'Planta grande' }],
    plans: [{ id: 'plan-a', buildingId: 'alb', floor: 0 }], spaces: [{ id: 'alb', name: 'Albergue' }],
  });
  const req = montage.montageRequest(reservation, montage.eventChanges(rows, EV), names);
  assert.deepEqual([req.source, req.kind, req.external_ref, req.project_ref, req.due, req.external_url],
    ['booking', 'booking.event_setup', 'RES2026-80-MONTAJE', 'RES2026-80', '2026-10-30', 'https://booking.ikisai.com/#/reservas/r-80']);
  assert.deepEqual(req.children.map((c) => [c.external_ref, c.title]), [
    ['e-atril', 'Montar: Atril (Albergue · planta 0)'],
    ['e-cambia-planta', 'Sustituir: Planta por Planta grande (Albergue · planta 0)'],
    ['e-quita-mesa', 'Retirar: Mesa larga (Albergue · planta 0)'],
  ]);
  assert.ok(req.children.every((c) => /^[A-Za-z0-9_.:-]{1,100}$/.test(c.external_ref) && c.title.length <= 120));
  assert.deepEqual(montage.montageRequest(reservation, montage.eventChanges(rows, 'ev-sin-cambios'), names).children, []);
});

test('montaje · mover una pieza general es sustituirla por la misma: la tarea dice «Mover»', () => {
  const moved = [...rows.filter((r) => r.layer === 'general'), row({ id: 'e-mueve-mesa', layer: 'event', eventId: EV, op: 'replace', iconId: 'mesa', cellX: 9, replacesItemId: 'g-mesa' })];
  const names = montage.namesFrom({ icons: [{ id: 'mesa', name: 'Mesa larga' }], plans: [{ id: 'plan-a', label: 'Comedor' }] });
  const req = montage.montageRequest({ id: 'r', code: 'X1', title: 'T', start_date: null }, montage.eventChanges(moved, EV), names);
  assert.deepEqual(req.children.map((c) => c.title), ['Mover: Mesa larga (Comedor)']);
  assert.equal(req.due, undefined);
});

test('montaje · cada cambio del plano a set_event_decor: poner, mover o quitar lo general y lo del evento', () => {
  const withRev = rows.map((r) => ({ ...r, revision: 3 }));
  const item = (id: string, extra: Partial<montage.MapDecorChange['item']> = {}) => ({ id, planId: 'plan-a', iconId: 'atril', cellX: 7, cellY: 1, scale: 1, size: 1 as const, rotation: 90, ...extra });
  const nuevo = '00000000-0000-4000-8000-000000000001';
  assert.deepEqual(montage.eventDecorArgs(withRev, EV, { type: 'add', item: item(nuevo) }),
    { event_id: EV, put: [{ id: nuevo, plan_id: 'plan-a', cell_x: 7, cell_y: 1, scale: 1, size: 1, rotation: 90, icon_id: 'atril', op: 'add' }] });
  assert.ok(!('id' in montage.eventDecorArgs(withRev, EV, { type: 'add', item: item('deco-x') })!.put![0]!), 'un id que no es uuid lo pone Recursos');
  assert.deepEqual(montage.eventDecorArgs(withRev, EV, { type: 'move', item: item('g-mesa', { iconId: 'mesa' }) })!.put![0],
    { plan_id: 'plan-a', cell_x: 7, cell_y: 1, scale: 1, size: 1, rotation: 90, icon_id: 'mesa', op: 'replace', replaces_item_id: 'g-mesa' });
  assert.equal((montage.eventDecorArgs(withRev, EV, { type: 'remove', item: item('g-planta', { iconId: 'planta' }) })!.put![0] as Record<string, unknown>).op, 'remove');
  assert.deepEqual(montage.eventDecorArgs(withRev, EV, { type: 'remove', item: item('e-atril') }), { event_id: EV, delete: ['e-atril'] });
  assert.deepEqual(montage.eventDecorArgs(withRev, EV, { type: 'rotate', item: item('e-cambia-planta', { iconId: 'planta-grande' }) })!.put![0],
    { id: 'e-cambia-planta', expectedRevision: 3, plan_id: 'plan-a', cell_x: 7, cell_y: 1, scale: 1, size: 1, rotation: 90, icon_id: 'planta-grande', op: 'replace', replaces_item_id: 'g-planta' });
  assert.equal(montage.eventDecorArgs(withRev, EV, { type: 'move', item: item('otro') }), null, 'lo de otro evento no se toca');
});

