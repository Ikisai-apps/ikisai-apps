/**
 * Ikisai Tasks · cuadre con Finance al recibir (orden inverso de R4; RESPUESTAS de Core del 19-10-2026; API.md §35).
 *
 * Si una factura se valida en Finance **antes** de que Tasks reciba la compra, Finance no se entera de la recepción. Tras
 * marcar «Recibida», la app llama aquí: se lee `invoices.tasks_resource_entries` (lectura de Finance abierta a Tasks,
 * editor y propietaria, 0239) con las solicitudes y, si trae algo, se manda en un lote de Recursos como hace la Edge de
 * Finance (`reconcileResourceEntries`): `resources.reconcile_entries` y los costes de las entradas (`movement_costs`, con el
 * mismo id estable que usa Finance). Repetirlo no duplica nada (requestId y digest estables, cuadre idempotente).
 * - `POST purchases/reconcile {requestIds}`: hasta 100 solicitudes. Devuelve `{movements, costs}`.
 * Un fallo aquí no deshace la recepción: la app lo registra y sigue.
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

export async function reconcileReceipts(supabase: Supabase, ctx: RequestContext, requestIds: string[]): Promise<{ movements: number; costs: number }> {
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
