/**
 * Ruta compartida de la pasarela (finance-18): el código vive en `_domain/invoices/payments/` porque el despliegue de cada
 * Edge sube solo `_domain/<app>/` (scripts/deploy_supabase_function.py). Esta reexportación sirve al repo y a las pruebas.
 */
export * from '../invoices/payments/stripe.ts';
