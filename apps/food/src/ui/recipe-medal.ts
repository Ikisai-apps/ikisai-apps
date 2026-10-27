/**
 * La receta sin foto, en su tarjeta: su inicial sobre el color de su categoría (F-REC-3; regla del medallón de VG).
 * La foto, si la hay, se pinta encima al llegar (`.recipephoto img` ocupa toda la caja).
 */
import { renderMedal } from '@ikisai/ui-kit';
import type { RecipeCategory } from '@ikisai/domain-food';

const CATEGORY_COLORS: Record<RecipeCategory, string> = {
  desayuno: '#c98a2b', entrante: '#5f8f5a', principal: '#b5543c', guarnicion: '#7a9a3a', postre: '#b4628e',
  picnic: '#3f7f8f', merienda: '#a0713f', bebida: '#4a6fa5', base: '#7a6a58', otro: '#6b6b7a',
};

/** El color de la categoría, también para el medallón de Cocina y de la ficha del menú. */
export const recipeColor = (category: RecipeCategory | null | undefined): string => (category && CATEGORY_COLORS[category]) || CATEGORY_COLORS.otro;

export function recipeMedal(recipe: { name: string; category: RecipeCategory }, size = 56): HTMLElement {
  return renderMedal({ name: recipe.name, color: recipeColor(recipe.category), size });
}
