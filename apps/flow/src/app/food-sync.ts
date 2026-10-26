import type { SyncClient } from '@ikisai/sync-client';
import type { CartaLine, CartaMenu } from '@ikisai/domain-flow';

/**
 * «Actualizar carta desde Food» (encargo de VG del 26-10): el catálogo de Flow es un reflejo de la carta de Food
 * (`food.carta_projection`, que Food abre a Flow: se lee con la sesión de Flow). Lo hace el owner, a mano, así que
 * durante el servicio la carta no cambia sola. El plan (qué crear, actualizar o retirar) está en el dominio
 * (`_domain/flow/carta-sync.ts`); aquí, la lectura.
 */
export { pickMenu, planSync, type CartaMenu, type SyncPlan } from '@ikisai/domain-flow';

export async function readFoodMenus(client: SyncClient): Promise<CartaMenu[]> {
  const out = await client.api<{ rows: CartaLine[] }>('/read/food.carta_projection?limit=2000');
  const menus = new Map<string, CartaMenu>();
  for (const line of out.rows ?? []) {
    const menu = menus.get(line.menu_id) ?? { id: line.menu_id, name: line.menu_name, eventId: line.event_id, lines: [] };
    menu.lines.push(line);
    menus.set(line.menu_id, menu);
  }
  return [...menus.values()];
}
