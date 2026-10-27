import type { SyncClient } from '@ikisai/sync-client';
import { TABLES, type OrderStatus, type PayMethod, type SettleMethod, type UnitStatus } from '@ikisai/domain-flow';

/**
 * Datos del personal leídos del espejo local (docs/flow/API.md §2). Todo en memoria por pantalla: una barra tiene pocos
 * cientos de filas. `_pending` lo pone el sync-client mientras el servidor no confirma un cambio encolado.
 */

type Row = { id: string; revision: number; created_at: string; updated_at: string; deleted_at: string | null; _pending?: boolean };

export interface Product extends Row { project_id: string; scope: 'clasico' | 'gourmet' | 'barra'; code: string; name: string; description: string | null; price_cents: number; active: boolean; prepared: boolean; position: number; image_key: string | null; source_line_id: string | null; allergens: string[]; allergens_checked: boolean }
export interface Customer extends Row { project_id: string; number: number; origin: 'web' | 'guest'; guest_id: string | null; display_name: string | null }
/** Cuenta del cliente (0910): se carga a ella y se liquida con un pago único. */
export interface Account extends Row { project_id: string; customer_id: string | null; holder: string; status: 'open' | 'settled'; opened_by: string | null; settled_at: string | null; settled_by: string | null; payment_id: string | null }
export interface Order extends Row {
  project_id: string; origin: 'public' | 'counter'; status: OrderStatus; pay_seq: number | null; paid_at: string | null; paid_by: string | null;
  pay_method: PayMethod | 'account' | null; total_cents: number | null; delivered_at: string | null; delivered_by: string | null; delivery_exception: boolean;
  notes: string | null; customer_id: string | null; parent_id: string | null; account_id: string | null;
}
export interface OrderLine extends Row { order_id: string; product_id: string; quantity: number; unit_price_cents: number | null; position: number; delivered_qty: number }
export interface Payment extends Row { order_id: string | null; account_id: string | null; kind: 'charge' | 'reversal' | 'adjustment' | 'refund'; method: SettleMethod | null; amount_cents: number; note: string | null; settled_at: string | null; settled_by: string | null }
export interface Unit extends Row {
  project_id: string; column_key: string; kind: 'prep' | 'task' | 'station'; order_id: string | null; line_id: string | null; product_id: string | null;
  idx: number; pay_seq: number | null; label: string | null; priority: boolean; status: UnitStatus; assigned_to: string | null; done_at: string | null; done_by: string | null;
  payload: { item_key?: string; name?: string; unit?: string; qty?: number; to?: string; from?: string | null; external?: { app: string; kind: string; id: string; status?: string | null };
    /** Puesto (kind 'station'): su métrica, parámetros y textos con {target} y {rate}. */
    metric?: string; params?: Record<string, unknown>; text?: string; notice?: string; notice_in?: string[];
    /** «Comprar X» (fresco bajo umbral): se pide a Tasks como compra de un toque. */
    purchase?: boolean } | null; source_ref: string | null;
}
export interface Project extends Row { name: string; status: 'active' | 'closed'; notes: string | null; booking_event_id: string | null; starts_on: string | null; ends_on: string | null; cover_image: string | null; test_mode: boolean; food_menu_id: string | null; tasks_project_id: string | null;
  template_key: string | null; template_version: number | null; frozen: boolean; serves_public: boolean; cover_file_id: string | null }

export interface FlowData {
  project: Project | null;
  products: Map<string, Product>;
  customers: Map<string, Customer>;
  orders: Order[];
  linesByOrder: Map<string, OrderLine[]>;
  paymentsByOrder: Map<string, Payment[]>;
  units: Unit[];
  unitsByOrder: Map<string, Unit[]>;
  accounts: Account[];
  /** La caja de este flujo lleva cuentas (config `accounts` de su columna, solo v2). */
  accountsEnabled: boolean;
  /** Quien entrega puede dar por hecho lo que quede y entregar de una vez (config de Servicio, solo v2; 0912). */
  completeOnDelivery: Set<string>;
}

const live = <T extends Row>(rows: unknown[]): T[] => (rows as T[]).filter((r) => !r.deleted_at);

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) { const k = key(item); const list = out.get(k); if (list) list.push(item); else out.set(k, [item]); }
  return out;
}

/**
 * Datos de un proyecto (`projectId`) o, sin él, de todo lo que la persona ve (las fichas abiertas por id). El acceso por
 * proyecto ya lo filtra el servidor (0902): aquí solo hay filas de los proyectos de la persona.
 */
export async function loadData(client: SyncClient, projectId?: string | null): Promise<FlowData> {
  const [projects, products, customers, orders, lines, payments, units, accounts, columns] = await Promise.all([
    client.list(TABLES.projects), client.list(TABLES.products), client.list(TABLES.customers), client.list(TABLES.orders),
    client.list(TABLES.orderLines), client.list(TABLES.payments), client.list(TABLES.units), client.list(TABLES.accounts), client.list(TABLES.columns),
  ]);
  const project = projectId ? live<Project>(projects).find((p) => p.id === projectId) ?? null : null;
  const inProject = <T extends Row & { project_id: string }>(rows: T[]) => (projectId ? rows.filter((r) => r.project_id === projectId) : rows);
  const liveOrders = inProject(live<Order>(orders));
  const liveUnits = inProject(live<Unit>(units));
  return {
    project,
    products: new Map(inProject(live<Product>(products)).map((p) => [p.id, p])),
    customers: new Map(inProject(live<Customer>(customers)).map((c) => [c.id, c])),
    orders: liveOrders,
    linesByOrder: groupBy(live<OrderLine>(lines).sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at)), (l) => l.order_id),
    paymentsByOrder: groupBy(live<Payment>(payments).filter((p) => p.order_id).sort((a, b) => a.created_at.localeCompare(b.created_at)), (p) => p.order_id!),
    units: liveUnits,
    unitsByOrder: groupBy(liveUnits.slice().sort((a, b) => a.idx - b.idx), (u) => u.order_id ?? ''),
    accounts: inProject(live<Account>(accounts)),
    accountsEnabled: !!projectId && live<{ project_id: string; key: string; config: Record<string, unknown> | null } & Row>(columns)
      .some((c) => c.project_id === projectId && c.key === 'order' && c.config?.accounts === true),
    completeOnDelivery: new Set(live<{ project_id: string; key: string; config: Record<string, unknown> | null } & Row>(columns)
      .filter((c) => c.key === 'service' && c.config?.complete_on_delivery === true).map((c) => c.project_id)),
  };
}

/** Avisa con los datos nuevos cuando cambia cualquier tabla de Flow (agrupando cambios seguidos). */
export function watchData(client: SyncClient, onData: (data: FlowData) => void, projectId?: string | null): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let alive = true;
  const refresh = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => { timer = null; const data = await loadData(client, projectId); if (alive) onData(data); }, 60);
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

/** Pedidos y suma de cada cuenta (lo cobrado o entregado). */
export function accountTotals(data: FlowData): Map<string, { orders: number; cents: number }> {
  const out = new Map<string, { orders: number; cents: number }>();
  for (const o of data.orders) {
    if (!o.account_id || o.status === 'open') continue;
    const t = out.get(o.account_id) ?? { orders: 0, cents: 0 };
    t.orders += 1; t.cents += o.total_cents ?? 0;
    out.set(o.account_id, t);
  }
  return out;
}

export function customerNumber(data: FlowData, order: Order): number | null {
  return order.customer_id ? data.customers.get(order.customer_id)?.number ?? null : null;
}

/** Proyectos que ve la persona, el más actual arriba (FLOW-DIR VG 26-10): activos antes que cerrados; luego por fechas. */
export async function loadProjects(client: SyncClient): Promise<Project[]> {
  const today = new Date().toISOString().slice(0, 10);
  const rank = (p: Project) => (p.status === 'active' ? 0 : 1);
  /** Distancia a hoy: 0 si está en curso; si no, días hasta su inicio o desde su fin. */
  const distance = (p: Project) => {
    if (!p.starts_on) return Number.MAX_SAFE_INTEGER / 2;
    if (p.starts_on <= today && (!p.ends_on || p.ends_on >= today)) return 0;
    const ref = p.starts_on > today ? p.starts_on : (p.ends_on ?? p.starts_on);
    return Math.abs(Date.parse(ref) - Date.parse(today)) / 86_400_000;
  };
  return live<Project>(await client.list(TABLES.projects))
    // Por evento (fechas) y, dentro, por versión: «Barra · v1 (congelada)», «Barra · v2».
    .sort((a, b) => rank(a) - rank(b) || distance(a) - distance(b) || (a.booking_event_id ?? '').localeCompare(b.booking_event_id ?? '')
      || (a.template_key ?? '').localeCompare(b.template_key ?? '') || (a.template_version ?? 0) - (b.template_version ?? 0) || b.created_at.localeCompare(a.created_at));
}

/** «Ahora · hasta el 1 nov», «Dentro de 3 días», «Ya pasó». */
export function projectState(p: Project, today = new Date().toISOString().slice(0, 10)): string {
  const base = projectStateBase(p, today);
  return [base, p.frozen ? 'congelada' : '', p.test_mode ? 'modo pruebas' : ''].filter(Boolean).join(' · ');
}

function projectStateBase(p: Project, today: string): string {
  if (p.status === 'closed') return 'Cerrado';
  if (!p.starts_on) return 'Sin fechas';
  const fmt = (d: string) => new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' }).format(new Date(`${d}T12:00:00`));
  if (p.starts_on <= today && (!p.ends_on || p.ends_on >= today)) return p.ends_on ? `Ahora · hasta el ${fmt(p.ends_on)}` : 'Ahora';
  if (p.starts_on > today) {
    const days = Math.round((Date.parse(p.starts_on) - Date.parse(today)) / 86_400_000);
    return days === 1 ? 'Mañana' : `Dentro de ${days} días`;
  }
  return 'Ya pasó';
}

export function projectDates(p: Project): string {
  if (!p.starts_on) return '';
  const fmt = (d: string) => new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' }).format(new Date(`${d}T12:00:00`));
  return p.ends_on && p.ends_on !== p.starts_on ? `${fmt(p.starts_on)} – ${fmt(p.ends_on)}` : fmt(p.starts_on);
}

/** Valor en vivo de la métrica de un puesto (`flow.station_metrics`, calculado en el servidor). */
export interface StationMetric { unit_id: string; metric: string; value: { target: number; rate: number; window: number } & Record<string, unknown> }

export async function loadStationMetrics(client: SyncClient, projectId: string): Promise<Map<string, StationMetric>> {
  try {
    const out = await client.api<StationMetric[] | null>('/read/flow.station_metrics', { method: 'POST', json: { project_id: projectId } });
    return new Map((out ?? []).map((m) => [m.unit_id, m]));
  } catch { return new Map(); }
}

/**
 * Histéresis de las métricas que la piden (`value.hysteresis`, pan v2): la cifra mostrada solo cambia si se mueve al menos
 * eso, o si quedaría por debajo de lo firme (`value.firm`). Así no baila con cada pedido; lo demás se ve tal cual.
 */
export function steadyMetrics(shown: Map<string, StationMetric>, next: Map<string, StationMetric>): Map<string, StationMetric> {
  const out = new Map<string, StationMetric>();
  for (const [id, m] of next) {
    const h = Number(m.value.hysteresis);
    const prev = shown.get(id);
    if (!prev || !(h > 0)) { out.set(id, m); continue; }
    const firm = Number(m.value.firm ?? 0);
    const keep = Math.abs(m.value.target - prev.value.target) < h && prev.value.target >= firm;
    out.set(id, keep ? { ...m, value: { ...m.value, target: prev.value.target } } : m);
  }
  return out;
}

/** «Ahora deben estar calentándose {target} …» con los valores de la métrica. */
export function fillMetricText(template: string | undefined, metric: StationMetric | undefined): string {
  if (!template || !metric) return '';
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = (metric.value as Record<string, unknown>)[k];
    return typeof v === 'number' ? new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(v) : String(v ?? '');
  });
}

/** Existencias por ingrediente (`flow.stock_view`): mesa, nevera y fresco, y lo consumido hoy. */
export interface StockItem {
  item_key: string; name: string; unit: string; consumed_today: number;
  places: Partial<Record<'mesa' | 'nevera' | 'fresco', { level: number; capacity: number; threshold_pct: number }>>;
}

export async function loadStock(client: SyncClient, projectId: string): Promise<StockItem[]> {
  try { return (await client.api<StockItem[] | null>('/read/flow.stock_view', { method: 'POST', json: { project_id: projectId } })) ?? []; }
  catch { return []; }
}
