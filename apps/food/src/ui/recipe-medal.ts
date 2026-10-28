/**
 * La receta sin foto, en su tarjeta: su inicial sobre el color de su categoría (F-REC-3; regla del medallón de VG).
 * La foto, si la hay, se pinta encima al llegar (`.recipephoto img` ocupa toda la caja).
 */
import { renderMedal } from '@ikisai/ui-kit';
import type { RecipeCategory } from '@ikisai/domain-food';
import type { SyncClient } from '@ikisai/sync-client';
import { T } from '../app/client.ts';
import { cartaImage } from './carta.ts';

const CATEGORY_COLORS: Record<RecipeCategory, string> = {
  desayuno: '#c98a2b', entrante: '#5f8f5a', principal: '#b5543c', guarnicion: '#7a9a3a', postre: '#b4628e',
  picnic: '#3f7f8f', merienda: '#a0713f', bebida: '#4a6fa5', base: '#7a6a58', otro: '#6b6b7a',
};

/** El color de la categoría, también para el medallón de Cocina y de la ficha del menú. */
export const recipeColor = (category: RecipeCategory | null | undefined): string => (category && CATEGORY_COLORS[category]) || CATEGORY_COLORS.otro;

/**
 * La imagen de la carta de cada receta (las de los montaditos las sirve Flow; 28-10): una receta sin foto propia la usa en
 * su medallón. La foto de la receta, si la hay, sigue pintándose encima.
 */
const cartaImages = new Map<string, string>();

/** Lee las líneas de la carta: receta → clave de su imagen. Lo llama el recetario al cargar, antes de pintar. */
export async function loadCartaImages(client: SyncClient): Promise<void> {
  const lines = (await client.list(T.cartaLines)) as Array<{ recipe_id: string | null; image_key: string | null; deleted_at?: string | null }>;
  cartaImages.clear();
  for (const l of lines) if (!l.deleted_at && l.recipe_id && l.image_key && !cartaImages.has(l.recipe_id)) cartaImages.set(l.recipe_id, l.image_key);
}

/** La clave de la imagen de la carta de una receta, si tiene. */
export const cartaImageKey = (recipeId: string): string | undefined => cartaImages.get(recipeId);

export function recipeMedal(recipe: { id?: string; name: string; category: RecipeCategory }, size = 56): HTMLElement {
  const key = recipe.id ? cartaImages.get(recipe.id) : undefined;
  return renderMedal({ name: recipe.name, color: recipeColor(recipe.category), size, ...(key ? { image: cartaImage(key) } : {}) });
}
