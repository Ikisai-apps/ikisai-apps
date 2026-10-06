/** Datos de un menú leídos del espejo local, compartidos por sus pestañas (Menú, Compra, Preparación, Cierre). */
import type { SyncClient } from '@ikisai/sync-client';
import type { Equipment, Ingredient, Menu, MenuGraph, MenuItem, MenuService, Recipe, RecipeEquipment, RecipeIngredient } from '@ikisai/domain-food';
import { T, type Mirror } from './client.ts';
import type { PhotoRef } from './photos.ts';

/** En el espejo local la foto puede ser todavía un marcador de blob en cola. */
export type RecipeRow = Mirror<Omit<Recipe, 'photo_file_id' | 'photo_thumb_file_id'> & { photo_file_id: PhotoRef; photo_thumb_file_id: PhotoRef }>;

export interface MenuData {
  menu: Mirror<Menu> | null;
  services: Mirror<MenuService>[];
  items: Mirror<MenuItem>[];
  recipes: RecipeRow[];
  lines: Mirror<RecipeIngredient>[];
  ingredients: Mirror<Ingredient>[];
  equipment: Mirror<Equipment>[];
  needs: Mirror<RecipeEquipment>[];
  /** El mismo grafo que usa el servidor para avisos, compra y preparación. */
  graph: MenuGraph;
  /** Alguna fila de la que dependen compra y preparación tiene cambios locales sin confirmar. */
  pending: boolean;
}

export async function loadMenuData(client: SyncClient, menuId: string): Promise<MenuData> {
  const [menu, allServices, allItems, recipes, lines, ingredients, equipment, needs] = await Promise.all([
    client.get(T.menus, menuId) as Promise<Mirror<Menu> | null>,
    client.list(T.menuServices) as Promise<Mirror<MenuService>[]>,
    client.list(T.menuItems) as Promise<Mirror<MenuItem>[]>,
    client.list(T.recipes, { includeDeleted: true }) as Promise<RecipeRow[]>,
    client.list(T.recipeIngredients) as Promise<Mirror<RecipeIngredient>[]>,
    client.list(T.ingredients, { includeDeleted: true }) as Promise<Mirror<Ingredient>[]>,
    client.list(T.equipment) as Promise<Mirror<Equipment>[]>,
    client.list(T.recipeEquipment) as Promise<Mirror<RecipeEquipment>[]>,
  ]);
  const live = menu && !menu.deleted_at ? menu : null;
  const services = allServices.filter((s) => s.menu_id === menuId);
  const serviceIds = new Set(services.map((s) => s.id));
  const items = allItems.filter((i) => serviceIds.has(i.service_id));
  const used = new Set(items.map((i) => i.recipe_id));
  const graph: MenuGraph = {
    services: services as MenuService[], items: items as MenuItem[], recipes: recipes as unknown as Recipe[],
    recipe_ingredients: lines as RecipeIngredient[], ingredients: ingredients as Ingredient[],
  };
  const pending = [...services, ...items, ...recipes.filter((r) => used.has(r.id)), ...lines.filter((l) => used.has(l.recipe_id))].some((row) => row._pending === true);
  return { menu: live, services, items, recipes, lines, ingredients, equipment, needs, graph, pending };
}

export const MENU_TABLES = [T.menus, T.menuServices, T.menuItems, T.recipes, T.recipeIngredients, T.ingredients] as const;

/** Grafo de cada menú vivo, leído del espejo una sola vez (para Inicio y Eventos). */
export async function loadAllMenuGraphs(client: SyncClient): Promise<Map<string, MenuGraph>> {
  const [menus, services, items, recipes, lines, ingredients] = await Promise.all([
    client.list(T.menus) as Promise<Mirror<Menu>[]>,
    client.list(T.menuServices) as Promise<Mirror<MenuService>[]>,
    client.list(T.menuItems) as Promise<Mirror<MenuItem>[]>,
    client.list(T.recipes, { includeDeleted: true }) as Promise<RecipeRow[]>,
    client.list(T.recipeIngredients) as Promise<Mirror<RecipeIngredient>[]>,
    client.list(T.ingredients, { includeDeleted: true }) as Promise<Mirror<Ingredient>[]>,
  ]);
  const out = new Map<string, MenuGraph>();
  for (const menu of menus) {
    const own = services.filter((s) => s.menu_id === menu.id);
    const ids = new Set(own.map((s) => s.id));
    out.set(menu.id, {
      services: own as MenuService[], items: items.filter((i) => ids.has(i.service_id)) as MenuItem[], recipes: recipes as unknown as Recipe[],
      recipe_ingredients: lines as RecipeIngredient[], ingredients: ingredients as Ingredient[],
    });
  }
  return out;
}

