/**
 * Food · R5c, P17: worker del consumo a las 24 h (`POST /api/v1/worker/consumption/tick`; docs/food/API.md §2.8).
 *
 * Con la cuenta de servicio `food` (núcleo, 0096; la crea `ensureServiceActor` la primera vez) y sin depender de que alguien abra la app:
 * 1. lee los platos vencidos (`food.consumption_due`);
 * 2. anota el consumo en Food con un id fijo por plato. Es el cerrojo: si ya hay uno (de la app o de otra vuelta), se salta;
 * 3. descuenta en Recursos con `resources.consume` (`once: true`, 0806) y un `requestId` fijo por plato: ni un reintento
 *    ni la app pueden descontar dos veces el mismo plato.
 */
import { ensureServiceActor, isFault, sha256Hex, stable, type Supabase } from '../_kit/mod.ts';

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
  // Servicio `food` del núcleo (0096): la cuenta se crea la primera vez y después se reutiliza, como la de Feedback.
  const actor = await ensureServiceActor(supabase, FOOD_SERVICE);
  const commit = async (app: string, requestId: string, operations: unknown[]) => supabase.rpc('core_commit', {
    p_app: app, p_actor: actor, p_request_id: requestId, p_digest: await sha256Hex(stable(operations)), p_expected_cursor: null, p_operations: operations, p_confirmation: null,
    // Origen `server` (0118): en Recursos cuenta el `source_app: 'food'` declarado (FO4, 0820), el mismo que pone `stock/commands`.
    p_origin: 'server',
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
          item_id: c.item_id, quantity: c.quantity, kind: 'consumo_servicio', source_app: 'food', source_ref: `menu_item:${item.menu_item_id}`, note: item.note, once: true,
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
