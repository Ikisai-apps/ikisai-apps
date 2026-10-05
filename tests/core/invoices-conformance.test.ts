import { runConformance } from '../../packages/test-kit/src/conformance.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';

runConformance({
  app: 'invoices',
  slug: 'invoices-api',
  origin: INVOICES_ORIGINS[0]!,
  createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!] }),
  table: 'invoices.suppliers',
  fieldA: 'name',
  fieldB: 'notes',
  required: { name: 'Proveedor de prueba' },
});
