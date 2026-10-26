import { runConformance } from '../../packages/test-kit/src/conformance.ts';
import { FLOW_ORIGINS, createFlowApp } from '../../supabase/functions/flow-api/app.ts';

// Suite completa sobre `flow.projects` (owner escribe; `name` y `notes` son texto libre; purgable). Ver docs/flow/API.md §2.
runConformance({
  app: 'flow',
  slug: 'flow-api',
  origin: FLOW_ORIGINS[0]!,
  createHandler: (config) => createFlowApp({ ...config, origins: [FLOW_ORIGINS[0]!] }),
  table: 'flow.projects',
  fieldA: 'name',
  fieldB: 'notes',
  required: { name: 'Proyecto de prueba' },
});
