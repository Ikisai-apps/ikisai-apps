import { runConformance } from '../../packages/test-kit/src/conformance.ts';
import { FLOW_ORIGINS, createFlowApp } from '../../supabase/functions/flow-api/app.ts';

// Sin tabla mientras Flow no tenga modelo de datos: con la primera tabla sincronizable, la suite completa (table, fieldA,
// fieldB, required) es obligatoria (docs/flow/ESTADO.md).
runConformance({
  app: 'flow',
  slug: 'flow-api',
  origin: FLOW_ORIGINS[0]!,
  createHandler: (config) => createFlowApp({ ...config, origins: [FLOW_ORIGINS[0]!] }),
});
