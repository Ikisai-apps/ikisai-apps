import { runConformance } from '../../packages/test-kit/src/conformance.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';

runConformance({
  app: 'central',
  slug: 'central-api',
  origin: CENTRAL_ORIGINS[0]!,
  createHandler: (config) => createCentralApp({ ...config, origins: [CENTRAL_ORIGINS[0]!] }),
  table: 'central.people',
  fieldA: 'display_name',
  fieldB: 'availability_notes',
  required: { display_name: 'Persona de prueba', relation: 'equipo' },
});
