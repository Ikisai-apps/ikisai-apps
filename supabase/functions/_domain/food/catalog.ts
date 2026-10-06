/** Ikisai Food · vocabularios y tipos del catálogo (docs/food/API.md §2.1). Los comparten la Edge y el frontend. */
import type { Unit } from './units.ts';

export const RECIPE_CATEGORIES = ['desayuno', 'entrante', 'principal', 'guarnicion', 'postre', 'picnic', 'merienda', 'bebida', 'base', 'otro'] as const;
export const RECIPE_STATUSES = ['en_prueba', 'validada', 'archivada'] as const;
export const DIET_TAGS = ['vegetariano', 'vegano', 'sin_gluten', 'sin_lactosa'] as const;
/** Los 14 alérgenos de declaración obligatoria (Reglamento UE 1169/2011). */
export const ALLERGENS = [
  'gluten', 'crustaceos', 'huevos', 'pescado', 'cacahuetes', 'soja', 'lacteos', 'frutos_de_cascara',
  'apio', 'mostaza', 'sesamo', 'sulfitos', 'altramuces', 'moluscos',
] as const;
export const EQUIPMENT_STATUSES = ['operativo', 'limitado', 'averiado', 'fuera_de_servicio'] as const;

export type RecipeCategory = (typeof RECIPE_CATEGORIES)[number];
export type RecipeStatus = (typeof RECIPE_STATUSES)[number];
export type DietTag = (typeof DIET_TAGS)[number];
export type Allergen = (typeof ALLERGENS)[number];
export type EquipmentStatus = (typeof EQUIPMENT_STATUSES)[number];

/** Columnas comunes de toda fila sincronizable (contrato §2.1). */
export interface SyncedColumns {
  id: string;
  revision: number;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  deleted_at: string | null;
}

export interface Recipe extends SyncedColumns {
  name: string;
  public_name: string | null;
  public_description: string | null;
  category: RecipeCategory;
  base_servings: number;
  method: string | null;
  conservation: string | null;
  freezable: boolean;
  regeneration: string | null;
  service_notes: string | null;
  prep_minutes: number | null;
  status: RecipeStatus;
  diet_tags: DietTag[];
  allergens: Allergen[];
  allergens_checked: boolean;
  photo_file_id: string | null;
  photo_thumb_file_id: string | null;
}

export interface Ingredient extends SyncedColumns {
  name: string;
  preferred_unit: Unit;
  preferred_supplier: string | null;
  active: boolean;
}

export interface RecipeIngredient extends SyncedColumns {
  recipe_id: string;
  ingredient_id: string;
  quantity: number;
  unit: Unit;
  position: number;
  notes: string | null;
}

export interface Equipment extends SyncedColumns {
  name: string;
  category: string | null;
  quantity: number;
  capacity: string | null;
  location: string | null;
  status: EquipmentStatus;
  notes: string | null;
}

export interface RecipeEquipment extends SyncedColumns {
  recipe_id: string;
  equipment_id: string;
  quantity_required: number;
  notes: string | null;
}

export const FOOD_TABLES = {
  recipes: 'food.recipes',
  ingredients: 'food.ingredients',
  recipeIngredients: 'food.recipe_ingredients',
  equipment: 'food.equipment',
  recipeEquipment: 'food.recipe_equipment',
} as const;

/** Fotos de receta: el cliente las recomprime a WebP (JPEG si el navegador no codifica WebP) y no conserva el original. */
export const PHOTO_MIME = ['image/webp', 'image/jpeg'] as const;
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
export const PHOTO_MAX_SIDE = 1600;
export const PHOTO_THUMB_SIDE = 480;
/** Columnas de food.recipes que referencian core.files. */
export const RECIPE_FILE_FIELDS = ['photo_file_id', 'photo_thumb_file_id'] as const;

/** Nombre de ingrediente tal y como lo compara la base: sin espacios sobrantes y sin distinguir mayúsculas. */
export function ingredientKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}
