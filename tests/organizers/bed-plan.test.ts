/**
 * Organizers · la planta con camas de Alojamiento (O-C2 b, `app/bed-plan.ts`): forma de cada cama desde su disposición en
 * Booking y la capa de quién duerme. Pura, datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planIndex, planLayer, withBedLayouts, type PlanRoom, type PortalPlans } from '../../apps/organizers/src/app/bed-plan.ts';

const square = { points: [[0, 0], [40, 0], [40, 20], [0, 20]] as Array<[number, number]> };
const data: PortalPlans = {
  plans: [{ id: 'p1', buildingId: 'b1', floor: null, position: 0, width: 100, height: 100, fileId: 'f1', mime: 'image/png', sha256: null, url: 'https://example.invalid/p1' }],
  spaces: [
    { id: 'r1', parentId: 'b1', kind: 'habitacion', name: 'Hab 1', planId: 'p1', planShape: square, position: 0 },
    { id: 'c1', parentId: 'r1', kind: 'cama', name: 'Cama 1', planId: 'p1', planShape: { points: [[9, 9], [9, 9], [9, 9]] }, position: 0 },
    { id: 'c2', parentId: 'r1', kind: 'cama', name: 'Cama 2', planId: null, planShape: null, position: 1 },
    { id: 'c3', parentId: 'r1', kind: 'cama', name: 'Cama 3', planId: 'p1', planShape: square, position: 2 },
  ],
};
const rooms: PlanRoom[] = [{
  space_id: 'b-r1', resource_space_id: 'r1', layout: { cols: 4, rows: 2 }, name: 'Hab 1',
  beds: [
    { bed_id: 'b-c1', resource_bed_id: 'c1', layout: { x: 0, y: 0, rot: 0 }, label: '1', kind: 'individual', free: false, guest_id: 'g1', status: 'confirmed' },
    { bed_id: 'b-c2', resource_bed_id: 'c2', layout: { x: 2, y: 1, rot: 0 }, label: '2', kind: 'individual', free: false, guest_id: 'g2', status: 'requested' },
    { bed_id: 'b-c3', resource_bed_id: 'c3', layout: null, label: '3', kind: 'individual', free: true },
    { bed_id: 'b-x', resource_bed_id: null, layout: { x: 0, y: 1 }, label: 'S', kind: 'supletoria', free: true, group_label: 'Grupo' },
  ],
}];

test('cada cama toma la forma de su disposición en Booking; sin disposición, sin forma', () => {
  const out = withBedLayouts(data, rooms);
  const by = new Map(out.spaces.map((s) => [s.id, s]));
  assert.deepEqual(by.get('c1')!.planShape, { points: [[0, 0], [20, 0], [20, 10], [0, 10]] });
  assert.deepEqual(by.get('c2')!.planShape, { points: [[20, 10], [40, 10], [40, 20], [20, 20]] });
  assert.equal(by.get('c2')!.planId, 'p1');
  assert.equal(by.get('c3')!.planShape, null, 'la forma de Recursos no vale: manda Booking');
  assert.deepEqual(by.get('r1')!.planShape, square);
});

test('la capa: quién duerme, pendiente, reservada y libres por habitación', () => {
  const index = planIndex(rooms);
  assert.deepEqual([...index.keys()].sort(), ['c1', 'c2', 'c3', 'r1']);
  const names: Record<string, string> = { g1: 'Ana', g2: 'Luis' };
  const text = { free: 'Libre', requested: 'Pendiente', group: 'Reservada', roomFree: (f: number, n: number) => `${f} de ${n}` };
  const layer = (id: string) => planLayer(index.get(id)!, (g) => names[g]!, text);
  assert.deepEqual(layer('c1'), { state: 'occupied', label: 'Ana' });
  assert.deepEqual(layer('c2'), { state: 'occupied', tone: 'warn', label: 'Luis · Pendiente' });
  assert.deepEqual(layer('c3'), { state: 'free', label: 'Libre' });
  assert.deepEqual(layer('r1'), { tone: 'ok', label: '1 de 3', short: '1' }, 'la supletoria no cuenta');
  const group = planLayer({ room: rooms[0]!, bed: rooms[0]!.beds[3]! }, () => '', text);
  assert.deepEqual(group, { state: 'occupied', tone: 'muted', label: 'Reservada' });
});
