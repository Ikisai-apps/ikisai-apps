import type { SyncClient } from '@ikisai/sync-client';
import { TABLES, type OrderStatus, type PayMethod, type UnitStatus } from '@ikisai/domain-flow';

/**
 * Datos del personal leídos del espejo local (docs/flow/API.md §2). Todo en memoria por pantalla: una barra tiene pocos
 * cientos de filas. `_pending` lo pone el sync-client mientras el servidor no confirma un cambio encolado.
 */

type Row = { id: string; revision: number; created_at: string; updated_at: string; deleted_at: string | null; _pending?: boolean };

export interface Product extends Row { project_id: string; scope: 'clasico' | 'gourmet' | 'barra'; code: string; name: string; description: string | null; price_cents: number; active: boolean; prepared: boolean; position: number; image_key: string | null }
export interface Customer extends Row { project_id: string; number: number }
export interface Order extends Row {
  project_id: string; origin: 'public' | 'counter'; status: OrderStatus; pay_seq: number | null; paid_at: string | null; paid_by: string | null;
  pay_method: PayMethod | null; total_cents: number | null; delivered_at: string | null; delivered_by: string | null; delivery_exception: boolean;
  notes: string | null; customer_id: string | null; parent_id: string | null;
}
export interface OrderLine extends Row { order_id: string; product_id: string; quantity: number; unit_price_cents: number | null; position: number; delivered_qty: number }
export interface Payment extends Row { order_id: string; kind: 'charge' | 'reversal' | 'adjustment' | 'refund'; method: PayMethod | null; amount_cents: number; note: string | null; settled_at: string | null; settled_by: string | null }
export interface Unit extends Row {
  project_id: string; column_key: string; kind: 'prep' | 'task'; order_id: string | null; line_id: string | null; product_id: string | null;
  idx: number; pay_seq: number | null; label: string | null; priority: boolean; status: UnitStatus; assigned_to: string | null; done_at: string | null; done_by: string | null;
}
export interface Project extends Row { name: string; status: 'active' | 'closed' }

export interface FlowData {
  project: Project | null;
  products: Map<string, Product>;
  customers: Map<string, Customer>;
  orders: Order[];
  linesByOrder: Map<string, OrderLine[]>;
  paymentsByOrder: Map<string, Payment[]>;
  units: Unit[];
  unitsByOrder: Map<string, Unit[]>;
}

const live = <T extends Row>(rows: unknown[]): T[] => (rows as T[]).filter((r) => !r.deleted_at);

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) { const k = key(item); const list = out.get(k); if (list) list.push(item); else out.set(k, [item]); }
  return out;
}

export async function loadData(client: SyncClient): Promise<FlowData> {
  const [projects, products, customers, orders, lines, payments, units] = await Promise.all([
    client.list(TABLES.projects), client.list(TABLES.products), client.list(TABLES.customers), client.list(TABLES.orders),
    client.list(TABLES.orderLines), client.list(TABLES.payments), client.list(TABLES.units),
  ]);
  const activeProjects = live<Project>(projects).filter((p) => p.status === 'active').sort((a, b) => b.created_at.localeCompare(a.created_at));
  const project = activeProjects[0] ?? null;
  const inProject = <T extends Row & { project_id: string }>(rows: T[]) => (project ? rows.filter((r) => r.project_id === project.id) : rows);
  const liveOrders = inProject(live<Order>(orders));
  const liveUnits = inProject(live<Unit>(units));
  return {
    project,
    products: new Map(inProject(live<Product>(products)).map((p) => [p.id, p])),
    customers: new Map(inProject(live<Customer>(customers)).map((c) => [c.id, c])),
    orders: liveOrders,
    linesByOrder: groupBy(live<OrderLine>(lines).sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at)), (l) => l.order_id),
    paymentsByOrder: groupBy(live<Payment>(payments).sort((a, b) => a.created_at.localeCompare(b.created_at)), (p) => p.order_id),
    units: liveUnits,
    unitsByOrder: groupBy(liveUnits.slice().sort((a, b) => a.idx - b.idx), (u) => u.order_id ?? ''),
  };
}

/** Avisa con los datos nuevos cuando cambia cualquier tabla de Flow (agrupando cambios seguidos). */
export function watchData(client: SyncClient, onData: (data: FlowData) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let alive = true;
  const refresh = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => { timer = null; const data = await loadData(client); if (alive) onData(data); }, 60);
  };
  const offs = Object.values(TABLES).map((t) => client.onTable(t, refresh));
  refresh();
  return () => { alive = false; if (timer) clearTimeout(timer); offs.forEach((off) => off()); };
}

/** Orden de trabajo (§4, §10.3): los cobrados por número de cobro; los abiertos, por creación. Nunca por estado. */
export function byPaySeq(a: Order, b: Order): number {
  return (a.pay_seq ?? Number.MAX_SAFE_INTEGER) - (b.pay_seq ?? Number.MAX_SAFE_INTEGER) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

/** Total de un pedido: el del servidor si está cobrado; si no, informativo con el precio vigente. */
export function orderTotal(data: FlowData, order: Order): number {
  if (order.total_cents !== null) return order.total_cents;
  return (data.linesByOrder.get(order.id) ?? []).reduce((sum, l) => sum + l.quantity * (data.products.get(l.product_id)?.price_cents ?? 0), 0);
}

/** Lo que falta de un pedido cobrado: montaditos sin terminar y productos sin entregar (§6, FLOW-DIR-001 §2). */
export function pendingOf(data: FlowData, order: Order): { prepPending: number; prepTotal: number; undelivered: number; items: number } {
  const units = (data.unitsByOrder.get(order.id) ?? []).filter((u) => u.status !== 'cancelled');
  const lines = data.linesByOrder.get(order.id) ?? [];
  return {
    prepPending: units.filter((u) => u.status !== 'done').length,
    prepTotal: units.length,
    undelivered: lines.reduce((n, l) => n + Math.max(0, l.quantity - l.delivered_qty), 0),
    items: lines.reduce((n, l) => n + l.quantity, 0),
  };
}

export function customerNumber(data: FlowData, order: Order): number | null {
  return order.customer_id ? data.customers.get(order.customer_id)?.number ?? null : null;
}
