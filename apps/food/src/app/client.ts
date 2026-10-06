import { createSyncClient, type ApiError, type SyncClient, type TableName } from '@ikisai/sync-client';
import {
  ALLERGENS, DIET_TAGS, EQUIPMENT_STATUSES, RECIPE_CATEGORIES, RECIPE_STATUSES, UNITS,
  type Allergen, type DietTag, type EquipmentStatus, type RecipeCategory, type RecipeStatus, type Unit,
} from '@ikisai/domain-food';

export const APP = 'food';

export const T = {
  recipes: 'food.recipes',
  ingredients: 'food.ingredients',
  recipeIngredients: 'food.recipe_ingredients',
  equipment: 'food.equipment',
  recipeEquipment: 'food.recipe_equipment',
  menus: 'food.menus',
  menuServices: 'food.menu_services',
  menuItems: 'food.menu_items',
  shoppingLists: 'food.shopping_lists',
  shoppingItems: 'food.shopping_list_items',
  preparation: 'food.preparation_items',
} as const satisfies Record<string, TableName>;

/** Fila del espejo local: `_pending` lo pone el cliente offline mientras el servidor no confirma. */
export type Mirror<Row> = Row & { _pending?: boolean; [column: string]: unknown };

export const CATEGORY_LABELS: Record<RecipeCategory, string> = {
  desayuno: 'Desayuno', entrante: 'Entrante', principal: 'Principal', guarnicion: 'Guarnición', postre: 'Postre',
  picnic: 'Picnic', merienda: 'Merienda', bebida: 'Bebida', base: 'Base', otro: 'Otro',
};
export const RECIPE_STATUS_LABELS: Record<RecipeStatus, string> = { en_prueba: 'En prueba', validada: 'Validada', archivada: 'Archivada' };
export const DIET_LABELS: Record<DietTag, string> = { vegetariano: 'Vegetariano', vegano: 'Vegano', sin_gluten: 'Sin gluten', sin_lactosa: 'Sin lactosa' };
export const ALLERGEN_LABELS: Record<Allergen, string> = {
  gluten: 'Gluten', crustaceos: 'Crustáceos', huevos: 'Huevos', pescado: 'Pescado', cacahuetes: 'Cacahuetes', soja: 'Soja', lacteos: 'Lácteos',
  frutos_de_cascara: 'Frutos de cáscara', apio: 'Apio', mostaza: 'Mostaza', sesamo: 'Sésamo', sulfitos: 'Sulfitos', altramuces: 'Altramuces', moluscos: 'Moluscos',
};
export const UNIT_LABELS: Record<Unit, string> = { g: 'g', kg: 'kg', ml: 'ml', l: 'l', unidad: 'unidad', paquete: 'paquete', manojo: 'manojo', otro: 'otro' };
export const EQUIPMENT_STATUS_LABELS: Record<EquipmentStatus, string> = {
  operativo: 'Operativo', limitado: 'Limitado', averiado: 'Averiado', fuera_de_servicio: 'Fuera de servicio',
};
export { ALLERGENS, DIET_TAGS, EQUIPMENT_STATUSES, RECIPE_CATEGORIES, RECIPE_STATUSES, UNITS };

/** Número en español sin ceros de más: 2,5 · 800 · 0,125. */
export function formatQuantity(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('es-ES', { maximumFractionDigits: 3 }) : '';
}

/** Lee un número escrito con coma o con punto; `null` si no lo es. */
export function parseQuantity(text: string): number | null {
  const clean = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!clean || !/^\d+(\.\d+)?$/.test(clean)) return null;
  return Number(clean);
}

export function createClient(): SyncClient {
  return createSyncClient({
    app: APP,
    apiBase: '/api/v1',
    tables: Object.values(T),
    pullIntervalMs: 30_000,
  });
}

/** Mensaje legible en español para un error de la API, de red o de las reglas de Food. */
export function describeError(error: unknown): string {
  const e = error as Partial<ApiError> & { message?: string };
  const code = typeof e?.code === 'string' ? e.code : '';
  switch (code) {
    case 'LOGIN_FAILED': return 'Correo o contraseña incorrectos.';
    case 'NETWORK': return 'No hay conexión con el servidor.';
    case 'UNAUTHENTICATED':
    case 'UNAUTHORIZED': return 'La sesión ha caducado. Vuelve a iniciar sesión.';
    case 'FORBIDDEN':
    case 'NO_MEMBERSHIP': return 'Tu cuenta no tiene acceso a Food.';
    case 'VERSION_CONFLICT': return 'Otra persona ha modificado esta fila.';
    case 'BACKEND_UNAVAILABLE': return 'El servidor no está disponible ahora mismo.';
    case 'DUPLICATE_NAME': return 'Ya existe un ingrediente con ese nombre: usa el existente.';
    case 'ALLERGENS_UNCHECKED': return 'Revisa los alérgenos antes de validar la receta.';
    case 'RECIPE_IN_USE': return 'La receta está en un menú: archívala en lugar de borrarla.';
    case 'INGREDIENT_IN_USE': return 'El ingrediente está en alguna receta: desactívalo en lugar de borrarlo.';
    case 'EQUIPMENT_IN_USE': return 'Alguna receta necesita esta máquina: márcala fuera de servicio en lugar de borrarla.';
    case 'PARENT_DELETED': return 'El elemento del que depende está en la papelera.';
    case 'INVALID_FILE': return 'La foto no se pudo enlazar. Vuelve a elegirla.';
    case 'BLOB_MISSING': return 'La foto ya no está en este dispositivo. Vuelve a elegirla.';
    case 'MENU_LOCKED': return 'El menú está validado: reábrelo para cambiarlo.';
    default: return typeof e?.message === 'string' && e.message ? e.message : 'Ha ocurrido un error inesperado.';
  }
}
