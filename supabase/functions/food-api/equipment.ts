/**
 * Food · tanda 27: worker del estado de las peticiones de máquina (`POST /api/v1/worker/equipment/tick`; migración 1106;
 * Tasks #606, docs/tasks/API.md §22.3). Con la cuenta de servicio `food`:
 * 1. lee los avisos vivos que aún pueden cambiar (`food.equipment_notices_to_check`, hasta 200);
 * 2. pregunta su estado a Tasks en una sola llamada (`worker/requests/status`, con la clave de worker);
 * 3. copia en cada aviso el estado que haya cambiado, en un solo lote. Así «En reparación» (`open`) lo ven todos los
 *    dispositivos de la cocina, también los de quien no está en Tasks.
 * Si Tasks no responde, no se toca nada y la siguiente vuelta lo vuelve a intentar.
 */
import { ensureServiceActor, sha256Hex, stable, type Supabase } from '../_kit/mod.ts';
import { FOOD_SERVICE } from './consumption.ts';

interface NoticeToCheck { id: string; revision: number; equipment_id: string; notified_on: string; request_status: string | null }

const STATUSES = new Set(['pending', 'open', 'done', 'dismissed', 'deleted', 'unknown']);

/** Referencia del aviso en Tasks: la misma que manda `equipment/:id/fault`, con el prefijo de la app. */
export const noticeRef = (equipmentId: string, day: string) => `food:equipment_fault:${equipmentId}:${day}`;

export async function runEquipmentTick(supabase: Supabase, options: { workerKey?: string; fetch?: typeof fetch } = {}) {
  const actor = await ensureServiceActor(supabase, FOOD_SERVICE);
  const due = await supabase.rpc<{ items: NoticeToCheck[] }>('core_read', {
    p_app: 'food', p_actor: actor, p_name: 'food.equipment_notices_to_check', p_args: { limit: 200 },
  });
  const out = { checked: due.items.length, updated: 0, error: null as string | null };
  if (!due.items.length) return out;
  const transport = options.fetch ?? fetch;
  let items: Array<{ externalRef: string; status: string }> = [];
  try {
    const res = await transport(`${supabase.base}/functions/v1/tasks-api/api/v1/worker/requests/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': options.workerKey ?? '' },
      body: JSON.stringify({ externalRefs: due.items.map((n) => noticeRef(n.equipment_id, n.notified_on)) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ...out, error: `TASKS_${res.status}` };
    items = ((await res.json()) as { items?: typeof items }).items ?? [];
  } catch {
    return { ...out, error: 'TASKS_UNAVAILABLE' };
  }
  const status = new Map(items.filter((i) => STATUSES.has(i.status)).map((i) => [i.externalRef, i.status]));
  const operations = due.items.flatMap((n) => {
    const next = status.get(noticeRef(n.equipment_id, n.notified_on));
    return next && next !== n.request_status
      ? [{ op: 'update', table: 'food.equipment_notices', id: n.id, expectedRevision: n.revision, fields: { request_status: next } }]
      : [];
  });
  if (!operations.length) return out;
  const digest = await sha256Hex(stable(operations));
  await supabase.rpc('core_commit', {
    p_app: 'food', p_actor: actor, p_request_id: `food-equipment-status:${digest.slice(0, 32)}`, p_digest: digest,
    p_expected_cursor: null, p_operations: operations, p_confirmation: null,
  });
  return { ...out, updated: operations.length };
}
