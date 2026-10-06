/**
 * Tasks · compras no alimentarias (docs/tasks/API.md §18): operaciones compuestas puras. Como el resto del dominio,
 * construyen operaciones de fila con sus cascadas y el hook SQL de la migración 0305 las verifica.
 */
import { POSITION_STEP, reject, type Dataset, type Operation, type Priority, type PurchaseRequestRow, type SupplyItemRow, type Uuid } from './types.ts';

import type { NewId } from './ops.ts';
const randomId: NewId = () => crypto.randomUUID();
const live = <T extends { deleted_at: string | null }>(rows: readonly T[]): T[] => rows.filter((r) => !r.deleted_at);
const insert = (table: string, id: Uuid, fields: Record<string, unknown>): Operation => ({ op: 'insert', table, id, fields });
const update = (table: string, row: { id: Uuid; revision: number }, fields: Record<string, unknown>): Operation => ({ op: 'update', table, id: row.id, expectedRevision: row.revision, fields });
const remove = (table: string, row: { id: Uuid; revision: number }): Operation => ({ op: 'delete', table, id: row.id, expectedRevision: row.revision });
const nextPosition = (rows: ReadonlyArray<{ position: number }>) => Math.max(0, ...rows.map((r) => Number(r.position) || 0)) + POSITION_STEP;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

function liveItem(data: Dataset, id: Uuid): SupplyItemRow {
  const item = data['tasks.supply_items'].find((s) => s.id === id);
  if (!item || item.deleted_at) reject(404, 'NOT_FOUND', 'No existe ese suministro.', { id });
  return item!;
}
function liveRequest(data: Dataset, id: Uuid): PurchaseRequestRow {
  const request = data['tasks.purchase_requests'].find((r) => r.id === id);
  if (!request || request.deleted_at) reject(404, 'NOT_FOUND', 'No existe esa solicitud.', { id });
  return request!;
}

// --- Stock ----------------------------------------------------------------------------------------------------------

/** Stock de un suministro: la suma de sus movimientos vivos. */
export function supplyStock(data: Dataset, itemId: Uuid): number {
  return round3(live(data['tasks.supply_movements']).filter((m) => m.supply_item_id === itemId).reduce((sum, m) => sum + Number(m.delta), 0));
}

/** Suministros vivos bajo su mínimo («Queda poco»), con su stock y la solicitud abierta, si la hay. */
export function lowStock(data: Dataset, tabId?: Uuid): Array<{ item: SupplyItemRow; stock: number; openRequest: PurchaseRequestRow | null }> {
  return live(data['tasks.supply_items'])
    .filter((s) => !s.archived && (!tabId || s.tab_id === tabId))
    .map((item) => ({ item, stock: supplyStock(data, item.id) }))
    .filter(({ item, stock }) => stock < Number(item.min_quantity))
    .map(({ item, stock }) => ({
      item, stock,
      openRequest: live(data['tasks.purchase_requests']).find((r) => r.supply_item_id === item.id && ['requested', 'approved', 'purchased'].includes(r.status)) ?? null,
    }));
}

/** Entrada, consumo o recuento. Un recuento guarda la diferencia con el stock actual; si no hay diferencia, no hay lote. */
export function supplyMovementOps(data: Dataset, itemId: Uuid, input: { kind: 'in' | 'out' | 'count'; amount: number; note?: string }, newId: NewId = randomId): Operation[] {
  const item = liveItem(data, itemId);
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount < 0 || (input.kind !== 'count' && input.amount === 0)) {
    reject(422, 'INVALID_QUANTITY', 'Indica una cantidad válida.', { field: 'amount' });
  }
  const delta = input.kind === 'in' ? input.amount : input.kind === 'out' ? -input.amount : round3(input.amount - supplyStock(data, itemId));
  if (delta === 0) return [];
  return [insert('tasks.supply_movements', newId(), { tab_id: item.tab_id, supply_item_id: item.id, kind: input.kind === 'count' ? 'adjust' : input.kind, delta, note: input.note ?? '' })];
}

/** Enviar un suministro a la papelera con sus movimientos vivos (el hook no deja movimientos vivos de un suministro borrado). */
export function deleteSupplyItemOps(data: Dataset, itemId: Uuid): Operation[] {
  const item = liveItem(data, itemId);
  return [...live(data['tasks.supply_movements']).filter((m) => m.supply_item_id === itemId).map((m) => remove('tasks.supply_movements', m)), remove('tasks.supply_items', item)];
}

// --- Solicitudes ----------------------------------------------------------------------------------------------------

export interface NewPurchase {
  id?: Uuid;
  tab_id: Uuid;
  project_id?: Uuid | null;
  task_id?: Uuid | null;
  supply_item_id?: Uuid | null;
  title: string;
  note?: string;
  quantity?: number | null;
  unit?: string | null;
  estimated_amount?: number | null;
  priority?: Priority;
  needs_invoice?: boolean;
  repeat_days?: number | null;
  due?: string | null;
  supplier_id?: string | null;
  supplier_name?: string | null;
  status?: 'requested' | 'approved';
}

/** Solicitud nueva al final de la lista de su área. */
export function requestPurchaseOps(data: Dataset, input: NewPurchase, newId: NewId = randomId): Operation[] {
  if (input.task_id) {
    const task = data['tasks.tasks'].find((t) => t.id === input.task_id);
    if (!task) reject(404, 'NOT_FOUND', 'No existe esa tarea.', { id: input.task_id });
    if (input.project_id && input.project_id !== task!.project_id) reject(422, 'INCONSISTENT_KEYS', 'La tarea es de otro proyecto.', { field: 'task_id' });
    input = { ...input, project_id: task!.project_id };
  }
  const fields: Record<string, unknown> = {
    tab_id: input.tab_id, project_id: input.project_id ?? null, task_id: input.task_id ?? null, supply_item_id: input.supply_item_id ?? null,
    title: input.title.trim(), note: input.note ?? '', quantity: input.quantity ?? null, unit: input.unit ?? null, estimated_amount: input.estimated_amount ?? null,
    priority: input.priority ?? 'normal', needs_invoice: input.needs_invoice ?? true, repeat_days: input.repeat_days ?? null, due: input.due ?? null,
    supplier_id: input.supplier_id ?? null, supplier_name: input.supplier_name ?? null,
    position: nextPosition(live(data['tasks.purchase_requests']).filter((r) => r.tab_id === input.tab_id)),
  };
  if (input.status && input.status !== 'requested') fields.status = input.status;
  return [insert('tasks.purchase_requests', input.id ?? newId(), fields)];
}

/** «Queda poco: pedir»: la solicitud precargada desde un suministro (cantidad de reposición o lo que falta hasta el mínimo). */
export function reorderSupplyOps(data: Dataset, itemId: Uuid, newId: NewId = randomId): Operation[] {
  const item = liveItem(data, itemId);
  const missing = Number(item.min_quantity) - supplyStock(data, itemId);
  const quantity = item.reorder_quantity != null ? Number(item.reorder_quantity) : Math.max(round3(missing), 1);
  return requestPurchaseOps(data, {
    tab_id: item.tab_id, supply_item_id: item.id, title: item.name, quantity, unit: item.unit,
    supplier_id: item.supplier_id, supplier_name: item.supplier_name,
  }, newId);
}

/** Cambiar de estado (aprobar, rechazar, marcar comprada). Para recibir, `receivePurchaseOps`. */
export function setPurchaseStatusOps(data: Dataset, requestId: Uuid, status: 'requested' | 'approved' | 'purchased' | 'rejected'): Operation[] {
  const request = liveRequest(data, requestId);
  return request.status === status ? [] : [update('tasks.purchase_requests', request, { status })];
}

/** Recibir: la solicitud pasa a recibida y, si es de un suministro con cantidad, entra en el stock en el mismo lote. */
export function receivePurchaseOps(data: Dataset, requestId: Uuid, newId: NewId = randomId): Operation[] {
  const request = liveRequest(data, requestId);
  const ops: Operation[] = request.status === 'received' ? [] : [update('tasks.purchase_requests', request, { status: 'received' })];
  const entered = live(data['tasks.supply_movements']).some((m) => m.purchase_request_id === request.id);
  const item = request.supply_item_id ? data['tasks.supply_items'].find((s) => s.id === request.supply_item_id && !s.deleted_at) : undefined;
  if (item && request.quantity && !entered) {
    ops.push(insert('tasks.supply_movements', newId(), { tab_id: request.tab_id, supply_item_id: item.id, kind: 'in', delta: Number(request.quantity), purchase_request_id: request.id, note: '' }));
  }
  return ops;
}

/** La siguiente de una recurrente: misma compra, con la fecha +N días desde que se recibió. */
export function nextRecurringOps(data: Dataset, requestId: Uuid, newId: NewId = randomId, status: 'requested' | 'approved' = 'requested'): Operation[] {
  const request = liveRequest(data, requestId);
  if (!request.repeat_days) return [];
  const from = request.received_at ? new Date(request.received_at) : new Date();
  const due = new Date(from.getTime() + request.repeat_days * 86_400_000).toISOString().slice(0, 10);
  return requestPurchaseOps(data, {
    tab_id: request.tab_id, project_id: request.project_id, task_id: request.task_id, supply_item_id: request.supply_item_id, title: request.title,
    note: request.note, quantity: request.quantity, unit: request.unit, estimated_amount: request.estimated_amount, priority: request.priority,
    needs_invoice: request.needs_invoice, repeat_days: request.repeat_days, due, supplier_id: request.supplier_id, supplier_name: request.supplier_name, status,
  }, newId);
}

// --- Plan de compras ------------------------------------------------------------------------------------------------

const supplierKey = (r: { supplier_id: string | null; supplier_name: string | null }) => r.supplier_id ? `id:${r.supplier_id}` : r.supplier_name?.trim() ? `nombre:${r.supplier_name.trim().toLocaleLowerCase()}` : 'sin';

/** Recurrentes que tocan en `date`: recibidas, con repetición, vencidas y sin otra abierta de la misma compra. */
export function dueRecurring(data: Dataset, tabId: Uuid, date: string): PurchaseRequestRow[] {
  const requests = live(data['tasks.purchase_requests']).filter((r) => r.tab_id === tabId);
  const sameBuy = (a: PurchaseRequestRow, b: PurchaseRequestRow) => (a.supply_item_id && a.supply_item_id === b.supply_item_id) || (!a.supply_item_id && !b.supply_item_id && a.title.trim().toLocaleLowerCase() === b.title.trim().toLocaleLowerCase());
  const latest = new Map<string, PurchaseRequestRow>();
  for (const r of requests) {
    if (r.status !== 'received' || !r.repeat_days || !r.received_at) continue;
    const key = r.supply_item_id ?? `t:${r.title.trim().toLocaleLowerCase()}`;
    const seen = latest.get(key);
    if (!seen || (seen.received_at ?? '') < r.received_at) latest.set(key, r);
  }
  return [...latest.values()].filter((r) => {
    const due = new Date(new Date(r.received_at!).getTime() + r.repeat_days! * 86_400_000).toISOString().slice(0, 10);
    return due <= date && !requests.some((o) => o.id !== r.id && sameBuy(o, r) && ['requested', 'approved', 'purchased'].includes(o.status));
  });
}

/**
 * «Preparar plan»: un plan con una parada por proveedor y, en ella, las solicitudes aprobadas sin plan del área, más las
 * recurrentes que tocan (se crean ya aprobadas, así que lo prepara quien aprueba). Lo que no tiene proveedor va a la
 * parada «Sin proveedor». Con `recurring: false` solo agrupa lo ya aprobado (así lo prepara un agente, que no aprueba).
 */
export function preparePlanOps(data: Dataset, input: { tab_id: Uuid; title: string; planned_for?: string | null; today: string; recurring?: boolean }, newId: NewId = randomId): Operation[] {
  const planId = newId();
  const ops: Operation[] = [insert('tasks.purchase_plans', planId, { tab_id: input.tab_id, title: input.title.trim(), planned_for: input.planned_for ?? null })];
  const approved = live(data['tasks.purchase_requests']).filter((r) => r.tab_id === input.tab_id && r.status === 'approved' && !r.plan_stop_id);
  const recurring = input.recurring === false ? [] : dueRecurring(data, input.tab_id, input.planned_for ?? input.today);
  const created: Array<{ id: Uuid; supplier_id: string | null; supplier_name: string | null; fresh: Operation }> = recurring.map((r) => {
    const fresh = nextRecurringOps(data, r.id, newId, 'approved')[0]!;
    return { id: fresh.id!, supplier_id: r.supplier_id, supplier_name: r.supplier_name, fresh };
  });
  const stops = new Map<string, Uuid>();
  let position = 0;
  const stopFor = (r: { supplier_id: string | null; supplier_name: string | null }) => {
    const key = supplierKey(r);
    if (!stops.has(key)) {
      const id = newId();
      stops.set(key, id);
      position += POSITION_STEP;
      ops.push(insert('tasks.purchase_plan_stops', id, {
        tab_id: input.tab_id, plan_id: planId, supplier_id: r.supplier_id, supplier_name: key === 'sin' ? 'Sin proveedor' : (r.supplier_name?.trim() || r.supplier_id!), position,
      }));
    }
    return stops.get(key)!;
  };
  for (const r of approved) ops.push(update('tasks.purchase_requests', r, { plan_stop_id: stopFor(r) }));
  for (const c of created) { c.fresh.fields!.plan_stop_id = stopFor(c); ops.push(c.fresh); }
  if (ops.length === 1) reject(422, 'INVALID_PURCHASE', 'No hay solicitudes aprobadas ni recurrentes pendientes para este plan.');
  return ops;
}

/** Quitar un plan que no tiene nada comprado: sus paradas a la papelera y sus solicitudes vuelven a estar sin plan. */
export function deletePlanOps(data: Dataset, planId: Uuid): Operation[] {
  const plan = data['tasks.purchase_plans'].find((p) => p.id === planId && !p.deleted_at);
  if (!plan) reject(404, 'NOT_FOUND', 'No existe ese plan.', { id: planId });
  const stops = live(data['tasks.purchase_plan_stops']).filter((s) => s.plan_id === planId);
  const stopIds = new Set(stops.map((s) => s.id));
  const requests = live(data['tasks.purchase_requests']).filter((r) => r.plan_stop_id && stopIds.has(r.plan_stop_id));
  if (requests.some((r) => r.status === 'purchased' || r.status === 'received')) reject(422, 'INVALID_PURCHASE', 'Este plan ya tiene compras: termínalo en lugar de borrarlo.');
  return [...requests.map((r) => update('tasks.purchase_requests', r, { plan_stop_id: null })), ...stops.map((s) => remove('tasks.purchase_plan_stops', s)), remove('tasks.purchase_plans', plan!)];
}
