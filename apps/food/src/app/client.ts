import { createSyncClient, type ApiError, type SyncClient, type TableName } from '@ikisai/sync-client';
import { formatQuantity as kitFormatQuantity, parseQuantity as kitParseQuantity } from '@ikisai/ui-kit';
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
  /** Comentarios del organizador desde su portal: en Food solo cambian `status` y `reply`. */
  menuComments: 'food.menu_comments',
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

/** Número en español sin ceros de más, con hasta tres decimales como las cantidades de Food: 2,5 · 800 · 0,125. */
export function formatQuantity(value: unknown): string {
  const n = Number(value);
  return value === null || value === undefined || !Number.isFinite(n) ? '' : kitFormatQuantity(n, 3);
}

/** Lee un número escrito a la española o a la inglesa (kit); `null` si está vacío o no es un número. */
export function parseQuantity(text: string): number | null {
  const n = kitParseQuantity(text);
  return n === null || Number.isNaN(n) ? null : n;
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
    case 'MENU_EXISTS': return 'Este evento ya tiene un menú.';
    case 'MENU_EMPTY': return 'Añade al menos un plato antes de validar.';
    case 'MENU_NOT_FOUND': return 'El menú ya no existe.';
    case 'EVENT_NOT_FOUND': return 'El evento ya no está disponible para cocina.';
    case 'EVENT_CHANGED': return 'La información del evento ha cambiado. Revísala antes de continuar.';
    case 'MENU_WARNINGS_UNACKNOWLEDGED': return 'Han aparecido avisos nuevos. Revísalos antes de validar.';
    case 'INVALID_TRANSITION': return 'El menú ya no está en el estado esperado.';
    case 'OFFLINE': return 'Esta acción necesita conexión.';
    case 'PENDING_CHANGES': return 'Hay cambios sin sincronizar o conflictos por resolver. Sincroniza primero.';
    default: return typeof e?.message === 'string' && e.message ? e.message : 'Ha ocurrido un error inesperado.';
  }
}
