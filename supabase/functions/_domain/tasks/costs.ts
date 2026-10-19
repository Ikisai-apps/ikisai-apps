/**
 * Tasks · costes de tarea y proyecto (R6 PR 4; docs/tasks/API.md §37): funciones puras sobre el espejo de Recursos.
 * - Materiales: lo gastado de cada material × el coste medio ponderado de su artículo (las entradas con coste; las que lo
 *   reciben después, por `resources.movement_costs`). Sin entradas con coste, el material cuenta como «sin coste».
 * - A mano: `resources.cost_entries` con `target_app = 'tasks'` y `target_ref = 'task:<id>'` o `'project:<id>'`
 *   (p. ej. «alquiler de andamio 120 €»).
 * - El campo `cost` de la tarea (de antes de R6) sigue como coste a mano.
 * Quién ve los importes lo decide la interfaz (la propietaria y el responsable de compras del área).
 */
import type { Dataset, TaskMaterialRow, Uuid } from './types.ts';

export interface CostMovement { id: Uuid; item_id: Uuid; kind: string; quantity: number | string; unit_cost?: number | string | null; deleted_at?: string | null }
export interface MovementCost { movement_id: Uuid; unit_cost: number | string; deleted_at?: string | null }
export interface CostEntry { id: Uuid; target_app: string; target_ref: string; amount: number | string; description: string; at?: string; deleted_at?: string | null; revision?: number }

const round2 = (n: number) => Math.round(n * 100) / 100;

export const costRef = (kind: 'task' | 'project', id: Uuid): string => `${kind}:${id}`;

/** Coste medio ponderado de un artículo (por unidad base) con sus entradas con coste; `null` si no tiene ninguna. */
export function averageUnitCost(itemId: Uuid, movements: readonly CostMovement[], movementCosts: readonly MovementCost[] = []): number | null {
  const late = new Map(movementCosts.filter((c) => !c.deleted_at).map((c) => [c.movement_id, Number(c.unit_cost)]));
  let quantity = 0, amount = 0;
  for (const m of movements) {
    if (m.item_id !== itemId || m.deleted_at || !m.kind.startsWith('entrada_')) continue;
    const cost = m.unit_cost != null && m.unit_cost !== '' ? Number(m.unit_cost) : late.get(m.id);
    if (cost == null || !Number.isFinite(cost)) continue;
    quantity += Number(m.quantity); amount += Number(m.quantity) * cost;
  }
  return quantity > 0 ? amount / quantity : null;
}

/** Costes a mano de un destino (`task:<id>` o `project:<id>`), vivos. */
export function manualCosts(entries: readonly CostEntry[], ref: string): CostEntry[] {
  return entries.filter((e) => !e.deleted_at && e.target_app === 'tasks' && e.target_ref === ref);
}

export interface TaskCost {
  /** Cada material gastado con su coste (o `null` si su artículo no tiene entradas con coste). */
  materials: Array<{ material: TaskMaterialRow; unitCost: number | null; amount: number | null }>;
  materialsAmount: number;
  /** Materiales gastados sin coste conocido. */
  uncosted: number;
  manual: CostEntry[];
  manualAmount: number;
  /** El campo `cost` de la tarea (de antes de R6). */
  legacy: number;
  total: number;
}

export function taskCost(data: Dataset, taskId: Uuid, inventory: { movements: readonly CostMovement[]; movementCosts?: readonly MovementCost[]; costEntries?: readonly CostEntry[] }): TaskCost {
  const task = data['tasks.tasks'].find((t) => t.id === taskId);
  const averages = new Map<Uuid, number | null>();
  const avg = (itemId: Uuid) => {
    if (!averages.has(itemId)) averages.set(itemId, averageUnitCost(itemId, inventory.movements, inventory.movementCosts ?? []));
    return averages.get(itemId)!;
  };
  const materials = (data['tasks.task_materials'] ?? []).filter((m) => m.task_id === taskId && !m.deleted_at && m.consumed != null && Number(m.consumed) > 0)
    .map((material) => { const unitCost = avg(material.item_id); return { material, unitCost, amount: unitCost == null ? null : round2(Number(material.consumed) * unitCost) }; });
  const manual = manualCosts(inventory.costEntries ?? [], costRef('task', taskId));
  const materialsAmount = round2(materials.reduce((n, m) => n + (m.amount ?? 0), 0));
  const manualAmount = round2(manual.reduce((n, e) => n + Number(e.amount), 0));
  const legacy = Number(task?.cost) || 0;
  return { materials, materialsAmount, uncosted: materials.filter((m) => m.amount == null).length, manual, manualAmount, legacy, total: round2(materialsAmount + manualAmount + legacy) };
}

/** Coste de un proyecto: el de sus tareas vivas más sus costes a mano. */
export function projectCostOf(data: Dataset, projectId: Uuid, inventory: Parameters<typeof taskCost>[2]): number {
  const tasks = data['tasks.tasks'].filter((t) => t.project_id === projectId && !t.deleted_at);
  const manual = manualCosts(inventory.costEntries ?? [], costRef('project', projectId)).reduce((n, e) => n + Number(e.amount), 0);
  return round2(tasks.reduce((n, t) => n + taskCost(data, t.id, inventory).total, 0) + manual);
}

/** Alta de un coste a mano en Recursos (lo envía el cliente de Recursos). */
export function costEntryOperation(input: { id: Uuid; kind: 'task' | 'project'; targetId: Uuid; amount: number; description: string; at?: string }) {
  const description = input.description.trim();
  if (!description || description.length > 200) throw new RangeError('Describe el coste en 1 a 200 caracteres.');
  if (!Number.isFinite(input.amount) || input.amount === 0) throw new RangeError('Indica un importe.');
  return { op: 'insert' as const, table: 'resources.cost_entries', id: input.id, fields: {
    target_app: 'tasks', target_ref: costRef(input.kind, input.targetId), amount: round2(input.amount), description, ...(input.at ? { at: input.at } : {}),
  } };
}
