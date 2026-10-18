/**
 * Food · R5c, P17: worker del consumo a las 24 h (`POST /api/v1/worker/consumption/tick`; docs/food/API.md §2.8).
 *
 * Con la cuenta de servicio `food` (la da de alta Core) y sin depender de que alguien abra la app:
 * 1. lee los platos vencidos (`food.consumption_due`);
 * 2. anota el consumo en Food con un id fijo por plato. Es el cerrojo: si ya hay uno (de la app o de otra vuelta), se salta;
 * 3. descuenta en Recursos con `resources.consume` y un `requestId` fijo por plato: repetirlo devuelve el recibo, así que
 *    un reintento tras un fallo a medias no descuenta dos veces.
 */
import { isFault, sha256Hex, stable, type Supabase } from '../_kit/mod.ts';

export const FOOD_SERVICE = 'food';

interface DueItem {
  menu_item_id: string;
  /** Ya anotado (automático) pero sin movimientos: solo falta descontar. */
  retry: boolean;
  note: string;
  calls: Array<{ item_id: string; quantity: number; default_space_id: string | null }>;
}

/** Uuid estable a partir de un texto (el mismo plato, el mismo consumo). */
export async function stableUuid(seed: string): Promise<string> {
  const hex = await sha256Hex(seed);
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Errores que dicen que el consumo ya estaba anotado (o el plato ya no existe): no hay nada que hacer. */
const DONE = new Set(['ROW_EXISTS', 'CONSTRAINT_VIOLATION', 'PARENT_DELETED']);

export async function runConsumptionTick(supabase: Supabase, options: { limit?: number } = {}) {
  // La cuenta la da de alta Core (servicio `food`, editor en Food). Sin ella no se hace nada, y no se crea ninguna cuenta
  // de Auth aquí: si el alta falla, cada vuelta dejaría una huérfana.
  const actor = await supabase.rpc<string | null>('core_service_actor', { p_name: FOOD_SERVICE });
  if (!actor) return { noted: 0, consumed: 0, skipped: 0, errors: [], service: 'missing' };
  const commit = async (app: string, requestId: string, operations: unknown[]) => supabase.rpc('core_commit', {
    p_app: app, p_actor: actor, p_request_id: requestId, p_digest: await sha256Hex(stable(operations)), p_expected_cursor: null, p_operations: operations, p_confirmation: null,
  });
  const due = await supabase.rpc<{ kitchen: string[]; items: DueItem[] }>('core_read', {
    p_app: 'food', p_actor: actor, p_name: 'food.consumption_due', p_args: { limit: options.limit ?? 50 },
  });
  const out = { noted: 0, consumed: 0, skipped: 0, errors: [] as Array<{ menuItemId: string; code: string }> };
  for (const item of due.items) {
    if (!item.retry) {
      try {
        await commit('food', `food-auto-consumption:${item.menu_item_id}`, [{
          op: 'insert', table: 'food.consumptions', id: await stableUuid(`food-consumption:${item.menu_item_id}`),
          fields: { menu_item_id: item.menu_item_id, status: 'confirmado', automatic: true, notes: 'Descontado solo a las 24 h' },
        }]);
        out.noted += 1;
      } catch (error) {
        const code = isFault(error) ? error.code : 'ERROR';
        if (DONE.has(code)) out.skipped += 1; else out.errors.push({ menuItemId: item.menu_item_id, code });
        continue;
      }
    }
    if (!item.calls.length) continue;
    try {
      await commit('resources', `food-auto-consume:${item.menu_item_id}`, item.calls.map((c) => ({
        op: 'call', procedure: 'resources.consume',
        args: {
          item_id: c.item_id, quantity: c.quantity, kind: 'consumo_servicio', source_app: 'food', source_ref: `menu_item:${item.menu_item_id}`, note: item.note,
          space_ids: due.kitchen, ...(c.default_space_id ? { default_space_id: c.default_space_id } : {}),
        },
      })));
      out.consumed += 1;
    } catch (error) {
      out.errors.push({ menuItemId: item.menu_item_id, code: isFault(error) ? error.code : 'ERROR' });
    }
  }
  return out;
}
