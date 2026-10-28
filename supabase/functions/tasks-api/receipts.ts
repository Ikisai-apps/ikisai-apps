/**
 * Ikisai Tasks · cuadre con Finance al recibir (orden inverso de R4; RESPUESTAS de Core del 19-10-2026; API.md §35).
 *
 * Si una factura se valida en Finance **antes** de que Tasks reciba la compra, Finance no se entera de la recepción. Tras
 * marcar «Recibida», la app llama aquí: se lee `invoices.tasks_resource_entries` (lectura de Finance abierta a Tasks,
 * editor y propietaria, 0239) con las solicitudes y, si trae algo, se manda en un lote de Recursos como hace la Edge de
 * Finance (`reconcileResourceEntries`): `resources.reconcile_entries` y los costes de las entradas (`movement_costs`, con el
 * mismo id estable que usa Finance). Repetirlo no duplica nada (requestId y digest estables, cuadre idempotente).
 * - `POST purchases/reconcile {requestIds}`: hasta 100 solicitudes. Devuelve `{movements, costs, results}`: en `results`,
 *   una fila por solicitud (MUELA-094 §4) con `state` — `ok` (cuadrada: lo facturado es lo previsto o no hay previsto),
 *   `diff` (con diferencia), `none` (sin factura en Finance todavía, o sin acceso a Finance) o `error` (el cuadre no se
 *   pudo hacer) —, `invoiced` (lo asignado en Finance), `estimated`, `diff` y `codes`. Si falla el lote de Recursos, las
 *   que tenían factura vuelven con `error` (200): la app las apunta en su cola y las reintenta.
 * Un fallo aquí no deshace la recepción: la app lo enseña y lo reintenta.
 */
import { fail, sha256Hex, stable, type AppRoute, type CommitResult, type RequestContext, type Supabase } from '../_kit/mod.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** El mismo uuid estable que Finance (food-api/consumption.ts): así un coste no se apunta dos veces venga de donde venga. */
async function stableUuid(seed: string): Promise<string> {
  const hex = await sha256Hex(seed);
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

interface EntriesRead { source_app: string; entries: unknown[]; refs: string[]; skipped?: unknown[]; costs?: Array<{ movement_id: string; unit_cost: number; source_ref: string }> }

export type ReconcileState = 'ok' | 'diff' | 'none' | 'error';
export interface ReconcileResult { id: string; state: ReconcileState; invoiced: number | null; estimated: number | null; diff: number | null; codes: string[] }
interface AllocationRow { target_id: string; invoice_code?: string | null; allocated_amount?: number | string | null }

/**
 * El resultado de cada solicitud frente a sus facturas (pura, para probarla sin servidor): sin filas, `none`; con ellas, lo
 * asignado frente al importe estimado de la solicitud (diferencia de medio céntimo o menos, `ok`).
 */
export function reconcileResults(ids: readonly string[], rows: readonly AllocationRow[], estimated: ReadonlyMap<string, number | null>, failed = false): ReconcileResult[] {
  return ids.map((id) => {
    const mine = rows.filter((r) => r.target_id === id);
    const est = estimated.get(id) ?? null;
    if (!mine.length) return { id, state: 'none', invoiced: null, estimated: est, diff: null, codes: [] };
    const invoiced = Math.round(mine.reduce((n, r) => n + Number(r.allocated_amount ?? 0), 0) * 100) / 100;
    const diff = est == null ? null : Math.round((invoiced - est) * 100) / 100;
    const codes = [...new Set(mine.map((r) => r.invoice_code).filter((c): c is string => !!c))];
    return { id, state: failed ? 'error' : diff != null && Math.abs(diff) > 0.005 ? 'diff' : 'ok', invoiced, estimated: est, diff, codes };
  });
}

/** Importe estimado de cada solicitud pedida (lo previsto). */
async function estimatesOf(supabase: Supabase, ctx: RequestContext, ids: readonly string[]): Promise<Map<string, number | null>> {
  const want = new Set(ids);
  const out = new Map<string, number | null>();
  for (let offset = 0; ; offset += 2000) {
    const page = await supabase.rpc<{ rows: Array<{ id: string; estimated_amount: number | string | null }> }>('core_snapshot_table', {
      p_app: 'tasks', p_role: ctx.membership.role, p_table: 'tasks.purchase_requests', p_include_deleted: false, p_limit: 2000, p_offset: offset,
    });
    for (const r of page.rows) if (want.has(r.id)) out.set(r.id, r.estimated_amount == null ? null : Number(r.estimated_amount));
    if (page.rows.length < 2000 || out.size === want.size) return out;
  }
}

export async function reconcileReceipts(supabase: Supabase, ctx: RequestContext, requestIds: string[]): Promise<{ movements: number; costs: number; results: ReconcileResult[] }> {
  const [allocations, estimated] = await Promise.all([
    supabase.rpc<{ rows?: AllocationRow[] }>('core_read', { p_app: 'tasks', p_actor: ctx.user.id, p_name: 'invoices.allocations_by_target', p_args: { targetApp: 'tasks', targetKind: 'purchase_request', ids: requestIds } })
      .then((r) => r?.rows ?? []).catch(() => [] as AllocationRow[]),
    estimatesOf(supabase, ctx, requestIds),
  ]);
  try {
    const done = await commitReconcile(supabase, ctx, requestIds);
    return { ...done, results: reconcileResults(requestIds, allocations, estimated) };
  } catch (error) {
    console.warn('tasks-api · cuadre con Finance', error);
    return { movements: 0, costs: 0, results: reconcileResults(requestIds, allocations, estimated, true) };
  }
}

async function commitReconcile(supabase: Supabase, ctx: RequestContext, requestIds: string[]): Promise<{ movements: number; costs: number }> {
  const read = await supabase.rpc<EntriesRead>('core_read', { p_app: 'tasks', p_actor: ctx.user.id, p_name: 'invoices.tasks_resource_entries', p_args: { request_ids: requestIds } });
  const known = new Set<string>();
  const costs = read.costs ?? [];
  if (costs.length) {
    // Un coste ya apuntado (por Finance o por una llamada anterior) no se vuelve a insertar: ROW_EXISTS tumbaría el lote.
    const ids = await Promise.all(costs.map((c) => stableUuid(`movement-cost:${c.movement_id}`)));
    const rows = await supabase.rpc<{ rows: Array<{ id: string }> }>('core_snapshot_table', { p_app: 'resources', p_role: 'reader', p_table: 'resources.movement_costs', p_include_deleted: true, p_limit: 2000, p_offset: 0 });
    for (const r of rows.rows) if (ids.includes(r.id)) known.add(r.id);
  }
  if (!read.entries.length && !read.refs.length && !costs.length) return { movements: 0, costs: 0 };
  const operations: unknown[] = [{ op: 'call', procedure: 'resources.reconcile_entries', args: { source_app: read.source_app, entries: read.entries, refs: read.refs } }];
  let added = 0;
  for (const c of costs) {
    const id = await stableUuid(`movement-cost:${c.movement_id}`);
    if (known.has(id)) continue;
    operations.push({ op: 'insert', table: 'resources.movement_costs', id, fields: { movement_id: c.movement_id, unit_cost: c.unit_cost, source_app: 'invoices', source_ref: c.source_ref } });
    added += 1;
  }
  const digest = await sha256Hex(stable(operations));
  const out = await supabase.rpc<CommitResult>('core_commit', {
    p_app: 'resources', p_actor: ctx.user.id, p_request_id: `tasks-reconcile-${digest.slice(0, 40)}`, p_digest: digest,
    p_expected_cursor: null, p_operations: operations,
    p_confirmation: ctx.user.kind === 'agent' ? { required: false, id: null, risk: { required: false, reasons: ['tasks:reconcile_receipts'] } } : null,
    // 0118: el lote lo confirma el servidor, no el navegador (Recursos 0820 pone así el origen de los movimientos).
    p_origin: 'server',
  });
  return { movements: ((out.results?.[0] as { movements?: unknown[] } | undefined)?.movements ?? []).length, costs: added };
}

export function receiptRoutes(supabase: Supabase): AppRoute[] {
  return [{
    method: 'POST', pattern: 'purchases/reconcile', handler: async ({ ctx, json }) => {
      if (!['editor', 'owner'].includes(ctx.membership.role)) fail(403, 'FORBIDDEN', 'Solo quien recibe compras cuadra con Finance.');
      const body = await json();
      const ids = body?.requestIds;
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 || !ids.every((id: unknown) => typeof id === 'string' && UUID.test(id))) {
        fail(422, 'INVALID_OPERATION', 'requestIds es una lista de 1 a 100 ids de solicitud.');
      }
      return reconcileReceipts(supabase, ctx, (ids as string[]).map((id) => id.toLowerCase()));
    },
  }];
}
