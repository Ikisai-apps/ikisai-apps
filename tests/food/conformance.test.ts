import { runConformance } from '../../packages/test-kit/src/conformance.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';

runConformance({
  app: 'food',
  slug: 'food-api',
  origin: FOOD_ORIGINS[0]!,
  createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  uploadSample: { mime: 'image/webp', filename: 'foto.webp' },
  table: 'food.equipment',
  fieldA: 'name',
  fieldB: 'notes',
  required: { name: 'Horno de prueba' },
});
