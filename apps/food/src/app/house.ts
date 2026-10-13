/** Food · lo de hoy en el menú de casa, para Menús e Inicio (O3a; docs/food/API.md §2.6). */
import { HOUSE_MENU_ID, type Menu, type MenuItem, type MenuService, type Recipe } from '@ikisai/domain-food';
import type { SyncClient } from '@ikisai/sync-client';
import { T, type Mirror } from './client.ts';
import { todayKey } from './events.ts';

export const HOUSE_MENU_HASH = `#/menus/${HOUSE_MENU_ID}`;

const SERVICE_NAMES: Record<MenuService['service_type'], string> = { desayuno: 'Desayuno', comida: 'Comida', cena: 'Cena', picnic: 'Picnic', merienda: 'Merienda', otro: 'Otro' };

export interface HouseToday {
  /** El menú de casa ya existe en este dispositivo. */
  exists: boolean;
  /** «Comida · Lentejas, Ensalada», uno por servicio de hoy, en su orden. */
  lines: string[];
}

export async function loadHouseToday(client: SyncClient): Promise<HouseToday> {
  const menu = (await client.get(T.menus, HOUSE_MENU_ID)) as Mirror<Menu> | null;
  if (!menu || menu.deleted_at) return { exists: false, lines: [] };
  const today = todayKey();
  const [services, items, recipes] = await Promise.all([
    client.list(T.menuServices) as Promise<Mirror<MenuService>[]>,
    client.list(T.menuItems) as Promise<Mirror<MenuItem>[]>,
    client.list(T.recipes, { includeDeleted: true }) as Promise<Mirror<Recipe>[]>,
  ]);
  const names = new Map(recipes.map((r) => [r.id, r.name]));
  const lines = services
    .filter((s) => s.menu_id === HOUSE_MENU_ID && s.service_date === today && !s.deleted_at)
    .sort((a, b) => Number(a.position) - Number(b.position) || (a.service_time ?? '99').localeCompare(b.service_time ?? '99'))
    .map((s) => {
      const dishes = items.filter((i) => i.service_id === s.id && !i.deleted_at).sort((a, b) => Number(a.position) - Number(b.position)).map((i) => names.get(i.recipe_id) ?? '—');
      return `${SERVICE_NAMES[s.service_type]} · ${dishes.length ? dishes.join(', ') : 'sin platos'}`;
    });
  return { exists: true, lines };
}
