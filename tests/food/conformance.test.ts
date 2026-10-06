import { runConformance } from '../../packages/test-kit/src/conformance.ts';
import { createFoodApp, FOOD_ORIGINS, FOOD_UPLOADS } from '../../supabase/functions/food-api/app.ts';

// La suite ejercita la mecánica de subidas con un PDF de muestra; la política real de Food (solo imágenes)
// se comprueba en catalog.test.ts.
runConformance({
  app: 'food',
  slug: 'food-api',
  origin: FOOD_ORIGINS[0]!,
  createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!], uploads: { ...FOOD_UPLOADS, allowedMime: ['application/pdf'] } }),
  table: 'food.equipment',
  fieldA: 'name',
  fieldB: 'notes',
  required: { name: 'Horno de prueba' },
});
