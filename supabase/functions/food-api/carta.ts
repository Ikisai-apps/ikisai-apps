/**
 * Food · la carta: el stock de Recursos al día de las ventas (docs/food/API.md §2.10; migración 1109).
 *
 * Flow registra las ventas de un día con `food.record_carta_sales` (POST commands, sesión del encargado). Tras el commit,
 * `syncCartaStock` deja los movimientos con la referencia `carta:<menu>:<día>` como dicen las ventas: consume lo que
 * falta (`resources.consume`: primero lo que caduca antes) o, si se corrigió a la baja, devuelve la diferencia con una
 * entrada a mano. Lo hace la cuenta de servicio `food` (como el consumo a las 24 h), porque quien cierra la caja no
 * tiene por qué tener acceso a Recursos. Repetirlo no cambia nada: compara con lo que ya hay.
 */
import { ensureServiceActor, isFault, sha256Hex, stable, type CommitResult, type Supabase } from '../_kit/mod.ts';
import { cartaStockOperations, type CartaStockPlan } from '../_domain/food/mod.ts';
import { FOOD_SERVICE, stableUuid } from './consumption.ts';

export interface CartaStockResult {
  menuId: string;
  day: string;
  consumed: number;
  returned: number;
  /** Artículos que había que devolver y no tienen sitio. */
  skipped: string[];
  /** Líneas vendidas que no se pueden pasar a stock (receta sin artículos o sin conversión). */
  unconverted: string[];
  error?: string;
}

export async function syncCartaStock(supabase: Supabase, menuId: string, day: string): Promise<CartaStockResult> {
  const actor = await ensureServiceActor(supabase, FOOD_SERVICE);
  const plan = await supabase.rpc<CartaStockPlan>('core_read', {
    p_app: 'food', p_actor: actor, p_name: 'food.carta_stock_plan', p_args: { menu_id: menuId, day },
  });
  const { operations, skipped } = cartaStockOperations(plan);
  const out: CartaStockResult = { menuId, day, consumed: 0, returned: 0, skipped, unconverted: plan.unconverted };
  if (!operations.length) return out;
  const note = `Ventas de la carta del ${day}`;
  // Se gasta de donde haya (la barra no es la cocina) y, si no queda, lo que falta se anota en el sitio del artículo o en
  // la cocina: el stock queda en negativo y se ve.
  const fallback = (itemId: string) => plan.items.find((i) => i.item_id === itemId)?.default_space_id ?? plan.kitchen[0] ?? null;
  const ops = await Promise.all(operations.map(async (o) => o.kind === 'consume'
    ? { op: 'call', procedure: 'resources.consume', args: { item_id: o.itemId, quantity: o.quantity, kind: 'consumo_servicio', source_app: 'food', source_ref: plan.source_ref, note,
        ...(fallback(o.itemId) ? { default_space_id: fallback(o.itemId) } : {}) } }
    : { op: 'insert', table: 'resources.movements', id: await stableUuid(`${plan.source_ref}:${o.itemId}:${stable(plan.items)}`),
        fields: { item_id: o.itemId, space_id: o.spaceId, quantity: o.quantity, kind: 'entrada_manual', source_app: 'food', source_ref: plan.source_ref, note: `${note}: corrección a la baja` } }));
  // El mismo plan (lo que hay y lo que debería haber) da el mismo requestId: un reintento devuelve el recibo.
  const digest = await sha256Hex(stable(ops));
  await supabase.rpc('core_commit', {
    p_app: 'resources', p_actor: actor, p_request_id: `food-carta-stock:${digest.slice(0, 40)}`, p_digest: digest,
    p_expected_cursor: null, p_operations: ops, p_confirmation: null,
  });
  out.consumed = operations.filter((o) => o.kind === 'consume').length;
  out.returned = operations.length - out.consumed;
  return out;
}

/** Los días de carta que tocó un commit (ventas registradas), para ajustar su stock después. */
export function cartaDaysOf(result: CommitResult): Array<{ menuId: string; day: string }> {
  const seen = new Map<string, { menuId: string; day: string }>();
  for (const change of result.changes) {
    if (change.table !== 'food.carta_sales' || !change.after) continue;
    const menuId = String(change.after.menu_id ?? '');
    const day = String(change.after.day ?? '').slice(0, 10);
    if (menuId && day) seen.set(`${menuId}:${day}`, { menuId, day });
  }
  return [...seen.values()];
}

/** Tras el commit: si falla, las ventas ya están guardadas y el stock se reintenta con `POST carta/stock`. */
export async function afterCartaSales(supabase: Supabase, result: CommitResult): Promise<CartaStockResult[]> {
  const out: CartaStockResult[] = [];
  for (const { menuId, day } of cartaDaysOf(result)) {
    try {
      out.push(await syncCartaStock(supabase, menuId, day));
    } catch (error) {
      out.push({ menuId, day, consumed: 0, returned: 0, skipped: [], unconverted: [], error: isFault(error) ? error.code : 'ERROR' });
    }
  }
  return out;
}
