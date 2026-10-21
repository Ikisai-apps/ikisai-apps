/**
 * Tasks · compras no alimentarias (docs/tasks/API.md §18): operaciones compuestas puras. Como el resto del dominio,
 * construyen operaciones de fila con sus cascadas y el hook SQL de la migración 0305 las verifica.
 */
import { POSITION_STEP, reject, type Dataset, type Operation, type Priority, type PurchaseRequestRow, type Uuid } from './types.ts';

import type { NewId } from './ops.ts';
const randomId: NewId = () => crypto.randomUUID();
const live = <T extends { deleted_at: string | null }>(rows: readonly T[]): T[] => rows.filter((r) => !r.deleted_at);
const insert = (table: string, id: Uuid, fields: Record<string, unknown>): Operation => ({ op: 'insert', table, id, fields });
const update = (table: string, row: { id: Uuid; revision: number }, fields: Record<string, unknown>): Operation => ({ op: 'update', table, id: row.id, expectedRevision: row.revision, fields });
const remove = (table: string, row: { id: Uuid; revision: number }): Operation => ({ op: 'delete', table, id: row.id, expectedRevision: row.revision });
const nextPosition = (rows: ReadonlyArray<{ position: number }>) => Math.max(0, ...rows.map((r) => Number(r.position) || 0)) + POSITION_STEP;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

function liveRequest(data: Dataset, id: Uuid): PurchaseRequestRow {
  const request = data['tasks.purchase_requests'].find((r) => r.id === id);
  if (!request || request.deleted_at) reject(404, 'NOT_FOUND', 'No existe esa solicitud.', { id });
  return request!;
}

// --- Almacén: el inventario común de Recursos (R6) ----------------------------------------------------------------------

/** Lo que Tasks usa de un artículo de `resources.items` (filas del espejo del segundo cliente o de `tasks.supply_item`). */
export interface ResourceItem {
  id: Uuid; name: string; kind: string; base_unit: string; min_quantity: number | string | null; reorder_quantity: number | string | null;
  default_space_id: Uuid | null; default_supplier_id: string | null; active: boolean; deleted_at: string | null;
}
export interface ResourceMovement { item_id: Uuid; quantity: number | string; deleted_at?: string | null }

/** Tipos de artículo que son suministros de la casa: todo menos lo de cocina (lo mismo que `tasks.supply_kind` en SQL). */
export const KITCHEN_KINDS = ['ingrediente', 'bebida', 'menaje'] as const;
export const isSupplyKind = (kind: string | null | undefined): boolean => !!kind && !(KITCHEN_KINDS as readonly string[]).includes(kind);

/** Stock de un artículo en toda la casa: la suma de sus movimientos vivos. */
export function itemStock(movements: readonly ResourceMovement[], itemId: Uuid): number {
  return round3(movements.filter((m) => m.item_id === itemId && !m.deleted_at).reduce((sum, m) => sum + Number(m.quantity), 0));
}

/** «Queda poco»: suministros activos con mínimo y menos stock que él, con la solicitud abierta que ya lo pide, si la hay. */
export function lowStock(data: Dataset, items: readonly ResourceItem[], movements: readonly ResourceMovement[]): Array<{ item: ResourceItem; stock: number; openRequest: PurchaseRequestRow | null }> {
  return items
    .filter((i) => !i.deleted_at && i.active !== false && isSupplyKind(i.kind) && i.min_quantity != null && Number(i.min_quantity) > 0)
    .map((item) => ({ item, stock: itemStock(movements, item.id) }))
    .filter(({ item, stock }) => stock < Number(item.min_quantity))
    .map(({ item, stock }) => ({ item, stock, openRequest: openRequestFor(data, item.id) }));
}

/** La solicitud abierta (pedida, aprobada o comprada) de un artículo, si la hay. */
export function openRequestFor(data: Dataset, itemId: Uuid): PurchaseRequestRow | null {
  return live(data['tasks.purchase_requests']).find((r) => r.item_id === itemId && ['requested', 'approved', 'purchased'].includes(r.status)) ?? null;
}

/** Referencia de la entrada en Recursos de una solicitud recibida (`source_ref` con `source_app = 'tasks'`). */
export const receiptRef = (requestId: Uuid): string => `purchase_request:${requestId}`;

/** Un envase de `resources.item_units` (unidad, factor hacia la base, habitual y precio del envase; #695). */
export interface ItemUnitRow {
  id?: Uuid; item_id: Uuid; unit: string; factor: number | string; usual?: boolean | null; price?: number | string | null; deleted_at?: string | null;
}

/** Lo que entra al recibir (MUELA-094 §4): lo que hacía falta, lo que se compra (envases enteros), lo que sobra y el coste. */
export interface ReceiptPlan {
  /** Lo que hacía falta, en la unidad base del artículo. */
  need: number;
  /** Lo que se compra y entra en el almacén, en la unidad base (envases × factor). */
  bought: number;
  /** Lo que sobra y se queda en el almacén (bought − need, nunca negativo). */
  extra: number;
  baseUnit: string;
  /** El envase con el que se compra (sin envase, null) y cuántos. */
  pack: { unit: string; factor: number; price: number | null } | null;
  packs: number | null;
  /** Importe de la compra: el estimado de la solicitud o, sin él, envases × precio del envase. Sin precio, null (nunca 0). */
  amount: number | null;
  /** Coste por unidad base sobre lo que entra (amount ÷ bought). */
  unitCost: number | null;
}

const EPS = 1e-9;
/** Unidades que se convierten entre sí (familia y tamaño en la menor). Lo demás solo vale si es la base o un envase. */
const SCALE: Record<string, [string, number]> = {
  g: ['masa', 1], gr: ['masa', 1], kg: ['masa', 1000], mg: ['masa', 0.001],
  ml: ['vol', 1], cl: ['vol', 10], dl: ['vol', 100], l: ['vol', 1000],
  ud: ['ud', 1], u: ['ud', 1], unidad: ['ud', 1], unidades: ['ud', 1], uds: ['ud', 1],
};
const unitKey = (u: string | null | undefined) => String(u ?? '').trim().toLocaleLowerCase().replace(/\.$/, '');
const liveUnits = (units: readonly ItemUnitRow[] | null | undefined, itemId: Uuid) =>
  (units ?? []).filter((u) => u.item_id === itemId && !u.deleted_at && Number(u.factor) > 0);

/**
 * Una cantidad de la solicitud pasada a la unidad base del artículo: la base tal cual (o sin unidad), un envase del
 * artículo (× su factor) o una unidad de la misma familia (kg → g, l → ml…). Si no se sabe pasar, null.
 */
export function toBaseQuantity(quantity: number, unit: string | null | undefined, baseUnit: string, units?: readonly ItemUnitRow[] | null): number | null {
  const u = unitKey(unit), b = unitKey(baseUnit);
  if (!u || u === b) return quantity;
  const pack = (units ?? []).find((x) => unitKey(x.unit) === u && Number(x.factor) > 0);
  if (pack) return round3(quantity * Number(pack.factor));
  const from = SCALE[u], to = SCALE[b];
  if (from && to && from[0] === to[0]) return round3((quantity * from[1]) / to[1]);
  return null;
}

/**
 * Lo que entra al recibir una solicitud con artículo (almacén = Sí, MUELA-094): **envases enteros** del habitual (`usual`;
 * si no hay, el primero), en la unidad base del artículo; lo que sobra se queda en el almacén. Si la solicitud ya se pide
 * en envases («2 garrafas de 5 l»), entra eso. Sin envase, entra lo pedido (en la base). Sin artículo o sin cantidad, null.
 * Una unidad que no se sabe pasar a la base se rechaza (`INVALID_UNIT`): nunca entra una cifra en otra unidad.
 */
export function receiptPlan(request: PurchaseRequestRow, item: { base_unit: string } | null | undefined, units?: readonly ItemUnitRow[] | null): ReceiptPlan | null {
  const quantity = Number(request.quantity);
  if (!request.item_id || !(quantity > 0)) return null;
  const baseUnit = item?.base_unit || request.unit || '';
  const formats = liveUnits(units, request.item_id);
  const base = item ? toBaseQuantity(quantity, request.unit, baseUnit, formats) : quantity;
  if (base === null) {
    reject(422, 'INVALID_UNIT', `No se sabe pasar «${request.unit}» a ${baseUnit}, la unidad del artículo: cambia la unidad de la solicitud.`, { field: 'unit', id: request.id });
  }
  const asked = formats.find((f) => unitKey(f.unit) === unitKey(request.unit)) ?? null;
  const fmt = asked ?? formats.find((f) => f.usual) ?? formats[0] ?? null;
  let bought = base!;
  let packs: number | null = null;
  if (fmt) {
    const factor = Number(fmt.factor);
    packs = asked ? Math.ceil(quantity - EPS) : Math.ceil(base! / factor - EPS);
    bought = round3(packs * factor);
  }
  const needRaw = request.need_quantity == null ? null : Number(request.need_quantity);
  const need = needRaw != null && needRaw > 0 ? needRaw : base!;
  const price = fmt?.price == null || fmt.price === '' ? null : Number(fmt.price);
  const estimated = request.estimated_amount == null ? null : Number(request.estimated_amount);
  const amount = estimated != null && estimated > 0 ? estimated : packs != null && price != null && price > 0 ? Math.round(packs * price * 100) / 100 : null;
  return {
    need: round3(need), bought, extra: round3(Math.max(bought - need, 0)), baseUnit,
    pack: fmt ? { unit: fmt.unit, factor: Number(fmt.factor), price: price != null && price > 0 ? price : null } : null, packs,
    amount, unitCost: amount != null && bought > 0 ? Math.round((amount / bought) * 10000) / 10000 : null,
  };
}

/**
 * La entrada en Recursos al recibir una solicitud con artículo y cantidad: `entrada_manual` en el sitio indicado con **lo
 * comprado** (`receiptPlan`: envases enteros, en la unidad base) y el coste por unidad sobre eso. El id lo da quien llama,
 * estable por solicitud (así recibir dos veces no suma dos veces: el núcleo rechaza la segunda con ROW_EXISTS). Sin artículo
 * o sin cantidad, no hay entrada. Sin `item` (llamadas de antes), entra lo pedido tal cual.
 */
export function receiptEntryOperation(request: PurchaseRequestRow, input: { id: Uuid; spaceId: Uuid; item?: { base_unit: string } | null; units?: readonly ItemUnitRow[] | null }): Operation | null {
  const plan = receiptPlan(request, input.item ?? null, input.units ?? null);
  if (!plan || !(plan.bought > 0)) return null;
  return insert('resources.movements', input.id, {
    item_id: request.item_id, space_id: input.spaceId, lot_id: null, quantity: plan.bought, kind: 'entrada_manual', reason: null,
    unit_cost: plan.unitCost, transfer_id: null,
    source_app: 'tasks', source_ref: receiptRef(request.id), note: request.title.slice(0, 500),
  });
}

// --- Solicitudes ----------------------------------------------------------------------------------------------------

export interface NewPurchase {
  id?: Uuid;
  tab_id: Uuid;
  project_id?: Uuid | null;
  task_id?: Uuid | null;
  item_id?: Uuid | null;
  title: string;
  note?: string;
  quantity?: number | null;
  unit?: string | null;
  /** Lo que hacía falta, en la unidad base del artículo (MUELA-094). */
  need_quantity?: number | null;
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
    tab_id: input.tab_id, project_id: input.project_id ?? null, task_id: input.task_id ?? null, item_id: input.item_id ?? null,
    title: input.title.trim(), note: input.note ?? '', quantity: input.quantity ?? null, unit: input.unit ?? null, estimated_amount: input.estimated_amount ?? null,
    priority: input.priority ?? 'normal', needs_invoice: input.needs_invoice ?? true, repeat_days: input.repeat_days ?? null, due: input.due ?? null,
    supplier_id: input.supplier_id ?? null, supplier_name: input.supplier_name ?? null,
    position: nextPosition(live(data['tasks.purchase_requests']).filter((r) => r.tab_id === input.tab_id)),
  };
  if (input.need_quantity != null) fields.need_quantity = input.need_quantity;
  if (input.status && input.status !== 'requested') fields.status = input.status;
  return [insert('tasks.purchase_requests', input.id ?? newId(), fields)];
}

/**
 * «Queda poco: pedir»: la solicitud precargada desde un artículo de Recursos (cantidad de reposición o lo que falta hasta
 * el mínimo, en su unidad base), en el área que la pide. El proveedor habitual del artículo va como id; el nombre lo pone
 * quien llama si lo conoce (catálogo de Finance).
 */
export function reorderItemOps(data: Dataset, input: { tab_id: Uuid; item: ResourceItem; stock: number; supplier_name?: string | null }, newId: NewId = randomId): Operation[] {
  const { item } = input;
  if (item.deleted_at) reject(404, 'NOT_FOUND', 'No existe ese artículo.', { id: item.id });
  const missing = Number(item.min_quantity ?? 0) - input.stock;
  const quantity = item.reorder_quantity != null ? Number(item.reorder_quantity) : Math.max(round3(missing), 1);
  return requestPurchaseOps(data, {
    tab_id: input.tab_id, item_id: item.id, title: item.name, quantity, unit: item.base_unit, need_quantity: quantity,
    supplier_id: item.default_supplier_id, supplier_name: input.supplier_name ?? null,
  }, newId);
}

/** Cambiar de estado (aprobar, rechazar, marcar comprada). Para recibir, `receivePurchaseOps`. */
export function setPurchaseStatusOps(data: Dataset, requestId: Uuid, status: 'requested' | 'approved' | 'purchased' | 'rejected'): Operation[] {
  const request = liveRequest(data, requestId);
  return request.status === status ? [] : [update('tasks.purchase_requests', request, { status })];
}

/**
 * «No se compró» (0337): una compra marcada por error vuelve a aprobada. Si su plan ya está terminado, sale de la parada
 * para poder entrar en otro plan; si el plan sigue abierto, se queda en él. Con una factura ligada no se puede (`invoiced`
 * lo sabe quien lee Finance; el servidor lo comprueba igual con `PURCHASE_INVOICED`). Lo recibido no se deshace aquí.
 */
export function undoPurchaseOps(data: Dataset, requestId: Uuid, opts: { invoiced?: boolean } = {}): Operation[] {
  const request = liveRequest(data, requestId);
  if (request.status !== 'purchased') reject(422, 'INVALID_PURCHASE', 'Solo se deshace una compra que aún no se ha recibido.', { id: requestId });
  if (opts.invoiced) reject(422, 'PURCHASE_INVOICED', 'Ya está ligada a una factura: corrígelo en Finance.', { id: requestId });
  const stop = request.plan_stop_id ? data['tasks.purchase_plan_stops'].find((s) => s.id === request.plan_stop_id) : null;
  const plan = stop ? data['tasks.purchase_plans'].find((p) => p.id === stop.plan_id) : null;
  const leave = !!stop && (!plan || plan.deleted_at != null || plan.status === 'done');
  return [update('tasks.purchase_requests', request, leave ? { status: 'approved', plan_stop_id: null } : { status: 'approved' })];
}

/**
 * Recibir: la solicitud pasa a recibida. La entrada en el stock es de Recursos (otra app, otro lote): la construye
 * `receiptEntryOperation` y la envía el cliente de Recursos antes de este lote.
 */
export function receivePurchaseOps(data: Dataset, requestId: Uuid): Operation[] {
  const request = liveRequest(data, requestId);
  return request.status === 'received' ? [] : [update('tasks.purchase_requests', request, { status: 'received' })];
}

/** La siguiente de una recurrente: misma compra, con la fecha +N días desde que se recibió. */
export function nextRecurringOps(data: Dataset, requestId: Uuid, newId: NewId = randomId, status: 'requested' | 'approved' = 'requested'): Operation[] {
  const request = liveRequest(data, requestId);
  if (!request.repeat_days) return [];
  const from = request.received_at ? new Date(request.received_at) : new Date();
  const due = new Date(from.getTime() + request.repeat_days * 86_400_000).toISOString().slice(0, 10);
  return requestPurchaseOps(data, {
    tab_id: request.tab_id, project_id: request.project_id, task_id: request.task_id, item_id: request.item_id, title: request.title,
    note: request.note, quantity: request.quantity, unit: request.unit, need_quantity: request.need_quantity ?? null, estimated_amount: request.estimated_amount, priority: request.priority,
    needs_invoice: request.needs_invoice, repeat_days: request.repeat_days, due, supplier_id: request.supplier_id, supplier_name: request.supplier_name, status,
  }, newId);
}

// --- Plan de compras ------------------------------------------------------------------------------------------------

const supplierKey = (r: { supplier_id: string | null; supplier_name: string | null }) => r.supplier_id ? `id:${r.supplier_id}` : r.supplier_name?.trim() ? `nombre:${r.supplier_name.trim().toLocaleLowerCase()}` : 'sin';

/** Recurrentes que tocan en `date`: recibidas, con repetición, vencidas y sin otra abierta de la misma compra. */
export function dueRecurring(data: Dataset, tabId: Uuid, date: string): PurchaseRequestRow[] {
  const requests = live(data['tasks.purchase_requests']).filter((r) => r.tab_id === tabId);
  const sameBuy = (a: PurchaseRequestRow, b: PurchaseRequestRow) => (a.item_id && a.item_id === b.item_id) || (!a.item_id && !b.item_id && a.title.trim().toLocaleLowerCase() === b.title.trim().toLocaleLowerCase());
  const latest = new Map<string, PurchaseRequestRow>();
  for (const r of requests) {
    if (r.status !== 'received' || !r.repeat_days || !r.received_at) continue;
    const key = r.item_id ?? `t:${r.title.trim().toLocaleLowerCase()}`;
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
export function preparePlanOps(data: Dataset, input: { tab_id: Uuid; title: string; planned_for?: string | null; today: string; recurring?: boolean; exclude?: readonly Uuid[] | null }, newId: NewId = randomId): Operation[] {
  const planId = newId();
  // «Preparando» al momento (MUELA-094, hallazgo 1): sin esperar al valor por defecto del servidor.
  const ops: Operation[] = [insert('tasks.purchase_plans', planId, { tab_id: input.tab_id, title: input.title.trim(), planned_for: input.planned_for ?? null, status: 'draft' })];
  // Lo quitado de «Lo que entrará al preparar» no entra: las aprobadas por su id y las recurrentes por el de la recibida.
  const skip = new Set(input.exclude ?? []);
  const approved = live(data['tasks.purchase_requests']).filter((r) => r.tab_id === input.tab_id && r.status === 'approved' && !r.plan_stop_id && !skip.has(r.id));
  const recurring = input.recurring === false ? [] : dueRecurring(data, input.tab_id, input.planned_for ?? input.today).filter((r) => !skip.has(r.id));
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

/** Las solicitudes que crea un lote de `preparePlanOps` (las recurrentes que tocan): para el «Deshacer» de crear el plan. */
export const createdRequestIds = (ops: readonly Operation[]): Uuid[] =>
  ops.filter((o) => o.op === 'insert' && o.table === 'tasks.purchase_requests').map((o) => o.id!);

/**
 * Quitar un plan que no tiene nada comprado: sus paradas a la papelera y sus solicitudes vuelven a estar sin plan. Con
 * `created` (el «Deshacer» de crearlo), las recurrentes que creó al prepararlo van a la papelera en lugar de quedarse
 * aprobadas y sin plan (MUELA-094, riesgo de PERDIDAS §4).
 */
export function deletePlanOps(data: Dataset, planId: Uuid, opts: { created?: readonly Uuid[] | null } = {}): Operation[] {
  const plan = data['tasks.purchase_plans'].find((p) => p.id === planId && !p.deleted_at);
  if (!plan) reject(404, 'NOT_FOUND', 'No existe ese plan.', { id: planId });
  const stops = live(data['tasks.purchase_plan_stops']).filter((s) => s.plan_id === planId);
  const stopIds = new Set(stops.map((s) => s.id));
  const requests = live(data['tasks.purchase_requests']).filter((r) => r.plan_stop_id && stopIds.has(r.plan_stop_id));
  if (requests.some((r) => r.status === 'purchased' || r.status === 'received')) reject(422, 'INVALID_PURCHASE', 'Este plan ya tiene compras: termínalo en lugar de borrarlo.');
  const created = new Set(opts.created ?? []);
  return [...requests.map((r) => (created.has(r.id) ? remove('tasks.purchase_requests', r) : update('tasks.purchase_requests', r, { plan_stop_id: null }))),
    ...stops.map((s) => remove('tasks.purchase_plan_stops', s)), remove('tasks.purchase_plans', plan!)];
}

/** La parada viva de una solicitud, si está en un plan que sigue vivo. */
export function planOf(data: Dataset, request: PurchaseRequestRow): { stop: Dataset['tasks.purchase_plan_stops'][number]; plan: Dataset['tasks.purchase_plans'][number] } | null {
  if (!request.plan_stop_id) return null;
  const stop = data['tasks.purchase_plan_stops'].find((s) => s.id === request.plan_stop_id && !s.deleted_at);
  const plan = stop ? data['tasks.purchase_plans'].find((p) => p.id === stop.plan_id && !p.deleted_at) : null;
  return stop && plan ? { stop, plan } : null;
}

/**
 * «+ Añadir al plan» (MUELA-094 §3): una compra aprobada y sin plan entra en la parada de su tienda o en una nueva al
 * final. Un plan terminado no admite nada.
 */
export function addToPlanOps(data: Dataset, planId: Uuid, requestId: Uuid, newId: NewId = randomId): Operation[] {
  const request = liveRequest(data, requestId);
  const plan = data['tasks.purchase_plans'].find((p) => p.id === planId && !p.deleted_at);
  if (!plan) reject(404, 'NOT_FOUND', 'No existe ese plan.', { id: planId });
  if (plan!.status === 'done') reject(422, 'INVALID_PURCHASE', 'El plan está terminado: reábrelo para añadir algo.', { id: planId });
  if (request.status !== 'approved') reject(422, 'INVALID_PURCHASE', 'Solo entra en un plan una compra aprobada.', { id: requestId });
  if (planOf(data, request)) reject(422, 'INVALID_PURCHASE', 'Ya está en un plan.', { id: requestId });
  const stops = live(data['tasks.purchase_plan_stops']).filter((s) => s.plan_id === planId);
  const key = supplierKey(request);
  const stop = stops.find((s) => supplierKey(s) === key || (key === 'sin' && s.supplier_name === 'Sin proveedor'));
  if (stop) return [update('tasks.purchase_requests', request, { plan_stop_id: stop.id })];
  const stopId = newId();
  return [
    insert('tasks.purchase_plan_stops', stopId, {
      tab_id: plan!.tab_id, plan_id: planId, supplier_id: request.supplier_id, supplier_name: key === 'sin' ? 'Sin proveedor' : (request.supplier_name?.trim() || request.supplier_id!), position: nextPosition(stops),
    }),
    update('tasks.purchase_requests', request, { plan_stop_id: stopId }),
  ];
}

/** «×» en el plan: la compra sale de él y vuelve a «aprobadas sin plan». Comprada o recibida no se saca (también lo rechaza el servidor). */
export function removeFromPlanOps(data: Dataset, requestId: Uuid): Operation[] {
  const request = liveRequest(data, requestId);
  if (!request.plan_stop_id) return [];
  if (request.status === 'purchased' || request.status === 'received') reject(422, 'INVALID_PURCHASE', 'Ya está comprada: no se puede sacar del plan.', { id: requestId });
  return [update('tasks.purchase_requests', request, { plan_stop_id: null })];
}

/**
 * Arrastrar a otra tienda (MUELA-094 §1, decisión de Sevilla): cambia el proveedor de una compra que no está comprada ni
 * en un plan (si está en un plan, se quedaría en la parada de la tienda vieja). `null` = «Sin tienda».
 */
export function moveToSupplierOps(data: Dataset, requestId: Uuid, supplier: { supplier_id?: string | null; supplier_name: string | null }): Operation[] {
  const request = liveRequest(data, requestId);
  if (request.status === 'purchased' || request.status === 'received') reject(422, 'INVALID_PURCHASE', 'Ya está comprada: la tienda no cambia.', { id: requestId });
  const inPlan = planOf(data, request);
  if (inPlan) reject(422, 'INVALID_PURCHASE', `Está en el plan «${inPlan.plan.title}»: sácala del plan para cambiar de tienda.`, { id: requestId });
  const name = supplier.supplier_name?.trim() || null;
  const id = supplier.supplier_id ?? null;
  if ((request.supplier_name ?? null) === name && (request.supplier_id ?? null) === id) return [];
  return [update('tasks.purchase_requests', request, { supplier_name: name, supplier_id: id })];
}
